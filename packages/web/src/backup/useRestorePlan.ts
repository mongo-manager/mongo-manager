import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { RestorePlan } from '@mongo-manager/shared/browser'
import { backupApi } from '@/api/backup'
import { readBusyWait } from './readBusy'

/**
 * U5, U6: the restore plan follows the mapping and the mode, 300 ms after the last change; a newer
 * request cancels the one in flight. A null body means "not yet" (the upload is still arriving).
 */
export function useRestorePlan(connectionId: Ref<string>, body: ComputedRef<object | null>) {
  const plan = ref<RestorePlan | null>(null)
  const loading = ref(false)
  const error = ref<unknown>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | null = null

  const run = () => {
    clearTimeout(timer)
    // A plan still on its way is for settings that just changed: it must not end the loading.
    inflight?.abort()
    inflight = null
    if (!body.value) {
      loading.value = false
      // Review (M5): an earlier plan's error (another target's) is not this one's.
      error.value = null
      return
    }
    loading.value = true
    timer = setTimeout(
      () =>
        void (async () => {
          const mine = new AbortController()
          inflight = mine
          try {
            const p = await backupApi.restorePlan(connectionId.value, body.value!, { signal: mine.signal })
            if (inflight === mine) {
              plan.value = p
              error.value = null
            }
          } catch (e) {
            if (inflight === mine && !mine.signal.aborted) {
              // The server is still reading the backup (round 2, I7): the plan is asked for again.
              const wait = readBusyWait(e)
              if (wait !== null) {
                inflight = null
                timer = setTimeout(run, wait)
                return
              }
              error.value = e
            }
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
  watch([connectionId, body], run, { deep: true, immediate: true })
  onBeforeUnmount(() => {
    clearTimeout(timer)
    inflight?.abort()
  })
  return { plan, loading, error, refresh: run }
}
