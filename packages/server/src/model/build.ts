import { ObjectId, type Document, type MongoClient } from 'mongodb'
import {
  DATA_MODEL_LIMITS,
  SchemaAnalyser,
  deserializeValue,
  serializeValue,
  type DataModel,
  type ModelCollection,
  type ModelCollectionType,
  type ModelIndex,
} from '@mongo-manager/shared'
import { isAdminOnlyNs } from '../connections/access'
import { guardAggregate, type GateDeps } from '../masking/gate'
import { maskDocument } from '../masking/document'
import { maskAnalysis } from '../masking/schema'
import { inferReferences, lookupsIn, modelFields, type Lookup, type SampledCollection } from './infer'

/** One collection's sample: MongoDB's own limit (the whole build has its deadline too). */
const SAMPLE_MS = 10_000
/** One values check: a count of at most ten _ids. */
const CHECK_MS = 2_000
/** Listing the collections. */
const LIST_MS = 10_000
/** Plugins wave 3: listing one collection's indexes. */
const INDEX_MS = 2_000

export interface ModelInput {
  client: MongoClient
  db: string
  sampleSize: number
  /** The documents the whole model may sample (MM_MODEL_MAX_DOCS): each sample shrinks to fit. */
  maxDocs: number
  /**
   * The caller is the connection's admin: credential collections are theirs to see. MongoDB's own
   * system.* collections are left out for everyone (they are not part of an application's model).
   */
  admin: boolean
  /** The masking gate for a restricted user, else null. */
  gate: GateDeps | null
  /** The saved pipelines this user may see in the database, each with the collection it runs on. */
  pipelines: ReadonlyArray<{ coll: string; stages: unknown }>
  comment: string
  /** The caller left: stop reading. */
  gone: () => boolean
  deadline: number
}

const why = (e: unknown): ModelCollection['refused'] => {
  // A gate's failed listing says why by its cause (review of the agent's gate, M-1).
  const failure = e instanceof Error && e.name === 'IndexListingFailed' && e.cause !== undefined ? e.cause : e
  const code = (failure as { code?: unknown }).code
  if (code === 13 || code === 8000 || (e as { statusCode?: unknown }).statusCode === 403)
    return 'not_permitted'
  if (
    code === 50 ||
    code === 262 ||
    (failure as { name?: unknown }).name === 'MongoOperationTimeoutError' ||
    (e as { statusCode?: unknown }).statusCode === 504
  )
    return 'timeout'
  return 'error'
}

/**
 * Plugins wave 3 (spec §4): a collection's indexes by their keys' names and whether each is unique
 * — never a partial filter, a collation or any option holding a value. None where they could not be
 * read (rights, time): the diagram then marks nothing.
 */
/**
 * An index's keys by their names. Wave 3 review: a text index keys `_fts` and `_ftsx`; the fields it
 * searches are its weights' names (numbers only beside them, never a value).
 */
function keysOf(ix: Document): string[] {
  const keys = Object.keys((ix.key ?? {}) as Record<string, unknown>)
  if (keys.includes('_fts')) {
    const searched = ix.weights && typeof ix.weights === 'object' ? Object.keys(ix.weights as object) : []
    // Wave 3 second review: a wildcard text index searches string fields only — marked as none
    // rather than every field.
    return [...keys.filter((k) => k !== '_fts' && k !== '_ftsx'), ...searched.filter((k) => k !== '$**')]
  }
  // A wildcard index with a projection covers what it names (and below), or, leaving fields out,
  // is marked as none rather than marking fields it does not hold (wave 3 second review).
  if (keys.includes('$**') && ix.wildcardProjection && typeof ix.wildcardProjection === 'object') {
    const projection = flatProjection(ix.wildcardProjection as Record<string, unknown>)
    const included = projection.filter(([k, v]) => k !== '_id' && v !== 0 && v !== false).map(([k]) => k)
    const rest = keys.filter((k) => k !== '$**')
    return included.length === projection.filter(([k]) => k !== '_id').length
      ? [...rest, ...included.flatMap((k) => [k, `${k}.$**`])]
      : rest
  }
  return keys
}

/**
 * A wildcard projection as dotted paths: `{ items: { sku: 1 } }` names `items.sku`, not all of
 * `items` (third review).
 */
function flatProjection(projection: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(projection).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? flatProjection(value as Record<string, unknown>, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, unknown]],
  )
}

async function indexesOf(input: ModelInput, coll: string): Promise<ModelIndex[] | null> {
  const left = input.deadline - Date.now()
  if (left <= 0 || input.gone()) return null
  try {
    const list = await input.client
      .db(input.db)
      .collection(coll)
      .listIndexes({ maxTimeMS: Math.max(1, Math.min(INDEX_MS, left)), comment: input.comment } as never)
      .toArray()
    return list.slice(0, DATA_MODEL_LIMITS.indexes).map((ix) => ({
      keys: keysOf(ix),
      ...(ix.unique === true || ix.name === '_id_' ? { unique: true as const } : {}),
    }))
  } catch {
    return null
  }
}

/**
 * completion W6.4: a database's data model. Every collection's fields come from a $sample read
 * as the schema analysis reads it (masked first for a restricted user, so a personal field keeps
 * only its name); views are listed with their source, not sampled. References are inferred from
 * names, from sampled ObjectIds checked against other collections' _ids (through the gate, bounded),
 * and from the $lookup stages of views and of the saved pipelines the user may see. No value leaves.
 */
