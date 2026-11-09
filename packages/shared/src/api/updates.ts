// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

/**
 * The updater (2026-11-03): what the About page shows. An administrator (settings:manage) sees the
 * check, its setting and the offer; anyone else the installed version only.
 */
export type UpdateDistribution = 'npm' | 'standalone' | 'docker' | 'copy' | 'source'
export type UpdateCheckFailure = 'unreachable' | 'rate_limited' | 'bad_answer' | 'signature' | 'no_asset'
/** What Update can do here: install it, or say what to do instead. */
export type UpdateOffer = 'install' | 'pull_image' | 'reinstall' | 'notice'
/** launcher_old: the release needs a newer installed program than this one (its minLauncher). */
export type UpdateOfferReason = 'image_old' | 'node_old' | 'no_launcher' | 'source' | 'launcher_old'
export type UpdatePhase = 'downloading' | 'verifying' | 'preparing' | 'restarting'

export interface UpdateLatest {
  version: string
  /** ISO date. */
  publishedAt: string
  /** The release notes, as plain text. */
  notes: string
  /** The release's page on GitHub. */
  url: string
}

export interface UpdateStatus {
  installed: string
  distribution: UpdateDistribution
  /** MM_UPDATES=off (or no release key): nothing is checked, offered or shown. */
  disabled: boolean
  /** Started by the launcher, which can run a downloaded version. */
  launcher: boolean
  /** The daily check is on. */
  auto: boolean
  lastCheck: null | {
    at: number
    outcome: 'current' | 'available' | 'failed'
    reason?: UpdateCheckFailure
    /** rate_limited: when GitHub answers again. */
    retryAt?: number
  }
  latest: UpdateLatest | null
  offer: UpdateOffer | null
  offerReason?: UpdateOfferReason
  /** Docker: the image this runs in. */
  image?: { version: string | null; created: string | null; old: boolean }
  /**
   * Docker: a newer image brings system fixes; the version to pull. Advice only: Update still works
   * on the image there is (user report 2026-11-09).
   */
  imageAdvice?: string
  /**
   * How the last update ended: installed, rolled back at its first start, or (final review, I6) a
   * version that had run well refused at a start because its files no longer matched its release.
   */
  lastUpdate?: {
    version: string
    outcome: 'updated' | 'rolled_back' | 'refused'
    code?: 'exited' | 'timeout' | 'files'
    reason?: string
    at: number
  }
  progress: null | { phase: UpdatePhase; percent?: number }
  /** The last install from the panel that did not get as far as the restart. */
  installFailure?: { reason: string; at: number }
}

export const UpdateSettingsBodySchema = z.strictObject({ auto: z.boolean() })
export const UpdateInstallBodySchema = z.strictObject({
  version: z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}$/),
  /** Install although jobs are running (the dialog said how many). */
  confirmJobs: z.boolean().optional(),
})
export type UpdateInstallBody = z.infer<typeof UpdateInstallBodySchema>
