import { AppError } from '../errors'
import { EgressError, SLOW_ANSWER_MS, type Egress, type EgressResponse } from './egress'

/**
 * GitHub's hosts, reached over https with nothing of the server's sent along (no cookie, token or
 * credentials) — by plugin installs (2026-10-11) and the updater (2026-11-03). The hosts a release
 * and its assets come from; a redirect anywhere else is refused.
 */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
export const MAX_REDIRECTS = 4
export const GITHUB_HEADERS = { 'user-agent': 'mongo-manager', 'x-github-api-version': '2022-11-28' }

export const upstream = (message: string, reason: string, more: Record<string, unknown> = {}) =>
  new AppError('UPSTREAM_ERROR', message, 502, { reason, ...more })

/**
 * Reads an address of GitHub's, following redirects only to GitHub's hosts, over https, within
 * what is left of the install's time. `tooLarge`: what an answer over `limit` means.
 */
export async function githubGet(
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
          headers: { accept, ...GITHUB_HEADERS },
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
export function followable(location: string | undefined, from: string): string | null {
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
 * A large asset, streamed: the same redirects as githubGet, then the answer as it comes. The whole
 * download must end by `until`.
 */
export async function githubStream(egress: Egress, start: string, until: number): Promise<EgressResponse> {
  let url = start
  for (let hop = 0; ; hop++) {
    const left = until - Date.now()
    if (left <= 0) throw upstream('GitHub took too long to answer', 'github_unreachable')
    try {
      return await egress.request({
        method: 'GET',
        url,
        deadlineMs: Math.min(left, SLOW_ANSWER_MS),
        headers: { accept: 'application/octet-stream', ...GITHUB_HEADERS },
      })
    } catch (e) {
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
