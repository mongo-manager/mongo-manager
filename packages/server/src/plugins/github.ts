import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PluginOrigin } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { EgressError, type Egress } from '../net/egress'
import { safeEqual } from '../http/security'

/**
 * User request 2026-10-11: a plugin installed from a public GitHub repository's release. Only
 * GitHub's own hosts are reached, over https, with nothing of the server's sent along (no cookie,
 * token or credentials); the release's one `.tgz` is then installed as an upload is — disabled,
 * scanned, waiting for an administrator's approval.
 */
export interface GithubRef {
  owner: string
  repo: string
  /** The release named in the address; null for the latest. */
  tag: string | null
}

/** The hosts a release and its asset come from; a redirect anywhere else is refused. */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
/** A tag's part: a tag may hold slashes (review 2026-10-11), each part plain. */
const TAG_PART = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/
/** Printable ASCII only: a release's tag and asset names are shown, nothing in them may hide. */
const SHOWN = /^[\x21-\x7e]{1,200}$/
const MAX_REDIRECTS = 4
/** The whole install, however many requests and redirects (review 2026-10-11). */
const BUDGET_MS = 4 * 60_000
/** A release's description with many assets and long notes stays well under this. */
const RELEASE_BYTES = 5 * 1024 * 1024

const bad = () =>
  Errors.validation('Give a GitHub repository address, as https://github.com/owner/repository', {
    reason: 'github_address',
  })

const plainRepo = (owner: string | undefined, repo: string | undefined): repo is string =>
  !!owner && !!repo && OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..'

/** The repository (and release) an administrator named: https://github.com/owner/repo[/releases[/tag/x]]. */
export function parseGithubRef(text: string): GithubRef {
  const raw = text.trim()
  if (raw.length > 400 || !/^https:\/\//i.test(raw)) throw bad()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw bad()
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    // No query or fragment, even an empty one: an address names the repository and nothing else.
    raw.includes('?') ||
    raw.includes('#')
  )
    throw bad()
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  const [owner, rawRepo, ...rest] = parts
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!plainRepo(owner, repo)) throw bad()
  if (!rest.length) return { owner: owner!, repo, tag: null }
  if (rest[0] !== 'releases') throw bad()
  if (rest.length === 1 || (rest.length === 2 && rest[1] === 'latest'))
    return { owner: owner!, repo, tag: null }
  const tag = rest.slice(2)
  if (rest[1] === 'tag' && tag.length >= 1 && tag.length <= 4 && tag.every((p) => TAG_PART.test(p)))
    if (!tag.some((p) => p.includes('..'))) return { owner: owner!, repo, tag: tag.join('/') }
  throw bad()
}

const ReleaseSchema = z.object({
  tag_name: z.string().regex(SHOWN),
  html_url: z.string().max(1000).optional(),
  assets: z
    .array(
      z.object({
        name: z.string().regex(SHOWN),
        size: z.number().int().nonnegative(),
        browser_download_url: z.string().max(2000),
        // GitHub's checksum of the asset ("sha256:…"; security review 2026-10-13); older releases have
        // none. Checked on the archive only: another asset's is none of the install's business.
        digest: z.string().max(200).nullable().optional(),
      }),
    )
    .max(1000),
})

const upstream = (message: string, reason: string, more: Record<string, unknown> = {}) =>
  new AppError('UPSTREAM_ERROR', message, 502, { reason, ...more })

/**
 * Reads an address of GitHub's, following redirects only to GitHub's hosts, over https, within
 * what is left of the install's time. `tooLarge`: what an answer over `limit` means.
 */
async function get(
  egress: Egress,
  start: string,
  accept: string,
  limit: number,
  until: number,
  tooLarge: () => Error,
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  let url = start
  for (let hop = 0; ; hop++) {
    const left = until - Date.now()
    if (left <= 0) throw upstream('GitHub took too long to answer', 'github_unreachable')
    try {
      const res = await egress.buffer(
        {
          method: 'GET',
          url,
          deadlineMs: left,
          headers: { accept, 'user-agent': 'mongo-manager', 'x-github-api-version': '2022-11-28' },
        },
        limit,
      )
      return { status: res.status, headers: res.headers, body: res.body }
    } catch (e) {
      if (e instanceof EgressError && e.reason === 'too_large') throw tooLarge()
      if (!(e instanceof EgressError) || e.reason !== 'redirect')
        throw upstream('GitHub cannot be reached from the server', 'github_unreachable')
      const next = followable(e.location, url)
      if (!next)
        throw upstream('GitHub sent the download somewhere it is not allowed to go', 'github_redirect')
      if (hop >= MAX_REDIRECTS) throw upstream('GitHub redirected too many times', 'github_redirects')
      url = next
    }
  }
}

