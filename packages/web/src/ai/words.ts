import { useI18n } from 'vue-i18n'
import type { AiAction } from '@mongo-manager/shared/browser'

/** Phase 4a-1: reasons, warnings and parse outcomes in the reader's language. */
export function useAiWords() {
  const { t, te } = useI18n()
  const word = (group: string, code: string) =>
    te(`ai.${group}.${code}`) ? t(`ai.${group}.${code}`) : t('ai.reason.provider_error')
  return {
    reason: (code: string, retryAfterMs?: number) => {
      // The server's 429 says RATE_LIMITED (its error code) with when to try again; the provider's says rate_limited.
      const c = code === 'RATE_LIMITED' ? 'rate_limited' : code
      return c === 'rate_limited' && retryAfterMs !== undefined
        ? t('ai.reason.rate_limited_in', { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) })
        : word('reason', c)
    },
    warning: (code: string) => word('warning', code),
    parse: (code: string) => word('parse', code),
    action: (a: AiAction) => t(`ai.action.${a}`),
  }
}
