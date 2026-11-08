// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { z } from 'zod'
import type { GdriveConfigSchema } from '@mongo-manager/shared'
import type { Egress, EgressResponse } from '../../net/egress'
import { EgressError, SMALL_ANSWER_MS, discard, rangedBody, readBounded } from '../../net/egress'
import { safeEqual } from '../../http/security'
import type { GoogleHosts, GoogleTokens } from './google-auth'
import { assertSafePath, isSafeKey, layoutRoot } from './layout'
import { retryAfterMs, withRetry } from './retry'
import {
  DestinationError,
  offsetOf,
  sizeOf,
  type DestinationAdapter,
  type RemoteItem,
  type ResumeState,
} from './types'

export type GdriveConfig = z.infer<typeof GdriveConfigSchema>
const FOLDER = 'application/vnd.google-apps.folder'
const PAGE = 1000
const MAX_ITEMS = 10_000
/** Ten full pages hold MAX_ITEMS; more pages than that (empty ones included) is a provider looping. */
const MAX_PAGES = 20
/** Phase 3d-3b final review (A13): Drive calls one listing makes at most (years and months walked). */
const MAX_LIST_CALLS = 200

export const escapeQuery = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

interface Session extends ResumeState {
  key: string
  session: string
  offset: number
}

/** Where an interrupted upload continues: Drive's "Range: bytes=0-N", never past the file's end. */
function resumeAt(header: string | string[] | undefined, size: number): number {
  const range = /^bytes=0-(\d+)$/.exec(String(Array.isArray(header) ? header[0] : (header ?? '')))
  const at = range ? Number(range[1]) + 1 : 0
  if (at > size) throw new DestinationError('provider', 'Google reported more bytes than the file holds')
  return at
}

/** The id Drive gave a file or folder; an answer without one is refused, never kept as "undefined". */
function idOf(body: Record<string, unknown>): string {
  if (typeof body.id !== 'string' || !/^[\w-]{1,256}$/.test(body.id))
    throw new DestinationError('provider', 'Google answered without a file id')
  return body.id
}

