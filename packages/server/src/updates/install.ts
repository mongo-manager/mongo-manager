import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import {
  INCOMING_PREFIX,
  INFO_ASSET,
  PACKAGE_ASSET,
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_FILES,
  RELEASE_PUBLIC_KEYS,
  SIGNATURE_ASSET,
  SUMS_ASSET,
  assetNames,
  parseSums,
  readTar,
  verifyVersionDir,
  type VersionKind,
} from '@mongo-manager/shared'
import { AppError } from '../errors'
import { safeEqual } from '../http/security'
import type { Egress } from '../net/egress'
import { githubStream } from '../net/github'
import { CheckError, checkRelease, type CheckedRelease } from './check'

/** The release's package and binary, at most. */
const TGZ_MAX = 200 * 1024 * 1024
const BINARY_MAX = 400 * 1024 * 1024
/** A download of that size over a slow line. */
const DOWNLOAD_BUDGET_MS = 30 * 60_000

export type DownloadFailure =
  'unreachable' | 'signature' | 'no_asset' | 'too_large' | 'digest' | 'files' | 'bad_answer'

export const downloadFailed = (detail: DownloadFailure) =>
  new AppError('UPSTREAM_ERROR', 'The update could not be downloaded and checked', 502, {
    reason: 'update_failed',
    detail,
  })

export interface DownloadOptions {
  egress: Egress
  dataDir: string
  version: string
  kind: VersionKind
  target: string | null
  keys?: readonly string[]
  /** The release as the check found it; fetched by its tag when absent (the launcher's repair). */
  release?: CheckedRelease
  onProgress?(p: { phase: 'downloading' | 'verifying'; percent?: number }): void
}

/** Streams an asset into a file while hashing it, never past `limit`; its sha256. */
async function fetchTo(
  egress: Egress,
  url: string,
  file: string,
  size: number,
  limit: number,
  progress?: (n: number) => void,
): Promise<string> {
  const res = await githubStream(egress, url, Date.now() + DOWNLOAD_BUDGET_MS).catch(() => {
    throw downloadFailed('unreachable')
  })
  if (res.status !== 200) {
    res.body.resume()
    throw downloadFailed('unreachable')
  }
  const hash = createHash('sha256')
  let bytes = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length
      if (bytes > limit) return done(downloadFailed('too_large'))
      hash.update(chunk)
      progress?.(size > 0 ? Math.min(99, Math.floor((bytes / size) * 100)) : 0)
      done(null, chunk)
    },
  })
  try {
    await pipeline(res.body, count, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
  } catch (e) {
    throw e instanceof AppError ? e : downloadFailed('unreachable')
  }
  return hash.digest('hex')
}

/**
 * Updater, spec §5.2 (2026-11-03): a release downloaded into `<data>/app/<version>/` — staged in a
 * private `.incoming-*` folder, every byte checked against the signed SHA256SUMS before anything is
 * unpacked, then the whole folder checked as the launcher checks it, then moved into place. Any
 * failure leaves nothing behind.
 */
export async function downloadVersion(opts: DownloadOptions): Promise<string> {
  const keys = opts.keys ?? RELEASE_PUBLIC_KEYS
  const appDir = join(opts.dataDir, 'app')
  mkdirSync(appDir, { recursive: true, mode: 0o700 })
  const incoming = join(appDir, `${INCOMING_PREFIX}${randomBytes(8).toString('hex')}`)
  const staged = join(incoming, opts.version)
  mkdirSync(staged, { recursive: true, mode: 0o700 })
  try {
    let release = opts.release
    if (!release || release.version !== opts.version)
      release = await checkRelease(opts.egress, keys, opts.version).catch((e: unknown) => {
        throw e instanceof CheckError
          ? downloadFailed(e.reason === 'rate_limited' ? 'unreachable' : e.reason)
          : e
      })
    const names = assetNames(opts.version)
    const name = opts.kind === 'package' ? names.tgz : opts.target ? names.standalone(opts.target) : null
    const asset = name ? release.assets.get(name) : undefined
    const expected = name ? parseSums(release.sums.toString('utf8')).get(name) : undefined
    if (!name || !asset || !expected) throw downloadFailed('no_asset')
    const limit = opts.kind === 'package' ? TGZ_MAX : BINARY_MAX
    if (asset.size > limit) throw downloadFailed('too_large')
    const file = join(staged, opts.kind === 'package' ? PACKAGE_ASSET : name)
    opts.onProgress?.({ phase: 'downloading', percent: 0 })
    const digest = await fetchTo(opts.egress, asset.url, file, asset.size, limit, (percent) =>
      opts.onProgress?.({ phase: 'downloading', percent }),
    )
    opts.onProgress?.({ phase: 'verifying' })
    // Checked before a byte of it is unpacked.
    if (!safeEqual(digest, expected)) throw downloadFailed('digest')
    // Final review (C2): the standalone binary runs as a program (it was written private, 0o600).
    if (opts.kind === 'standalone') chmodSync(file, 0o700)
    writeFileSync(join(staged, SUMS_ASSET), release.sums, { mode: 0o600 })
    writeFileSync(join(staged, SIGNATURE_ASSET), release.signature, { mode: 0o600 })
    writeFileSync(join(staged, INFO_ASSET), release.infoBytes, { mode: 0o600 })
    if (opts.kind === 'package') {
      let entries
      try {
        entries = readTar(readFileSync(file), { maxBytes: PACKAGE_MAX_BYTES, maxFiles: PACKAGE_MAX_FILES })
      } catch {
        throw downloadFailed('files')
      }
      for (const e of entries) {
        if (!e.path.startsWith('package/')) throw downloadFailed('files')
        const to = join(staged, ...e.path.split('/'))
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
        writeFileSync(to, e.data, { flag: 'wx', mode: 0o600 })
      }
    }
    const verified = verifyVersionDir(staged, { kind: opts.kind, target: opts.target, keys })
    if (!verified.ok) {
      const r = verified.reason
      throw downloadFailed(
        r === 'signature' || r === 'digest' ? r : r === 'missing' || r === 'files' ? 'files' : 'bad_answer',
      )
    }
    const target = join(appDir, opts.version)
    const existing = verifyVersionDir(target, { kind: opts.kind, target: opts.target, keys })
    if (!existing.ok) {
      rmSync(target, { recursive: true, force: true })
      renameSync(staged, target)
    }
    return target
  } finally {
    rmSync(incoming, { recursive: true, force: true })
  }
}
