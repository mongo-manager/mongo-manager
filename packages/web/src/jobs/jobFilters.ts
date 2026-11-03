import type { JobKindName, JobState, JobView } from '@mongo-manager/shared'

/**
 * User review 2026-10-08 ("arka plan işleri için neden bir sayfan yok"): what the background jobs
 * page filters by. A job interrupted by a restart or of unknown outcome counts as failed.
 */
export type StateGroup = 'running' | 'done' | 'failed' | 'cancelled'
export const STATE_GROUPS: readonly StateGroup[] = ['running', 'done', 'failed', 'cancelled']

export interface JobFilters {
  state: 'all' | StateGroup
  kind: 'all' | JobKindName
  connectionId: string
  /** Only the jobs the viewer started. */
  mine: boolean
  search: string
  /** Only jobs that ended (or, still running, started) at or after this time. */
  since: number | null
}

/** When a job counts for "the last 24 hours": when it ended, or started while it runs. */
const lastSeen = (job: JobView) => job.finishedAt ?? job.startedAt

export const stateGroup = (state: JobState): StateGroup =>
  state === 'running' || state === 'done' || state === 'cancelled' ? state : 'failed'

/** Where a job runs, as shown and searched: "shop.orders", "shop", or nothing for a whole server. */
export const jobPlace = (job: JobView): string =>
  job.db === '*' ? '' : job.coll === '*' ? job.db : `${job.db}.${job.coll}`

export function filterJobs(
  jobs: readonly JobView[],
  filters: JobFilters,
  kindLabel: (kind: JobKindName) => string,
): JobView[] {
  const words = filters.search.trim().toLocaleLowerCase()
  return jobs.filter((job) => {
    if (filters.state !== 'all' && stateGroup(job.state) !== filters.state) return false
    if (filters.kind !== 'all' && job.kind !== filters.kind) return false
    if (filters.connectionId !== 'all' && job.connectionId !== filters.connectionId) return false
    if (filters.mine && !job.mine) return false
    if (filters.since !== null && lastSeen(job) < filters.since) return false
    if (!words) return true
    return [jobPlace(job), job.target, job.scheduleName ?? '', kindLabel(job.kind)]
      .join('\n')
      .toLocaleLowerCase()
      .includes(words)
  })
}

export const DAY = 24 * 60 * 60 * 1000

export function jobCounts(
  jobs: readonly JobView[],
  now: number,
): {
  running: number
  recent: number
  failedRecently: number
  byState: Record<'all' | StateGroup, number>
} {
  const byState = { all: jobs.length, running: 0, done: 0, failed: 0, cancelled: 0 }
  let recent = 0
  let failedRecently = 0
  for (const job of jobs) {
    const group = stateGroup(job.state)
    byState[group]++
    if (group === 'running' || lastSeen(job) < now - DAY) continue
    recent++
    if (group === 'failed') failedRecently++
  }
  return { running: byState.running, recent, failedRecently, byState }
}
