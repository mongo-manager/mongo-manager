import type {
  CompactEstimate,
  ShardKeyAnalysis,
  ShardKeyAnalysisBody,
  StorageReport,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

const coll = (t: CollectionTarget) =>
  path`connections/${t.connectionId}/databases/${t.db}/collections/${t.coll}`

/** Plugins wave 4 (2026-10-27): a database's storage, compact, a shard key's analysis. */
export const storageApi = {
  report: (connectionId: string, db: string) =>
    api.get<StorageReport>(path`connections/${connectionId}/databases/${db}/storage`),
  compactEstimate: (t: CollectionTarget) => api.post<CompactEstimate>(`${coll(t)}/compact-estimate`),
  /**
   * With the collection's name: sent once the user typed it in the app's own dialog. The server checks
   * it again — a guard against a stray call, not a proof of the typing (the dialog is that).
   */
  compact: (t: CollectionTarget, confirm: string) =>
    api.post<{ bytesFreed: number }>(`${coll(t)}/compact`, { confirm }),
  shardKeyAnalysis: (t: CollectionTarget, key: ShardKeyAnalysisBody['key']) =>
    api.post<ShardKeyAnalysis>(`${coll(t)}/shard-key-analysis`, { key }),
}
