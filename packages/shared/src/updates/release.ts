// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { parseReleaseVersion } from './version'

const Version = z.string().refine((v) => parseReleaseVersion(v) !== null, 'Not a release version')

/**
 * release.json, listed in SHA256SUMS: what a release needs to run. Final review (I7): every later
 * release must still be read by the launchers out there, so a key one adds is ignored (stripped), and
 * one that needs a newer launcher than an install has says so in minLauncher.
 */
export const ReleaseInfoSchema = z.object({
  schema: z.literal(1),
  version: Version,
  /** The oldest Node it runs on. */
  node: Version,
  /** The oldest Docker image that can run it (a newer runtime stage needs a pull). */
  minImage: Version,
  /** The oldest installed program (launcher) that may run it; older ones are offered a reinstall. */
  minLauncher: Version.optional(),
})
export type ReleaseInfo = z.infer<typeof ReleaseInfoSchema>

/** The exit code by which the app asks its launcher to start it again. */
export const RESTART_EXIT_CODE = 75
/** How long a new version has to say it is ready on its first start. */
export const HEALTH_WINDOW_MS = 60_000
/** A Docker image older than this is called old (Node and system fixes wait in a newer one). */
export const IMAGE_OLD_MS = 90 * 86_400_000
/** The app's database file in the data directory (the server's DB_FILE; the launcher must not load the server). */
export const DB_FILE_NAME = 'mongo-manager.db'

/** The release workflow's standalone builds. */
export const STANDALONE_TARGETS = ['linux-x64', 'linux-arm64', 'win-x64', 'macos-arm64'] as const

export const SUMS_ASSET = 'SHA256SUMS'
export const SIGNATURE_ASSET = 'SHA256SUMS.sig'
export const INFO_ASSET = 'release.json'

/** A release's file names, as the release workflow writes them. */
export function assetNames(version: string): { tgz: string; standalone(target: string): string } {
  return {
    tgz: `mongo-manager-${version}.tgz`,
    standalone: (target) => `mongo-manager-${version}-${target}${target.startsWith('win-') ? '.exe' : ''}`,
  }
}
