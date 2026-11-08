// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { hiddenMatch, type FieldShape } from '../../kit/src/shape'
import type { Language } from '../../kit/src/i18n'
import { DE, ES, FR, JA, KO, PT, RU, ZH } from '../../mock-data/src/data/extra'
import { EN, TR, type Lists } from '../../mock-data/src/data/lists'
import { namedTemplate, templateFor } from '../../mock-data/src/plan'
import { rand } from '../../mock-data/src/prng'
import { templateOf } from '../../mock-data/src/templates'
import { hmacSha256, toHex } from './hash'

/**
 * Plugins wave 4 (spec §1): an anonymised copy of a collection's documents (canonical Extended
 * JSON), field by field — kept, faked by kind (the mock-data plugin's templates: an e-mail stays an
 * e-mail), hashed consistently (HMAC-SHA256 with a salt drawn for the run, never saved), shuffled
 * between the documents, a date shifted by the same days in a document, a number given noise, set
 * null, removed or masked. A field hidden from the user is never kept: the plugin never had its
 * value, and what it writes in its place is never "derived" from the mask.
 */
type Doc = Record<string, unknown>

export const TECHNIQUES = [
  'keep',
  'fake',
  'hash',
  'shuffle',
  'shift',
  'noise',
  'null',
  'remove',
  'mask',
] as const
export type Technique = (typeof TECHNIQUES)[number]
/** What a hidden field may become. */
export const HIDDEN_TECHNIQUES: readonly Technique[] = ['mask', 'fake', 'null', 'remove']
/** The fake kinds offered; `auto` is the field's own, by its name and type. */
export const FAKE_KINDS = [
  'auto',
  'fullName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'username',
  'streetAddress',
  'city',
  'postalCode',
  'country',
  'companyName',
  'sentence',
  'word',
  'uuidString',
  'objectId',
  'pastDate',
  'int',
] as const
export type FakeKind = (typeof FAKE_KINDS)[number]
export const MAX_DAYS = 3650
/** What an _id may become: still one value per document, never null nor a number made noisy. */
export const ID_TECHNIQUES: readonly Technique[] = ['keep', 'hash', 'fake', 'shuffle', 'remove']
/** The fake kinds that keep an _id unique. */
export const ID_KINDS: readonly FakeKind[] = ['auto', 'objectId', 'uuidString']

export interface FieldPlan {
  /** As shown: `contacts[].phone`. */
  path: string
  /** The keys, arrays left out. */
  segments: string[]
  hidden: boolean
  /** The types sampled, most common first (none for a hidden field). */
  types: string[]
  technique: Technique
  kind: FakeKind
  days: number
  percent: number
  /**
   * A field holding other fields in some documents and a value in others (final review I3): this plan
   * is for its values; its fields have their own.
   */
  scalarOnly?: true
}
export type Unseen = 'remove' | 'keep'
export interface Options {
  seed: number
  /** The consistent hash's key: drawn for the run, never saved. */
  salt: Uint8Array
  hidden: readonly (readonly string[])[]
  /** Fields no plan names (not in the sample). */
  unseen: Unseen
  /** The language of the fake values: that language's lists, English where there are none. */
  lang: Language
  now: number
}

/**
 * The word lists the fake values come from, per language (the mock-data plugin's own lists). A
 * language of the app has its list (the kit's languageOf turns anything else into English).
 */
const LISTS = {
  en: EN,
  tr: TR,
  zh: ZH,
  ja: JA,
  es: ES,
  pt: PT,
  ko: KO,
  de: DE,
  fr: FR,
  ru: RU,
} satisfies Record<Language, Lists>
export const listsFor = (lang: Language): Lists => LISTS[lang]

/** Templates whose fields name a person, a place one lives or an account: replaced by default. */
const PERSONAL = new Set([
  'email',
  'firstName',
  'lastName',
  'fullName',
  'username',
  'phone',
  'streetAddress',
  'street',
  'postalCode',
  'ipv4',
  'birthDate',
  'password',
  'iban',
  'latitude',
  'longitude',
  'geoPoint',
  'avatarUrl',
])