/** A JSON answer, bounded in size and (phase 3d-3b final review, A16) in total time. */
async function json(res: EgressResponse, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const text = (await readBounded(res.body, limit)).toString('utf8')
  try {
    const v = JSON.parse(text || '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Phase 3d-3b spec §2.4: drive.file — the app sees only the files it created, in its own folder. */
export function createDriveAdapter(o: {
  egress: Egress
  hosts: GoogleHosts
  tokens: GoogleTokens
  config: GdriveConfig
  account: string | null
  folderId: string | null
  saveFolderId(id: string): void
  partBytes: number
  now: () => number
  /** Retries per request (default: the full policy); 0 when someone waits on the answer. */
  retries?: number
}): DestinationAdapter {
  const { config } = o
  const shared = config.sharedDriveId
  const ca = o.hosts.caPem ? { caPem: o.hosts.caPem } : {}
  const folders = new Map<string, string>()
  let rootId = o.folderId

  const common = (q: URLSearchParams) => {
    q.set('supportsAllDrives', 'true')
    return q
  }
  async function api(
    method: string,
    url: URL,
    opts: {
      headers?: Record<string, string>
      body?: Buffer | (() => Readable)
      signal: AbortSignal
      allow?: number[]
      /**
       * Phase 3d-3b final review (A16): the overall deadline - small answers by default; null for
       * an upload's chunks and the media download (their bytes flow, the idle timer watches them).
       */
      deadlineMs?: number | null
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
        // Phase 3d-3b final review (A11): an access token Google no longer takes is refreshed once,
        // in place - not through a retry, which a caller who is waiting (retries 0) does not allow.
        if (res.status === 401 && !refreshed) {
          refreshed = true
          discard(res.body)
          o.tokens.invalidate()
          res = await send()
        }
        if (res.status < 300 || opts.allow?.includes(res.status)) return res
        const err: Record<string, unknown> = await json(res, 64 * 1024).catch(() => ({}))
        const reason = String(
          ((err.error as { errors?: Array<{ reason?: string }> })?.errors ?? [])[0]?.reason ?? '',
        )
        const extra = {
          status: res.status,
          ...(retryAfterMs(res.headers['retry-after'], o.now()) !== undefined
            ? { retryAfterMs: retryAfterMs(res.headers['retry-after'], o.now())! }
            : {}),
        }
        if (res.status === 401)
          throw new DestinationError('reconnect', 'Google no longer accepts this connection', extra)
        if (reason === 'storageQuotaExceeded') throw new DestinationError('quota', 'The Drive is full', extra)
        if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
          throw new DestinationError('provider', 'Google asks to slow down', { ...extra, status: 429 })
        if (res.status === 403)
          throw new DestinationError('forbidden', 'The account may not write here', extra)
        if (res.status === 404) throw new DestinationError('not_found', 'Not found at the destination', extra)
        throw new DestinationError('provider', `Google refused the request (${res.status})`, extra)
      },
      { signal: opts.signal, retries: o.retries },
    )
  }
  const filesUrl = (path = '', q: Record<string, string> = {}) =>
    new URL(`${o.hosts.api}/drive/v3/files${path}?${common(new URLSearchParams(q)).toString()}`)

  async function find(parent: string, name: string, folder: boolean, signal: AbortSignal) {
    const q = `name='${escapeQuery(name)}' and '${escapeQuery(parent)}' in parents and mimeType${folder ? '=' : '!='}'${FOLDER}' and trashed=false`
    const extra: Record<string, string> = shared
      ? { corpora: 'drive', driveId: shared, includeItemsFromAllDrives: 'true' }
      : {}
    const res = await api(
      'GET',
      filesUrl('', {
        q,
        fields: 'files(id,name,size,sha256Checksum,md5Checksum,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: '10',
        ...extra,
      }),
      { signal },
    )
    const files = ((await json(res)).files ?? []) as Array<Record<string, string>>
    return files[0] ?? null
  }
  async function createFolder(parent: string, name: string, signal: AbortSignal): Promise<string> {
    const body = Buffer.from(JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }))
    const res = await api('POST', filesUrl('', { fields: 'id' }), {
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    })
    return idOf(await json(res))
  }
  async function root(signal: AbortSignal): Promise<string> {
    if (rootId) {
      const res = await api('GET', filesUrl(`/${encodeURIComponent(rootId)}`, { fields: 'id,trashed' }), {
        signal,
        allow: [404],
      })
      const body = await json(res)
      if (res.status !== 404 && body.trashed !== true) return rootId
    }
    const top = shared ?? 'root'
    const found = await find(top, config.folderName, true, signal)
    rootId = found?.id ?? (await createFolder(top, config.folderName, signal))
    o.saveFolderId(rootId)
    folders.clear()
    return rootId
  }
  async function folderFor(parts: string[], create: boolean, signal: AbortSignal): Promise<string | null> {
    let id = await root(signal)
    let path = ''
    for (const p of parts) {
      path = path ? `${path}/${p}` : p
      const cached = folders.get(path)
      if (cached) {
        id = cached
        continue
      }
      const found = await find(id, p, true, signal)
      if (!found && !create) return null
      id = found?.id ?? (await createFolder(id, p, signal))
      folders.set(path, id)
    }
    return id
  }
  async function fileOf(key: string, signal: AbortSignal) {
    const parts = assertSafePath(key)
    const parent = await folderFor(parts.slice(0, -1), false, signal)
    return parent ? find(parent, parts.at(-1)!, false, signal) : null
  }
  const sameOrigin = (u: string) => {
    try {
      return new URL(u).origin === new URL(o.hosts.upload).origin
    } catch {
      return false
    }
  }

  const adapter: DestinationAdapter = {
    readBack: false,
    endpoint: () => new URL(o.hosts.api),
    caPem: () => o.hosts.caPem,
    async authCheck(signal) {
      await root(signal)
      if (o.account) return { account: o.account }
      const res = await api('GET', new URL(`${o.hosts.api}/drive/v3/about?fields=user(emailAddress)`), {
        signal,
      })
      const user = (await json(res)).user as { emailAddress?: string } | undefined
      return user?.emailAddress ? { account: user.emailAddress } : {}
    },
    async put(key, file, resume, io, signal) {
      const parts = assertSafePath(key)
      const parent = (await folderFor(parts.slice(0, -1), true, signal))!
      let s = resume as Session | null
      if (s && (s.key !== key || !sameOrigin(s.session))) s = null
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
      if (!s) {
        const meta = Buffer.from(JSON.stringify({ name: parts.at(-1), parents: [parent] }))
        const res = await api(
          'POST',
          new URL(`${o.hosts.upload}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`),
          {
            headers: {
              'content-type': 'application/json; charset=UTF-8',
              'x-upload-content-type': 'application/octet-stream',
              'x-upload-content-length': String(file.size),
            },
            body: meta,
            signal,
          },
        )
        discard(res.body)
        const location = String(res.headers.location ?? '')
        // D5: the session URI is a bearer capability; it must lead back to Google's upload host.
        if (!sameOrigin(location))
          throw new DestinationError('provider', 'Google answered with an upload address on another host')
        s = { key, session: location, offset: 0 }
      }
      io.saveResume(s)
      io.progress(offset)
      while (!done) {
        if (offset >= file.size) {
          // Phase 3d-3b final review (A10): Drive holds every byte; the result is asked for - a
          // range of nothing ("bytes N-(N-1)/N") is not a valid request.
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
        const length = Math.min(o.partBytes, file.size - offset)
        const end = offset + length - 1
        const start = offset
        const res = await api('PUT', new URL(s.session), {
          headers: {
            'content-range': `bytes ${start}-${end}/${file.size}`,
            'content-length': String(length),
          },
          body: () => createReadStream(file.path, { start, end }),
          signal,
          allow: [308],
          deadlineMs: null,
        })
        if (res.status === 308) {
          discard(res.body)
          offset = resumeAt(res.headers.range, file.size)
          // A10: a part Google did not take (or a range going backwards) is not sent for ever.
          if (offset <= start)
            throw new DestinationError('provider', 'Google did not accept the part that was sent')
          s.offset = offset
          io.saveResume(s)
          io.progress(offset)
        } else done = await json(res)
      }
      io.saveResume(null)
      const id = idOf(done)
      const meta = await json(
        await api(
          'GET',
          filesUrl(`/${encodeURIComponent(id)}`, { fields: 'id,size,sha256Checksum,md5Checksum' }),
          { signal },
        ),
      )
      const sha = typeof meta.sha256Checksum === 'string' ? meta.sha256Checksum : undefined
      const md5 = typeof meta.md5Checksum === 'string' ? meta.md5Checksum : undefined
      if (
        Number(meta.size) !== file.size ||
        (sha ? !safeEqual(sha, file.sha256) : md5 ? !safeEqual(md5, file.md5) : false)
      )
        throw new DestinationError('verify', 'Drive holds a different file than the one sent')
      io.progress(file.size)
      return { ref: id, checksums: { ...(sha ? { sha256: sha } : {}), ...(md5 ? { md5 } : {}) } }
    },
    async putSmall(key, body, signal) {
      const parts = assertSafePath(key)
      const parent = (await folderFor(parts.slice(0, -1), true, signal))!
      const boundary = `mm${randomBytes(12).toString('hex')}`
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: parts.at(-1), parents: [parent] })}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
        ),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
      const res = await api(
        'POST',
        new URL(`${o.hosts.upload}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`),
        {
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          body: payload,
          signal,
        },
      )
      discard(res.body)
    },
    async stat(key, signal) {
      const f = await fileOf(key, signal)
      if (!f) return null
      // Phase 3d-3b final review (A15): a size is a non-negative integer, never NaN.
      const size = sizeOf(f.size)
      if (size === null) throw new DestinationError('provider', 'Google did not report the file’s size')
      return {
        size,
        archived: false,
        ref: f.id,
        ...(f.sha256Checksum ? { sha256: f.sha256Checksum } : {}),
        ...(f.md5Checksum ? { md5: f.md5Checksum } : {}),
      }
    },
    async get(key, offset, signal) {
      const f = await fileOf(key, signal)
      if (!f) throw new DestinationError('not_found', 'The backup is not in this Drive folder')
      const res = await api('GET', filesUrl(`/${encodeURIComponent(f.id!)}`, { alt: 'media' }), {
        headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
        signal,
        deadlineMs: null,
      })
      // A12: a 200 (the range ignored) is skipped up to the offset; a 206 must start where asked.
      return rangedBody(res, offset)
    },
    async getSmall(key, limit, signal) {
      const f = await fileOf(key, signal)
      if (!f) return null
      if ((sizeOf(f.size) ?? 0) > limit)
        throw new EgressError('too_large', 'The file is larger than expected')
      const res = await api('GET', filesUrl(`/${encodeURIComponent(f.id!)}`, { alt: 'media' }), { signal })
      return readBounded(res.body, limit)
    },
    async list(cursor, signal) {
      const items: RemoteItem[] = []
      let calls = 0
      const children = async (parent: string, folder: boolean) => {
        const q = `'${escapeQuery(parent)}' in parents and mimeType${folder ? '=' : '!='}'${FOLDER}' and trashed=false`
        const out: Array<Record<string, string>> = []
        let token = ''
        let pages = 0
        do {
          // Phase 3d-3b final review (A13): a bounded number of calls for the whole listing.
          if (++calls > MAX_LIST_CALLS) break
          const res = await api(
            'GET',
            filesUrl('', {
              q,
              fields: 'nextPageToken,files(id,name,size,modifiedTime)',
              pageSize: '1000',
              ...(token ? { pageToken: token } : {}),
              ...(shared ? { corpora: 'drive', driveId: shared, includeItemsFromAllDrives: 'true' } : {}),
            }),
            { signal },
          )
          const body = await json(res, 8 * 1024 * 1024)
          out.push(...((body.files ?? []) as Array<Record<string, string>>))
          token = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
          // Like MAX_ITEMS, a page cap ends the listing with what came: empty pages that keep a
          // next-page token never keep us asking.
        } while (token && out.length < MAX_ITEMS && ++pages < MAX_PAGES)
        return out
      }
      // Only the layout's folders (a year of 4 digits, then a month of 2), newest first, until
      // MAX_ITEMS objects (A13): anything else is never descended into.
      const named = (list: Array<Record<string, string>>, shape: RegExp) =>
        list
          .filter((x) => typeof x.name === 'string' && shape.test(x.name) && typeof x.id === 'string')
          .sort((a, b) => (a.name! < b.name! ? 1 : -1))
      const top = await folderFor(layoutRoot('').split('/'), false, signal)
      if (top)
        years: for (const y of named(await children(top, true), /^\d{4}$/))
          for (const m of named(await children(y.id!, true), /^\d{2}$/)) {
            for (const f of await children(m.id!, false)) {
              const key = `${layoutRoot('')}/${y.name}/${m.name}/${f.name}`
              if (isSafeKey(key, '') && typeof f.id === 'string')
                items.push({
                  key,
                  size: sizeOf(f.size) ?? 0,
                  modifiedAt: Date.parse(f.modifiedTime ?? '') || null,
                  archived: false,
                  ref: f.id,
                })
              if (items.length >= MAX_ITEMS) break years
            }
            if (calls >= MAX_LIST_CALLS) break years
          }
      items.sort((a, b) => (a.key < b.key ? 1 : -1))
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(key, signal) {
      const f = await fileOf(key, signal)
      if (!f) return
      const res = await api('DELETE', filesUrl(`/${encodeURIComponent(f.id!)}`), { signal, allow: [404] })
      discard(res.body)
    },
    async abandon(resume, signal) {
      const s = resume as Session
      if (typeof s.session !== 'string' || !sameOrigin(s.session)) return
      const res = await api('DELETE', new URL(s.session), { signal, allow: [404, 410, 499] })
      discard(res.body)
    },
  }
  return adapter
}
