import type { CreateIndex, CreateSearchIndex, JobView, SchemaAnalysis } from '@mongo-manager/shared'
import { api, path } from './client'
import type { Caution } from '@/documents/caution'

export interface CollectionTarget {
  connectionId: string
  db: string
  coll: string
}

/** One document as the server sends it: canonical EJSON plus its version hash, or why it cannot be shown. */
export type DocumentItem =
  | { document: Record<string, unknown>; hash: string; caution?: DocumentCaution }
  | { unsupported: { _id: unknown; reason: string } }

/** Data review 2026-10-13 (M3): a field the app would not write back as stored. */
/** Data review 2026-10-13 (M3): a field the app would not write back as stored. */
export type DocumentCaution = Caution

export interface FindBody {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
  maxTimeMS?: number
  skip: number
  limit: number
  /** False for a plugin's find: never one of the user's recent queries (wave 2 review I1). */
  remember?: boolean
  /** W1 review: false for the app's own read for the user (the chart view): kept out of the history. */
  record?: boolean
}
/** A remembered query, as canonical EJSON parts (phase 1g-1). */
export interface RecentQuery {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
}
export interface FindResult {
  documents: DocumentItem[]
  hasMore: boolean
}
/** The find's collation and hint, which change what is counted. */
export interface CountOptions {
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
}
/** count is null when the server gave up; atLeast then holds a lower bound. */
export interface CountResult {
  count: number | null
  exact: boolean
  atLeast?: number
}
export type BulkBody =
  | { filter: Record<string, unknown>; operation: 'delete' }
  | {
      filter: Record<string, unknown>
      operation: 'update'
      update: Record<string, unknown> | Record<string, unknown>[]
    }
export interface BulkPreview {
  matched: number
  total: number
  requiresConfirmation: boolean
  filterHash: string
  /** W2.3: a few matched documents before and after (canonical EJSON, masked), or why there are none. */
  samples?: BulkSamples
}
export type BulkSamples =
  | {
      documents: Array<{ before: Record<string, unknown>; after?: Record<string, unknown>; fails?: true }>
      /** Re-review (minor 5): some samples were left out to keep the answer small. */
      cut?: true
    }
  | { unavailable: string; message?: string }
export interface BulkResult {
  deleted?: number
  matched?: number
  modified?: number
}
export interface IndexInfo {
  name: string
  key: Record<string, unknown>
  options: Record<string, unknown>
  usage: { ops: number; since: string } | null
}

/** W2.6: an Atlas Search or Vector Search index, as the server lists it. */
export interface SearchIndexInfo {
  name: string
  type: 'search' | 'vectorSearch'
  /** PENDING, BUILDING, READY, FAILED, STALE, DELETING, DOES_NOT_EXIST (Atlas's words). */
  status: string
  queryable: boolean
  message?: string
  /** Canonical EJSON. */
  definition: Record<string, unknown>
}
export type SearchIndexList =
  | { supported: true; indexes: SearchIndexInfo[] }
  | { supported: false; reason: 'not_enabled' | 'unsupported'; indexes: [] }

const base = (t: CollectionTarget) =>
  path`connections/${t.connectionId}/databases/${t.db}/collections/${t.coll}`

const collectionKey = (t: CollectionTarget) =>
  ['connections', t.connectionId, 'databases', t.db, 'collections', t.coll] as const

export const documentKeys = {
  all: (t: CollectionTarget) => [...collectionKey(t), 'documents'] as const,
  page: (t: CollectionTarget, body: FindBody) => [...collectionKey(t), 'documents', 'page', body] as const,
  count: (t: CollectionTarget, filter: Record<string, unknown>, options: CountOptions = {}) =>
    [...collectionKey(t), 'documents', 'count', filter, options] as const,
  indexes: (t: CollectionTarget) => [...collectionKey(t), 'indexes'] as const,
  indexJobs: (t: CollectionTarget) => [...collectionKey(t), 'indexes', 'jobs'] as const,
  searchIndexes: (t: CollectionTarget) => [...collectionKey(t), 'search-indexes'] as const,
  schema: (t: CollectionTarget, sampleSize: number) => [...collectionKey(t), 'schema', sampleSize] as const,
}