/** The fields a plan is made for: each field of the sample but one holding others (its fields are). */
export function plansOf(shape: readonly FieldShape[]): FieldPlan[] {
  const containers = new Set<string>()
  for (const f of shape) {
    const cut = Math.max(f.path.lastIndexOf('.'), -1)
    if (cut < 0) continue
    // `a.b` and `a[].b` both make `a` a container.
    const parent = f.path.slice(0, cut).replace(/\[\]$/, '')
    containers.add(parent)
    for (let i = parent.indexOf('.'); i >= 0; i = parent.indexOf('.', i + 1))
      containers.add(parent.slice(0, i).replace(/\[\]$/, ''))
  }
  // A container sampled with values too gets a plan for those values (final review I3).
  const holdsValues = (f: FieldShape) => f.types.some((x) => x.type !== 'object' && x.type !== 'array')
  return shape
    .filter((f) => f.hidden || !containers.has(f.path) || holdsValues(f))
    .map((f) => {
      const named = f.hidden ? null : namedTemplate(f.path)
      const technique: Technique = f.hidden
        ? 'mask'
        : f.path !== '_id' && named && PERSONAL.has(named)
          ? 'fake'
          : 'keep'
      return {
        path: f.path,
        segments: f.segments,
        hidden: f.hidden,
        types: f.types.map((t) => t.type),
        technique,
        kind: 'auto' as const,
        days: 30,
        percent: 10,
        ...(!f.hidden && containers.has(f.path) ? { scalarOnly: true as const } : {}),
      }
    })
}

/** A seed for one document and one field, from the run's. */
const seedFor = (seed: number, a: number, b: number): number => {
  let h =
    Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 1, 0xc2b2ae35) ^ Math.imul(b + 7, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  return (h ^ (h >>> 12)) >>> 0
}

const isPlain = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v: unknown, key: string): v is Doc => isPlain(v) && Object.keys(v).length === 1 && key in v
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const DAY = 86_400_000

/** Each place a path reaches in a document, through arrays: its holder and its key. */
function placesOf(doc: Doc, segments: readonly string[]): Array<{ holder: Doc; key: string }> {
  const out: Array<{ holder: Doc; key: string }> = []
  const walk = (node: unknown, i: number) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, i))
    if (!isPlain(node)) return
    const key = segments[i]!
    if (!Object.hasOwn(node, key)) return
    if (i === segments.length - 1) out.push({ holder: node, key })
    else walk(node[key], i + 1)
  }
  walk(doc, 0)
  return out
}

function hashOf(value: unknown, salt: Uint8Array): unknown {
  const digest = hmacSha256(salt, new TextEncoder().encode(JSON.stringify(value) ?? 'undefined'))
  const hex = toHex(digest)
  const n48 = Number.parseInt(hex.slice(0, 12), 16)
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'boolean') return (digest[0]! & 1) === 1
  if (typeof value === 'number') return n48
  if (typeof value === 'string')
    return value.includes('@') ? `${hex.slice(0, 12)}@example.com` : hex.slice(0, 16)
  if (only(value, '$numberInt'))
    return { $numberInt: String(Number.parseInt(hex.slice(0, 8), 16) % 2147483647) }
  if (only(value, '$numberLong')) return { $numberLong: String(n48) }
  if (only(value, '$numberDouble')) return { $numberDouble: String(n48) }
  if (only(value, '$numberDecimal')) return { $numberDecimal: String(n48) }
  if (only(value, '$oid')) return { $oid: hex.slice(0, 24) }
  if (only(value, '$date')) return { $date: { $numberLong: String(n48 % (60 * 365 * DAY)) } }
  if (only(value, '$uuid')) {
    const h = hex.slice(0, 32)
    return {
      $uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    }
  }
  if (only(value, '$binary') && isPlain(value.$binary)) {
    const bytes = String.fromCharCode(...digest.slice(0, 16))
    return { $binary: { base64: btoa(bytes), subType: String(value.$binary.subType ?? '00') } }
  }
  return hex.slice(0, 16)
}

function shifted(value: unknown, offset: number): unknown {
  if (only(value, '$date')) {
    const inner = value.$date
    if (only(inner, '$numberLong'))
      return { $date: { $numberLong: String(Number(inner.$numberLong) + offset) } }
    if (typeof inner === 'string' && !Number.isNaN(Date.parse(inner)))
      return { $date: new Date(Date.parse(inner) + offset).toISOString() }
    return value
  }
  if (typeof value === 'string') {
    if (DATE_ONLY.test(value)) {
      const at = Date.parse(`${value}T00:00:00Z`)
      return Number.isNaN(at) ? value : new Date(at + offset).toISOString().slice(0, 10)
    }
    if (DATE_TIME.test(value)) {
      const at = Date.parse(value)
      if (Number.isNaN(at)) return value
      const iso = new Date(at + offset).toISOString()
      return value.includes('.') ? iso : iso.replace(/\.\d{3}Z$/, 'Z')
    }
  }
  return value
}

