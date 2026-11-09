// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { JobRunner } from '../../jobs/runner'
import type { JobRecord } from '../../jobs/types'

/** Plan ruling 12: a job's end, from the runner's own announcements (subscribed before looking). */
export function waitForJob(jobs: JobRunner, id: string): Promise<JobRecord> {
  return new Promise((resolve, reject) => {
    const off = jobs.onChange((job) => {
      if (job.id === id && job.state !== 'running') {
        off()
        resolve(job)
      }
    })
    const now = jobs.get(id)
    if (!now) {
      off()
      reject(new Error('The job is gone'))
    } else if (now.state !== 'running') {
      off()
      resolve(now)
    }
  })
}
