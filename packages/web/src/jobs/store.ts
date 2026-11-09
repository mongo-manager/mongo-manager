// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { JobView } from '@mongo-manager/shared'

/**
 * The background jobs this user may see (phase 1h spec §6), fed by the real-time channel or, when
 * it cannot open, by polling. A job seen running that is now over is announced once to the
 * listeners, however the news arrived (an update, a snapshot after reconnecting, a poll).
 */
export const useJobsStore = defineStore('jobs', () => {
  const byId = ref<Record<string, JobView>>({})
  const listeners = new Set<(job: JobView) => void>()
  /** Server clock minus this machine's: elapsed times use the server's clock (final review Minor 9). */
  const clockOffset = ref(0)

  function setServerTime(now: number): void {
    clockOffset.value = now - Date.now()
  }

  const serverNow = () => Date.now() + clockOffset.value

  const list = computed(() => Object.values(byId.value).sort((a, b) => b.startedAt - a.startedAt))
  const running = computed(() => list.value.filter((j) => j.state === 'running'))

  function announce(previous: JobView | undefined, job: JobView): void {
    if (previous?.state !== 'running' || job.state === 'running') return
    for (const listener of listeners) {
      try {
        listener(job)
      } catch {
        // One listener's failure must not hide the news from the others.
      }
    }
  }

  // User review 2026-10-08: the pace of a running job (units a second, smoothed), for the time left.
  const rates = ref<Record<string, number>>({})
  const samples = new Map<string, { at: number; done: number }>()
  function sample(job: JobView): void {
    if (job.state !== 'running' || !job.progress) {
      samples.delete(job.id)
      if (job.id in rates.value) {
        const { [job.id]: _gone, ...rest } = rates.value
        rates.value = rest
      }
      return
    }
    const at = Date.now()
    const done = job.progress.done
    const before = samples.get(job.id)
    if (before && done > before.done && at > before.at) {
      const pace = ((done - before.done) * 1000) / (at - before.at)
      const known = rates.value[job.id]
      rates.value = { ...rates.value, [job.id]: known === undefined ? pace : known * 0.6 + pace * 0.4 }
    }
    if (!before || done !== before.done) samples.set(job.id, { at, done })
  }
  const rateOf = (id: string): number | null => rates.value[id] ?? null
  /** Seconds left, from the pace so far; null until a pace is known or once the job ended. */
  function timeLeft(id: string): number | null {
    const job = byId.value[id]
    const rate = rates.value[id]
    if (!job || job.state !== 'running' || !job.progress || !rate) return null
    return Math.max(0, (job.progress.total - job.progress.done) / rate)
  }
  /** A job another view asked to show (the jobs panel opens it on the jobs page). */
  const focused = ref<string | null>(null)
  /** W4.4: a job whose report was asked for ("Open report" on a toast): its details open it. */
  const reportWanted = ref<string | null>(null)
  const focus = (id: string | null, opts: { report?: boolean } = {}) => {
    focused.value = id
    if (opts.report) reportWanted.value = id
  }
  const reportShown = () => (reportWanted.value = null)

  function upsert(job: JobView): void {
    const previous = byId.value[job.id]
    // A job never runs again once it ended: a start reply that arrives after the real-time "done"
    // (a job quicker than its HTTP answer) is stale. It does say this client started the job, whose
    // end was first seen without a start: the end is announced now.
    if (previous && previous.state !== 'running' && job.state === 'running') {
      announce({ ...previous, state: 'running' }, previous)
      return
    }
    byId.value = { ...byId.value, [job.id]: job }
    sample(job)
    announce(previous, job)
  }

  function remove(id: string): void {
    const { [id]: _gone, ...rest } = byId.value
    byId.value = rest
  }

  /** The full list from the server: jobs missing from it are no longer visible. */
  function replaceAll(jobs: JobView[]): void {
    const previous = byId.value
    byId.value = Object.fromEntries(jobs.map((j) => [j.id, j]))
    for (const job of jobs) sample(job)
    for (const job of jobs) announce(previous[job.id], job)
  }

  function forCollection(connectionId: string, db: string, coll: string): JobView[] {
    return list.value.filter((j) => j.connectionId === connectionId && j.db === db && j.coll === coll)
  }

  function onFinished(listener: (job: JobView) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function reset(): void {
    byId.value = {}
    rates.value = {}
    samples.clear()
    focused.value = null
    reportWanted.value = null
  }

  return {
    byId,
    list,
    running,
    clockOffset,
    setServerTime,
    serverNow,
    upsert,
    remove,
    replaceAll,
    rateOf,
    timeLeft,
    focused,
    focus,
    reportWanted,
    reportShown,
    forCollection,
    onFinished,
    reset,
  }
})

export type JobsStore = ReturnType<typeof useJobsStore>