export const documentsApi = {
  find: (t: CollectionTarget, body: FindBody, signal?: AbortSignal) =>
    api.post<FindResult>(`${base(t)}/find`, body, signal ? { signal } : undefined),
  count: (
    t: CollectionTarget,
    filter: Record<string, unknown>,
    options: CountOptions,
    signal?: AbortSignal,
  ) =>
    api.post<CountResult>(
      `${base(t)}/count`,
      {
        filter,
        ...(options.collation ? { collation: options.collation } : {}),
        ...(options.hint !== undefined ? { hint: options.hint } : {}),
      },
      signal ? { signal } : undefined,
    ),
  get: (t: CollectionTarget, id: unknown) => api.post<DocumentItem>(`${base(t)}/documents/get`, { _id: id }),
  insert: (t: CollectionTarget, documents: Record<string, unknown>[]) =>
    api.post<{ insertedIds: unknown[] }>(`${base(t)}/documents`, { documents }),
  /** Field-level update (`$set`/`$unset`), pinned to the version the user saw. */
  update: (t: CollectionTarget, id: unknown, set: Record<string, unknown>, unset: string[], hash: string) =>
    api.post<{ modified: number }>(`${base(t)}/documents/update`, { _id: id, set, unset, hash }),
  replace: (t: CollectionTarget, id: unknown, document: Record<string, unknown>, hash: string) =>
    api.post<{ modified: number }>(`${base(t)}/documents/replace`, { _id: id, document, hash }),
  recentQueries: (t: CollectionTarget) =>
    api.get<{ queries: Array<{ query: RecentQuery; usedAt: number }> }>(`${base(t)}/recent-queries`),
  clearRecentQueries: (t: CollectionTarget) => api.delete<void>(`${base(t)}/recent-queries`),
  remove: (t: CollectionTarget, id: unknown) => api.post<void>(`${base(t)}/documents/delete`, { _id: id }),
  bulkPreview: (t: CollectionTarget, body: BulkBody) =>
    api.post<BulkPreview>(`${base(t)}/bulk/preview`, body),
  bulkExecute: (t: CollectionTarget, body: BulkBody, filterHash: string, confirm?: string) =>
    api.post<BulkResult>(`${base(t)}/bulk/execute`, { ...body, filterHash, ...(confirm ? { confirm } : {}) }),
  indexes: (t: CollectionTarget) => api.get<IndexInfo[]>(`${base(t)}/indexes`),
  /** A sampled schema analysis (phase 1i); the result is not stored on the server. */
  schema: (t: CollectionTarget, sampleSize: number, signal?: AbortSignal, maxTimeMS?: number) =>
    api.post<SchemaAnalysis>(
      `${base(t)}/schema`,
      { sampleSize, ...(maxTimeMS ? { maxTimeMS } : {}) },
      signal ? { signal } : undefined,
    ),
  /** Starts a background build (long builds must not meet a request timeout); see indexJobs. */
  createIndex: (t: CollectionTarget, body: CreateIndex) =>
    api.post<{ job: JobView }>(`${base(t)}/indexes`, body),
  /** This collection's builds, running and recent; the jobs store keeps them current. */
  indexJobs: (t: CollectionTarget) => api.get<{ jobs: JobView[] }>(`${base(t)}/indexes/jobs`),
  /** Builds MongoDB is running on this collection, whoever started them (read from $currentOp). */
  indexProgress: (t: CollectionTarget) =>
    api.get<{ builds: Array<{ message: string; done: number | null; total: number | null }> }>(
      `${base(t)}/indexes/progress`,
    ),
  dropIndex: (t: CollectionTarget, name: string) =>
    api.delete<void>(`${base(t)}/indexes/${encodeURIComponent(name)}`),
  /** W2.6: Atlas Search and Vector Search indexes, or why the server has none. */
  searchIndexes: (t: CollectionTarget) => api.get<SearchIndexList>(`${base(t)}/search-indexes`),
  createSearchIndex: (t: CollectionTarget, body: CreateSearchIndex) =>
    api.post<{ name: string }>(`${base(t)}/search-indexes`, body),
  updateSearchIndex: (t: CollectionTarget, name: string, definition: Record<string, unknown>) =>
    api.patch<{ name: string }>(`${base(t)}/search-indexes/${encodeURIComponent(name)}`, { definition }),
  dropSearchIndex: (t: CollectionTarget, name: string) =>
    api.delete<void>(`${base(t)}/search-indexes/${encodeURIComponent(name)}`),
  hideIndex: (t: CollectionTarget, name: string, hidden: boolean) =>
    api.patch<{ name: string; hidden: boolean }>(`${base(t)}/indexes/${encodeURIComponent(name)}`, {
      hidden,
    }),
}
