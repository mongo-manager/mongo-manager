import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CollectionTarget } from '@/api/documents'
import { favouritesApi } from '@/api/library'
import { saveError } from '@/library/errors'
import { useToastStore } from '@/stores/toasts'
import type { FindTemplate } from './queryBuild'

/**
 * Phase 2c: a find saved as a favourite — its filter parts (skip, limit and the time limit are page
 * settings, not the query). W1 (completion §2): shared by the composer (the query typed) and the
 * query panel (the query in use); the query is fixed when the dialog opens.
 */
export function useFavouriteSave(target: () => CollectionTarget | undefined) {
  const { t } = useI18n()
  const toasts = useToastStore()
  const open = ref(false)
  const busy = ref(false)
  const error = ref('')
  let pending: FindTemplate | null = null
  let defaults: Record<string, string> = {}

  /**
   * Query parameters (spec 2026-10-28): a template is saved as typed, each parameter's value as its
   * default (an empty one is none).
   */
  function start(query: FindTemplate, params: Record<string, string> = {}): void {
    pending = query
    defaults = Object.fromEntries(
      Object.entries(params).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
    )
    error.value = ''
    open.value = true
  }

  async function save(item: { name: string; tags: string[]; shared: boolean }): Promise<void> {
    const where = target()
    const q = pending
    if (!q || !where || busy.value) return
    busy.value = true
    try {
      await favouritesApi.create(where, {
        name: item.name,
        tags: item.tags,
        query: {
          filter: q.filter,
          ...(q.projection ? { projection: q.projection } : {}),
          ...(q.sort ? { sort: q.sort } : {}),
          ...(q.collation ? { collation: q.collation } : {}),
          ...(q.hint !== undefined ? { hint: q.hint } : {}),
          ...(Object.keys(defaults).length > 0 ? { params: defaults } : {}),
        },
        shared: item.shared,
      })
      open.value = false
      pending = null
      toasts.push({ kind: 'success', message: t('library.favouriteSaved', { name: item.name }) })
    } catch (e) {
      error.value = saveError(e, t)
    } finally {
      busy.value = false
    }
  }

  return { open, busy, error, start, save }
}
