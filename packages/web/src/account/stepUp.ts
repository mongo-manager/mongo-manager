import { startAuthentication } from '@simplewebauthn/browser'
import { api, ApiError } from '@/api/client'
import { explainError } from '@/api/reasons'
import { passkeyErrorKey } from '@/auth/passkeys'
import { i18n } from '@/i18n'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'

/** The answer when the person would not prove a second factor: the action stops without a message. */
export const STEP_UP_DECLINED = Symbol('step-up declined')

function stepUpMethods(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.code !== 'FORBIDDEN') return null
  const d = (e.details ?? {}) as { reason?: unknown; methods?: unknown }
  if (d.reason !== 'step_up_required') return null
  return Array.isArray(d.methods) ? d.methods.filter((m): m is string => typeof m === 'string') : []
}

async function withPasskey(): Promise<void> {
  const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    'auth/step-up/passkey/options',
    {},
  )
  const response = await startAuthentication({ optionsJSON })
  await api.post<void>('auth/step-up/passkey', { response })
}

/** Asks for a second factor and proves it in this session; false when it was not given. */
async function proveSecondFactor(methods: string[]): Promise<boolean> {
  const t = i18n.global.t
  const dialogs = useDialogStore()
  const toasts = useToastStore()
  if (methods.includes('passkey')) {
    const usePasskey = await dialogs.confirm({
      title: t('security.stepUp.title'),
      message: t('security.stepUp.passkeyMessage'),
      confirmLabel: t('security.stepUp.usePasskey'),
    })
    if (usePasskey) {
      try {
        await withPasskey()
        return true
      } catch (e) {
        toasts.push({
          kind: 'error',
          message: e instanceof ApiError ? explainError(e, t) : t(passkeyErrorKey(e)),
        })
      }
    }
  }
  const code = await dialogs.prompt({
    title: t('security.stepUp.title'),
    message: methods.includes('totp')
      ? t('security.stepUp.codeMessage')
      : t('security.stepUp.recoveryMessage'),
    confirmLabel: t('common.continue'),
    input: { type: 'text', label: t('security.stepUp.code'), autocomplete: 'off' },
  })
  if (!code?.trim()) return false
  try {
    await api.post<void>('auth/step-up', { code: code.trim() })
    return true
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
    return false
  }
}

/**
 * Security review 2026-10-13 (L2): managing second factors takes one proved in this session lately.
 * Runs the action; when the server asks for that, asks the person and runs it once more.
 */
export async function withStepUp<T>(run: () => Promise<T>): Promise<T | typeof STEP_UP_DECLINED> {
  try {
    return await run()
  } catch (e) {
    const methods = stepUpMethods(e)
    if (!methods) throw e
    if (!(await proveSecondFactor(methods))) return STEP_UP_DECLINED
    return run()
  }
}
