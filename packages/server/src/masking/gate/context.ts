import { randomBytes } from 'node:crypto'
import type { Document } from 'mongodb'
import type { Masker, Pattern } from '../match'

export const MAX_VIEW_DEPTH = 10

/** The rules of a namespace; a time-series bucket collection has its view's (3b). */
export function rulesFor(masker: Masker, db: string, coll: string): readonly Pattern[] {
  const ruleColl = coll.startsWith('system.buckets.') ? coll.slice('system.buckets.'.length) : coll
  return masker.forNs(db, ruleColl).patterns
}

/** What the gate reads from MongoDB: injected, so the gate stays testable without a server. */
export interface GateDeps {
  masker: Masker
  /** A view's definition, or null for a collection or a missing namespace. */
  view(
    db: string,
    coll: string,
  ): Promise<{ viewOn: string; pipeline: Document[]; collation?: Document } | null>
  /** The collection's indexes as listIndexes answers them ([] when unreadable). */
  indexes(db: string, coll: string): Promise<Document[]>
  /**
   * Final review of the agent's gate (M-4): the last listing failed (other than for a namespace that
   * does not exist): its [] is not "no index".
   */
  indexesUnread?(db: string, coll: string): boolean
  /** Why the last listing failed, for a write to say (a server's own failure is the job's). */
  indexesFailure?(db: string, coll: string): unknown
  /** What the namespace is, from the same listing as `view` (tenth review of explain masking). */
  kind?(db: string, coll: string): Promise<'view' | 'timeseries' | 'collection' | 'missing'>
  /**
   * How the collection is stored, from the same listing (thirteenth review, I3, M3): clustered by
   * _id, or a time series by its time and meta fields; null where it cannot be read.
   */
  storage?(
    db: string,
    coll: string,
  ): Promise<{
    clustered: boolean
    timeseries?: { timeField: string; metaField?: string }
    collation?: Document
  } | null>
}

/** What a variable names: an array's path (its elements), or a value already guarded. */
export type Binding = readonly string[] | 'safe'
export interface Scope {
  readonly vars: ReadonlyMap<string, Binding>
}
export const ROOT_SCOPE: Scope = { vars: new Map() }

export interface GateCtx {
  deps: GateDeps
  /** The database of the query: `$lookup` and `$unionWith` read from it. */
  db: string
  /** A stored view's pipeline cannot be rewritten: what needs a guard is refused instead (§3.6). */
  strict: boolean
  /** Some namespace read so far has rules: `$out` and `$merge` are refused (§3.5). */
  ruled: { value: boolean }
  /** Views and joins followed so far. */
  depth: number
  scope: Scope
  /** Makes our temporary field names unguessable, so no stored field is overwritten (final review M3). */
  nonce: string
  /**
   * Inside a $redact expression (W5): 'open' where no rule applies, 'root' where one does. $redact
   * evaluates its expression at every level of the document with CURRENT set to that level, so a
   * "$field" there may read any sub-document's field, a masked one included; only $$ROOT paths,
   * which name one place, can be checked.
   */
  redact: 'open' | 'root' | null
  /**
   * Documents only checked (a write's, the data model's, a count of filters alone): their order is
   * not changed (twelfth review, I5).
   */
  unordered?: true
  /**
   * Final review of the agent's gate (M-A): an order needed whatever the indexes are when it runs (a
   * job's read, a view to store): its joins' too.
   */
  always?: true
  /**
   * Fifteenth to seventeenth reviews of explain masking (I-2, I-1): the collation the operation runs
   * under (its view's, or its collection's own); its joins read under it too.
   */
  collation?: Document
}

export const newCtx = (deps: GateDeps, db: string): GateCtx => ({
  deps,
  db,
  strict: false,
  ruled: { value: false },
  depth: 0,
  scope: ROOT_SCOPE,
  nonce: randomBytes(6).toString('hex'),
  redact: null,
})
