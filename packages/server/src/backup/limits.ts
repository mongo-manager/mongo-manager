import type { Config } from '../config'

export const MiB = 1024 * 1024
export const MAX_ARCHIVE_NAMESPACES = 10_000
export const MAX_METADATA_BYTES = 16 * MiB
/** BSON's 16 MiB, plus room for a time series bucket's own fields. */
export const MAX_DOC_BYTES = 16 * MiB + 16 * 1024
export const MAX_NESTING = 100
export const INFLATE_RATIO_BACKUP = 200
export const MAX_DIR_ZIP_ENTRIES = 100_000
export const MAX_BACKUP_JOBS = 2
export const MAX_TOOL_PROCESSES = 2
export const UPLOAD_PART_BYTES = 8 * MiB
/** How long an inspection waits for more of a growing upload before answering "waiting". */
export const INSPECT_WAIT_MS = 1_500

export interface BackupLimits {
  quota: number
  totalQuota: number
  maxUpload: number
  ttlMs: number
  maxJobMs: number
  chunkBytes: number
  toolsPath: string | null
  /** Phase 3d-3b. */
  folderRoots: string[]
  privateNetworks: string[]
  destPartBytes: number
  destTransfers: number
  /** W4 re-review (minor): the most a restore drill writes (null: its free-space bound alone). */
  drillMaxBytes: number | null
  /** Phase 3d-3c. */
  schedules: boolean
  scheduleConcurrency: number
}

export function backupLimits(config: Pick<Config, 'backup'>): BackupLimits {
  const b = config.backup
  return {
    quota: b.quotaMb * MiB,
    totalQuota: b.totalQuotaMb * MiB,
    maxUpload: b.maxUploadMb * MiB,
    ttlMs: b.ttlHours * 3600_000,
    maxJobMs: b.maxJobHours * 3600_000,
    chunkBytes: b.chunkMb * MiB,
    toolsPath: b.toolsPath ?? null,
    folderRoots: b.folderRoots,
    privateNetworks: b.privateNetworks,
    destPartBytes: b.destPartMb * MiB,
    destTransfers: b.destTransfers,
    drillMaxBytes: b.drillMaxMb !== undefined ? b.drillMaxMb * MiB : null,
    schedules: b.schedules,
    scheduleConcurrency: b.scheduleConcurrency,
  }
}
