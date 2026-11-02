import { useI18n } from 'vue-i18n'
import type { BackupScope, CronFieldName } from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

/** A moment in a schedule's own zone ("Tue 6 Oct, 02:00"): its times are wall-clock times there. */
export function zonedTime(t: number, zone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t)
}

/** What a schedule backs up, in a few words. */
export function useScopeWords() {
  const { t } = useI18n()
  return (scope: BackupScope): string =>
    scope.kind === 'collection'
      ? `${scope.db}.${scope.coll}`
      : scope.kind === 'database'
        ? scope.collections
          ? t(
              'schedules.scope.someCollections',
              { db: scope.db, count: scope.collections.length },
              scope.collections.length,
            )
          : scope.db
        : scope.databases
          ? t('schedules.scope.someDatabases', { count: scope.databases.length }, scope.databases.length)
          : t('schedules.scope.server')
}

/** Final review minor 2: a refused cron expression in the reader's language, naming the field. */
export function useCronWords() {
  const { t, te } = useI18n()
  return (p: { field: CronFieldName | null; message: string; code?: string; params?: object }): string => {
    if (!p.code || !te(`schedules.cron.${p.code}`)) return p.message
    const field = p.field ? t(`schedules.cron.field.${p.field}`) : ''
    // Code in a message travels as a parameter (vue-i18n reads "@" as a link).
    return t(`schedules.cron.${p.code}`, { daily: '@daily', reboot: '@reboot', ...p.params, field })
  }
}

/** A refused save or action in the reader's words (schedules.refusal.*, keys.reason.*). */
export function useScheduleError() {
  const { t, te } = useI18n()
  const cronWords = useCronWords()
  return (e: unknown): string => {
    const d = (e instanceof ApiError ? e.details : undefined) as
      | {
          reason?: unknown
          problem?: { minutes?: number; field?: CronFieldName | null; code?: string; params?: object }
          count?: number
          name?: unknown
        }
      | undefined
    const reason = typeof d?.reason === 'string' ? d.reason : null
    // A cron expression's problem names the field and the value; an older server's own words otherwise.
    if (reason === 'cadence_cron' && e instanceof ApiError)
      return cronWords({ field: d?.problem?.field ?? null, message: e.message, ...d?.problem })
    if (reason && te(`schedules.refusal.${reason}`))
      return t(`schedules.refusal.${reason}`, { minutes: d?.problem?.minutes ?? 0, count: d?.count ?? 0 })
    if (reason && te(`keys.reason.${reason}`))
      return t(`keys.reason.${reason}`, { name: String(d?.name ?? '') })
    return describeError(e, t)
  }
}

/** A run's reason in words; a pause reason says why the schedule paused. */
export function useRunReason() {
  const { t, te } = useI18n()
  return (reason: string | null, byName = ''): string | null => {
    if (!reason) return null
    if (te(`schedules.pause.${reason}`)) return t(`schedules.pause.${reason}`, { name: byName })
    if (te(`schedules.reason.${reason}`)) return t(`schedules.reason.${reason}`)
    return reason
  }
}
