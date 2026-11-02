import { ref } from 'vue'
import { ApiError } from '@/api/client'
import { backupApi } from '@/api/backup'

const PART = 8 * 1024 * 1024
const RETRIES = 5

/**
 * Plan ruling 2, U4, U8: a file goes up in 8 MiB parts. A failed part is retried after asking the
 * server how much it already has; progress, speed and the time left are live.
 */
export function useResumableUpload() {
  const uploadId = ref<string | null>(null)
  const sent = ref(0)
  const total = ref(0)
  const speed = ref(0)
  const eta = ref<number | null>(null)
  const state = ref<'idle' | 'uploading' | 'resuming' | 'done' | 'error'>('idle')
  const error = ref<unknown>(null)
  let controller: AbortController | null = null

  // A network failure, a gateway error, a lost place, or a part that stalled or was cut (the server
  // kept what arrived) can be resumed; a refusal cannot (final review minor 7).
  const RESUMABLE_REASONS = new Set(['upload_idle', 'upload_aborted', 'upload_busy'])
  const resumable = (e: unknown) =>
    !(e instanceof ApiError) ||
    e.status >= 500 ||
    e.status === 409 ||
    RESUMABLE_REASONS.has(String((e.details as { reason?: unknown } | undefined)?.reason))

  async function start(file: File): Promise<string> {
    controller = new AbortController()
    const signal = controller.signal
    state.value = 'uploading'
    error.value = null
    sent.value = 0
    total.value = file.size
    speed.value = 0
    eta.value = null
    try {
      const created = await backupApi.createUpload({ name: file.name, size: file.size })
      uploadId.value = created.uploadId
      const started = performance.now()
      let offset = 0
      let failures = 0
      while (offset < file.size) {
        try {
          const r = await backupApi.uploadPart(created.uploadId, offset, file.slice(offset, offset + PART), {
            signal,
          })
          offset = r.received
          failures = 0
          state.value = 'uploading'
        } catch (e) {
          if (signal.aborted || ++failures > RETRIES || !resumable(e)) throw e
          state.value = 'resuming'
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** failures)))
          offset = (await backupApi.uploadStatus(created.uploadId)).received
        }
        sent.value = offset
        const seconds = (performance.now() - started) / 1000
        speed.value = seconds > 0 ? offset / seconds : 0
        eta.value = speed.value > 0 ? (file.size - offset) / speed.value : null
      }
      state.value = 'done'
      eta.value = 0
      return created.uploadId
    } catch (e) {
      state.value = 'error'
      error.value = e
      throw e
    }
  }

  return { start, uploadId, sent, total, speed, eta, state, error, abort: () => controller?.abort() }
}
