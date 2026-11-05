// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import { ERROR_AND_LOG_SINCE as ERROR_AND_LOG, findServerJs } from '@mongo-manager/shared'
import { nsMaskerFrom, type Pattern } from '../masking/match'
import { assuredLevel, levelAtLeast, levelBelow, olderServer, type ServerLevel } from '../backup/series'

const pick = (from: Document, keys: readonly string[]): Document =>
  Object.fromEntries(keys.filter((k) => Object.hasOwn(from, k)).map((k) => [k, from[k]]))

const SHAPE = [
  'capped',
  'size',
  'max',
  'collation',
  'clusteredIndex',
  'changeStreamPreAndPostImages',
] as const
const TIMESERIES = [
  'timeField',
  'metaField',
  'granularity',
  'bucketMaxSpanSeconds',
  'bucketRoundingSeconds',
] as const
const VALIDATION = ['validator', 'validationLevel', 'validationAction'] as const

/**
 * MongoDB 9.0 (local run, 2026-10-20; review of db45c424), found on 9.0.4, 8.3.13, 8.2.6, 8.0.34,
 * 7.0.45 and 6.0.29: 9.0 lists `fixedBucketing` on every series, and 8.3 on build 2dsphere indexes
 * at version 4; neither is taken below those feature levels. A series' own bucketing
 * (`bucketRoundingSeconds`) needs 6.3, and without it 6.0 refuses its `bucketMaxSpanSeconds` too.
 */
const FIXED_BUCKETING_SINCE = [9, 0] as const
const OWN_BUCKETING_SINCE = [6, 3] as const
const GEO_VERSION_4_SINCE = [8, 3] as const
/** Review of 69adc29a (I-4): below 8.1 a create with it is refused ("Enumeration value 'errorAndLog'"). */
const ERROR_AND_LOG_SINCE = ERROR_AND_LOG.split('.').map(Number) as [number, number]
/** Review of 69adc29a (M-3): 6.0 refuses one ("wildcard indexes do not allow compounding"). */
const COMPOUND_WILDCARD_SINCE = [7, 0] as const
const GEO_VERSION = '2dsphereIndexVersion'
/** A number as listIndexes gives it, or as an archive's canonical EJSON does (an Int32); else NaN. */
const numberOf = (v: unknown): number =>
  typeof v === 'number'
    ? v
    : v !== null && typeof v === 'object' && typeof (v as { valueOf(): unknown }).valueOf() === 'number'
      ? (v as { valueOf(): number }).valueOf()
      : Number.NaN

/**
 * What mongorestore, which passes a namespace's options and indexes as the archive has them, would
 * give `target` that it may refuse: series options outside the allowlist it may not take (any, from
 * a newer server than it), and, when indexes are restored, 2dsphere indexes of a later version.
 */
export function optionsTargetMayRefuse(
  meta: { options: Document; indexes: Document[] },
  target: ServerLevel | null,
  sourceVersion: string | null,
  indexes: boolean,
): string[] {
  const level = assuredLevel(target)
  const out: string[] = []
  const ts = meta.options?.timeseries as Document | null | undefined
  if (ts && typeof ts === 'object')
    for (const k of Object.keys(ts)) {
      if (k === 'fixedBucketing') {
        if (!levelAtLeast(level, ...FIXED_BUCKETING_SINCE)) out.push(k)
      } else if (k === 'bucketRoundingSeconds') {
        if (!levelAtLeast(level, ...OWN_BUCKETING_SINCE)) out.push(k)
      } else if (!(TIMESERIES as readonly string[]).includes(k)) {
        // An option no release here knows: refused unless the target is as new as its source.
        const source = sourceVersion && /^(\d+)\.(\d+)/.exec(sourceVersion)
        const sure = level ? `${level[0]}.${level[1]}.0` : null
        if (!source || !sure || olderServer(sure, sourceVersion)) out.push(k)
      }
    }
  if (meta.options?.validationAction === 'errorAndLog' && !levelAtLeast(level, ...ERROR_AND_LOG_SINCE))
    out.push('validationAction errorAndLog')
  if (indexes && !levelAtLeast(level, ...COMPOUND_WILDCARD_SINCE))
    for (const ix of meta.indexes ?? []) {
      const fields = ix.key && typeof ix.key === 'object' ? Object.keys(ix.key as Document) : []
      if (fields.length > 1 && fields.some((f) => f === '$**' || f.endsWith('.$**')))
        out.push(`compound wildcard index ${String(ix.name ?? '')}`)
    }
  if (indexes && !levelAtLeast(level, ...GEO_VERSION_4_SINCE))
    for (const ix of meta.indexes ?? [])
      if (numberOf(ix[GEO_VERSION]) > 3) out.push(`${GEO_VERSION} ${numberOf(ix[GEO_VERSION])}`)
  return [...new Set(out)]
}