function noisy(value: unknown, factor: number): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? Math.round(value * factor) : value * factor
  if (only(value, '$numberInt'))
    return {
      $numberInt: String(
        Math.max(-2147483648, Math.min(2147483647, Math.round(Number(value.$numberInt) * factor))),
      ),
    }
  if (only(value, '$numberLong'))
    return { $numberLong: String(Math.round(Number(value.$numberLong) * factor)) }
  if (only(value, '$numberDouble')) {
    const n = Number(value.$numberDouble)
    return Number.isFinite(n) ? { $numberDouble: String(n * factor) } : value
  }
  if (only(value, '$numberDecimal')) {
    const raw = String(value.$numberDecimal)
    const n = Number(raw)
    if (!Number.isFinite(n)) return value
    const places = raw.includes('.') ? raw.split('.')[1]!.replace(/[eE].*$/, '').length : 0
    return { $numberDecimal: (n * factor).toFixed(Math.min(places, 20)) }
  }
  return value
}

const isId = (plan: FieldPlan) => plan.segments.length === 1 && plan.segments[0] === '_id'
const effective = (plan: FieldPlan, hidden: Options['hidden']): Technique => {
  const isHidden = plan.hidden || hiddenMatch(hidden, plan.segments)
  if (isHidden && !HIDDEN_TECHNIQUES.includes(plan.technique)) return 'mask'
  // Final review Minor 11: an _id the import would refuse is never made.
  if (isId(plan) && !ID_TECHNIQUES.includes(plan.technique)) return 'keep'
  return plan.technique
}
/** A value a scalar-only plan leaves to its fields' plans. */
const holdsFields = (v: unknown) => isPlain(v) || (Array.isArray(v) && v.some(isPlain))

/** Leaves out what no plan names (and is not on the way to one). */
function removeUnseen(doc: Doc, plans: readonly FieldPlan[]): void {
  // Each key: whether a plan is for its value (`whole`: the value as it is, whatever it holds), and
  // the keys under it other plans name (final review I3, Minor 9).
  interface Node {
    whole: boolean
    values: boolean
    children: Map<string, Node>
  }
  const node = (): Node => ({ whole: false, values: false, children: new Map() })
  const tree = node()
  for (const p of plans) {
    let at = tree
    for (const key of p.segments) {
      let next = at.children.get(key)
      if (!next) at.children.set(key, (next = node()))
      at = next
    }
    if (p.scalarOnly) at.values = true
    else at.whole = true
  }
  /** Whether a value at `at` is kept; what it holds that no plan names is left out. */
  const keep = (value: unknown, at: Node): boolean => {
    if (at.whole) return true
    if (Array.isArray(value)) {
      if (!value.some(isPlain)) return at.values
      // Values among an array's documents no plan is for: left out.
      const kept = value.filter((v) => (isPlain(v) ? (prune(v, at), true) : at.values))
      value.splice(0, value.length, ...kept)
      return true
    }
    if (isPlain(value)) {
      prune(value, at)
      return true
    }
    return at.values
  }
  const prune = (value: Doc, at: Node) => {
    for (const key of Object.keys(value)) {
      const child = at.children.get(key)
      if (!child || !keep(value[key], child)) delete value[key]
    }
  }
  prune(doc, tree)
}

/** Whatever a rule hides and no plan replaced: masked, wherever it is. */
function maskHidden(doc: Doc, plans: readonly FieldPlan[], hidden: Options['hidden']): void {
  if (!hidden.length) return
  const handled = new Set(
    plans.filter((p) => HIDDEN_TECHNIQUES.includes(p.technique)).map((p) => p.segments.join('\u0000')),
  )
  const walk = (value: unknown, segments: string[]) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, segments))
    if (!isPlain(value)) return
    for (const key of Object.keys(value)) {
      const at = [...segments, key]
      if (hiddenMatch(hidden, at)) {
        if (!handled.has(at.join('\u0000'))) value[key] = '***'
      } else walk(value[key], at)
    }
  }
  walk(doc, [])
}

