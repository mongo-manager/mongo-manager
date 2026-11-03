import { EJSON, calculateObjectSize } from 'bson'
import type { Document, MongoClient } from 'mongodb'
import {
  AI_LIMITS,
  SchemaAnalyser,
  deserializeValue,
  formatShell,
  isWritePipeline,
  ruleSegments,
  serializeValue,
  type AiAction,
  type AiRequest,
  type AiSchemaSummary,
  type AiSent,
  type SchemaAnalysis,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'
import { withMongo } from '../data/mongo-errors'
import { isAdminOnlyNamespace, isDrillScratch } from '../connections/access'
import { isEncryptionMetadata } from '../encryption/fields'
import { compileRules, nsMaskerFrom, type Masker, type NsMasker } from '../masking/match'
import { gateDepsFor, viewAwareMasker } from '../masking/restricted'
import { maskerForPrincipal } from '../masking/request'
import { maskDocument } from '../masking/document'
import { maskAnalysis } from '../masking/schema'
import { maskFindDef, maskPipelineDef, maskValidator } from '../masking/definitions'
import { redactSecrets } from '../masking/secrets'
import {
  MASKING_UNSUPPORTED,
  PERSONAL_FIELD,
  guardAggregate,
  guardFind,
  isOrderRefusal,
} from '../masking/gate'
import { normaliseExplain } from '../explain/normalise'
import { personalPlan } from '../masking/explain'
import { adviceFor } from '../explain/advice'
import type { PlanNode } from '../explain/types'

export interface ContextInput {
  ctx: ServerContext
  principal: Principal
  connectionId: string
  client: MongoClient
  db: string
  coll: string
  request: AiRequest
  comment: string
  signal: AbortSignal
}
/** Phase 4a-2: what a context is built from — a chat turn names its parts instead of an action. */
export type PartsInput = Omit<ContextInput, 'request'> & {
  current?: AiRequest['current']
  samples?: AiRequest['samples']
}
/** What besides the schema summary a context carries. */
export interface ContextWants {
  plan: boolean
  indexes: boolean
  validator: boolean
  /** UI redesign R1 review: the schemas of the collections its id fields refer to. */
  related?: boolean
}
export const wantsFor = (action: AiAction): ContextWants => ({
  plan: action === 'optimise',
  indexes: false,
  validator: action === 'validation',
  related: action === 'query' || action === 'pipeline',
})

/** The whole schema pass, MongoDB and this process together. */
const SCHEMA_MS = 20_000
const MONGO_MS = 10_000

/**
 * Spec §1.3, plan ruling 5: the connection's rules for everyone (the data leaves the server), a
 * view following its source's rules; a namespace that cannot be resolved is masked whole.
 */
export async function aiMasker(
  ctx: ServerContext,
  client: MongoClient,
  connectionId: string,
  db: string,
  coll: string,
): Promise<Masker> {
  const rules = compileRules(ctx.personalFields.get(connectionId).rules)
  return viewAwareMasker(rules, gateDepsFor(rules, client), [[db, coll]])
}

/** Spec §1.3: paths, types and how often each occurs — never values, ranges or histograms. */
export function summarise(a: SchemaAnalysis, count: number | null, maxPaths: number): AiSchemaSummary {
  const kept = a.fields.slice(0, maxPaths)
  return {
    sampled: a.sampled,
    count,
    fields: kept.map((f) => ({
      path: f.path,
      types: { ...(f.types as Record<string, number>) },
      share: a.sampled ? Math.min(1, Math.round((f.count / a.sampled) * 100) / 100) : 0,
      ...(f.masked ? { personal: true as const } : {}),
    })),
    more: a.fields.length - kept.length,
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const relaxed = (v: unknown) => EJSON.stringify(v as Document, { relaxed: true })
const bytes = (s: string) => Buffer.byteLength(s)

/** Elements kept of an array when a sample is cut (final review minor 3). */
const ARRAY_KEEP = 20

/**
 * A value made smaller: deeper than `depth` becomes "…", arrays keep their first elements, long
 * strings their start, and a large BSON value (a binary, code) is replaced whole (final review minor 2).
 */
function prune(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) {
    if (depth <= 0) return '…'
    const kept = v.slice(0, ARRAY_KEEP).map((x) => prune(x, depth - 1))
    return v.length > ARRAY_KEEP ? [...kept, '…'] : kept
  }
  if (isPlain(v))
    return depth <= 0 ? '…' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x, depth - 1)]))
  if (typeof v === 'string' && v.length > 256) return `${v.slice(0, 256)}…`
  if (v && typeof v === 'object' && calculateObjectSize({ v }) > 512) return '…'
  return v
}