/** A redirect's target when it may be followed: https, one of GitHub's hosts, nothing else in it. */
function followable(location: string | undefined, from: string): string | null {
  if (!location) return null
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    return null
  }
  if (next.protocol !== 'https:' || next.port || next.username || next.password) return null
  return GITHUB_HOSTS.has(next.hostname) ? next.href : null
}

/**
 * The repository a release belongs to, from its own page's address: a renamed repository's
 * release names its new place (review 2026-10-11). Absent, the name typed; not GitHub's, refused.
 */
function repositoryOf(release: z.infer<typeof ReleaseSchema>, ref: GithubRef): string {
  if (release.html_url === undefined) return `${ref.owner}/${ref.repo}`
  let page: URL
  try {
    page = new URL(release.html_url)
  } catch {
    throw upstream('GitHub’s answer was not understood', 'github_failed')
  }
  const [owner, repo, kind] = page.pathname.split('/').slice(1)
  if (
    page.protocol !== 'https:' ||
    page.host !== 'github.com' ||
    kind !== 'releases' ||
    !plainRepo(owner, repo)
  )
    throw upstream('GitHub’s answer was not understood', 'github_failed')
  return `${owner}/${repo}`
}

/** The release's plugin archive, and where it came from — bounded at `limit` bytes. */
export async function fetchGithubRelease(
  egress: Egress,
  ref: GithubRef,
  limit: number,
): Promise<{ archive: Buffer; origin: PluginOrigin }> {
  const until = Date.now() + BUDGET_MS
  const api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
  const answer = await get(
    egress,
    ref.tag ? `${api}/releases/tags/${encodeURIComponent(ref.tag)}` : `${api}/releases/latest`,
    'application/vnd.github+json',
    RELEASE_BYTES,
    until,
    () => upstream('GitHub’s answer was not understood', 'github_failed'),
  )
  if (answer.status === 404)
    throw new AppError('NOT_FOUND', 'No published release was found in that repository', 404, {
      reason: 'github_not_found',
    })
  // A limit only when GitHub says so; another refusal is a refusal (review 2026-10-11).
  if (answer.status === 429 || (answer.status === 403 && answer.headers['x-ratelimit-remaining'] === '0'))
    throw new AppError('RATE_LIMITED', 'GitHub refused for now; try again later', 429, {
      reason: 'github_rate_limited',
    })
  if (answer.status === 403) throw upstream('GitHub refused to give that release', 'github_forbidden')
  if (answer.status !== 200) throw upstream('GitHub did not give the release', 'github_failed')
  let release: z.infer<typeof ReleaseSchema>
  try {
    release = ReleaseSchema.parse(JSON.parse(answer.body.toString('utf8')))
  } catch {
    throw upstream('GitHub’s answer was not understood', 'github_failed')
  }
  const repository = repositoryOf(release, ref)
  const archives = release.assets.filter((a) => /\.(?:tgz|tar\.gz)$/i.test(a.name))
  if (!archives.length)
    throw Errors.validation('The release has no plugin archive (.tgz)', { reason: 'github_no_archive' })
  if (archives.length > 1)
    throw Errors.validation('The release has more than one archive: publish one .tgz', {
      reason: 'github_many_archives',
      names: archives.slice(0, 10).map((a) => a.name),
    })
  const asset = archives[0]!
  if (asset.size > limit) throw Errors.payloadTooLarge()
  // Its checksum, when GitHub names one: one this version cannot check is refused before anything is
  // downloaded, never skipped (review of the ops fixes, M3).
  let expected: string | null = null
  if (asset.digest) {
    const named = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)
    if (!named)
      throw upstream('The release names a checksum this version cannot check', 'github_digest_unknown')
    expected = named[1]!.toLowerCase()
  }
  // Only an asset of this repository's releases, on github.com: never an address the answer names.
  const prefix = `https://github.com/${repository}/releases/download/`.toLowerCase()
  let download: URL
  try {
    download = new URL(asset.browser_download_url)
  } catch {
    throw upstream('The release’s archive is not on GitHub', 'github_asset')
  }
  if (
    !download.href.toLowerCase().startsWith(prefix) ||
    download.username ||
    download.port ||
    download.search
  )
    throw upstream('The release’s archive is not on GitHub', 'github_asset')
  const file = await get(egress, download.href, 'application/octet-stream', limit, until, () =>
    Errors.payloadTooLarge(),
  )
  if (file.status !== 200) throw upstream('GitHub did not give the release’s archive', 'github_failed')
  // The archive the release published, byte for byte, when GitHub names its checksum.
  if (expected && !safeEqual(createHash('sha256').update(file.body).digest('hex'), expected))
    throw upstream('The archive is not the one the release published', 'github_digest')
  const tag = release.tag_name
  return {
    archive: file.body,
    origin: {
      kind: 'github',
      repository,
      release: tag,
      asset: asset.name,
      url: `https://github.com/${repository}/releases/tag/${tag.split('/').map(encodeURIComponent).join('/')}`,
    },
  }
}
