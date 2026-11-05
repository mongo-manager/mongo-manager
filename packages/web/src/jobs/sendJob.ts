// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useI18n } from 'vue-i18n'
import type { JobView } from '@mongo-manager/shared'
import { useReasonText } from '@/destinations/errors'

/** Phase 3d-3b final review: a send job — its failures (B33), localKept and waitingFor are read here. */
export type SendJobView = JobView

/**
 * The server's own failure sentence, without its English frame ("Not sent — …", "The local copy was
 * kept."): the reader's language says those around it. What remains is the destinations' detail.
 */
export function englishFailure(error: string | null): string {
  return (error ?? '')
    .replace(/^Not sent\s+[—-]\s+/, '')
    .replace(/\.?\s*The local copy was kept\.?$/, '')
    .trim()
}

/**
 * A dump's report says why the send queued after it could not start (DumpReport.sendError) as the
 * server's English sentence: the known ones are said in the reader's words, others as they are.
 */
const SEND_START_ERRORS: Array<[RegExp, string]> = [
  [/^The account that started this backup can no longer send it$/, 'backup.send.accountGone'],
  [/^Destination not found$/, 'backup.refusal.destination_unknown'],
  [/ accepts encrypted backups only$/, 'backup.refusal.destination_encrypted_only'],
  [
    /^An unencrypted backup with personal data cannot leave the server$/,
    'backup.refusal.destination_personal_plain',
  ],
  [/^This backup is already being sent to that destination$/, 'destinations.reason.copy_sending'],
  [/^You already have \d+ backups or restores running$/, 'backup.refusal.backup_busy'],
]
export function useSendStartError() {
  const { t } = useI18n()
  return (sendError: string): string => {
    const key = SEND_START_ERRORS.find(([re]) => re.test(sendError))?.[1]
    return t('backup.send.notStarted', { error: key ? t(key) : sendError })
  }
}

/**
 * Final review C24, C29: a failed send in the reader's words — each destination with its reason, and,
 * when the local copy was to go, that it stayed and because of which destinations.
 */
export function useSendFailure() {
  const { t, locale } = useI18n()
  const reasonWords = useReasonText()
  const list = (names: string[]) => new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(names)
  /** The destinations and their reasons only: "NAS: The destination is full." */
  const detail = (job: SendJobView): string => {
    const failures = job.failures ?? []
    return failures.length
      ? failures
          .map((f) => t('backup.send.failure', { name: f.destination, reason: reasonWords(f.reason) }))
          .join(' ')
      : englishFailure(job.error)
  }
  /** The whole sentence a toast says. */
  const sentence = (job: SendJobView): string => {
    const failures = job.failures ?? []
    const why = detail(job)
    const parts = [why ? t('backup.send.failed', { error: why }) : t('backup.send.failedPlain')]
    if (job.localKept)
      parts.push(
        failures.length
          ? t('backup.send.localKept', { names: list(failures.map((f) => f.destination)) }, failures.length)
          : // Short names review 13 (M-2): stopped (out of time) before a destination failed.
            t('backup.send.localKeptStopped'),
      )
    return parts.join(' ')
  }
  return { detail, sentence }
}
