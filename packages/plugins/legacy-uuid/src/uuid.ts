/**
 * Legacy UUIDs (research 2026-10-28: CUSTOMER-I-5949, CUSTOMER-I-6812, CUSTOMER-I-6680): before the
 * standard UUID subtype (4), the drivers stored a UUID as binary subtype 3, each in its own byte
 * order — Java's reversed each half, C#'s (.NET's Guid) reversed its first three groups, Python's
 * kept the bytes in order. The same 16 bytes read as three different UUIDs; a UUID searched for
 * must be written in the order of the driver that stored it.
 */
export type Encoding = 'standard' | 'java' | 'csharp' | 'python'
export const ENCODINGS: Encoding[] = ['standard', 'java', 'csharp', 'python']
export const LEGACY: Exclude<Encoding, 'standard'>[] = ['java', 'csharp', 'python']

export type Doc = Record<string, unknown>

const HEX = /^[0-9a-f]{32}$/

/**
 * A UUID as people write it: 32 hex digits, with or without dashes and braces, or inside
 * UUID("…") as the shell writes it; null when it is not one.
 */
export function parseUuid(text: string): Uint8Array | null {
  let t = text.trim()
  const call = /^(?:new\s+)?UUID\(\s*(["'])(.*)\1\s*\)$/i.exec(t)
  if (call) t = call[2]!.trim()
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
  const dashed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
  const hex = (dashed ? t.replace(/-/g, '') : t).toLowerCase()
  if (!HEX.test(hex)) return null
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** The UUID's usual text: 8-4-4-4-12 lower-case hex digits. */
export function formatUuid(bytes: Uint8Array): string {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const reversed = (bytes: Uint8Array, from: number, to: number): number[] =>
  [...bytes.slice(from, to)].reverse()

/**
 * A driver's byte order applied to 16 bytes. Each order is its own inverse: the same call turns a
 * UUID into what that driver stored, and what it stored back into the UUID.
 */
export function reorder(bytes: Uint8Array, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case 'java':
      return Uint8Array.from([...reversed(bytes, 0, 8), ...reversed(bytes, 8, 16)])
    case 'csharp':
      return Uint8Array.from([
        ...reversed(bytes, 0, 4),
        ...reversed(bytes, 4, 6),
        ...reversed(bytes, 6, 8),
        ...bytes.slice(8, 16),
      ])
    default:
      return Uint8Array.from(bytes)
  }
}

export const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
export function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text)
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** The value a driver stored for a UUID, as canonical Extended JSON. */
export function stored(uuid: Uint8Array, encoding: Encoding): Doc {
  return {
    $binary: { base64: toBase64(reorder(uuid, encoding)), subType: encoding === 'standard' ? '04' : '03' },
  }
}

/** The shell's way of writing that value. */
export function shellOf(uuid: Uint8Array, encoding: Encoding): string {
  if (encoding === 'standard') return `UUID("${formatUuid(uuid)}")`
  return `BinData(3, "${toBase64(reorder(uuid, encoding))}")`
}

/**
 * A filter on a field for a UUID stored by one driver, or by any of them (`any`: the standard value
 * and the three legacy ones).
 */
export function filterFor(field: string, uuid: Uint8Array, encoding: Encoding | 'any'): Doc {
  if (encoding !== 'any') return { [field]: stored(uuid, encoding) }
  return { [field]: { $in: ENCODINGS.map((e) => stored(uuid, e)) } }
}

/** A value that may hold a UUID: 16 bytes of subtype 3 (legacy) or 4 (standard). */
export function uuidBytes(value: unknown): { bytes: Uint8Array; legacy: boolean } | null {
  if (value === null || typeof value !== 'object') return null
  const b = (value as { $binary?: unknown; $binaryHead?: unknown }).$binary ?? (value as Doc).$binaryHead
  if (b === null || typeof b !== 'object') return null
  const { base64, subType, length } = b as { base64?: unknown; subType?: unknown; length?: unknown }
  // Canonical Extended JSON writes a subtype as two hexadecimal digits.
  if (typeof base64 !== 'string' || (subType !== '03' && subType !== '04')) return null
  if (length !== undefined && length !== 16) return null
  const bytes = fromBase64(base64)
  if (!bytes || bytes.length !== 16) return null
  return { bytes, legacy: subType === '03' }
}

/** What a legacy value reads as, in each driver's order. */
export function readings(bytes: Uint8Array): Record<Exclude<Encoding, 'standard'>, string> {
  return {
    java: formatUuid(reorder(bytes, 'java')),
    csharp: formatUuid(reorder(bytes, 'csharp')),
    python: formatUuid(reorder(bytes, 'python')),
  }
}
