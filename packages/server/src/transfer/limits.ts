// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Config } from '../config'

/** Phase 3d-1 spec §7: every limit in one place. */
export const MiB = 1024 * 1024
export const MAX_RECORD_CHARS = 16 * MiB
export const MAX_FIELDS = 10_000
export const MAX_DEPTH = 100
export const MAX_PATH_SEGMENTS = 100
export const INFLATE_RATIO = 20
export const MAX_ZIP_ENTRY = 512 * MiB
export const MAX_ZIP_ENTRIES = 10_000
export const MAX_XML_PART = 8 * MiB
export const MAX_SHARED_STRINGS = 1_000_000
export const MAX_SHARED_TEXT = 64 * MiB
export const MAX_SHEETS = 256
export const XLSX_MAX_ROWS = 1_048_576
export const XLSX_MAX_DATA_ROWS = 1_048_575
export const XLSX_MAX_CELL = 32_767
export const UPLOAD_IDLE_MS = 30_000
export const UPLOADS_PER_MINUTE = 10
export const MAX_CONCURRENT_UPLOADS = 2
export const MAX_TRANSFER_JOBS = 2
export const PREVIEW_READ = 1000
export const PREVIEW_SHOWN = 100
export const INFER_CHARS = 64
export const SNIFF_BYTES = 64 * 1024
export const BATCH_DOCS = 1000
export const BATCH_BYTES = 16 * MiB
export const MAX_REPORT_ERRORS = 1000
export const MAX_OMITTED_FIELDS = 100
export const SWEEP_EVERY_MS = 3600_000

/** Review I3 (user request 2026-10-10): a SQL dump's preview reads for at most this long. */
export const SQL_PREVIEW_MS = 30_000

export interface TransferLimits {
  maxUpload: number
  quota: number
  /** All owners' files together (security review 2026-10-13); no total when not given. */
  total?: number
  ttlMs: number
  maxJobMs: number
  /** How long a SQL dump's preview may read; SQL_PREVIEW_MS when not given. */
  previewMs?: number
}

export function transferLimits(config: Pick<Config, 'transfer'>): TransferLimits {
  return {
    maxUpload: config.transfer.maxUploadMb * MiB,
    quota: config.transfer.quotaMb * MiB,
    total: (config.transfer.totalQuotaMb ?? Math.max(51_200, config.transfer.quotaMb)) * MiB,
    ttlMs: config.transfer.ttlHours * 3600_000,
    maxJobMs: config.transfer.maxJobHours * 3600_000,
    previewMs: SQL_PREVIEW_MS,
  }
}
