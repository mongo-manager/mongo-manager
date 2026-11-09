// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'
import { bsonKind } from './bson-kind'
import { fieldsOf } from '../masking/gate/values'

/**
 * Phase 3d-2 spec §6.2: MongoDB's BSON comparison order, as the server sorts _id with the simple
 * collation. The ranks are the server's canonical types; numbers compare by exact value across
 * Int32, Long, Double and Decimal128; strings by their UTF-8 bytes. A merge join of two _id-sorted
 * streams is only correct if this agrees with the server everywhere (a property test checks it).
 */
const unorderable = (what: string) =>
  Errors.conflict(`A ${what} _id cannot be put in order; these collections cannot be compared`, {
    reason: 'id_order',
  })

const utf8 = (s: string) => Buffer.from(s, 'utf8')
const bytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const sign = (n: number | bigint) => (n < 0 ? -1 : n > 0 ? 1 : 0)

function rank(v: unknown): number {
  if (v === undefined) return 0
  if (v === null) return 5
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return 10
    case 'string':
      return 15
    case 'boolean':
      return 40
  }
  if (v instanceof Date) return 45
  if (v instanceof RegExp) return 50
  if (Array.isArray(v)) return 25
  switch (bsonKind(v)) {
    case 'MinKey':
      return -1
    case 'Int32':
    case 'Long':
    case 'Double':
    case 'Decimal128':
      return 10
    case 'BSONSymbol':
      return 15
    case 'Binary':
      return 30
    case 'ObjectId':
      return 35
    case 'Timestamp':
      return 47
    case 'BSONRegExp':
      return 50
    case 'DBPointer':
      return 55
    case 'Code':
      return (v as { scope?: unknown }).scope ? 65 : 60
    case 'MaxKey':
      return 100
    case 'DBRef':
    case undefined:
      return 20
  }
  throw unorderable('value of this type as an')
}

/** An exact number: NaN, ±Infinity, or the fraction n/d (d > 0). */
type Exact = { k: 'nan' } | { k: 'inf'; s: 1 | -1 } | { k: 'fin'; n: bigint; d: bigint }

function fromDouble(x: number): Exact {
  if (Number.isNaN(x)) return { k: 'nan' }
  if (!Number.isFinite(x)) return { k: 'inf', s: x > 0 ? 1 : -1 }
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) return { k: 'fin', n: BigInt(x), d: 1n }
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const bits = view.getBigUint64(0)
  const negative = bits >> 63n === 1n
  const exponent = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & ((1n << 52n) - 1n)
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n)
  const e = exponent === 0 ? -1074 : exponent - 1075
  const n = e >= 0 ? mantissa << BigInt(e) : mantissa
  const d = e >= 0 ? 1n : 1n << BigInt(-e)
  return { k: 'fin', n: negative ? -n : n, d }
}

function fromDecimal(text: string): Exact {
  if (/^-?NaN$/i.test(text)) return { k: 'nan' }
  if (/^-?Inf/i.test(text)) return { k: 'inf', s: text.startsWith('-') ? -1 : 1 }
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i.exec(text)
  if (!m) throw unorderable('Decimal128')
  const digits = BigInt(`${m[2]}${m[3] ?? ''}`)
  const exp = Number(m[4] ?? 0) - (m[3]?.length ?? 0)
  const n = exp >= 0 ? digits * 10n ** BigInt(exp) : digits
  const d = exp >= 0 ? 1n : 10n ** BigInt(-exp)
  return { k: 'fin', n: m[1] ? -n : n, d }
}

function exact(v: unknown): Exact {
  if (typeof v === 'number') return fromDouble(v)
  if (typeof v === 'bigint') return { k: 'fin', n: v, d: 1n }
  switch (bsonKind(v)) {
    case 'Int32':
      return { k: 'fin', n: BigInt((v as { value: number }).value), d: 1n }
    case 'Double':
      return fromDouble((v as { value: number }).value)
    case 'Long':
      return { k: 'fin', n: BigInt(String(v)), d: 1n }
    default:
      return fromDecimal(String(v))
  }
}

