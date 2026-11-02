import type { JobRecord } from '../../src/jobs/types'
import type { TestApp } from '../helpers'
import { countWait } from './wait-budget'

/**
 * How long waitJob waits when a test names no bound: 5 s short of the 20 s test limit, so the wait, not
 * the test limit, runs out first and says why (CI 2026-10-21; wait-budget.ts).
 */
export const JOB_WAIT_MS = 15_000

/** Waits until a job leaves "running"; its bound counts against the test's limit (wait-budget.ts). */
export async function waitJob(t: TestApp, id: string, ms = JOB_WAIT_MS): Promise<JobRecord> {
  countWait(ms)
  const until = Date.now() + ms
  for (;;) {
    const job = t.app.ctx.jobs.get(id)
    if (job && job.state !== 'running') return job
    if (Date.now() > until) throw new Error(`job ${id} still running`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
