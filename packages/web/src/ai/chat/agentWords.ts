import { useI18n } from 'vue-i18n'
import { MIN_BACKUP_PASSWORD, type AiAgentPlace, type AiAgentStep } from '@mongo-manager/shared/browser'
import { formatCount } from '@/format'

/**
 * A connection failure's kind as the reason a step gives (the server's own mapping). Review of A5
 * (I1): one it cannot sort is "failed" — connection_unknown is a connection the agent may not use.
 */
export const connectionReason = (kind: string): string =>
  kind === 'unknown' ? 'connection_failed' : `connection_${kind}`

/** W6.3: an agent's steps in the reader's language. */
export function useAgentWords() {
  const { t, te, locale } = useI18n()
  const count = (n: number) => formatCount(n, locale.value)
  const reason = (code: string) =>
    te(`ai.agent.reason.${code}`)
      ? t(`ai.agent.reason.${code}`, { n: MIN_BACKUP_PASSWORD })
      : t('ai.agent.reason.other', { code })
  /** What a step found or did, in a few words (never document values). */
  function summary(step: AiAgentStep): string | null {
    const s = step.summary
    if (!s) return null
    const n = (k: string) => Number(s[k] ?? 0)
    const parts: string[] = []
    for (const key of [
      'connections',
      'databases',
      'collections',
      'indexes',
      'destinations',
      'fields',
      'jobs',
      'backups',
      'schedules',
      // Design 2026-10-25 (B3): the server's health.
      'members',
      'operations',
      'queries',
      'suggestions',
      'unneeded',
      // B4: MongoDB's users and roles.
      'users',
      'roles',
      // C2.
      'distinct',
    ] as const)
      if (key in s) parts.push(t(`ai.agent.summary.${key}`, { n: count(n(key)) }, n(key)))
    if ('count' in s) parts.push(t('ai.agent.summary.count', { n: count(n('count')) }, n('count')))
    if ('returned' in s)
      parts.push(
        t(
          s.more ? 'ai.agent.summary.returnedMore' : 'ai.agent.summary.returned',
          { n: count(n('returned')) },
          n('returned'),
        ),
      )
    if ('stage' in s && s.stage) parts.push(t('ai.agent.summary.stage', { stage: String(s.stage) }))
    if ('created' in s) parts.push(t('ai.agent.summary.created', { name: String(s.created) }))
    if ('inserted' in s)
      parts.push(t('ai.agent.summary.inserted', { n: count(n('inserted')) }, n('inserted')))
    if ('modified' in s)
      parts.push(
        t(
          'ai.agent.summary.modified',
          { n: count(n('modified')), matched: count(n('matched')) },
          n('modified'),
        ),
      )
    else if ('matched' in s)
      parts.push(t('ai.agent.summary.matched', { n: count(n('matched')) }, n('matched')))
    if ('deleted' in s) parts.push(t('ai.agent.summary.deleted', { n: count(n('deleted')) }, n('deleted')))
    if ('dropped' in s) parts.push(t('ai.agent.summary.dropped', { name: String(s.dropped) }))
    if ('renamed' in s) parts.push(t('ai.agent.summary.renamed', { name: String(s.renamed) }))
    // Design 2026-10-25 (C7): what was done to an alert rule or a report.
    if (typeof s.alertRule === 'string' && te(`ai.agent.summary.alertRule.${s.alertRule}`))
      parts.push(t(`ai.agent.summary.alertRule.${s.alertRule}`))
    if (typeof s.report === 'string' && te(`ai.agent.summary.report.${s.report}`))
      parts.push(
        t(
          `ai.agent.summary.report.${s.report}`,
          { name: String(s.name ?? ''), n: count(typeof s.counts === 'number' ? s.counts : 0) },
          // The count chooses the plural (a run's words have one).
          typeof s.counts === 'number' ? s.counts : 1,
        ),
      )
    if (typeof s.alerts === 'number')
      parts.push(t('ai.agent.summary.alerts', { n: count(s.alerts) }, s.alerts))
    // Review of C7b (nit): each said with its own plural.
    if (typeof s.rules === 'number' && typeof s.reports === 'number')
      parts.push(
        t('ai.agent.summary.rules', { n: count(s.rules) }, s.rules),
        t('ai.agent.summary.reports', { n: count(s.reports) }, s.reports),
      )
    // Design 2026-10-25 (C4): a plan of changes shown.
    if (step.tool === 'plan_changes' && typeof s.changes === 'number')
      parts.push(t('ai.agent.summary.planned', { n: count(s.changes) }, s.changes))
    if ('killed' in s) parts.push(t('ai.agent.summary.killed', { opid: String(s.killed) }))
    // Review of B3: a server's version; a replica set's mode where it is none.
    if (typeof s.version === 'string') parts.push(t('ai.agent.summary.version', { version: s.version }))
    if (typeof s.mode === 'string' && te(`ai.agent.summary.mode.${s.mode}`))
      parts.push(t(`ai.agent.summary.mode.${s.mode}`))
    // Design 2026-10-25 (B1): what was done to a schedule, by its name.
    if (
      typeof s.did === 'string' &&
      typeof s.schedule === 'string' &&
      te(`ai.agent.summary.schedule.${s.did}`)
    )
      parts.push(t(`ai.agent.summary.schedule.${s.did}`, { name: s.schedule }))
    else if (s.started === true) parts.push(t('ai.agent.summary.started'))
    // User request 2026-10-26 (review, minor 2): a backup made without a password, said so.
    if (step.tool === 'run_backup' && s.format === 'gzip') parts.push(t('ai.agent.summary.plainBackup'))
    // Design 2026-10-25 (C3): a collection's validation rules set or removed.
    if (typeof s.validator === 'string' && te(`ai.agent.summary.validator.${s.validator}`))
      parts.push(t(`ai.agent.summary.validator.${s.validator}`))
    // Design 2026-10-25 (A5): what a connection check found.
    if (s.connected === true) parts.push(t('ai.agent.summary.connected'))
    if (s.connected === false)
      // Review of A5 (N2): the words a read meeting the same failure says.
      parts.push(reason(connectionReason(typeof s.problem === 'string' ? s.problem : 'unknown')))
    if (typeof s.state === 'string')
      parts.push(t('ai.agent.summary.state', { state: t(`ai.agent.jobState.${s.state}`) }))
    // Design 2026-10-25 (C6): a large collection read whole — said while it runs, and after.
    // Review of C6 (I2): one that may stop at its first matches is said as such.
    const may = s.scanMay === true ? 'May' : ''
    if (typeof s.scanning === 'number')
      parts.push(t(`ai.agent.summary.scanning${may}`, { n: count(s.scanning) }, s.scanning))
    if (typeof s.scanned === 'number')
      parts.push(t(`ai.agent.summary.scanned${may}`, { n: count(s.scanned) }, s.scanned))
    if (typeof s.message === 'string') parts.push(s.message)
    return parts.length ? parts.join(' · ') : null
  }
  /** Where a step acts: "Sales Mongo · sales.users". */
  const place = (p: AiAgentPlace | null, name: (id: string) => string) =>
    p
      ? [p.connection || name(p.connectionId), p.db ? (p.coll ? `${p.db}.${p.coll}` : p.db) : null]
          .filter(Boolean)
          .join(' · ')
      : null
  const sent = (step: AiAgentStep) =>
    step.sent
      ? step.sent === 'documents'
        ? t('ai.agent.sent.documents', { n: count(step.documents ?? 0) }, step.documents ?? 0)
        : t(`ai.agent.sent.${step.sent}`)
      : null
  return {
    tool: (tool: string) => t(`ai.agent.tool.${tool}`),
    state: (state: string) => t(`ai.agent.state.${state}`),
    reason,
    summary,
    place,
    sent,
  }
}
