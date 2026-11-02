import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { JobView } from '@mongo-manager/shared'
import { connectionsApi, queryKeys } from '@/api/connections'
import { formatElapsed } from './elapsed'
import { kindKey } from './labels'
import { clock, statusOf } from './present'

/**
 * The words the jobs panel and page say about a job (user review 2026-10-08): its kind, its state,
 * its connection by name, and — once over — how long it took and when it ended, as a clock.
 */
export function useJobWords() {
  const { t, locale } = useI18n()
  const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
  const connection = (id: string | null) =>
    id === null ? '' : (connections.value?.find((c) => c.id === id)?.name ?? id)
  const kind = (job: JobView) => t(kindKey(job.kind))
  const state = (job: JobView) => t(`jobs.ui.state.${job.state}`)
  const status = (job: JobView) => statusOf(job.state)
  /** "3 s", "1 min 4 s": the time it took, or has taken so far. */
  const took = (job: JobView, now: number) => {
    const ms = (job.finishedAt ?? now) - job.startedAt
    // A job quicker than a second ended at once; "0 s" would read as nothing done.
    return job.finishedAt && ms < 1000 ? t('jobs.ui.underSecond') : formatElapsed(ms, locale.value)
  }
  /** The end as a clock ("14:38", "6 Oct 09:05"). */
  const ended = (job: JobView, now: number) =>
    job.finishedAt ? clock(job.finishedAt, now, locale.value) : ''
  const who = (job: JobView) => (job.mine ? t('jobs.ui.you') : t('jobs.ui.anotherUser'))
  return { t, locale, connection, kind, state, status, took, ended, who }
}