/** Spec §1.3: a sample as relaxed Extended JSON within `maxBytes`, deepest fields first, then keys. */
export function cutDocument(doc: unknown, maxBytes: number): string {
  // A document far over the bound is never written out whole (final review minor 3).
  const whole = isPlain(doc) ? calculateObjectSize(doc) : 0
  if (whole <= maxBytes * 4) {
    const text = relaxed(doc)
    if (bytes(text) <= maxBytes) return text
  }
  let text: string
  for (let depth = 6; depth >= 1; depth--) {
    text = relaxed(prune(doc, depth))
    if (bytes(text) <= maxBytes) return text
  }
  const top = prune(doc, 1)
  const out: Record<string, unknown> = {}
  if (isPlain(top))
    for (const [k, v] of Object.entries(top)) {
      out[k] = v
      // A field that does not fit is left out; the next ones may (final review minor 2).
      if (bytes(relaxed({ ...out, '…': '…' })) > maxBytes) delete out[k]
    }
  out['…'] = '…'
  return relaxed(out)
}

/** A field path as sent: at most 256 characters (final review minor 4). */
const PATH_KEEP = 256

/** Spec §1.3: within 48 KiB — long paths are cut, then paths go (halving), then samples. */
export function capContext(sent: AiSent, maxBytes: number = AI_LIMITS.contextBytes): void {
  const size = () => bytes(JSON.stringify(sent))
  let paths = 0
  let samples = 0
  if (sent.schema)
    for (const f of sent.schema.fields)
      if (f.path.length > PATH_KEEP) f.path = `${f.path.slice(0, PATH_KEEP)}…`
  // Final review Minor 6: the related collections' paths too.
  for (const r of sent.related ?? [])
    for (const f of r.schema.fields) if (f.path.length > PATH_KEEP) f.path = `${f.path.slice(0, PATH_KEEP)}…`
  // What was left out is named in the context itself, so the note is measured with it.
  const note = (kind: string, n: number) => {
    const i = sent.leftOut.findIndex((l) => l.startsWith(`${kind}:`))
    if (i < 0) sent.leftOut.push(`${kind}:${n}`)
    else sent.leftOut[i] = `${kind}:${n}`
  }
  let related = 0
  while (size() > maxBytes && sent.related?.length) {
    sent.related.pop()
    related++
    note('related', related)
  }
  if (sent.related?.length === 0) delete sent.related
  while (size() > maxBytes && sent.schema && sent.schema.fields.length > 0) {
    const drop = Math.max(1, Math.ceil(sent.schema.fields.length / 2))
    sent.schema.fields.splice(sent.schema.fields.length - drop)
    sent.schema.more += drop
    paths += drop
    note('schema_paths', paths)
  }
  while (size() > maxBytes && sent.samples.length) {
    sent.samples.pop()
    samples++
    note('samples', samples)
  }
  if (size() > maxBytes) throw Errors.validation('The context is too large to send', { reason: 'too_large' })
}

async function schemaSummary(
  input: PartsInput,
  ns: NsMasker,
  coll: string = input.coll,
  maxPaths: number = AI_LIMITS.schemaPaths,
  sampleSize: number = AI_LIMITS.schemaSample,
): Promise<AiSchemaSummary> {
  const { client, db, comment, signal } = input
  const analyser = new SchemaAnalyser()
  const deadline = Date.now() + SCHEMA_MS
  await withMongo(async () => {
    const cursor = client
      .db(db)
      .collection(coll)
      .aggregate([{ $sample: { size: sampleSize } }], {
        maxTimeMS: 15_000,
        promoteValues: false,
        allowDiskUse: false,
        comment,
      })
    try {
      for await (const doc of cursor) {
        if (signal.aborted || Date.now() > deadline) break
        analyser.add(
          ns.any ? (deserializeValue(maskDocument(serializeValue(doc), ns)) as Record<string, unknown>) : doc,
        )
      }
    } finally {
      await cursor.close()
    }
  })
  const count = await client
    .db(db)
    .collection(coll)
    .estimatedDocumentCount({ maxTimeMS: 5_000, comment } as never)
    .catch(() => null)
  return summarise(maskAnalysis(analyser.result(), ns), count, maxPaths)
}

