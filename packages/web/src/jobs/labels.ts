// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { JobKindName } from '@mongo-manager/shared'

/** i18n keys cannot contain the dot of a job kind's name. */
const KEYS: Record<JobKindName, string> = {
  'index.create': 'jobs.kind.indexCreate',
  'collection.duplicate': 'jobs.kind.collectionDuplicate',
  'data.import': 'jobs.kind.dataImport',
  'data.importSql': 'jobs.kind.dataImportSql',
  'data.export': 'jobs.kind.dataExport',
  'data.copy': 'jobs.kind.dataCopy',
  'data.compare': 'jobs.kind.dataCompare',
  'data.sync': 'jobs.kind.dataSync',
  'backup.dump': 'jobs.kind.backupDump',
  'backup.restore': 'jobs.kind.backupRestore',
  'backup.send': 'jobs.kind.backupSend',
  'backup.fetch': 'jobs.kind.backupFetch',
  'backup.drill': 'jobs.kind.backupDrill',
}

export const kindKey = (kind: JobKindName): string => KEYS[kind]
