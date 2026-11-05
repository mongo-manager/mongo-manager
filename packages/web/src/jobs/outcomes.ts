// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { openBackupsSection } from '@/backup/openBackups'
import { useSendFailure, useSendStartError, type SendJobView } from './sendJob'
import { useQueryClient } from '@tanstack/vue-query'
import type { JobView } from '@mongo-manager/shared'
import { queryKeys } from '@/api/connections'
import { documentKeys } from '@/api/documents'
import { useToastStore, type ToastAction } from '@/stores/toasts'
import { backupApi, backupKeys } from '@/api/backup'
import { transferApi } from '@/api/transfer'
import { destinationKeys } from '@/api/destinations'
import { useTabsStore } from '@/stores/tabs'
import { isJobShown } from '@/transfer/shownJobs'
import { followApiLink } from '@/api/localLinks'
import { useJobsStore } from './store'
import { restoreTarget, type RestoreTarget } from './restoreTarget'
import { openCollectionTab, openDatabaseTab, openJobsTab } from '@/workspace/openTabs'
import { askNotifications, notifyWhenHidden, rememberAsked, shouldAskNotifications } from './notify'

/**
 * What happens when a job ends (phase 1h spec §6): the data it changed is fetched again for
 * everyone who sees it, and the person who started it is told how it went.
 */
