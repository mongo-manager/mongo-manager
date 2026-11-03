import type {
  ConvertSamplesRequest,
  ConvertSamplesResponse,
  CopyPlan,
  Dialect,
  ExportRequest,
  ImportRequest,
  JobView,
  Preset,
  PresetInput,
  SqlExportBody,
  SqlImportRequest,
  SqlPreviewResponse,
  SyncRequest,
  TransferFormat,
  TransferPreviewResponse,
  TransferReport,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

const apiBase = () => new URL('api/', document.baseURI)

/** The query a documents view has applied (EJSON objects, as the find route takes them). */
export interface ExportQuery {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  collation?: Record<string, unknown>
  hint?: string | Record<string, unknown>
  skip?: number
  limit?: number
}

export const transferKeys = {
  presets: (kind: 'import' | 'export' | 'copy') => ['transfer', 'presets', kind] as const,
  report: (jobId: string) => ['transfer', 'report', jobId] as const,
}

/** Phase 3d-1: file import and export (uploads go through useUpload, which reports progress). */
export const transferApi = {
  preview: (conn: string, uploadId: string, body: { format?: TransferFormat; dialect?: Dialect } = {}) =>
    api.post<TransferPreviewResponse>(path`connections/${conn}/transfer/uploads/${uploadId}/preview`, body),
  /** W4.1: sample text as the import would write it in each target type (the caller's own text). */
  convertSamples: (conn: string, body: ConvertSamplesRequest) =>
    api.post<ConvertSamplesResponse>(path`connections/${conn}/transfer/convert-samples`, body),
  discard: (conn: string, uploadId: string) =>
    api.delete<void>(path`connections/${conn}/transfer/uploads/${uploadId}`),
  startImport: (conn: string, db: string, coll: string, body: ImportRequest) =>
    api.post<{ job: JobView }>(path`connections/${conn}/databases/${db}/collections/${coll}/import`, body),
  startExport: (conn: string, db: string, coll: string, body: ExportRequest) =>
    api.post<{ job: JobView }>(path`connections/${conn}/databases/${db}/collections/${coll}/export`, body),
  /** User request 2026-10-10: a SQL dump's tables and skipped statements (the dump is read, never run). */
  sqlPreview: (conn: string, uploadId: string) =>
    api.post<SqlPreviewResponse>(path`connections/${conn}/transfer/uploads/${uploadId}/sql-preview`, {}),
  /** The chosen tables of a dump into collections of `db`, as one job ('data.importSql'). */
  importSql: (conn: string, db: string, body: SqlImportRequest) =>
    api.post<{ job: JobView }>(path`connections/${conn}/databases/${db}/import-sql`, body),
  /** User requests 2026-10-11, 2026-10-12: chosen collections of one database as one SQL file. */
  exportSql: (conn: string, db: string, body: SqlExportBody) =>
    api.post<{ job: JobView }>(path`connections/${conn}/databases/${db}/export-sql`, body),
  report: (jobId: string) => api.get<TransferReport>(path`transfer/jobs/${jobId}/report`),
  /** Plain links: the browser downloads with the session cookie; the server sends attachment headers. */
  fileUrl: (jobId: string) => new URL(path`transfer/files/${jobId}`, apiBase()).href,
  rejectedUrl: (jobId: string) => new URL(path`transfer/jobs/${jobId}/rejected`, apiBase()).href,
  presets: (kind: 'import' | 'export' | 'copy') =>
    api.get<{ presets: Preset[] }>(path`transfer/presets?kind=${kind}`),
  savePreset: (input: PresetInput, id?: string) =>
    id ? api.put<Preset>(path`transfer/presets/${id}`, input) : api.post<Preset>('transfer/presets', input),
  deletePreset: (id: string) => api.delete<void>(path`transfer/presets/${id}`),
  /** Phase 3d-2: a copy's plan (summary, refusals, hash), then its start with the hash. */
  copyPlan: (conn: string, db: string, coll: string | null, body: object) =>
    api.post<CopyPlan>(
      coll
        ? path`connections/${conn}/databases/${db}/collections/${coll}/copy/plan`
        : path`connections/${conn}/databases/${db}/copy/plan`,
      body,
    ),
  startCopy: (conn: string, db: string, coll: string | null, body: object) =>
    api.post<{ job: JobView }>(
      coll
        ? path`connections/${conn}/databases/${db}/collections/${coll}/copy`
        : path`connections/${conn}/databases/${db}/copy`,
      body,
    ),
  startCompare: (conn: string, db: string, coll: string | null, body: object) =>
    api.post<{ job: JobView }>(
      coll
        ? path`connections/${conn}/databases/${db}/collections/${coll}/compare`
        : path`connections/${conn}/databases/${db}/compare`,
      body,
    ),
  startSync: (body: SyncRequest) => api.post<{ job: JobView }>('transfer/sync', body),
}
