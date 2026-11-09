// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3d-3b spec §3: which addresses a destination may reach. Every form an address can take is
 * judged — an IPv4 address inside IPv6 (mapped, compatible, NAT64) is judged as the IPv4 address.
 */
export interface Net {
  bytes: Uint8Array
  prefix: number
}

export type AddressVerdict =
  | { ok: true; allowedNetwork: boolean }
  | { ok: false; reason: 'metadata' | 'link_local' | 'loopback' | 'private' | 'reserved' }

function parseV4(text: string): Uint8Array | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i]!)) return null
    const n = Number(parts[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseV6(text: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.split('::').length > 2) return null
  let head = text
  let v4: Uint8Array | null = null
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.')) {
    v4 = parseV4(text.slice(lastColon + 1))
    if (!v4) return null
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [left, right] = head.includes('::') ? head.split('::') : [head, null]
  const groups = (s: string) => (s === '' ? [] : s.split(':'))
  const l = groups(left!)
  const r = right === null || right === undefined ? [] : groups(right)
  const missing = 8 - l.length - r.length
  const compressed = right !== null && right !== undefined
  if (compressed ? missing < 1 : missing !== 0) return null
  const all = [...l, ...Array<string>(compressed ? missing : 0).fill('0'), ...r]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i]!)) return null
    const n = parseInt(all[i]!, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  if (v4) out.set(v4, 12)
  return out
}

/** 4 bytes for IPv4, 16 for IPv6; null for anything else (zone ids included: they name an interface). */
export function ipBytes(address: string): Uint8Array | null {
  if (address.includes('%')) return null
  return address.includes(':') ? parseV6(address) : parseV4(address)
}

const startsWith = (b: Uint8Array, prefix: number[]) => prefix.every((x, i) => b[i] === x)
const zeros = (n: number) => Array<number>(n).fill(0)

/**
 * The IPv4 address carried by ::ffff:0:0/96 (mapped), ::ffff:0:0:0/96 (translated, phase 3d-3b final
 * review), ::/96 (not :: and ::1) or 64:ff9b::/96.
 */
export function embeddedIPv4(b: Uint8Array): Uint8Array | null {
  if (b.length !== 16) return null
  const tail = b.slice(12)
  if (startsWith(b, [...zeros(10), 0xff, 0xff])) return tail
  if (startsWith(b, [...zeros(8), 0xff, 0xff, 0, 0])) return tail
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, ...zeros(8)])) return tail
  if (startsWith(b, zeros(12)) && (tail[0] !== 0 || tail[1] !== 0 || tail[2] !== 0 || tail[3]! > 1))
    return tail
  return null
}

export function parseCidr(text: string): Net {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(text.trim())
  const bytes = m ? ipBytes(m[1]!) : null
  const prefix = m ? Number(m[2]) : NaN
  if (!bytes || !(prefix >= 0 && prefix <= bytes.length * 8))
    throw new Error(`${text} is not a CIDR (address/prefix)`)
  return { bytes, prefix }
}

export function inNet(address: Uint8Array, net: Net): boolean {
  if (address.length !== net.bytes.length) return false
  let bits = net.prefix
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if ((address[i]! & mask) !== (net.bytes[i]! & mask)) return false
  }
  return true
}

const nets = (list: string[]) => list.map(parseCidr)
/** Spec §3: never reachable, whatever the configuration says. */
export const NEVER_ALLOWED = [
  '169.254.0.0/16',
  'fe80::/10',
  '169.254.169.254/32',
  'fd00:ec2::254/128',
  '100.100.100.200/32',
]
const METADATA = nets(['169.254.169.254/32', 'fd00:ec2::254/128', '100.100.100.200/32'])
const LINK_LOCAL = nets(['169.254.0.0/16', 'fe80::/10'])
const LOOPBACK = nets(['127.0.0.0/8', '::1/128'])
const PRIVATE = nets(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', '100.64.0.0/10'])
const RESERVED = nets([
  '0.0.0.0/8',
  '::/128',
  '224.0.0.0/4',
  'ff00::/8',
  '240.0.0.0/4',
  '255.255.255.255/32',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '2001:db8::/32',
  '100::/64',
  '2001::/32',
  '2002::/16',
  '64:ff9b:1::/48',
  // Phase 3d-3b final review: IPv4-translated (SIIT) and the deprecated site-local range.
  '::ffff:0:0:0/96',
  'fec0::/10',
])
const any = (list: Net[], b: Uint8Array) => list.some((n) => inNet(b, n))

export function classifyAddress(address: string, allowed: readonly Net[]): AddressVerdict {
  const raw = ipBytes(address)
  if (!raw) return { ok: false, reason: 'reserved' }
  const v4 = raw.length === 16 ? embeddedIPv4(raw) : null
  const forms = v4 ? [raw, v4] : [raw]
  if (forms.some((f) => any(METADATA, f))) return { ok: false, reason: 'metadata' }
  if (forms.some((f) => any(LINK_LOCAL, f))) return { ok: false, reason: 'link_local' }
  const listed = forms.some((f) => allowed.some((n) => inNet(f, n)))
  // The embedded IPv4 decides: ::ffff:10.0.0.1 is private even though ::ffff:0:0/96 is not listed.
  const judged = v4 ?? raw
  const special = any(LOOPBACK, judged)
    ? 'loopback'
    : any(PRIVATE, judged)
      ? 'private'
      : any(RESERVED, judged) || any(RESERVED, raw)
        ? 'reserved'
        : null
  if (listed) return { ok: true, allowedNetwork: true }
  return special ? { ok: false, reason: special } : { ok: true, allowedNetwork: false }
}

const NEVER = NEVER_ALLOWED.map((text) => ({ text, net: parseCidr(text) }))
/** The ranges MM_BACKUP_PRIVATE_NETWORKS may name (D5): loopback, private, CGNAT, unique-local. */
const PRIVATE_SPACE = [...LOOPBACK, ...PRIVATE]
const within = (inner: Net, outer: Net) =>
  inner.bytes.length === outer.bytes.length && inner.prefix >= outer.prefix && inNet(inner.bytes, outer)

/** An IPv6 range written in an IPv4 form (mapped, translated, compatible, NAT64) as that IPv4 range. */
function asIPv4(net: Net): Net | null {
  if (net.bytes.length !== 16 || net.prefix < 96) return null
  const v4 = embeddedIPv4(net.bytes)
  return v4 ? { bytes: v4, prefix: net.prefix - 96 } : null
}

/** Why a MM_BACKUP_PRIVATE_NETWORKS entry is refused, or null when it is usable. */
export function privateNetworkProblem(text: string): string | null {
  let net: Net
  try {
    net = parseCidr(text)
  } catch {
    return 'not a CIDR (address/prefix)'
  }
  // Phase 3d-3b final review: refused when it lies inside a never-allowed range, in any form. A
  // private range that merely contains such an address (100.64.0.0/10 holds 100.100.100.200) is
  // usable: those addresses are refused before the list is ever consulted.
  const forms = [net, asIPv4(net)].filter((n): n is Net => n !== null)
  for (const f of forms) {
    const never = NEVER.find((n) => within(f, n.net))
    if (never)
      return `it lies inside ${never.text}, a link-local or cloud metadata range that can never be allowed`
  }
  // D5: the setting opens private networks; a public range would turn it into an allow-all.
  if (!forms.some((f) => PRIVATE_SPACE.some((p) => within(f, p))))
    return 'it is not a private network (only loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 and ::1 ranges can be listed)'
  return null
}