/**
 * Review of 69adc29a (I-3): whether buckets made with `ours` may be written into an existing series
 * with `theirs`: the same granularity, or the same own span and rounding. Otherwise a query by time
 * misses them (seen on 8.2.6: a span of 86400 written into one of 3600).
 */
export function sameBucketing(theirs: Document, ours: Document): boolean {
  const own = (s: Document) => s.bucketRoundingSeconds !== undefined
  if (own(theirs) || own(ours)) {
    if (!own(theirs) || !own(ours)) return false
    if (numberOf(theirs.bucketRoundingSeconds) !== numberOf(ours.bucketRoundingSeconds)) return false
    if (numberOf(theirs.bucketMaxSpanSeconds) !== numberOf(ours.bucketMaxSpanSeconds)) return false
  } else {
    if ((theirs.granularity ?? 'seconds') !== (ours.granularity ?? 'seconds')) return false
    if (
      theirs.bucketMaxSpanSeconds !== undefined &&
      ours.bucketMaxSpanSeconds !== undefined &&
      numberOf(theirs.bucketMaxSpanSeconds) !== numberOf(ours.bucketMaxSpanSeconds)
    )
      return false
  }
  return true
}

export interface SourceCollection {
  name: string
  type: string
  options: Document
}

/**
 * Phase 3d-2 spec §7.3: a new collection's options from an allowlist of listCollections options.
 * Encrypted collections are not copied; a validator that runs JavaScript is refused unless the
 * server allows server-side JavaScript (a hostile source must not plant code in the target).
 */
export function createOptions(
  info: SourceCollection,
  want: { options: boolean; validator: boolean },
  allowServerJs: boolean,
  /** Review of db45c424: the target's feature level; null when unknown (taken as the least). */
  target: ServerLevel | null = null,
): { options: Document } | { skip: string } {
  const o = info.options ?? {}
  if (o.encryptedFields) return { skip: 'Encrypted (Queryable Encryption) collections are not copied' }
  const out: Document = {}
  if (want.options) {
    Object.assign(out, pick(o, SHAPE))
    if (o.timeseries) {
      const ts = o.timeseries as Document
      // A series made as it was, or not at all: without its rounding, buckets would be read by
      // another span than they were made with.
      if (ts.bucketRoundingSeconds !== undefined && levelBelow(target, ...OWN_BUCKETING_SINCE))
        return { skip: 'Its own bucketing (bucketRoundingSeconds) needs MongoDB 6.3 or later on the target' }
      out.timeseries = pick(ts, TIMESERIES)
      // Given only where the target is sure to take it: a feature level below 9.0 refuses it, true
      // or false, and no wrong answer came of leaving it out (reviews of 8e719ba7, I-2, and of
      // d7ddbaae: 8.0.34, 8.2.6 and 9.0.4, up to twelve query shapes over a changed series' buckets).
      if (
        typeof ts.fixedBucketing === 'boolean' &&
        levelAtLeast(assuredLevel(target), ...FIXED_BUCKETING_SINCE)
      )
        out.timeseries.fixedBucketing = ts.fixedBucketing
      if (o.expireAfterSeconds !== undefined) out.expireAfterSeconds = o.expireAfterSeconds
    } else if (o.clusteredIndex && o.expireAfterSeconds !== undefined)
      out.expireAfterSeconds = o.expireAfterSeconds
    if (out.clusteredIndex)
      out.clusteredIndex = pick(out.clusteredIndex as Document, ['key', 'unique', 'name'])
  }
  if (want.validator) {
    const validation = pick(o, VALIDATION)
    const js = validation.validator ? findServerJs(validation.validator) : null
    if (js && !allowServerJs) return { skip: `The validator uses ${js}, which runs JavaScript on the server` }
    if (validation.validationAction === 'errorAndLog' && levelBelow(target, ...ERROR_AND_LOG_SINCE))
      return {
        skip: 'Its validation action errorAndLog needs MongoDB 8.1 or later on the target: leave its validator out to write it without one',
      }
    Object.assign(out, validation)
  }
  return { options: out }
}

const INDEX_OPTIONS = [
  'key',
  'name',
  'unique',
  'sparse',
  'partialFilterExpression',
  'expireAfterSeconds',
  'collation',
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',
  '2dsphereIndexVersion',
  'bits',
  'min',
  'max',
  'wildcardProjection',
  'hidden',
] as const
const KINDS = new Set(['2d', '2dsphere', 'text', 'hashed'])

