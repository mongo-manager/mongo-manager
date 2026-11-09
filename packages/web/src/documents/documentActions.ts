// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { documentKeys, documentsApi, type CollectionTarget } from '@/api/documents'
import { queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import type { DocumentRow, Row } from './rows'
import { rowId } from './rowMenu'
import { toShell } from './values'

export function useDocumentActions(target: Ref<CollectionTarget>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const dialogs = useDialogStore()
  const toasts = useToastStore()

  /** Pages, counts and the collection's stats all change with its documents. */
  const refresh = () => {
    const { connectionId, db, coll } = target.value
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: documentKeys.all(target.value) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collectionStats(connectionId, db, coll) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.databaseStats(connectionId, db) }),
    ])
  }

  async function copy(row: DocumentRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(toShell(row.value))
      toasts.push({ kind: 'success', message: t('documents.copied') })
    } catch {
      toasts.push({ kind: 'error', message: t('documents.copyFailed') })
    }
  }

  async function remove(row: Row): Promise<void> {
    const ok = await dialogs.confirm({
      title: t('documents.deleteTitle'),
      message: t('documents.deleteConfirm', { id: rowId(row) }),
      confirmLabel: t('documents.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await documentsApi.remove(target.value, row.kind === 'document' ? row.raw._id : row.rawId)
      await refresh()
      toasts.push({ kind: 'success', message: t('documents.deleted') })
    } catch (e) {
      toasts.push({ kind: 'error', message: describeError(e, t) })
    }
  }

  return { copy, remove, refresh }
}
