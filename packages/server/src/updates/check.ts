// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  INFO_ASSET,
  RELEASE_REPO,
  ReleaseInfoSchema,
  SIGNATURE_ASSET,
  SUMS_ASSET,
  isSpoofingChar,
  parseReleaseVersion,
  parseSums,
  verifySums,
  type ReleaseInfo,
  type UpdateCheckFailure,
  type UpdateLatest,
} from '@mongo-manager/shared'
import { safeEqual } from '../http/security'
import type { Egress } from '../net/egress'
import { followable, githubGet } from '../net/github'

/**
 * The updater's check (2026-11-03): GitHub's latest published release of the project, offered only
 * when its SHA256SUMS is signed by a release key and its release.json is listed there. Nothing of
 * the server's goes with the requests; drafts and prereleases never count.
 */
export class CheckError extends Error {
  override name = 'CheckError'
  constructor(
    readonly reason: UpdateCheckFailure,
    readonly retryAt?: number,
  ) {
    super(`The update check failed: ${reason}`)
  }
}

export interface CheckedRelease extends UpdateLatest {
  info: ReleaseInfo
  /** The release's assets by name: their download address and size. */
  assets: Map<string, { url: string; size: number }>
  /** SHA256SUMS, its signature and release.json, as fetched and checked. */
  sums: Buffer
  signature: Buffer
  infoBytes: Buffer
}

const LatestSchema = z.object({
  tag_name: z.string().max(100),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().max(40).nullable(),
  html_url: z.string().max(1000),
  body: z.string().max(1_000_000).nullable().optional(),
  assets: z
    .array(
      z.object({
        name: z.string().max(200),
        size: z.number().int().nonnegative(),
        browser_download_url: z.string().max(2000),
      }),
    )
    .max(1000),
})

/** The whole check, however many requests and redirects. */
export const CHECK_BUDGET_MS = 60_000
const RELEASE_BYTES = 5 * 1024 * 1024
const SMALL_ASSET = 64 * 1024
export const NOTES_MAX = 20_000

export const latestUrl = (repo = RELEASE_REPO) => `https://api.github.com/repos/${repo}/releases/latest`
export const releasePage = (version: string, repo = RELEASE_REPO) =>
  `https://github.com/${repo}/releases/tag/v${version}`

/** Release notes as plain text: no control character but new lines and tabs, nothing that fakes its form. */
export function plainNotes(text: string): string {
  let out = ''
  for (const c of text.replace(/\r\n?/g, '\n')) {
    const code = c.codePointAt(0)!
    if (
      c === '\n' ||
      c === '\t' ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0) && !isSpoofingChar(code))
    )
      out += c
    if (out.length >= NOTES_MAX) break
  }
  return out.slice(0, NOTES_MAX)
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function fetchSmall(egress: Egress, url: string, until: number): Promise<Buffer> {
  let answer
  try {
    answer = await githubGet(
      egress,
      url,
      'application/octet-stream',
      SMALL_ASSET,
      until,
      () => new CheckError('bad_answer'),
    )
  } catch (e) {
    throw e instanceof CheckError ? e : new CheckError('unreachable')
  }
  if (answer.status !== 200) throw new CheckError('unreachable')
  return answer.body
}

/** The latest release, checked; a CheckError says why there is none to offer. */
export const checkLatest = (egress: Egress, keys: readonly string[]): Promise<CheckedRelease> =>
  checkRelease(egress, keys)

export const tagUrl = (version: string, repo = RELEASE_REPO) =>
  `https://api.github.com/repos/${repo}/releases/tags/v${version}`

/** A release, checked: the latest, or the one of `version` (an install after a restart, a repair). */
export async function checkRelease(
  egress: Egress,
  keys: readonly string[],
  version?: string,
): Promise<CheckedRelease> {
  const until = Date.now() + CHECK_BUDGET_MS
  const api = version ? tagUrl(version) : latestUrl()
  let answer
  try {
    answer = await githubGet(
      egress,
      api,
      'application/vnd.github+json',
      RELEASE_BYTES,
      until,
      () => new CheckError('bad_answer'),
    )
  } catch (e) {
    throw e instanceof CheckError ? e : new CheckError('unreachable')
  }
  const remaining = answer.headers['x-ratelimit-remaining']
  if (answer.status === 429 || (answer.status === 403 && remaining === '0')) {
    const reset = Number(answer.headers['x-ratelimit-reset'])
    throw new CheckError('rate_limited', Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined)
  }
  if (answer.status !== 200) throw new CheckError(answer.status >= 500 ? 'unreachable' : 'bad_answer')
  let release
  try {
    release = LatestSchema.parse(JSON.parse(answer.body.toString('utf8')))
  } catch {
    throw new CheckError('bad_answer')
  }
  const tag = /^v(.+)$/.exec(release.tag_name)?.[1]
  if (release.draft || release.prerelease || !tag || !parseReleaseVersion(tag))
    throw new CheckError('bad_answer')
  if (version && tag !== version) throw new CheckError('bad_answer')
  // The release is the project's own: its page is where the project's releases are.
  if (release.html_url !== releasePage(tag)) throw new CheckError('bad_answer')
  const assets = new Map<string, { url: string; size: number }>()
  for (const a of release.assets) {
    const url = followable(a.browser_download_url, api)
    if (url) assets.set(a.name, { url, size: a.size })
  }
  const url = (name: string) => {
    const a = assets.get(name)
    if (!a) throw new CheckError('no_asset')
    return a.url
  }
  const sumsUrl = url(SUMS_ASSET)
  const sigUrl = url(SIGNATURE_ASSET)
  const infoUrl = url(INFO_ASSET)
  const sums = await fetchSmall(egress, sumsUrl, until)
  const signature = await fetchSmall(egress, sigUrl, until)
  if (!verifySums(sums, signature.toString('latin1'), keys)) throw new CheckError('signature')
  const infoBytes = await fetchSmall(egress, infoUrl, until)
  let listed: Map<string, string>
  try {
    listed = parseSums(sums.toString('utf8'))
  } catch {
    throw new CheckError('bad_answer')
  }
  if (!safeEqual(listed.get(INFO_ASSET) ?? '', sha(infoBytes))) throw new CheckError('signature')
  let info: ReleaseInfo
  try {
    info = ReleaseInfoSchema.parse(JSON.parse(infoBytes.toString('utf8')))
  } catch {
    throw new CheckError('bad_answer')
  }
  if (info.version !== tag) throw new CheckError('bad_answer')
  return {
    version: tag,
    publishedAt: release.published_at ?? '',
    notes: plainNotes(release.body ?? ''),
    url: release.html_url,
    info,
    assets,
    sums,
    signature,
    infoBytes,
  }
}
