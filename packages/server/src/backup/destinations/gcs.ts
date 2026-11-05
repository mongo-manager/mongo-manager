// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { z } from 'zod'
import type { GcsConfigSchema } from '@mongo-manager/shared'
import type { Egress, EgressResponse } from '../../net/egress'
import { SMALL_ANSWER_MS, discard, rangedBody, readBounded } from '../../net/egress'
import { safeEqual } from '../../http/security'
import type { GoogleHosts, GoogleTokens } from './google-auth'
import { assertSafePath, isSafeKey, layoutRoot } from './layout'
import { RETRY_DELAYS, isRetryable, retryAfterMs, withRetry } from './retry'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DestinationError,
  offsetOf,
  sizeOf,
  type DestinationAdapter,
  type RemoteItem,
  type ResumeState,
} from './types'

export type GcsConfig = z.infer<typeof GcsConfigSchema>
const PAGE = 1000
const MAX_ITEMS = 10_000
/** Listing pages read for one listing at most (1000 objects each). */
const MAX_LIST_PAGES = 50
/** A resumable upload's parts are multiples of 256 KiB (Google's rule). */
const QUANTUM = 256 * 1024

interface Session extends ResumeState {
  key: string
  session: string
}

async function json(res: EgressResponse, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const text = (await readBounded(res.body, limit)).toString('utf8')
  try {
    const v = JSON.parse(text || '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Where an interrupted upload continues: "Range: bytes=0-N", never past the file's end. */
function resumeAt(header: string | string[] | undefined, size: number): number {
  const range = /^bytes=0-(\d+)$/.exec(String(Array.isArray(header) ? header[0] : (header ?? '')))
  const at = range ? Number(range[1]) + 1 : 0
  if (at > size) throw new DestinationError('provider', 'Google reported more bytes than the file holds')
  return at
}

/** Google's md5Hash is base64; the local digest is hex. */
const md5Hex = (b64: unknown): string | undefined =>
  typeof b64 === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(b64)
    ? Buffer.from(b64, 'base64').toString('hex')
    : undefined

/**
 * W4.5 (completion design §2 W4.5): Google Cloud Storage over its JSON API, signed in as a service
 * account (an RS256 assertion for an access token, scope devstorage.read_write). Uploads are resumable
 * sessions in parts of 256 KiB multiples; the session URI is a bearer capability, sealed in the resume
 * state, and must lead back to the storage host. Verification compares Google's MD5 with the local one.
 * Every request goes through the egress guard (and the proxy when one is set).
 */
export function createGcsAdapter(o: {
  egress: Egress
  hosts: GoogleHosts
  tokens: GoogleTokens
  config: GcsConfig
  account: string | null
  partBytes: number
  now: () => number
  retries?: number
}): DestinationAdapter {
  const { config } = o
  const storage = o.hosts.storage ?? 'https://storage.googleapis.com'
  const ca = o.hosts.caPem ? { caPem: o.hosts.caPem } : {}
  const root = layoutRoot(config.prefix)
  const partBytes = Math.max(QUANTUM, Math.floor(o.partBytes / QUANTUM) * QUANTUM)
  const bucket = encodeURIComponent(config.bucket)
  const objectUrl = (key: string, q: Record<string, string> = {}) => {
    const url = new URL(`${storage}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`)
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v)
    return url
  }
  const sameOrigin = (u: string) => {
    try {
      return new URL(u).origin === new URL(storage).origin
    } catch {
      return false
    }
  }

  async function api(
    method: string,
    url: URL,
    opts: {
      headers?: Record<string, string>
      body?: Buffer | (() => Readable)
      signal: AbortSignal
      allow?: number[]
      deadlineMs?: number | null
      /** W4 review (minor): the caller retries itself (a part: Google is asked where it stands first). */
      retries?: number
    },
  ): Promise<EgressResponse> {
    const deadlineMs = opts.deadlineMs === undefined ? SMALL_ANSWER_MS : opts.deadlineMs
    let refreshed = false
    const send = async () => {
      const token = await o.tokens.token(opts.signal)
      const body = typeof opts.body === 'function' ? opts.body() : opts.body
      return o.egress.request({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(Buffer.isBuffer(body) ? { 'content-length': String(body.length) } : {}),
          ...opts.headers,
        },
        ...(body !== undefined ? { body } : {}),
        ...ca,
        ...(deadlineMs !== null ? { deadlineMs } : {}),
        signal: opts.signal,
      })
    }
    return withRetry(
      async () => {
        let res = await send()
        // An access token Google no longer takes is refreshed once, in place.
        if (res.status === 401 && !refreshed) {
          refreshed = true
          discard(res.body)
          o.tokens.invalidate()
          res = await send()
        }
        if (res.status < 300 || opts.allow?.includes(res.status)) return res
        const err = await json(res, 64 * 1024).catch(() => ({}) as Record<string, unknown>)
        const reason = String(
          ((err.error as { errors?: Array<{ reason?: string }> })?.errors ?? [])[0]?.reason ?? '',
        )
        const extra = {
          status: res.status,
          ...(reason && /^[A-Za-z]{1,64}$/.test(reason) ? { code: reason } : {}),
          ...(retryAfterMs(res.headers['retry-after'], o.now()) !== undefined
            ? { retryAfterMs: retryAfterMs(res.headers['retry-after'], o.now())! }
            : {}),
        }
        if (res.status === 401)
          throw new DestinationError('auth', 'Google refused the service account', extra)
        if (res.status === 403)
          throw new DestinationError('forbidden', 'The service account may not do this in the bucket', extra)
        if (res.status === 404 && reason === 'notFound' && url.pathname.endsWith(`/b/${bucket}/o`))
          throw new DestinationError('bucket', 'The bucket does not exist', extra)
        if (res.status === 404) throw new DestinationError('not_found', 'Not found at the destination', extra)
        throw new DestinationError('provider', `Google refused the request (${res.status})`, extra)
      },
      { signal: opts.signal, retries: opts.retries ?? o.retries },
    )
  }

  async function startSession(key: string, size: number, signal: AbortSignal): Promise<Session> {
    const url = new URL(`${storage}/upload/storage/v1/b/${bucket}/o`)
    url.searchParams.set('uploadType', 'resumable')
    url.searchParams.set('name', key)
    const meta = Buffer.from(JSON.stringify({ name: key, storageClass: config.storageClass }))
    const res = await api('POST', url, {
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(size),
      },
      body: meta,
      signal,
    })
    discard(res.body)
    const location = String(res.headers.location ?? '')
    // The session URI is a bearer capability: it must lead back to the storage host.
    if (!sameOrigin(location))
      throw new DestinationError('provider', 'Google answered with an upload address on another host')
    return { key, session: location }
  }

  const adapter: DestinationAdapter = {
    readBack: false,
    endpoint: () => new URL(storage),
    caPem: () => o.hosts.caPem,
    async authCheck(signal) {
      const url = new URL(`${storage}/storage/v1/b/${bucket}/o`)
      url.searchParams.set('prefix', `${root}/`)
      url.searchParams.set('maxResults', '1')
      discard((await api('GET', url, { signal })).body)
      return o.account ? { account: o.account } : {}
    },
    async put(key, file, resume, io, signal) {
      assertSafePath(key)
      let s = resume as Session | null
      if (s && (s.key !== key || typeof s.session !== 'string' || !sameOrigin(s.session))) s = null
      let offset = 0
      let done: Record<string, unknown> | null = null
      if (s) {
        const res = await api('PUT', new URL(s.session), {
          headers: { 'content-range': `bytes */${file.size}`, 'content-length': '0' },
          signal,
          allow: [308, 404, 410],
        })
        if (res.status === 404 || res.status === 410) {
          discard(res.body)
          s = null
        } else if (res.status === 308) {
          discard(res.body)
          offset = resumeAt(res.headers.range, file.size)
        } else done = await json(res)
      }
      if (!s) s = await startSession(key, file.size, signal)
      io.saveResume(s)
      io.progress(offset)
      let failures = 0
      while (!done) {
        if (offset >= file.size) {
          const res = await api('PUT', new URL(s.session), {
            headers: { 'content-range': `bytes */${file.size}`, 'content-length': '0' },
            signal,
            allow: [308],
          })
          if (res.status === 308) {
            discard(res.body)
            throw new DestinationError(
              'provider',
              'Google holds the whole file but did not finish the upload',
            )
          }
          done = await json(res)
          break
        }
        const length = Math.min(partBytes, file.size - offset)
        const start = offset
        const end = offset + length - 1
        let res: EgressResponse
        try {
          res = await api('PUT', new URL(s.session), {
            headers: {
              'content-range': `bytes ${start}-${end}/${file.size}`,
              'content-length': String(length),
            },
            body: () => createReadStream(file.path, { start, end }),
            signal,
            allow: [308],
            deadlineMs: null,
            retries: 0,
          })
          failures = 0
        } catch (e) {
          // W4 review (minor): a part that failed midway (the network, a 5xx) may be held already,
          // wholly or in part: Google is asked where the upload stands, and it goes on from there.
          const most = Math.min(o.retries ?? RETRY_DELAYS.length, RETRY_DELAYS.length)
          if (!isRetryable(e) || failures >= most || signal.aborted) throw e
          await delay(RETRY_DELAYS[failures++]!, undefined, { signal })
          const st = await api('PUT', new URL(s.session), {
            headers: { 'content-range': `bytes */${file.size}`, 'content-length': '0' },
            signal,
            allow: [308],
          })
          if (st.status === 308) {
            discard(st.body)
            offset = resumeAt(st.headers.range, file.size)
            io.progress(offset)
          } else done = await json(st)
          continue
        }
        if (res.status === 308) {
          discard(res.body)
          offset = resumeAt(res.headers.range, file.size)
          if (offset <= start)
            throw new DestinationError('provider', 'Google did not accept the part that was sent')
          io.saveResume(s)
          io.progress(offset)
        } else done = await json(res)
      }
      io.saveResume(null)
      const md5 = md5Hex(done.md5Hash)
      if (sizeOf(done.size) !== file.size || (md5 !== undefined && !safeEqual(md5, file.md5)))
        throw new DestinationError('verify', 'The bucket holds a different file than the one sent')
      io.progress(file.size)
      return { checksums: md5 ? { md5 } : {} }
    },
    async putSmall(key, body, signal) {
      assertSafePath(key)
      const url = new URL(`${storage}/upload/storage/v1/b/${bucket}/o`)
      url.searchParams.set('uploadType', 'media')
      url.searchParams.set('name', key)
      discard(
        (await api('POST', url, { headers: { 'content-type': 'application/octet-stream' }, body, signal }))
          .body,
      )
    },
    async stat(key, signal) {
      const res = await api('GET', objectUrl(key, { fields: 'size,md5Hash,storageClass' }), {
        signal,
        allow: [404],
      })
      if (res.status === 404) {
        discard(res.body)
        return null
      }
      const meta = await json(res)
      const size = sizeOf(meta.size)
      if (size === null) throw new DestinationError('provider', 'Google did not report the object’s size')
      const md5 = md5Hex(meta.md5Hash)
      // Every Cloud Storage class is read at once (ARCHIVE too): nothing to thaw.
      return { size, archived: false, ...(md5 ? { md5 } : {}) }
    },
    async get(key, offset, signal) {
      const res = await api('GET', objectUrl(key, { alt: 'media' }), {
        headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
        signal,
        deadlineMs: null,
      })
      return rangedBody(res, offset)
    },
    async getSmall(key, limit, signal) {
      const res = await api('GET', objectUrl(key, { alt: 'media' }), { signal, allow: [404] })
      if (res.status === 404) {
        discard(res.body)
        return null
      }
      return readBounded(res.body, limit)
    },
    async list(cursor, signal) {
      const found: RemoteItem[] = []
      let token = ''
      const tokens = new Set<string>()
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const url = new URL(`${storage}/storage/v1/b/${bucket}/o`)
        url.searchParams.set('prefix', `${root}/`)
        url.searchParams.set('maxResults', String(PAGE))
        url.searchParams.set('fields', 'nextPageToken,items(name,size,updated)')
        if (token) url.searchParams.set('pageToken', token)
        const body = await json(await api('GET', url, { signal }), 8 * 1024 * 1024)
        for (const it of (Array.isArray(body.items) ? body.items : []) as Array<Record<string, unknown>>) {
          const key = typeof it.name === 'string' ? it.name : ''
          if (!isSafeKey(key, config.prefix)) continue
          const modified = Date.parse(String(it.updated ?? ''))
          found.push({
            key,
            size: sizeOf(it.size) ?? 0,
            modifiedAt: Number.isNaN(modified) ? null : modified,
            archived: false,
          })
        }
        const next = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
        // A provider repeating a token is not followed; the listing ends with what came.
        if (!next || tokens.has(next) || found.length >= 2 * MAX_ITEMS) break
        tokens.add(next)
        token = next
      }
      const items = found.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, MAX_ITEMS)
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(key, signal) {
      discard((await api('DELETE', objectUrl(key), { signal, allow: [404] })).body)
    },
    async abandon(resume, signal) {
      const s = resume as Session
      if (typeof s.session !== 'string' || !sameOrigin(s.session)) return
      // Cancelling a resumable session answers 499.
      discard((await api('DELETE', new URL(s.session), { signal, allow: [404, 410, 499] })).body)
    },
  }
  return adapter
}
