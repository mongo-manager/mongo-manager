import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BookOpen,
  Gauge,
  Lightbulb,
  MessageSquare,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-vue-next'
import type { AiCost, AiHistoryAction, AiHistoryItem } from '@mongo-manager/shared/browser'
import type { JobStatus } from '@/jobs/present'
import { useAiWords } from '../words'

/** User review 2026-10-09: what the AI history says about a request. */
export const ACTION_ICONS: Record<AiHistoryAction, Component> = {
  query: Search,
  pipeline: Workflow,
  explain: BookOpen,
  optimise: Gauge,
  validation: ShieldCheck,
  describe: Sparkles,
  chat: MessageSquare,
  // W6.2: the Overview's next steps put in order.
  nextActions: Lightbulb,
}

export function useHistoryWords() {
  const { t, locale } = useI18n()
  const ai = useAiWords()
  const action = (a: AiHistoryAction) => t(`aiHistory.action.${a}`)
  /** "Needs a pipeline" is an answer, not a failure (the server's outcome filter agrees). */
  const answered = (item: AiHistoryItem) => item.outcome === 'ok' || item.outcome === 'needs_pipeline'
  const status = (item: AiHistoryItem): JobStatus =>
    answered(item) ? 'done' : item.outcome === 'aborted' ? 'cancelled' : 'failed'
  const outcome = (item: AiHistoryItem) =>
    item.outcome === 'ok'
      ? t('aiHistory.outcome.ok')
      : item.outcome === 'aborted'
        ? t('aiHistory.outcome.aborted')
        : ai.reason(item.outcome)
  /** "12.4K" — tokens read at a glance; the exact number is in the details. */
  const tokens = (n: number) =>
    new Intl.NumberFormat(locale.value, {
      notation: n >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(n)
  const exact = (n: number) => new Intl.NumberFormat(locale.value).format(n)
  /** A cost in its currency — small ones with enough digits to be more than zero. */
  const money = (c: AiCost) => {
    const small = c.amount !== 0 && Math.abs(c.amount) < 0.01
    return new Intl.NumberFormat(locale.value, {
      style: 'currency',
      currency: c.currency,
      // Under a cent: its first three digits (never "$0.00"); otherwise cents, or tenths of them under 1.
      ...(small
        ? { maximumSignificantDigits: 3 }
        : { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(c.amount) < 1 ? 4 : 2 }),
    }).format(c.amount)
  }
  const costs = (list: AiCost[]) => (list.length ? list.map(money).join(' + ') : t('aiHistory.noPrice'))
  /** "2.4 s", "2,4 sn": the reader's decimal mark. */
  const ms = (n: number) =>
    n < 1000
      ? t('aiHistory.ms', { n: exact(n) })
      : t('aiHistory.seconds', {
          n: new Intl.NumberFormat(locale.value, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }).format(n / 1000),
        })
  return { t, locale, action, answered, status, outcome, tokens, exact, money, costs, ms }
}
