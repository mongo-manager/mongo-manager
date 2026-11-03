import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { reasonKey } from '@/api/reasons'
import {
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  Copy,
  Flag,
  Hourglass,
  Radio,
  RefreshCw,
  TriangleAlert,
} from 'lucide-vue-next'
import type { LiveSyncState, LiveSyncView } from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

export type Tone = 'success' | 'info' | 'warning' | 'error' | 'neutral'
export const STATE_TONE: Record<LiveSyncState, Tone> = {
  copying: 'info',
  catching_up: 'info',
  live: 'success',
  paused: 'neutral',
  attention: 'warning',
  retrying: 'warning',
  cutting_over: 'info',
  completed: 'success',
  failed: 'error',
  stopped: 'neutral',
}
export const STATE_ICON: Record<LiveSyncState, Component> = {
  copying: Copy,
  catching_up: Hourglass,
  live: Radio,
  paused: CirclePause,
  attention: TriangleAlert,
  retrying: RefreshCw,
  cutting_over: Flag,
  completed: CircleCheck,
  failed: CircleX,
  stopped: CircleStop,
}
export const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  info: 'bg-accent-soft text-accent-fg',
  warning: 'bg-warning-soft text-warning',
  error: 'bg-danger-soft text-danger',
  neutral: 'bg-subtle text-fg-muted',
}

export type CardAction =
  | 'pause'
  | 'resume'
  | 'verify'
  | 'finish'
  | 'stop'
  | 'remove'
  | 'details'
  | 'skip'
  | 'applySchema'
  | 'ignoreSchema'
  | 'review'
  | 'startAgain'

/** Phase 3e-2 spec §2.3, §5: states, reasons, refusals and warnings in the reader's language. */
export function useLiveSyncWords() {
  const { t, te } = useI18n()
  const state = (s: LiveSyncState) => t(`liveSync.state.${s}`)
  /** Why a sync is where it is, or null. A paused sync says who paused it. */
  const reason = (s: Pick<LiveSyncView, 'state' | 'reason' | 'pausedBy' | 'detail'>): string | null => {
    if (!s.reason) return null
    if (s.state === 'paused')
      return s.pausedBy?.startsWith('admin:')
        ? t('liveSync.reason.adminBy', { name: s.pausedBy.slice(6) })
        : t(`liveSync.reason.${s.reason}`)
    return te(`liveSync.reason.${s.reason}`) ? t(`liveSync.reason.${s.reason}`) : s.reason
  }
  // Seventh review of the open's stop (minor 2): a refusal is said where its words are — a live
  // sync's own, a copy's, a connection's — and as `unknown` (its code by default) where there are none.
  const refusalKey = (code: string) =>
    [`liveSync.refusal.${code}`, `dataTransfer.copy.refusal.${code}`, reasonKey(code)].find(
      (k): k is string => !!k && te(k),
    )
  const refusal = (code: string, unknown = code) => {
    const key = refusalKey(code)
    return key ? t(key) : unknown
  }
  /** Final review I8: why a sync retries, or which stream error waits for a person. */
  const cause = (code: string) => (te(`liveSync.cause.${code}`) ? t(`liveSync.cause.${code}`) : code)
  const warning = (code: string) => (te(`liveSync.warning.${code}`) ? t(`liveSync.warning.${code}`) : code)
  /** A refused action in words: a refusal code first, then the server's own error. */
  const error = (e: unknown): string => {
    const d = (e instanceof ApiError ? e.details : undefined) as
      { reason?: unknown; reasons?: unknown } | undefined
    if (Array.isArray(d?.reasons) && d.reasons.length)
      return d.reasons.map((r) => refusal(String(r))).join(' ')
    // Eighth review of the open's stop (minor 1): a field the planner may not read is named, as the
    // masking words name it; the live sync's own sentence (which names none) is for the card.
    const field = (d as { field?: unknown } | undefined)?.field
    if (
      e instanceof ApiError &&
      e.code === 'FORBIDDEN' &&
      d?.reason === 'personal_field' &&
      typeof field === 'string'
    )
      return t('masking.personalField', { field })
    if (typeof d?.reason === 'string' && refusalKey(d.reason)) return refusal(d.reason)
    return describeError(e, t)
  }
  return { state, reason, refusal, cause, warning, error }
}
