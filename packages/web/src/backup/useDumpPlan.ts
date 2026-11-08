// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import type { DumpPlan } from '@mongo-manager/shared/browser'
import { backupApi } from '@/api/backup'

/**
 * U2: the plan follows the settings, 300 ms after the last change. A newer request cancels the one
 * in flight, so a late answer never wins.
 */
export function useDumpPlan(connectionId: string, body: ComputedRef<object>) {
  const plan = ref<DumpPlan | null>(null)
  const loading = ref(false)
  const error = ref<unknown>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | null = null

  const run = () => {
    clearTimeout(timer)
    // A plan still on its way is for settings that just changed: it must not end the loading
    // (Start would use its stale hash).
    inflight?.abort()
    inflight = null
    loading.value = true
    timer = setTimeout(
      () =>
        void (async () => {
          const mine = new AbortController()
          inflight = mine
          try {
            const p = await backupApi.dumpPlan(connectionId, body.value, { signal: mine.signal })
            if (inflight === mine) {
              plan.value = p
              error.value = null
            }
          } catch (e) {
            if (inflight === mine && !mine.signal.aborted) error.value = e
          } finally {
            if (inflight === mine) {
              loading.value = false
              inflight = null
            }
          }
        })(),
      300,
    )
  }
  watch(body, run, { deep: true, immediate: true })
  onBeforeUnmount(() => {
    clearTimeout(timer)
    inflight?.abort()
  })
  return { plan, loading, error, refresh: run }
}