/** At most this many related collections, each with this many paths from this many documents. */
const RELATED_MAX = 5
const RELATED_PATHS = 60
const RELATED_SAMPLE = 100
/**
 * User review 2026-10-08 ("Copper Bowl ürününün ödemesini yapan müşteriler", asked from products):
 * at most this many other collections are looked at for fields that refer to this one, each from
 * this many documents.
 */
const RELATED_SCAN = 12
const RELATED_SCAN_SAMPLE = 50
/** Related collections are a help, never a wait: they are read together within this time. */
const RELATED_MS = 5_000
/** An id field's name: customerId, customer_id, productIds; or "id" inside a "customer" document. */
const ID_FIELD = /^(.+?)(?:Id|ID|_id|_ID)s?$/

/** The collection names an id field may refer to (customer → customer, customers, …). */
function namesFor(base: string): string[] {
  const b = base.replace(/[._-]+$/, '')
  const lower = b.charAt(0).toLowerCase() + b.slice(1)
  return [...new Set([lower, `${lower}s`, `${lower}es`, lower.replace(/y$/, 'ies'), b, `${b}s`])]
}

interface IdRef {
  /** The field's MongoDB path (items.productId). */
  via: string
  inArray: boolean
  /** The collection names it may refer to. */
  names: string[]
}
/** A schema's id fields, each with the collection names it may refer to. */
function idRefs(schema: AiSchemaSummary): IdRef[] {
  const refs: IdRef[] = []
  for (const field of schema.fields) {
    // The analyser writes an array's elements as "[]" (items[].productId); MongoDB's path is items.productId.
    const path = field.path.replace(/\[\]/g, '')
    const steps = path.split('.')
    const last = steps.at(-1)!
    // "id" or "_id" inside a document names it (customer.id, customer._id); a top-level _id is the
    // document's own. A base of one character (PID, __id) names nothing (final review Minor 7).
    const nested = (last === 'id' || last === '_id') && steps.length > 1
    const base = nested ? steps.at(-2)! : last === '_id' ? undefined : ID_FIELD.exec(last)?.[1]
    const clean = base?.replace(/^[._-]+|[._-]+$/g, '')
    if (clean && clean.length >= 2)
      refs.push({ via: path.slice(0, 256), inArray: field.path.includes('[]'), names: namesFor(clean) })
  }
  return refs
}

type Related = NonNullable<AiSent['related']>[number]

/**
 * UI redesign R1 review: the collections of the same database that a request may need, each by its
 * schema (masked by its own rules: paths, types and shares only) —
 * - those this one's id fields refer to (orders.customerId → customers);
 * - user review 2026-10-08: those whose id fields refer to this one (products ← orders.items.productId),
 *   and where their other id fields lead (orders.customerId → customers), so "the customers who paid
 *   for a product" can be asked from the products.
 * System collections and the admin, local and config databases are never looked at; a collection
 * that cannot be listed, read or read in time is left out (final review I1).
 */
