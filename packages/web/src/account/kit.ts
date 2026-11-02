import { useI18n } from 'vue-i18n'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

/** D7: a kit is read only up to this size, as the server reads it. */
export const MAX_KIT_BYTES = 8192
export class KitFileError extends Error {}

/** A recovery kit's text from its file; a larger file is no kit. */
export async function readKitFile(file: File): Promise<string> {
  if (file.size > MAX_KIT_BYTES) throw new KitFileError('too_large')
  return file.text()
}

/** A key or kit refusal in the reader's words (keys.reason.*). */
export function useKeyError() {
  const { t, te } = useI18n()
  return (e: unknown): string => {
    if (e instanceof KitFileError) return t('backup.unlock.tooLarge')
    const d = (e instanceof ApiError ? e.details : undefined) as
      { reason?: unknown; name?: unknown } | undefined
    if (typeof d?.reason === 'string' && te(`keys.reason.${d.reason}`))
      return t(`keys.reason.${d.reason}`, { name: String(d.name ?? '') })
    return describeError(e, t)
  }
}