/** The documents, anonymised (changed in place, and returned). */
export function anonymise(docs: Doc[], plans: readonly FieldPlan[], o: Options): Doc[] {
  const lists = listsFor(o.lang)
  if (o.unseen === 'remove') for (const d of docs) removeUnseen(d, plans)
  plans.forEach((plan, f) => {
    const technique = effective(plan, o.hidden)
    if (technique === 'keep') return
    if (technique === 'shuffle') {
      const places = docs
        .flatMap((d) => placesOf(d, plan.segments))
        .filter((p) => !plan.scalarOnly || !holdsFields(p.holder[p.key]))
      const values = places.map((p) => p.holder[p.key])
      const r = rand(seedFor(o.seed, -1, f))
      for (let i = values.length - 1; i > 0; i--) {
        const j = r.int(0, i)
        ;[values[i], values[j]] = [values[j], values[i]]
      }
      places.forEach((p, i) => (p.holder[p.key] = values[i]))
      return
    }
    const template =
      technique === 'fake'
        ? templateOf(
            plan.kind === 'auto'
              ? templateFor({
                  path: plan.path,
                  types: plan.types.map((type) => ({ type, count: 1 })),
                  hidden: plan.hidden,
                })
              : plan.kind,
          )
        : undefined
    docs.forEach((doc, d) => {
      const r = rand(seedFor(o.seed, d, f))
      // The same shift for every date of a document (spec §1).
      const offset = rand(seedFor(o.seed, d, -2)).int(-plan.days, plan.days) * DAY
      for (const { holder, key } of placesOf(doc, plan.segments)) {
        const value = holder[key]
        if (plan.scalarOnly && holdsFields(value)) continue
        const each = (fn: (v: unknown) => unknown) => (Array.isArray(value) ? value.map(fn) : fn(value))
        const fake = () => (template ? template.make({ r, lists, index: d, now: o.now }) : '***')
        switch (technique) {
          case 'fake': {
            // Final review Minor 11: a list of values faked value by value, unless the kind is a list.
            const one = fake()
            holder[key] =
              Array.isArray(value) && !Array.isArray(one) ? value.map((_, i) => (i ? fake() : one)) : one
            break
          }
          case 'hash':
            holder[key] = each((v) => hashOf(v, o.salt))
            break
          case 'shift':
            holder[key] = each((v) => shifted(v, offset))
            break
          case 'noise':
            holder[key] = each((v) => noisy(v, 1 + (r.next() * 2 - 1) * (plan.percent / 100)))
            break
          case 'null':
            holder[key] = null
            break
          case 'remove':
            delete holder[key]
            break
          case 'mask':
            holder[key] = '***'
            break
        }
      }
    })
  })
  for (const d of docs) maskHidden(d, plans, o.hidden)
  return docs
}

/** The run's settings as a file: each field's technique, never the salt nor a value. */
export function settingsText(plans: readonly FieldPlan[], unseen: Unseen): string {
  return JSON.stringify(
    {
      anonymiser: 1,
      unseen,
      fields: plans.map((p) => ({
        path: p.path,
        technique: p.technique,
        ...(p.technique === 'fake' ? { kind: p.kind } : {}),
        ...(p.technique === 'shift' ? { days: p.days } : {}),
        ...(p.technique === 'noise' ? { percent: p.percent } : {}),
      })),
    },
    null,
    2,
  )
}

/** Settings saved before, applied to this collection's fields (a field not here is counted, not kept). */
export function loadSettings(
  text: string,
  current: readonly FieldPlan[],
): { ok: true; plans: FieldPlan[]; unseen: Unseen; unknown: number } | { ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (
    !isPlain(parsed) ||
    parsed.anonymiser !== 1 ||
    !Array.isArray(parsed.fields) ||
    parsed.fields.length > 2000
  )
    return { ok: false }
  const unseen = parsed.unseen === undefined ? 'remove' : parsed.unseen
  if (unseen !== 'remove' && unseen !== 'keep') return { ok: false }
  const plans = current.map((p) => ({ ...p }))
  let unknown = 0
  for (const f of parsed.fields as unknown[]) {
    if (!isPlain(f) || typeof f.path !== 'string' || !TECHNIQUES.includes(f.technique as Technique))
      return { ok: false }
    const technique = f.technique as Technique
    if (f.kind !== undefined && !FAKE_KINDS.includes(f.kind as FakeKind)) return { ok: false }
    if (
      f.days !== undefined &&
      (!Number.isInteger(f.days) || (f.days as number) < 1 || (f.days as number) > MAX_DAYS)
    )
      return { ok: false }
    if (f.percent !== undefined && (typeof f.percent !== 'number' || !(f.percent > 0) || f.percent > 100))
      return { ok: false }
    const plan = plans.find((p) => p.path === f.path)
    if (!plan) {
      unknown++
      continue
    }
    plan.technique =
      plan.hidden && !HIDDEN_TECHNIQUES.includes(technique)
        ? 'mask'
        : isId(plan) && !ID_TECHNIQUES.includes(technique)
          ? 'keep'
          : technique
    if (f.kind !== undefined) plan.kind = f.kind as FakeKind
    if (f.days !== undefined) plan.days = f.days as number
    if (f.percent !== undefined) plan.percent = f.percent as number
  }
  return { ok: true, plans, unseen, unknown }
}
