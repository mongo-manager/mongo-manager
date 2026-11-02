import { markRaw } from 'vue'
import type { LibraryItem, QueryOrigin } from '@mongo-manager/shared'
import type { DocumentRow } from '@/documents/rows'
import { decodeDocument } from '@/documents/values'

/**
 * Phase 3a-2 spec §2 and §3.3: a shell result as the result pane shows it. Values are canonical EJSON
 * as the worker sent them. Results live only in memory (never in browser storage).
 */
export interface ShellResult {
  id: number
  resultType: string | null
  value: unknown
  /** The find/aggregate a cursor result came from (spec §3.3); absent for anything else. */
  origin?: QueryOrigin
  hasMore: boolean
  /** The result as documents, or null when it is not documents (a number, a string, …). */
  documents: Record<string, unknown>[] | null
  /** The command's output passed the size cap: nothing is shown but a note. */
  truncated?: boolean
  /** The code that gave it, as run (the history names a result by it). */
  command?: string
  /**
   * Its place among the results kept, from 1: a result's number may repeat after a reload (the page's
   * count starts again), its place never (review 2026-10-12, M4).
   */
  seq?: number
}

/** What tells a result apart (and the number shown): its place, else its number. */
export const resultKey = (r: ShellResult): number => r.seq ?? r.id

export const MAX_RESULTS = 10

const isPlainDocument = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const keys = Object.keys(v)
  // An EJSON value wrapper ({$oid}, {$date}, {$numberInt}, …) is a value, not a document.
  return keys.length === 0 || !keys.every((k) => k.startsWith('$'))
}

/** A cursor batch (an array of documents) or one document; null for anything else. */
export function documentsOf(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value.every(isPlainDocument) ? value : null
  return isPlainDocument(value) ? [value] : null
}

export function resultRows(result: ShellResult): DocumentRow[] {
  return (result.documents ?? []).map((doc, i) => ({
    key: `${result.id}:${i}`,
    kind: 'document',
    raw: markRaw(doc),
    hash: String(i),
    value: markRaw(decodeDocument(doc)),
  }))
}

/** The Documents view shows at most this many documents a page (the server's find bound). */
const MAX_PAGE = 1000

/**
 * W5: a find's skip and limit as the collection view's paging: it starts at the skip, the limit its
 * page size. As mongosh reads them: a negative limit is one batch of that many, 0 no limit.
 */
export function originPaging(origin: QueryOrigin): { skip?: number; limit?: number } {
  if (origin.kind !== 'find') return {}
  const paging: { skip?: number; limit?: number } = {}
  if (Number.isSafeInteger(origin.skip) && origin.skip! > 0) paging.skip = origin.skip
  if (Number.isSafeInteger(origin.limit) && origin.limit !== 0)
    paging.limit = Math.min(Math.abs(origin.limit!), MAX_PAGE)
  return paging
}

/**
 * The origin as a library item, to reopen it with the Library's open path: a find in the collection's
 * Documents view (its skip and limit go along as paging, `originPaging`), a pipeline in its builder.
 */
export function originToLibraryItem(origin: QueryOrigin): LibraryItem {
  const common = {
    type: 'history' as const,
    id: 'shell-result',
    db: origin.db,
    coll: origin.coll,
    tags: [],
    preview: '',
    at: new Date().toISOString(),
    shared: false,
    mine: true,
  }
  if (origin.kind === 'aggregate') return { ...common, kind: 'aggregate', body: origin.pipeline }
  const { filter, projection, sort, collation, hint } = origin
  return {
    ...common,
    kind: 'find',
    body: {
      filter,
      ...(projection ? { projection } : {}),
      ...(sort ? { sort } : {}),
      ...(collation ? { collation } : {}),
      ...(hint !== undefined ? { hint } : {}),
    },
  }
}

/** The last results of one shell, newest first, in memory only. */
export class ResultBuffer {
  items: ShellResult[] = []
  private placed = 0

  push(result: ShellResult): void {
    this.items = [{ ...result, seq: ++this.placed }, ...this.items].slice(0, MAX_RESULTS)
  }

  /** Forgets every result (the history cleared, the shell restarted, or asked): those it forgot. */
  clear(): ShellResult[] {
    const gone = this.items
    this.items = []
    return gone
  }

  /** Brings back results cleared (an Undo), behind any that came since. */
  restore(gone: ShellResult[]): void {
    this.items = [...this.items, ...gone].slice(0, MAX_RESULTS)
  }
}
