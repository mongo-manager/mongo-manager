/**
 * Phase 4b §1: a file's metadata (canonical Extended JSON, kept as such for editing) as a person
 * reads it — numbers as numbers, dates as ISO text, ids as their hex; a 64-bit or decimal number as
 * text (no precision lost).
 */
export function readable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readable)
  if (!value || typeof value !== 'object') return value
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1) {
    const key = keys[0]!
    const v = o[key]
    if (key === '$numberInt' || key === '$numberDouble') return Number(v)
    if (key === '$numberLong' || key === '$numberDecimal') return String(v)
    if (key === '$oid') return v
    if (key === '$date') {
      const ms =
        typeof v === 'string'
          ? Date.parse(v)
          : Number((v as { $numberLong?: unknown } | null)?.$numberLong ?? v)
      return Number.isFinite(ms) ? new Date(ms).toISOString() : v
    }
  }
  return Object.fromEntries(keys.map((k) => [k, readable(o[k])]))
}
