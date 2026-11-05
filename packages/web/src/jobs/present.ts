// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Component } from 'vue'
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CloudDownload,
  CloudUpload,
  Copy,
  CopyPlus,
  Download,
  FileCode,
  GitCompareArrows,
  ListTree,
  ShieldCheck,
  Upload,
} from 'lucide-vue-next'
import type { JobKindName, JobState, JobView } from '@mongo-manager/shared'

/**
 * User review 2026-10-08 ("Bitti'den sonra zaman sayacı göstermesi mantıksız … baştan tasarla"): how
 * a job reads in the jobs panel and on the jobs page — its kind's icon, a sentence of where the work
 * went, one of five states, and times as a clock, never as "N ago".
 */
export const KIND_ICONS: Record<JobKindName, Component> = {
  'index.create': ListTree,
  'collection.duplicate': Copy,
  'data.import': Upload,
  'data.importSql': FileCode,
  'data.export': Download,
  'data.copy': CopyPlus,
  'data.compare': GitCompareArrows,
  'data.sync': ArrowRightLeft,
  'backup.dump': Archive,
  'backup.restore': ArchiveRestore,
  'backup.send': CloudUpload,
  'backup.fetch': CloudDownload,
  'backup.drill': ShieldCheck,
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'warning'
export const statusOf = (state: JobState): JobStatus =>
  state === 'interrupted' || state === 'unknown' ? 'warning' : state

/** Where a job ran: "shop.orders", "shop", or null for a whole server. */
export const placeOf = (job: Pick<JobView, 'db' | 'coll'>): string | null =>
  job.db === '*' ? null : job.coll === '*' ? job.db : `${job.db}.${job.coll}`

/**
 * The work's direction: an export goes from the collection to a file, an import from a file to the
 * collection, a restore from a backup to the database. A null side is said by the caller (the whole
 * server, the destinations, this server).
 */
export function jobSentence(job: JobView): { from: string | null; to: string | null } {
  const place = placeOf(job)
  switch (job.kind) {
    case 'data.import':
    case 'data.importSql':
    case 'backup.restore':
      return { from: job.target, to: place }
    case 'backup.send':
      return { from: job.target, to: null }
    case 'backup.fetch':
      return { from: job.target, to: null }
    case 'collection.duplicate':
      return { from: place, to: job.db === '*' ? job.target : `${job.db}.${job.target}` }
    default:
      return { from: place, to: job.target }
  }
}

/** What a job's progress counts. */
export const progressUnit = (kind: JobKindName): 'bytes' | 'documents' | 'items' =>
  kind.startsWith('backup.') ? 'bytes' : kind === 'index.create' ? 'items' : 'documents'

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** A time as a clock: "14:38" today, "6 Eki 09:05" before, with the year when it is another one. */
export function clock(ms: number, now: number, locale: string): string {
  const at = new Date(ms)
  const today = new Date(now)
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (sameDay(at, today)) return time
  const date = at.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${date} ${time}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The day a time falls on, for grouping: "today", "yesterday", or the date in words. */
export function dayOf(ms: number, now: number, locale: string): { key: string; label: string } {
  const at = new Date(ms)
  const key = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay(at, today)) return { key, label: 'today' }
  if (sameDay(at, yesterday)) return { key, label: 'yesterday' }
  return {
    key,
    label: at.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    }),
  }
}