async function relatedOf(input: PartsInput, schema: AiSchemaSummary): Promise<Related[]> {
  const { ctx, client, db, coll, connectionId } = input
  if (['admin', 'local', 'config'].includes(db)) return []
  let listed: string[]
  try {
    listed = (
      await withMongo(() =>
        client
          .db(db)
          .listCollections({}, {
            nameOnly: true,
            authorizedCollections: true,
            maxTimeMS: RELATED_MS,
          } as never)
          .toArray(),
      )
    ).map((c) => c.name)
  } catch {
    return []
  }
  const existing = new Set(listed.filter((name) => !name.startsWith('system.') && name !== coll))
  if (existing.size === 0) return []
  const forward = new Map<string, IdRef>()
  for (const ref of idRefs(schema)) {
    const name = ref.names.find((n) => existing.has(n))
    if (name && !forward.has(name)) forward.set(name, ref)
  }
  const others = [...existing]
    .filter((name) => !forward.has(name))
    .sort()
    .slice(0, RELATED_SCAN)

  const summaryOf = async (name: string, sample: number) => {
    const masker = await withMongo(() => aiMasker(ctx, client, connectionId, db, name))
    return schemaSummary(input, masker.forNs(db, name), name, RELATED_PATHS, sample)
  }
  // Read together, within one shared time; any that fails or is late is left out.
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RELATED_MS)
  })
  const within = (name: string, sample: number) =>
    Promise.race([summaryOf(name, sample).catch(() => null), deadline]).then((s) => [name, s] as const)
  let read: Array<readonly [string, AiSchemaSummary | null]>
  try {
    read = await Promise.all([
      ...[...forward.keys()].map((name) => within(name, RELATED_SAMPLE)),
      ...others.map((name) => within(name, RELATED_SCAN_SAMPLE)),
    ])
  } finally {
    clearTimeout(timer)
  }
  const schemas = new Map(read.filter((r): r is readonly [string, AiSchemaSummary] => r[1] !== null))
  const entry = (name: string, ref: IdRef, extra: Partial<Related> = {}): Related => ({
    namespace: `${db}.${name}`,
    via: ref.via,
    ...(ref.inArray ? { inArray: true as const } : {}),
    ...extra,
    schema: schemas.get(name)!,
  })

  const out: Related[] = []
  for (const [name, ref] of forward) if (schemas.has(name)) out.push(entry(name, ref))
  const reverse: Related[] = []
  const further: Related[] = []
  // A collection reached from two places (orders and a view of them) is sent once.
  const sent = new Set([...forward.keys()].filter((name) => schemas.has(name)))
  for (const name of others) {
    const own = schemas.get(name)
    if (!own) continue
    const refs = idRefs(own)
    const here = refs.find((r) => r.names.includes(coll))
    if (!here) continue
    reverse.push(entry(name, here, { refersHere: true }))
    sent.add(name)
  }
  for (const item of reverse) {
    const name = item.namespace.slice(db.length + 1)
    for (const ref of idRefs(item.schema)) {
      const target = ref.names.find((n) => existing.has(n) && n !== name)
      if (!target || !schemas.has(target) || sent.has(target)) continue
      further.push(entry(target, ref, { from: item.namespace }))
      sent.add(target)
    }
  }
  return [...out, ...reverse, ...further].slice(0, RELATED_MAX)
}

/** Spec §1.3, plan ruling 3: the editor's query or pipeline, parsed, masked and formatted. */
function currentText(current: AiRequest['current'], db: string, coll: string, masker: Masker): string | null {
  if (!current) return null
  const tooLarge = () => Errors.validation('The current query is too large to send', { reason: 'too_large' })
  // A first, loose bound on what arrived (canonical EJSON is about three times the shell text)…
  if (bytes(JSON.stringify(current)) > AI_LIMITS.currentBytes * 4) throw tooLarge()
  let text: string | null
  if (current.pipeline)
    text = formatShell(maskPipelineDef(deserializeValue(current.pipeline), db, coll, masker), { indent: 0 })
  else {
    const query: Record<string, unknown> = {}
    for (const k of ['filter', 'projection', 'sort'] as const)
      if (current[k]) query[k] = deserializeValue(current[k])
    text = Object.keys(query).length ? formatShell(maskFindDef(query, db, coll, masker), { indent: 0 }) : null
  }
  // …then the bound of spec §1.3 on the text that is sent (final review minor 5).
  if (text && bytes(text) > AI_LIMITS.currentBytes) throw tooLarge()
  return text
}

/** Plan ruling 6: stage names, indexes, keys and directions — never a stage's filter. */
function strip(n: PlanNode | null): unknown {
  if (!n) return null
  return {
    stage: n.stage,
    ...(n.indexName ? { index: n.indexName } : {}),
    ...(n.keyPattern ? { keys: n.keyPattern } : {}),
    ...(n.direction ? { direction: n.direction } : {}),
    ...(n.isMultiKey ? { multiKey: true } : {}),
    ...(n.children.length ? { children: n.children.map(strip) } : {}),
  }
}