/** 1, -1, another non-zero number (a numeric BSON wrapper too), or an index type name. */
const validDirection = (dir: unknown): boolean => {
  if (typeof dir === 'string') return KINDS.has(dir)
  const n =
    typeof dir === 'number'
      ? dir
      : dir !== null && typeof dir === 'object'
        ? Number((dir as { valueOf(): unknown }).valueOf())
        : Number.NaN
  return Number.isFinite(n) && n !== 0
}

const validKey = (key: unknown): key is Document =>
  key !== null &&
  typeof key === 'object' &&
  !Array.isArray(key) &&
  Object.keys(key).length > 0 &&
  Object.keys(key).length <= 32 &&
  Object.entries(key as Document).every(
    ([field, dir]) => field !== '' && !field.includes('\0') && validDirection(dir),
  )

export interface IndexPlan {
  build: Document[]
  skipped: Array<{ name: string; reason: string }>
  ttl: string[]
}

/**
 * Indexes to build on the target, from an allowlist of listIndexes options (v, ns and background
 * are dropped; _id_ exists already). `personalUnique` says which unique indexes an anonymous or
 * masked copy cannot build (every value would be "***").
 */
export function indexPlan(
  indexes: Document[],
  personalUnique: (key: Document, partial: unknown) => boolean,
  /**
   * Review of db45c424: the target's feature level, where indexes are built (null: unknown); left
   * out (a backup), an index keeps what the server listed.
   */
  target?: ServerLevel | null,
): IndexPlan {
  const plan: IndexPlan = { build: [], skipped: [], ttl: [] }
  for (const index of indexes) {
    const name = String(index.name ?? '')
    if (name === '_id_') continue
    if (!validKey(index.key)) {
      plan.skipped.push({ name, reason: 'Its key is not a valid index key' })
      continue
    }
    if (index.unique === true && personalUnique(index.key, index.partialFilterExpression)) {
      plan.skipped.push({ name, reason: 'A unique index over personal data cannot hold masked values' })
      continue
    }
    const spec = pick(index, INDEX_OPTIONS)
    // A 2dsphere index of a version the target may not have is built at the target's own.
    if (
      target !== undefined &&
      numberOf(spec[GEO_VERSION]) > 3 &&
      !levelAtLeast(assuredLevel(target), ...GEO_VERSION_4_SINCE)
    )
      delete spec[GEO_VERSION]
    plan.build.push(spec)
    if (index.expireAfterSeconds !== undefined) plan.ttl.push(name)
  }
  return plan
}

/**
 * Phase 3e-2: a unique index whose key, or partial filter, reaches a masked path cannot hold masked
 * values ("***" everywhere). Wildcard rules count: `**.email` reaches `contact.email`; a key above a
 * masked path (`contact` over `contact.email`) reaches it too.
 */
export function uniqueOverMask(index: Document, mask: readonly Pattern[] | null): boolean {
  if (!mask || mask.length === 0 || index.unique !== true) return false
  const ns = nsMaskerFrom(mask)
  const paths = [
    ...Object.keys((index.key ?? {}) as Document),
    ...Object.keys((index.partialFilterExpression ?? {}) as Document).filter((k) => !k.startsWith('$')),
  ]
  return paths.some((k) => {
    const path = k.split('.')
    return ns.matches(path) || ns.under(path)
  })
}

export interface ViewDef {
  name: string
  viewOn: string
  pipeline: Document[]
}

/** Collection names a pipeline reads ($lookup, $graphLookup, $unionWith), at any depth. */
function reads(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) reads(v, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [k, v] of Object.entries(value as Document)) {
    if ((k === '$lookup' || k === '$graphLookup') && v && typeof v === 'object') {
      const from = (v as Document).from
      if (typeof from === 'string') out.add(from)
    }
    if (k === '$unionWith') {
      if (typeof v === 'string') out.add(v)
      else if (v && typeof v === 'object' && typeof (v as Document).coll === 'string')
        out.add((v as Document).coll as string)
    }
    reads(v, out)
  }
}

/** Views after the views they read (spec §7.3); a cycle cannot be created and is reported. */
export function viewOrder(views: ViewDef[]): { ordered: ViewDef[]; cyclic: string[] } {
  const names = new Set(views.map((v) => v.name))
  const deps = new Map<string, Set<string>>()
  for (const v of views) {
    const d = new Set<string>([v.viewOn])
    reads(v.pipeline, d)
    deps.set(v.name, new Set([...d].filter((n) => names.has(n) && n !== v.name)))
  }
  const ordered: ViewDef[] = []
  const done = new Set<string>()
  let progress = true
  while (progress) {
    progress = false
    for (const v of views) {
      if (done.has(v.name)) continue
      if ([...deps.get(v.name)!].every((d) => done.has(d))) {
        ordered.push(v)
        done.add(v.name)
        progress = true
      }
    }
  }
  return { ordered, cyclic: views.filter((v) => !done.has(v.name)).map((v) => v.name) }
}