function compareNumbers(a: unknown, b: unknown): number {
  const x = exact(a)
  const y = exact(b)
  // MongoDB: NaN sorts below every other number and equals itself.
  if (x.k === 'nan' || y.k === 'nan') return x.k === y.k ? 0 : x.k === 'nan' ? -1 : 1
  if (x.k === 'inf' || y.k === 'inf') {
    const xs = x.k === 'inf' ? x.s : 0
    const ys = y.k === 'inf' ? y.s : 0
    if (xs !== ys) return sign(xs - ys)
    if (x.k === 'inf') return 0
  }
  const f = x as { n: bigint; d: bigint }
  const g = y as { n: bigint; d: bigint }
  return sign(f.n * g.d - g.n * f.d)
}

function entries(v: unknown): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x])
  return Object.entries(fieldsOf(v as Record<string, unknown>))
}

function compareObjects(a: unknown, b: unknown): number {
  const x = entries(a)
  const y = entries(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [ka, va] = x[i]!
    const [kb, vb] = y[i]!
    const r = rank(va) - rank(vb)
    if (r !== 0) return sign(r)
    const k = bytes(utf8(ka), utf8(kb))
    if (k !== 0) return k
    const c = compareIds(va, vb)
    if (c !== 0) return c
  }
  return sign(x.length - y.length)
}

const ts = (v: unknown) => {
  const t = v as { t?: number; i?: number; high?: number; low?: number }
  return (BigInt((t.t ?? t.high ?? 0) >>> 0) << 32n) | BigInt((t.i ?? t.low ?? 0) >>> 0)
}

export function compareIds(a: unknown, b: unknown): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return sign(ra - rb)
  switch (ra) {
    case -1:
    case 0:
    case 5:
    case 100:
      return 0
    case 10:
      return compareNumbers(a, b)
    case 15: {
      const s = (v: unknown) => (typeof v === 'string' ? v : String((v as { value: unknown }).value))
      return bytes(utf8(s(a)), utf8(s(b)))
    }
    case 20:
    case 25:
      return compareObjects(a, b)
    case 30: {
      const bin = (v: unknown) => {
        const x = v as { buffer: Uint8Array; position: number; sub_type: number }
        return { data: x.buffer.subarray(0, x.position), sub: x.sub_type }
      }
      const x = bin(a)
      const y = bin(b)
      if (x.data.length !== y.data.length) return sign(x.data.length - y.data.length)
      if (x.sub !== y.sub) return sign(x.sub - y.sub)
      return bytes(x.data, y.data)
    }
    case 35:
      return bytes((a as { id: Uint8Array }).id, (b as { id: Uint8Array }).id)
    case 40:
      return sign(Number(a) - Number(b))
    case 45: {
      const x = (a as Date).getTime()
      const y = (b as Date).getTime()
      if (Number.isNaN(x) || Number.isNaN(y)) throw unorderable('date out of range as an')
      return sign(x - y)
    }
    case 47:
      return sign(ts(a) - ts(b))
    case 50: {
      const re = (v: unknown) =>
        v instanceof RegExp
          ? { p: v.source, f: v.flags }
          : { p: (v as { pattern: string }).pattern, f: (v as { options: string }).options }
      const x = re(a)
      const y = re(b)
      return bytes(utf8(x.p), utf8(y.p)) || bytes(utf8(x.f), utf8(y.f))
    }
    case 60:
    case 65: {
      const code = (v: unknown) => String((v as { code: unknown }).code)
      const c = bytes(utf8(code(a)), utf8(code(b)))
      if (c !== 0 || ra === 60) return c
      return compareObjects((a as { scope: unknown }).scope, (b as { scope: unknown }).scope)
    }
  }
  throw unorderable('DBPointer')
}
