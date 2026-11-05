// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useI18n } from 'vue-i18n'
import type { JobView } from '@mongo-manager/shared'
import { ApiError } from '@/api/client'
import { jobsApi } from '@/api/jobs'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useJobsStore } from './store'

/**
 * Cancels a job after asking: the jobs panel and the background jobs page share it. A job told to
 * stop that is still winding down says so; its end arrives with the next update.
 */
export function useCancelJob(): (job: JobView) => Promise<void> {
  const { t } = useI18n()
  const store = useJobsStore()
  const dialogs = useDialogStore()
  const toasts = useToastStore()
  return async (job) => {
    const ok = await dialogs.confirm({
      title: t('jobs.cancelTitle'),
      message: t('jobs.cancelConfirm', { name: job.target }),
      confirmLabel: t('jobs.cancel'),
      danger: true,
    })
    if (!ok) return
    try {
      const { job: now } = await jobsApi.cancel(job.id)
      store.upsert(now)
      if (now.state === 'running')
        toasts.push({ kind: 'info', message: t('jobs.stopping', { name: job.target }) })
    } catch (e) {
      const reason =
        e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
      if (reason === 'finished') toasts.push({ kind: 'info', message: t('jobs.alreadyFinished') })
      else if (reason === 'not_stopped') toasts.push({ kind: 'error', message: t('jobs.couldNotStop') })
      else toasts.push({ kind: 'error', message: describeError(e, t) })
    }
  }
}