async function planOf(input: PartsInput): Promise<{ plan: unknown; indexes: unknown }> {
  const { ctx, client, db, coll, principal, connectionId, comment } = input
  const collection = client.db(db).collection(coll)
  const current = input.current
  // A restricted user's query goes through the gate, as the explain route's (plan ruling 5).
  const restricted = maskerForPrincipal(ctx, principal, connectionId)
  const gate = restricted ? gateDepsFor(restricted, client) : null
  let raw: Document
  if (current?.pipeline) {
    const stages = deserializeValue<Document[]>(current.pipeline)
    if (isWritePipeline(stages))
      throw Errors.validation('A pipeline that writes ($out or $merge) is not explained', {
        reason: 'write_pipeline',
      })
    // Sixteenth review (M6): a pipeline the gate refuses has no plan either, as a find's.
    let guarded: Awaited<ReturnType<typeof guardAggregate>> | null = null
    try {
      guarded = gate ? await withMongo(() => guardAggregate(db, coll, stages, gate)) : null
    } catch (e) {
      const reason = (e as { details?: { reason?: unknown } }).details?.reason
      if (reason !== MASKING_UNSUPPORTED && reason !== PERSONAL_FIELD) throw e
      return { plan: null, indexes: await indexesOf(input) }
    }
    raw = await withMongo(() =>
      collection
        .aggregate(guarded?.stages ?? stages, { comment })
        .explain({ verbosity: 'queryPlanner', maxTimeMS: MONGO_MS }),
    )
  } else {
    const filter = current?.filter ? deserializeValue<Document>(current.filter) : {}
    const projection = current?.projection ? deserializeValue<Document>(current.projection) : undefined
    const sort = current?.sort ? deserializeValue<Document>(current.sort) : undefined
    let guarded: Awaited<ReturnType<typeof guardFind>> | null = null
    try {
      guarded = gate
        ? await withMongo(() =>
            guardFind(
              db,
              coll,
              { filter, ...(projection ? { projection } : {}), ...(sort ? { sort } : {}) },
              gate,
            ),
          )
        : null
    } catch (e) {
      // Fourteenth and fifteenth reviews (Minor 3, Minor 4): where the gate refuses the find (no
      // order hides a hidden value, or its projection with the order a page needs), it does not
      // run, and there is no plan to send: as for a personal plan, the assistant cannot tell why.
      const reason = (e as { details?: { reason?: unknown } }).details?.reason
      if (!isOrderRefusal(e) && reason !== MASKING_UNSUPPORTED && reason !== PERSONAL_FIELD) throw e
      return { plan: null, indexes: await indexesOf(input) }
    }
    const shown = guarded ? guarded.projection : projection
    // Twelfth review (Minor 2): the query that runs, in the gate's order.
    const order = guarded ? guarded.sort : sort
    raw = await withMongo(() =>
      collection
        .find(guarded?.filter ?? filter, {
          ...(shown ? { projection: shown } : {}),
          ...(order ? { sort: order } : {}),
          ...(guarded?.hint !== undefined ? { hint: guarded.hint } : {}),
          comment,
        })
        .explain({ verbosity: 'queryPlanner', maxTimeMS: MONGO_MS }),
    )
  }
  // Eighth review: a plan reading an index that holds personal data is not sent at all.
  if (gate) {
    // Ninth review (nit): a check that cannot finish (the gate's lookups ran out) sends no plan.
    const personal = await personalPlan(raw, gate, db, coll).catch(() => 'unknown')
    if (personal) return { plan: null, indexes: await indexesOf(input) }
  }
  const view = normaliseExplain(raw)
  const advice = adviceFor(view, { foreignIndexed: () => true }).map((w) => w.code)
  return {
    plan: {
      winning: strip(view.winning),
      rejected: view.rejected.slice(0, 3).map(strip),
      stages: view.pipeline.map((s) => s.stage),
      advice,
    },
    indexes: await indexesOf(input),
  }
}

