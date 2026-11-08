// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useTabsStore } from './tabs'
import { openSqlTransferTab } from '@/workspace/openTabs'
import type { AiAction, ExportFormat } from '@mongo-manager/shared/browser'
import type { ConnectionDto } from '@/api/connections'
import type { ExportQuery } from '@/api/transfer'

/** Phase 3e-2: a live sync's settings, to start one like an earlier one. */
export interface LiveSyncPreset {
  target: { connectionId: string; db: string; coll?: string }
  startMode?: 'copy' | 'replace' | 'merge' | 'from_now'
  errorPolicy?: 'pause' | 'skip'
  followNew?: boolean
  anonymous?: boolean
  collections?: string[]
  /** Final review m16: the sync this one starts again in place of. */
  replaces?: string
  /** W4.6: a filtered sync's filter (canonical EJSON), kept by "Start again". */
  filter?: Record<string, unknown> | null
}

export type WorkspaceDialog =
  | { kind: 'connection'; connection?: ConnectionDto; duplicate?: boolean }
  | { kind: 'createDatabase'; connectionId: string }
  | {
      kind: 'createCollection'
      connectionId: string
      db: string
      /** Phase 2a: a view from the aggregation builder, pre-filled. */
      view?: { viewOn: string; pipeline: string }
      /** User review 2026-10-09: the name a missing collection's tab asked for, pre-filled. */
      name?: string
    }
  | { kind: 'renameCollection'; connectionId: string; db: string; coll: string }
  /** W2.4: a collection's change-stream pre/post images (its tab, to open Validation from there). */
  | { kind: 'editCollection'; connectionId: string; db: string; coll: string; tabId?: string }
  | { kind: 'duplicateCollection'; connectionId: string; db: string; coll: string }
  | {
      kind: 'importData'
      connectionId: string
      db: string
      coll: string
      /** Plugins wave 3: documents a plugin handed over (NDJSON), who it is, and an id of their own. */
      file?: { id: string; name: string; text: string; from: string }
    }
  | {
      kind: 'exportData'
      connectionId: string
      db: string
      coll: string
      /** User request 2026-10-13: the assistant's query or pipeline, in the format asked for. */
      query?: ExportQuery
      stages?: unknown[]
      format?: Exclude<ExportFormat, 'sql'>
    }
  /** Phase 3d-2: copy (or, with compare, compare) a collection, or a database when coll is absent. */
  | { kind: 'copyData'; connectionId: string; db: string; coll?: string; compare?: boolean }
  /** Phase 3d-3a: back up a collection, a database (coll absent) or the server (db absent). */
  | { kind: 'backupDump'; connectionId: string; db?: string; coll?: string }
  /** Phase 3d-3a: restore into a connection (a database or collection preselects the targets). */
  | {
      kind: 'backupRestore'
      connectionId: string
      db?: string
      coll?: string
      backupId?: string
      /** Phase 3d-3b: a backup at a destination, fetched before it is restored. */
      remote?: { destinationId: string; key: string; name: string }
    }
  /** Phase 3d-3b: send a kept backup to destinations. */
  | { kind: 'backupSend'; backupId: string; connectionId: string }
  /** Phase 3d-3c: a new schedule (a connection and database prefill it), or a saved one to edit. */
  | { kind: 'backupSchedule'; connectionId?: string; db?: string; coll?: string; scheduleId?: string }
  /** Phase 3e-2: a new live sync (a source prefills it), a fresh start of one, or the review of a stopped one. */
  | {
      kind: 'liveSync'
      connectionId?: string
      db?: string
      coll?: string
      preset?: LiveSyncPreset
      review?: string
    }
  /** Phase 4a-1: Ask AI on a collection tab. */
  | {
      kind: 'ai'
      connectionId: string
      db: string
      coll: string
      tabId: string
      actions: AiAction[]
      /** Opened by a shortcut (Explain this pipeline): sent at once. */
      send?: boolean
    }
  | { kind: 'exportConnections' }
  | { kind: 'importConnections' }
  | { kind: 'shortcuts' }

/** One place to open workspace dialogs from the tree, the tabs and the palette. */
export const useWorkspaceDialogs = defineStore('workspaceDialogs', () => {
  const current = ref<WorkspaceDialog | null>(null)
  const open = (dialog: WorkspaceDialog): void => {
    current.value = dialog
  }
  const close = (): void => {
    current.value = null
  }
  /**
   * SQL transfer spec §1: the SQL plugin's bridge (ui.importSql / ui.exportSql) and the tree open
   * these, on a click. User request 2026-10-11: SQL ↔ MongoDB, the page, never a dialog.
   */
  const tabs = useTabsStore()
  const openImportSql = (connectionId: string, db: string): void =>
    void openSqlTransferTab(tabs, { part: 'import', connectionId, db })
  const openExportSql = (connectionId: string, db: string, coll?: string): void =>
    void openSqlTransferTab(tabs, { part: 'export', connectionId, db, ...(coll ? { coll } : {}) })
  return { current, open, close, openImportSql, openExportSql }
})
