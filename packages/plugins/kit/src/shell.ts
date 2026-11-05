// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 3: a document as the shell writes it (ObjectId('…'), ISODate('…'), plain
 * numbers), for a preview — easier to read than canonical Extended JSON.
 */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

export function shellText(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent + 1)
  const end = '  '.repeat(indent)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return quote(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v))
    return v.length ? `[\n${v.map((x) => `${pad}${shellText(x, indent + 1)}`).join(',\n')}\n${end}]` : '[]'
  if (!isPlain(v)) return String(v)
  if (typeof v.$oid === 'string') return `ObjectId(${quote(v.$oid)})`
  if (isPlain(v.$date) && typeof v.$date.$numberLong === 'string')
    return `ISODate(${quote(new Date(Number(v.$date.$numberLong)).toISOString())})`
  if (typeof v.$numberInt === 'string') return v.$numberInt
  if (typeof v.$numberDouble === 'string') return v.$numberDouble
  if (typeof v.$numberLong === 'string') return `NumberLong(${quote(v.$numberLong)})`
  if (typeof v.$numberDecimal === 'string') return `NumberDecimal(${quote(v.$numberDecimal)})`
  if (isPlain(v.$binary) && v.$binary.subType === '04' && typeof v.$binary.base64 === 'string') {
    const h = [...atob(v.$binary.base64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return `UUID(${quote(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`)})`
  }
  const entries = Object.entries(v)
  if (!entries.length) return '{}'
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k))
  return `{\n${entries.map(([k, x]) => `${pad}${key(k)}: ${shellText(x, indent + 1)}`).join(',\n')}\n${end}}`
}
