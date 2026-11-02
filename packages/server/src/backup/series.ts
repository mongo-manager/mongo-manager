import type { MongoClient } from 'mongodb'

const BUCKETS = 'system.buckets.'

/**
 * CI 2026-10-18 (MongoDB 8.3): mongo-tools' rule (SupportsRawData, common/db/version.go, from
 * 100.16.0): from 8.3 a time series' buckets are read and written through its own name with
 * rawData, and a dump keeps them under that name; before 8.3, under system.buckets.<name>.
 * mongorestore reads an archive by the version that made it, so a dump of an 8.3 server that kept
 * them as before restored nothing of the series, and a server without that namespace would have
 * had its series backed up empty. A version mongo-tools cannot read counts as an old one.
 */
export function rawSeries(version: string | null | undefined): boolean {
  const parts = versionParts(version)
  if (!parts) return false
  const [major, minor] = parts
  return major > 8 || (major === 8 && minor >= 3)
}

/** A version as mongo-tools reads it (StrToVersion): major, minor and patch, or null. */
function versionParts(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null
  const parts = version.split('-', 1)[0]!.split('+', 1)[0]!.split('.')
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null
  return parts.map(Number) as [number, number, number]
}

/**
 * Whether mongo-tools can read the version (review of the CI fixes, minor 4): one it cannot is never
 * guessed at where a time series is concerned, and never written into an archive's header, which
 * mongorestore would refuse.
 */
export const knownVersion = (version: string | null | undefined): version is string =>
  versionParts(version) !== null

/**
 * MongoDB 9.0 (local run, 2026-10-20): whether `target` is an older release than `source`, by major
 * and minor (the options a server knows change between releases, not patches). An unknown version
 * is never taken for an older one.
 */
export function olderServer(target: string | null | undefined, source: string | null | undefined): boolean {
  const [t, s] = [versionParts(target), versionParts(source)]
  if (!t || !s) return false
  return t[0] < s[0] || (t[0] === s[0] && t[1] < s[1])
}

/**
 * Review of db45c424: what a server takes is set by its feature level, its FCV — a 9.0 still at
 * FCV 8.0 (as after an upgrade) refuses what 8.0 refuses. Both as major and minor; `fcv` is null
 * when it cannot be read (getParameter needs a privilege a user may lack), `release` when the
 * server does not say its version.
 */
export interface ServerLevel {
  fcv: readonly [number, number] | null
  release: readonly [number, number] | null
}

const majorMinor = (v: unknown): [number, number] | null => {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)/.exec(v) : null
  return m ? [Number(m[1]), Number(m[2])] : null
}

export async function serverLevel(client: MongoClient): Promise<ServerLevel> {
  const fcvOf = async () => {
    try {
      const r = await client.db('admin').command({ getParameter: 1, featureCompatibilityVersion: 1 })
      return majorMinor((r.featureCompatibilityVersion as { version?: unknown } | undefined)?.version)
    } catch {
      return null
    }
  }
  const [fcv, release] = await Promise.all([fcvOf(), serverVersionOf(client).then(majorMinor)])
  return { fcv, release }
}

/** Whether `level` reaches major.minor. */
export const levelAtLeast = (
  level: readonly [number, number] | null,
  major: number,
  minor: number,
): boolean => level !== null && (level[0] > major || (level[0] === major && level[1] >= minor))

/**
 * The feature level a target is sure to have: its FCV, or, unread, the lowest its release may run
 * at (a x.0 one at the previous major's .0, a later minor at its own major's .0). Null: unknown.
 */
export function assuredLevel(t: ServerLevel | null): readonly [number, number] | null {
  if (!t) return null
  if (t.fcv) return t.fcv
  if (!t.release) return null
  const [major, minor] = t.release
  return minor === 0 ? [major - 1, 0] : [major, 0]
}

/**
 * Whether a target cannot reach major.minor: its FCV, else its release, is below it. Used where
 * there is no loss-free way round what the target lacks (a series that cannot be made as it was is
 * skipped): an unread FCV is taken to be its release's, as it is but for a while after an upgrade,
 * and the server says so if not. Where a loss-free way exists — the built-in engine instead of
 * mongorestore, a default left to the server — assuredLevel decides (review of 69adc29a, M-1).
 */
export function levelBelow(t: ServerLevel | null, major: number, minor: number): boolean {
  const known = t?.fcv ?? t?.release ?? null
  return known !== null && !levelAtLeast(known, major, minor)
}

/** What a find or an insert of a series' buckets names, on a server of that version. */
export function seriesAccess(
  coll: string,
  version: string | null | undefined,
): { coll: string; options: { rawData?: true } } {
  return rawSeries(version)
    ? { coll, options: { rawData: true } }
    : { coll: `${BUCKETS}${coll}`, options: {} }
}

/**
 * Third review of the CI fixes (minor 6): a path that names its place whatever the current folder and
 * drive are — on Windows a drive and a folder, or a share; `\\tools` is on the current drive.
 */
export function fullPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : p.startsWith('/')
}

/**
 * Fourth review of the CI fixes (minors 12, 13): a full path on this computer, never a network share
 * (tools run from one would run as the server's account; a folder root there is never used).
 */
export function localFullPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return fullPath(p, platform) && !(platform === 'win32' && /^[\\/]{2}/.test(p))
}

/** The server's version, or null when it does not say (within `ms`, when given). */
export async function serverVersionOf(client: MongoClient, ms?: number): Promise<string | null> {
  try {
    const build = await client
      .db('admin')
      .command({ buildInfo: 1 }, ms === undefined ? {} : { timeoutMS: ms })
    return typeof build.version === 'string' ? build.version : null
  } catch {
    return null
  }
}

/**
 * Review of the CI fixes (important 2): whether mongorestore can find a time series in an archive of
 * a server of 8.3 or later. mongorestore 100.16 on looks for it under its own name there; mongodump
 * before 100.16, and Mongo Manager before it followed that rule (its tool version says nothing of
 * which), kept it under system.buckets. Only the built-in engine reads both.
 */
export function toolsFindSeries(
  archiveVersion: string | null,
  toolVersion: string | null,
  /** The archive's Mongo Manager header says its series are under their own names. */
  ownLayout = false,
): boolean {
  if (!rawSeries(archiveVersion) || ownLayout) return true
  const m = /^(?:mongodump\s+)?r?(\d+)\.(\d+)\.(\d+)$/.exec(toolVersion?.trim() ?? '')
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 100 || (major === 100 && minor >= 16)
}
