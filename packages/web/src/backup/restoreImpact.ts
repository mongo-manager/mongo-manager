import type { RestorePlan } from '@mongo-manager/shared/browser'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** What a restore does to one target, in a line of the plan. */
export function restoreImpact(
  t: Translate,
  n: RestorePlan['namespaces'][number],
  keys: string,
  count: (v: number) => string,
): string {
  if (n.skipped) return t('backup.restore.impact.skipped', { reason: n.skipped })
  if (n.type === 'view') return t('backup.restore.impact.view')
  if (n.action === 'replace') {
    // Backup review M8: what a replaced target keeps of its own.
    const kept = n.keepsOwn
    const key = !kept
      ? 'replace'
      : kept.indexes && kept.options
        ? 'replaceKeepsBoth'
        : kept.indexes
          ? 'replaceKeepsIndexes'
          : 'replaceKeepsOptions'
    return t(`backup.restore.impact.${key}`, { count: count(n.documents ?? 0) })
  }
  if (n.action === 'upsert') return t('backup.restore.impact.upsert', { keys })
  if (n.action === 'insert') return t('backup.restore.impact.insert', { count: count(n.documents ?? 0) })
  return t('backup.restore.impact.create')
}