/** Plan ruling 6 of 4a-1: names, keys and flags — never a partial filter's values. */
async function indexesOf(input: PartsInput): Promise<unknown> {
  const { client, db, coll, comment } = input
  const indexes = ((await client
    .db(db)
    .collection(coll)
    .indexes({ maxTimeMS: 5_000, comment } as never)
    .catch(() => [])) ?? []) as Document[]
  return indexes.map((i) => ({
    name: i.name,
    keys: i.key,
    ...(i.unique ? { unique: true } : {}),
    ...(i.sparse ? { sparse: true } : {}),
    ...(i.hidden ? { hidden: true } : {}),
    ...(i.expireAfterSeconds !== undefined ? { ttl: true } : {}),
    ...(i.partialFilterExpression ? { partial: true } : {}),
  }))
}

async function validatorOf(input: PartsInput, masker: Masker): Promise<string | null> {
  const { client, db, coll } = input
  const [info] = await withMongo(() =>
    client.db(db).listCollections({ name: coll }, { nameOnly: false }).toArray(),
  )
  const validator = (info?.options as { validator?: Document } | undefined)?.validator
  return validator ? formatShell(maskValidator(validator, db, coll, masker)) : null
}

async function samplesOf(input: PartsInput, ns: NsMasker): Promise<string[]> {
  const { client, db, coll, comment, samples } = input
  const extra = nsMaskerFrom(samples!.mask.map((p) => ruleSegments(p)))
  const docs = await withMongo(() =>
    client
      .db(db)
      .collection(coll)
      .aggregate([{ $sample: { size: samples!.count } }], {
        maxTimeMS: MONGO_MS,
        promoteValues: false,
        comment,
      })
      .toArray(),
  )
  return docs.map((d) => {
    // The rules for everyone, then the paths the user ticked, then credential-like keys.
    const masked = redactSecrets(maskDocument(maskDocument(serializeValue(d), ns), extra))
    return cutDocument(deserializeValue(masked), AI_LIMITS.sampleBytes)
  })
}

/** Spec §1.3 (4a-1 and 4a-2): exactly what is sent, after masking and within the caps. */
export async function contextFor(input: PartsInput, wants: ContextWants): Promise<AiSent> {
  const { ctx, client, db, coll, connectionId } = input
  // Credential and system collections are never context (4a-1 spec §1.3); nor, security audit
  // 2026-10-16, the local database (its oplog holds every write), whoever asks.
  if (
    coll.startsWith('system.') ||
    isAdminOnlyNamespace(db, coll) ||
    // W8: nor the key vault and Queryable Encryption's metadata.
    isEncryptionMetadata(ctx.connections.get(connectionId)?.settings.encryption, db, coll)
  )
    throw Errors.forbidden('MongoDB’s own collections are never sent', { reason: 'credential_collection' })
  // W4 review C1: nor a restore drill's scratch copy of a backup.
  if (isDrillScratch(db)) throw Errors.forbidden('A restore drill’s scratch database is never sent')
  const masker = await withMongo(() => aiMasker(ctx, client, connectionId, db, coll))
  const ns = masker.forNs(db, coll)
  // The current query is checked before the collection is read (4a-1 final review minor 5).
  const current = currentText(input.current, db, coll, masker)
  const sent: AiSent = {
    namespace: `${db}.${coll}`,
    schema: await schemaSummary(input, ns),
    current,
    plan: null,
    indexes: null,
    validator: null,
    samples: [],
    leftOut: [],
  }
  if (wants.plan) Object.assign(sent, await planOf(input))
  else if (wants.indexes) sent.indexes = await indexesOf(input)
  if (wants.validator) sent.validator = await validatorOf(input, masker)
  if (input.samples) sent.samples = await samplesOf(input, ns)
  if (wants.related && sent.schema) {
    const related = await relatedOf(input, sent.schema)
    if (related.length) sent.related = related
  }
  capContext(sent)
  return sent
}

/** 4a-1's one-shot actions: the parts follow the action. */
export async function buildContext(input: ContextInput): Promise<AiSent> {
  const { request, ...rest } = input
  return contextFor({ ...rest, current: request.current, samples: request.samples }, wantsFor(request.action))
}
