// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useI18n } from 'vue-i18n'
import { MIN_MONGODB_VERSION } from '@mongo-manager/shared/browser'
import { useQueryClient } from '@tanstack/vue-query'
import { connectionsApi, queryKeys, type ConnectionDto, type TestResult } from '@/api/connections'
import { gridfsKeys } from '@/api/gridfs'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'

/** Connection, database and collection actions shared by the tree, the tabs and the palette. */
export function useConnectionActions() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const dialogs = useDialogStore()
  const tabs = useTabsStore()
  const toasts = useToastStore()

  const fail = (e: unknown): void => {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
  const refreshList = () => queryClient.invalidateQueries({ queryKey: queryKeys.connections, exact: true })

  function describeTest(result: TestResult): { kind: 'success' | 'error'; message: string } {
    return result.ok
      ? {
          kind: 'success',
          message: t('connection.testOk', {
            version: result.serverVersion,
            topology: t(`connection.topology.${result.topology}`),
            ms: result.latencyMs,
          }),
        }
      : {
          kind: 'error',
          message: `${t(`mongo.kinds.${result.error.kind}`, { min: MIN_MONGODB_VERSION })} ${result.error.message}${
            result.error.remembered ? ` ${t('mongo.rememberedTest')}` : ''
          }`,
        }
  }

  async function deleteConnection(c: ConnectionDto): Promise<void> {
    const ok = await dialogs.confirm({
      title: t('connection.delete'),
      message: t('connection.deleteConfirm', { name: c.name }),
      confirmLabel: t('menu.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await connectionsApi.remove(c.id)
      tabs.closeWhere((tab) => tab.params.connectionId === c.id)
      queryClient.removeQueries({ queryKey: ['connections', c.id] })
      await refreshList()
      toasts.push({ kind: 'success', message: t('connection.deleted') })
    } catch (e) {
      fail(e)
    }
  }

  async function toggleFavorite(c: ConnectionDto): Promise<void> {
    try {
      await connectionsApi.update(c.id, { favorite: !c.favorite })
      await refreshList()
    } catch (e) {
      fail(e)
    }
  }

  async function testSaved(c: ConnectionDto): Promise<void> {
    try {
      const result = await connectionsApi.testSaved(c.id)
      toasts.push(describeTest(result))
      // User report 2026-10-23: a server that answers again is read again, so what needs it is shown.
      if (result.ok) rereadIfFailed(c.id)
    } catch (e) {
      fail(e)
    }
  }

  const refreshConnection = (id: string) => queryClient.invalidateQueries({ queryKey: ['connections', id] })
  /** A connection's databases whose last read failed, read again (by any screen that shows them). */
  const rereadIfFailed = (id: string): void => {
    if (queryClient.getQueryState(queryKeys.databases(id))?.status !== 'error') return
    void queryClient.invalidateQueries({ queryKey: queryKeys.databases(id), exact: true })
  }
  const refreshDatabase = (id: string, db: string) => {
    rereadIfFailed(id)
    return queryClient.invalidateQueries({ queryKey: ['connections', id, 'databases', db] })
  }

  async function dropDatabase(connectionId: string, db: string): Promise<void> {
    const ok = await dialogs.confirm({
      title: t('database.drop'),
      message: t('database.dropConfirm', { name: db }),
      confirmLabel: t('menu.drop'),
      danger: true,
      requireText: db,
    })
    if (!ok) return
    try {
      await connectionsApi.dropDatabase(connectionId, db)
      tabs.closeWhere((tab) => tab.params.connectionId === connectionId && tab.params.db === db)
      queryClient.removeQueries({ queryKey: ['connections', connectionId, 'databases', db] })
      queryClient.removeQueries({ queryKey: gridfsKeys.all(connectionId, db) })
      await queryClient.invalidateQueries({ queryKey: queryKeys.databases(connectionId), exact: true })
      toasts.push({ kind: 'success', message: t('database.dropped', { name: db }) })
    } catch (e) {
      fail(e)
    }
  }

  /** Menu sweep 2026-10-08: a view is dropped as a view (its collection stays), and says so. */
  async function dropCollection(connectionId: string, db: string, coll: string, view = false): Promise<void> {
    const ok = await dialogs.confirm({
      title: view ? t('collection.dropView') : t('collection.drop'),
      message: view
        ? t('collection.dropViewConfirm', { name: coll })
        : t('collection.dropConfirm', { name: coll }),
      confirmLabel: t('menu.drop'),
      danger: true,
      requireText: coll,
    })
    if (!ok) return
    try {
      await connectionsApi.dropCollection(connectionId, db, coll)
      tabs.closeWhere(
        (tab) => tab.params.connectionId === connectionId && tab.params.db === db && tab.params.coll === coll,
      )
      // Everything read of it — pages, counts, indexes, stats — goes with it: a new collection of
      // the same name starts empty (review 2026-10-13, web).
      queryClient.removeQueries({ queryKey: [...queryKeys.collections(connectionId, db), coll] })
      // A GridFS bucket's lists live apart (review of the web fixes, minor 3).
      if (/\.(?:files|chunks)$/.test(coll))
        queryClient.removeQueries({ queryKey: gridfsKeys.all(connectionId, db) })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.collections(connectionId, db), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.databaseStats(connectionId, db) }),
        // MongoDB drops a database together with its last collection.
        queryClient.invalidateQueries({ queryKey: queryKeys.databases(connectionId), exact: true }),
      ])
      toasts.push({
        kind: 'success',
        message: view ? t('collection.viewDropped', { name: coll }) : t('collection.dropped', { name: coll }),
      })
    } catch (e) {
      fail(e)
    }
  }

  return {
    describeTest,
    deleteConnection,
    toggleFavorite,
    testSaved,
    refreshConnection,
    refreshDatabase,
    dropDatabase,
    dropCollection,
  }
}