export function useJobOutcomes(): void {
  const { t } = useI18n()
  const store = useJobsStore()
  const toasts = useToastStore()
  const queryClient = useQueryClient()
  const tabs = useTabsStore()

  const refresh = (job: JobView) => {
    const target = { connectionId: job.connectionId, db: job.db, coll: job.coll }
    if (job.kind === 'index.create') {
      void queryClient.invalidateQueries({ queryKey: documentKeys.indexes(target) })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.collectionStats(job.connectionId, job.db, job.coll),
      })
    } else if (job.kind === 'data.export') {
      // Nothing changed in MongoDB.
    } else if (job.kind === 'data.copy' || job.kind === 'data.sync') {
      // Phase 3d-2: the target changed (its database is the first part of the job's target).
      const connectionId = job.targetConnectionId ?? job.connectionId
      const db = job.target.split(/[. ]/)[0] ?? job.db
      // The target database's collection list and every view of its documents.
      void queryClient.invalidateQueries({ queryKey: ['connections', connectionId, 'databases', db] })
    } else if (job.kind === 'backup.dump') {
      // Phase 3d-3a: a new backup in the Backups section and the storage bar.
      void queryClient.invalidateQueries({ queryKey: backupKeys.all })
    } else if (job.kind === 'backup.send') {
      // Phase 3d-3b: copies changed (and a local backup may be gone).
      void queryClient.invalidateQueries({ queryKey: backupKeys.all })
      void queryClient.invalidateQueries({ queryKey: destinationKeys.all })
    } else if (job.kind === 'backup.fetch') {
      // The restore sheet that started it carries on; nothing else changed.
    } else if (job.kind === 'backup.restore') {
      // A restore can write into several databases of its target connection.
      void queryClient.invalidateQueries({ queryKey: ['connections', job.connectionId, 'databases'] })
    } else if (job.kind === 'data.compare') {
      // Nothing changed in MongoDB.
    } else if (job.kind === 'data.import') {
      // Phase 3d-1: an import (done, stopped or cancelled) may have written documents.
      void queryClient.invalidateQueries({ queryKey: documentKeys.all(target) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections(job.connectionId, job.db) })
    } else if (job.kind === 'data.importSql') {
      // SQL transfer: its tables went into collections of one database (its coll is '*'): the
      // database's collection list, stats and every view of its documents.
      void queryClient.invalidateQueries({ queryKey: ['connections', job.connectionId, 'databases', job.db] })
      // A database it created: the list of databases (its own query) shows it (review 2026-10-11).
      void queryClient.invalidateQueries({ queryKey: queryKeys.databases(job.connectionId), exact: true })
    } else if (job.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections(job.connectionId, job.db) })
    }
  }

  const sendFailure = useSendFailure().sentence
  const sendStartError = useSendStartError()
  const message = (job: JobView): { kind: 'success' | 'error' | 'info'; message: string } => {
    const name = job.target
    const error = job.error ?? ''
    // Short names review 14 (M3): a cancelled send that kept its only local copy says so.
    if (job.state === 'cancelled')
      return {
        kind: 'info',
        message:
          job.kind === 'backup.send' && (job as SendJobView).localKept
            ? t('backup.send.cancelledKept', { name })
            : t('jobs.cancelledNamed', { name }),
      }
    if (job.state === 'unknown') return { kind: 'info', message: t('jobs.unknownNamed', { name }) }
    if (job.state === 'interrupted') return { kind: 'error', message: t('jobs.interruptedNamed', { name }) }
    if (job.kind === 'index.create')
      return job.state === 'done'
        ? { kind: 'success', message: t('indexes.buildDone', { name }) }
        : { kind: 'error', message: t('indexes.buildFailed', { name, error }) }
    if (job.kind === 'data.import')
      return job.state === 'done'
        ? { kind: 'success', message: t('dataTransfer.importDone', { name }) }
        : { kind: 'error', message: t('dataTransfer.importFailed', { name, error }) }
    if (job.kind === 'data.importSql')
      return job.state === 'done'
        ? { kind: 'success', message: t('dataTransfer.sql.done', { name }) }
        : { kind: 'error', message: t('dataTransfer.sql.failed', { name, error }) }
    for (const [kind, key] of [
      ['data.copy', 'copy'],
      ['data.compare', 'compare'],
      ['data.sync', 'sync'],
    ] as const)
      if (job.kind === kind)
        return job.state === 'done'
          ? { kind: 'success', message: t(`dataTransfer.${key}.done`, { name }) }
          : { kind: 'error', message: t(`dataTransfer.${key}.failed`, { name, error }) }
    if (job.kind === 'backup.dump')
      return job.state === 'done'
        ? { kind: 'success', message: t('backup.done', { name }) }
        : { kind: 'error', message: t('backup.failed', { name, error }) }
    if (job.kind === 'backup.send')
      return job.state === 'done'
        ? {
            kind: 'success',
            // B12: an earlier destination of this backup failed, so its local copy stayed.
            message: job.localKept
              ? `${t('backup.send.done', { name })} ${t('backup.send.localKeptPlain')}`
              : t('backup.send.done', { name }),
          }
        : { kind: 'error', message: sendFailure(job) }
    // A finished download is not announced (see below): the restore sheet carries on.
    if (job.kind === 'backup.fetch')
      return {
        kind: 'error',
        message: error ? t('backup.remote.fetchFailed', { error }) : t('backup.remote.fetchFailedPlain'),
      }
    if (job.kind === 'backup.restore')
      return job.state === 'done'
        ? { kind: 'success', message: t('backup.restore.done', { name }) }
        : { kind: 'error', message: t('backup.restore.failed', { name, error }) }
    // W4.4: a restore drill, scheduled: it passed, or it found what the alerts are told about too.
    if (job.kind === 'backup.drill')
      return job.state === 'done'
        ? { kind: 'success', message: t('backup.drill.passed', { name }) }
        : { kind: 'error', message: t('backup.drill.failed', { name }) }
    if (job.kind === 'data.export')
      return job.state === 'done'
        ? { kind: 'success', message: t('dataTransfer.exportDone', { name }) }
        : { kind: 'error', message: t('dataTransfer.exportFailed', { name, error }) }
    return job.state === 'done'
      ? { kind: 'success', message: t('collection.duplicated', { name }) }
      : { kind: 'error', message: t('jobs.duplicateFailed', { name, error }) }
  }

  /** U8: a finished backup can be downloaded straight from its toast. */
  const download = (job: JobView): ToastAction => ({
    label: t('backup.list.download'),
    run: () => {
      void transferApi
        .report(job.id)
        .then((r) => {
          if (r.kind !== 'dump' || !r.backupId) return
          // Second review (N2): with a ticket in local mode, which a bare link never carried.
          return followApiLink(backupApi.downloadUrl(r.backupId), { download: '' })
        })
        .catch(() => undefined)
    },
  })
  /** Phase 3d-3b V8: a finished send opens its connection's Backups section. */
  const openBackups = (job: JobView): ToastAction => ({
    label: t('backup.send.open'),
    // Final review C26: the connections are read if nothing cached them; the scroll waits for the tab.
    run: () => void openBackupsSection(queryClient, tabs, job.connectionId),
  })
  /** W4.4 (U8): a finished backup or restore opens its report on the jobs page. */
  const openReport = (job: JobView): ToastAction => ({
    label: t('jobs.openReport'),
    run: () => {
      store.focus(job.id, { report: true })
      openJobsTab(tabs)
    },
  })
  /** W4.4 (U8): a finished restore opens what it wrote — its collection, or its database. */
  const openRestored = (job: JobView, target: RestoreTarget): ToastAction =>
    target.kind === 'collection'
      ? {
          label: t('jobs.openCollection'),
          run: () => void openCollectionTab(tabs, job.connectionId, target.db, target.coll),
        }
      : { label: t('jobs.openDatabase'), run: () => void openDatabaseTab(tabs, job.connectionId, target.db) }
  const BACKUP = new Set(['backup.dump', 'backup.restore', 'backup.send', 'backup.fetch', 'backup.drill'])
  const off = store.onFinished((job) => {
    refresh(job)
    if (!job.mine) return
    // A finished download: the restore sheet that asked for it says so.
    if (job.kind === 'backup.fetch' && job.state === 'done') return
    // A page that shows the job in sight says how it ended there: no toast besides (review 2026-10-11).
    if (isJobShown(job.id)) return
    const m = message(job)
    const done = job.state === 'done'
    if (job.kind === 'backup.restore' && done) {
      // What it wrote is in its report: "Open collection" joins the toast once it is read.
      const id = toasts.push({ ...m, actions: [openReport(job)] })
      void transferApi
        .report(job.id)
        .then((r) => {
          const target = r.kind === 'restore' ? restoreTarget(r) : null
          if (target) toasts.setActions(id, [openRestored(job, target), openReport(job)])
        })
        .catch(() => undefined)
    } else
      toasts.push({
        ...m,
        ...(job.kind === 'backup.dump' && done ? { actions: [download(job), openReport(job)] } : {}),
        ...(job.kind === 'backup.send' && done ? { actions: [openBackups(job)] } : {}),
      })
    // A long backup may end while the tab is in the background.
    if (BACKUP.has(job.kind)) notifyWhenHidden(t('app.name'), m.message)
    // Final review: a send queued after the dump that could not start says why (its report holds it).
    if (job.kind === 'backup.dump' && job.state === 'done')
      void transferApi
        .report(job.id)
        .then((r) => {
          if (r.kind === 'dump' && r.sendError)
            toasts.push({ kind: 'error', message: sendStartError(r.sendError) })
        })
        .catch(() => undefined)
  })
  onBeforeUnmount(off)

  // U8: asked once, when one's own backup has run for over a minute — never at load.
  let asked = false
  const askTimer = setInterval(() => {
    if (asked || !shouldAskNotifications()) return
    const long = store.running.some(
      (j) => j.mine && BACKUP.has(j.kind) && store.serverNow() - j.startedAt > 60_000,
    )
    if (!long) return
    asked = true
    toasts.push({
      kind: 'info',
      message: t('backup.notify.ask'),
      timeoutMs: 15_000,
      actions: [
        { label: t('backup.notify.allow'), run: () => void askNotifications().catch(() => undefined) },
        { label: t('backup.notify.later'), run: rememberAsked },
      ],
    })
  }, 15_000)
  onBeforeUnmount(() => clearInterval(askTimer))
}
