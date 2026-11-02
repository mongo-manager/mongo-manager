import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { reasonMessage } from '@/api/reasons'
import { fieldErrors } from './fieldPaths'

/**
 * Server validation → per-field messages (by issue path) plus general messages.
 * Issues for fields the form does not show (`isRendered` false) are listed as general messages,
 * so a refused save never looks like nothing happened; `flatten` lists every issue that way.
 */
export function useFormErrors(opts: { flatten?: boolean; isRendered?: (key: string) => boolean } = {}) {
  const { t } = useI18n()
  const fields = ref<Record<string, string>>({})
  const general = ref<string[]>([])

  function reset(): void {
    fields.value = {}
    general.value = []
  }

  function showError(e: unknown): void {
    reset()
    const named = reasonMessage(e, t)
    if (named) {
      general.value = [named]
      return
    }
    if (!(e instanceof ApiError) || e.code !== 'VALIDATION_ERROR') {
      general.value = [describeError(e, t)]
      return
    }
    const mapped = fieldErrors(e.details)
    const shown = (key: string) => !opts.flatten && (opts.isRendered?.(key) ?? true)
    const listed: string[] = []
    for (const [key, message] of Object.entries(mapped.fields)) {
      if (shown(key)) fields.value[key] = message
      else listed.push(`${key}: ${message}`)
    }
    const all = [...mapped.general, ...listed]
    general.value = all.length > 0 || Object.keys(fields.value).length > 0 ? all : [e.message]
  }

  const errorFor = (key: string): string | undefined =>
    fields.value[key] ? t('connection.invalidField', { message: fields.value[key] }) : undefined

  return { fields, general, reset, showError, errorFor }
}
