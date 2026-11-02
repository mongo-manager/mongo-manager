/**
 * The oldest MongoDB release mongo-manager supports (phase 1h spec §10): the oldest one CI tests.
 * Older servers are refused when a client opens, instead of failing later in odd ways.
 */
export const MIN_MONGODB_VERSION = '6.0'

const VERSION = /^(\d{1,4})\.(\d{1,4})(?:[.\-+].*)?$/

/** Major and minor of a MongoDB version string ("6.0.3", "7.0.0-rc1"), or null when it is not one. */
export function parseMongoVersion(version: string): { major: number; minor: number } | null {
  const match = VERSION.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

export function isSupportedMongoVersion(version: string): boolean {
  const found = parseMongoVersion(version)
  const floor = parseMongoVersion(MIN_MONGODB_VERSION)!
  if (!found) return false
  return found.major > floor.major || (found.major === floor.major && found.minor >= floor.minor)
}
