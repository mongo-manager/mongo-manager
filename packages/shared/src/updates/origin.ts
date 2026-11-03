import { z } from 'zod'
import { parseReleaseVersion } from './version'

/**
 * The launcher's word to the program it starts (2026-11-03): set together, read together. The
 * server reads it to know how it was installed — the program it runs may live in the data
 * directory, far from the install it came from.
 */
export const UPDATER_CHILD_ENV = 'MM_UPDATER_CHILD'
export const UPDATER_ORIGIN_ENV = 'MM_UPDATER_ORIGIN'

// Final review (I7): a later launcher may say more; what this version reads stays the same.
export const UpdaterOriginSchema = z.object({
  /** 'bundle': the npm package or a copy of it (the server tells which, from installDir). */
  distribution: z.enum(['bundle', 'standalone', 'docker']),
  /** The version the install itself carries. */
  bundledVersion: z.string().refine((v) => parseReleaseVersion(v) !== null),
  /** The bundle's dist folder, or the standalone binary's path. */
  installDir: z.string().min(1),
  /** The standalone build this binary is (linux-x64 …); null for a bundle. */
  target: z.string().nullable(),
  /** The account's other processes are ended before a downloaded version runs (Docker, a service). */
  isolate: z.boolean(),
})
export type UpdaterOrigin = z.infer<typeof UpdaterOriginSchema>

/** The contract, when the launcher set it whole; null otherwise. */
export function readOrigin(env: Record<string, string | undefined>): UpdaterOrigin | null {
  if (env[UPDATER_CHILD_ENV] !== '1') return null
  try {
    return UpdaterOriginSchema.parse(JSON.parse(env[UPDATER_ORIGIN_ENV] ?? ''))
  } catch {
    return null
  }
}

export function originEnv(origin: UpdaterOrigin): Record<string, string> {
  return { [UPDATER_CHILD_ENV]: '1', [UPDATER_ORIGIN_ENV]: JSON.stringify(origin) }
}
