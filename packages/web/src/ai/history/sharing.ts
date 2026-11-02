import { computed } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { aiHistoryApi, aiHistoryKeys } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import { useHistoryWords } from './historyWords'

/** A request's link: the AI history's page for it, on this app's address (its base path too). */
export const requestLink = (id: string) =>
  new URL(`ai-history/${encodeURIComponent(id)}`, document.baseURI).href

/**
 * User review 2026-10-09 ("isterse AI geçmişini paylaşabilsin … ekip modu … birden fazla ekip
 * üyesi"): whether there is anyone to share with, and sharing (or taking back) a request's entry.
 */
export function useSharing() {
  const w = useHistoryWords()
  const toasts = useToastStore()
  const queryClient = useQueryClient()
  const sharing = useQuery({ queryKey: aiHistoryKeys.sharing, queryFn: aiHistoryApi.sharing })
  const available = computed(() => sharing.data.value?.available ?? false)
  async function set(id: string, on: boolean): Promise<void> {
    try {
      await (on ? aiHistoryApi.share(id) : aiHistoryApi.unshare(id))
      toasts.push({ kind: 'success', message: w.t(on ? 'aiHistory.share.done' : 'aiHistory.share.undone') })
      await queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all })
    } catch (e) {
      toasts.push({ kind: 'error', message: describeError(e, w.t) })
    }
  }
  async function copyLink(id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(requestLink(id))
      toasts.push({ kind: 'success', message: w.t('aiHistory.share.copied') })
    } catch {
      toasts.push({ kind: 'error', message: w.t('aiHistory.share.copyFailed') })
    }
  }
  return { available, set, copyLink }
}