export async function buildModel(input: ModelInput): Promise<DataModel> {
  const { client, db, gate } = input
  const infos = (await listed(client, db))
    .filter((i) => typeof i.name === 'string' && !i.name.startsWith('system.'))
    .filter((i) => input.admin || !isAdminOnlyNs(`${db}.${i.name}`))
    .sort((a, b) => a.name.localeCompare(b.name))
  const drawn = infos.slice(0, DATA_MODEL_LIMITS.collections)
  // Review minor 13: the collections times the sample stay within the server's cap.
  const toSample = drawn.filter((i) => i.type !== 'view').length
  const size = Math.max(1, Math.min(input.sampleSize, Math.floor(input.maxDocs / Math.max(1, toSample))))
  const collections: ModelCollection[] = []
  const sampled: SampledCollection[] = []
  const lookups: Lookup[] = []
  for (const info of drawn) {
    const type: ModelCollectionType =
      info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection'
    if (type === 'view') {
      const options = (info.options ?? {}) as { viewOn?: unknown; pipeline?: unknown }
      const viewOn = typeof options.viewOn === 'string' ? options.viewOn : undefined
      // A view's joins run on its source; only names are read from its definition.
      if (viewOn) lookups.push(...lookupsIn(options.pipeline, viewOn, db))
      collections.push({
        name: info.name,
        type,
        sampled: 0,
        fields: [],
        moreFields: 0,
        ...(viewOn ? { viewOn } : {}),
      })
      sampled.push({ name: info.name, type, analysis: null })
      continue
    }
    const left = input.deadline - Date.now()
    if (left <= 0 || input.gone()) {
      collections.push({ name: info.name, type, sampled: 0, fields: [], moreFields: 0, refused: 'timeout' })
      sampled.push({ name: info.name, type, analysis: null })
      continue
    }
    try {
      const stages: Document[] = [{ $sample: { size } }]
      const output = gate
        ? (await guardAggregate(db, info.name, stages, gate, { order: false })).output
        : null
      const analyser = new SchemaAnalyser()
      const cursor = client
        .db(db)
        .collection(info.name)
        .aggregate(stages, {
          maxTimeMS: Math.max(1, Math.min(SAMPLE_MS, left)),
          allowDiskUse: false,
          promoteValues: false,
          comment: input.comment,
        })
      for await (const doc of cursor) {
        if (input.gone()) break
        analyser.add(
          output?.any
            ? (deserializeValue(maskDocument(serializeValue(doc), output)) as Record<string, unknown>)
            : doc,
        )
      }
      const analysis = output ? maskAnalysis(analyser.result(), output) : analyser.result()
      const indexes = await indexesOf(input, info.name)
      collections.push({
        name: info.name,
        type,
        sampled: analysis.sampled,
        ...modelFields(analysis),
        ...(indexes ? { indexes } : {}),
      })
      sampled.push({ name: info.name, type, analysis })
    } catch (e) {
      collections.push({ name: info.name, type, sampled: 0, fields: [], moreFields: 0, refused: why(e) })
      sampled.push({ name: info.name, type, analysis: null })
    }
  }
  for (const p of input.pipelines.slice(0, DATA_MODEL_LIMITS.pipelines))
    lookups.push(...lookupsIn(p.stages, p.coll, db))

  /** How many of these _ids the target holds — through the gate for a restricted user. */
  async function check(target: string, hexValues: string[]): Promise<number | null> {
    if (input.gone() || Date.now() > input.deadline) return null
    try {
      let stages: Document[] = [
        { $match: { _id: { $in: hexValues.map((h) => ObjectId.createFromHexString(h)) } } },
        { $count: 'n' },
      ]
      // A target whose _id is personal to this user is refused by the gate: not checked.
      if (gate) stages = (await guardAggregate(db, target, stages, gate, { order: false })).stages
      const [row] = await client
        .db(db)
        .collection(target)
        .aggregate(stages, { maxTimeMS: CHECK_MS, comment: input.comment })
        .toArray()
      return typeof row?.n === 'number' ? row.n : 0
    } catch {
      return null
    }
  }
  const references = await inferReferences({
    collections: sampled,
    lookups,
    check,
    budget: DATA_MODEL_LIMITS.overlapChecks,
  })
  return {
    db,
    sampleSize: size,
    ...(size < input.sampleSize ? { capped: true as const } : {}),
    collections,
    references,
    skipped: infos.length - drawn.length,
    at: new Date().toISOString(),
  }
}

type Listed = { name: string; type?: string; options?: Document }

/**
 * The database's collections. Review I1: a MongoDB user granted only some collections has no
 * listCollections action — as the collections list does, it then lists the names it may see
 * (authorizedCollections needs nameOnly), each with the type that listing gives (a view stays a view,
 * though its source is not known then).
 */
async function listed(client: MongoClient, db: string): Promise<Listed[]> {
  try {
    return (await client
      .db(db)
      .listCollections({}, { nameOnly: false, maxTimeMS: LIST_MS } as never)
      .toArray()) as Listed[]
  } catch (e) {
    if ((e as { code?: unknown }).code !== 13) throw e
    const names = (await client
      .db(db)
      .listCollections({}, { nameOnly: true, authorizedCollections: true, maxTimeMS: LIST_MS } as never)
      .toArray()) as Listed[]
    // Re-review minor 1: the name-only listing still says which are views or time series.
    return names.map((n) => ({ name: n.name, type: typeof n.type === 'string' ? n.type : 'collection' }))
  }
}
