import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Transform, pipeline, type Readable } from 'node:stream'
import type { z } from 'zod'
import type { WebdavConfigSchema } from '@mongo-manager/shared'
import type { Egress, EgressResponse } from '../../net/egress'
import { SLOW_ANSWER_MS, SMALL_ANSWER_MS, discard, rangedBody, readBounded } from '../../net/egress'
import { child, childrenOf, parseXml, textOf } from '../../net/xml'
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

export type WebdavConfig = z.infer<typeof WebdavConfigSchema>
const PROPFIND_BODY = Buffer.from(
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
)
const MAX_ITEMS = 10_000
const MiB = 1024 * 1024
/** Nextcloud assembles at most this many chunks. */
const MAX_CHUNKS = 10_000
const PAGE = 1000
/** Phase 3d-3b final review (A14): folders walked by one listing at most (the root, years, months). */
const MAX_WALKED = 300
/**
 * A PROPFIND answer (phase 3d-3b final review, A27): depth 1 on a Nextcloud chunk folder lists up to
 * 10 000 chunks at about 400 bytes each, beyond the spec's 1 MiB; 4 MiB is kept for these answers.
 */
const PROPFIND_LIMIT = 4 * 1024 * 1024

interface Chunked extends ResumeState {
  key: string
  dir: string
  chunkSize: number
}

const readSmall = async (body: Readable, limit = PROPFIND_LIMIT) =>
  (await readBounded(body, limit)).toString('utf8')

/** Phase 3d-3b spec §2.5: generic WebDAV, and Nextcloud/ownCloud with resumable chunked uploads. */
export function createWebdavAdapter(o: {
  egress: Egress
  config: WebdavConfig
  secrets: { password: string }
  partBytes: number
  now: () => number
  /** Retries per request (default: the full policy); 0 when someone waits on the answer. */
  retries?: number
}): DestinationAdapter {
  const { config } = o
  // Phase 3d-3b final review (A20): the keys are appended to the address; a query or a fragment
  // would carry them where the server never sees them as a path.
  if (/[?#]/.test(config.url))
    throw new DestinationError('bad_url', 'The WebDAV address must not have a query or a fragment')
  const nextcloud = config.preset === 'nextcloud'
  const site = config.url.replace(/\/+$/, '')
  const user = encodeURIComponent(config.username)
  const filesBase = nextcloud ? `${site}/remote.php/dav/files/${user}` : site
  const uploadsBase = `${site}/remote.php/dav/uploads/${user}`
  const folder = config.folder ? assertSafePath(config.folder) : []
  const enc = (parts: string[]) => parts.map(encodeURIComponent).join('/')
  // Phase 3d-3b final review (A4): no empty segment, whatever the folder ('' is the default).
  const at = (parts: string[], dir: boolean) =>
    new URL(`${filesBase}/${enc(parts)}${dir && parts.length ? '/' : ''}`)
  const urlOf = (key: string) => at([...folder, ...assertSafePath(key)], false)
  const dirUrl = (parts: string[]) => at([...folder, ...parts], true)
  const auth = `Basic ${Buffer.from(`${config.username}:${o.secrets.password}`).toString('base64')}`
  /** Only a chunk folder this adapter names: "<uploads>/mm-<24 hex>", never a path that climbs with "..". */
  const ownChunkDir = (dir: unknown): dir is string =>
    typeof dir === 'string' &&
    dir.startsWith(`${uploadsBase}/mm-`) &&
    /^[0-9a-f]{24}$/.test(dir.slice(uploadsBase.length + 4))

  async function dav(
    method: string,
    url: URL,
    opts: {
      headers?: Record<string, string>
      body?: Buffer | (() => Readable)
      signal: AbortSignal
      allow?: number[]
      /**
       * Phase 3d-3b final review (A16): the overall deadline — small answers by default; null for
       * the object's own bytes (they flow, the idle timer watches them); longer for an assembly.
       */
      deadlineMs?: number | null
    },
  ): Promise<EgressResponse> {
    const deadlineMs = opts.deadlineMs === undefined ? SMALL_ANSWER_MS : opts.deadlineMs
    return withRetry(
      async () => {
        const body = typeof opts.body === 'function' ? opts.body() : opts.body
        const res = await o.egress.request({
          method,
          url,
          headers: {
            authorization: auth,
            ...(Buffer.isBuffer(body) ? { 'content-length': String(body.length) } : {}),
            ...opts.headers,
          },
          ...(body !== undefined ? { body } : {}),
          ...(config.caPem ? { caPem: config.caPem } : {}),
          ...(deadlineMs !== null ? { deadlineMs } : {}),
          signal: opts.signal,
        })
        if (res.status < 300 || opts.allow?.includes(res.status)) return res
        // Phase 3d-3b final review (A1): dropped, never drained.
        discard(res.body)
        const extra = {
          status: res.status,
          ...(retryAfterMs(res.headers['retry-after'], o.now()) !== undefined
            ? { retryAfterMs: retryAfterMs(res.headers['retry-after'], o.now())! }
            : {}),
        }
        if (res.status === 401)
          throw new DestinationError('auth', 'The user name or the password is wrong', extra)
        if (res.status === 403) throw new DestinationError('forbidden', 'The user may not write here', extra)
        if (res.status === 404) throw new DestinationError('not_found', 'Not found at the destination', extra)
        if (res.status === 507) throw new DestinationError('quota', 'The destination is full', extra)
        if (res.status === 409)
          throw new DestinationError('conflict', 'A folder on the way is missing', extra)
        throw new DestinationError('provider', `The server refused the request (${res.status})`, extra)
      },
      { signal: opts.signal, retries: o.retries },
    )
  }

  async function ensureDir(parts: string[], signal: AbortSignal): Promise<void> {
    const all = [...folder, ...parts]
    for (let i = 1; i <= all.length; i++) {
      const res = await dav('MKCOL', at(all.slice(0, i), true), { signal, allow: [405] })
      discard(res.body)
    }
  }

  async function propfind(url: URL, depth: 0 | 1, signal: AbortSignal) {
    const res = await dav('PROPFIND', url, {
      headers: { depth: String(depth), 'content-type': 'application/xml' },
      body: PROPFIND_BODY,
      signal,
      allow: [404],
    })
    if (res.status === 404) {
      discard(res.body)
      return null
    }
    const doc = parseXml(await readSmall(res.body))
    return childrenOf(doc, 'response').map((r) => {
      const prop = child(child(r, 'propstat') ?? r, 'prop')
      const href = decodeURIComponent(new URL(textOf(r, 'href') ?? '', url).pathname)
      const length = prop ? textOf(prop, 'getcontentlength') : null
      const modified = prop ? Date.parse(textOf(prop, 'getlastmodified') ?? '') : NaN
      const isDir = Boolean(prop && child(child(prop, 'resourcetype') ?? prop, 'collection'))
      return {
        href,
        isDir,
        // Phase 3d-3b final review (A15): a size is a non-negative integer, else unknown.
        size: sizeOf(length),
        modifiedAt: Number.isNaN(modified) ? null : modified,
      }
    })
  }

  const counting = (start: number, io: { progress(n: number): void }) => {
    let sent = start
    return new Transform({
      transform(chunk: Buffer, _e, cb) {
        sent += chunk.length
        io.progress(sent)
        cb(null, chunk)
      },
    })
  }
  // Review of the stream errors (2026-10-20): .pipe() does not pass an error on. A file that cannot
  // be read was an uncaught error, ending the server, and the request waited for an end that never
  // came; through pipeline, the body ends with the file's error.
  const sending = (file: Readable, counter: Transform): Readable => pipeline(file, counter, () => undefined)

  const adapter: DestinationAdapter = {
    readBack: config.verifyReadBack,
    endpoint: () => new URL(`${filesBase}/`),
    caPem: () => config.caPem,
    async authCheck(signal) {
      const found = await propfind(dirUrl([]), 0, signal)
      if (!found) await ensureDir(layoutRoot('').split('/'), signal)
      return {}
    },
    async put(key, file, resume, io, signal) {
      const parts = assertSafePath(key)
      await ensureDir(parts.slice(0, -1), signal)
      const target = urlOf(key)
      if (!nextcloud) {
        // Generic WebDAV cannot resume: a failed send starts over.
        const res = await dav('PUT', target, {
          headers: { 'content-length': String(file.size), 'content-type': 'application/octet-stream' },
          body: () => sending(createReadStream(file.path), counting(0, io)),
          signal,
          deadlineMs: null,
        })
        discard(res.body)
        return {}
      }
      // Phase 3d-3b final review (A21): Nextcloud takes at most 10 000 chunks; they grow like S3 parts.
      const need = Math.ceil(file.size / MAX_CHUNKS)
      const chunkSize = need > o.partBytes ? Math.ceil(need / MiB) * MiB : o.partBytes
      let state = resume as Chunked | null
      if (state && (state.key !== key || state.chunkSize !== chunkSize || !ownChunkDir(state.dir)))
        state = null
      const have = new Map<string, number>()
      if (state) {
        const listed = await propfind(new URL(`${state.dir}/`), 1, signal)
        if (!listed) state = null
        else
          for (const e of listed)
            if (!e.isDir && e.size !== null) have.set(e.href.slice(e.href.lastIndexOf('/') + 1), e.size)
      }
      if (!state) {
        const id = createHash('sha256').update(`${key}|${o.now()}`).digest('hex').slice(0, 24)
        state = { key, dir: `${uploadsBase}/mm-${id}`, chunkSize }
        const res = await dav('MKCOL', new URL(`${state.dir}/`), {
          headers: { destination: target.href },
          signal,
        })
        discard(res.body)
      }
      io.saveResume(state)
      const count = Math.ceil(file.size / chunkSize)
      let sent = 0
      for (let n = 1; n <= count; n++) {
        const name = String(n).padStart(5, '0')
        const start = (n - 1) * chunkSize
        const length = Math.min(chunkSize, file.size - start)
        // Review Focus 1: a chunk of the wrong size is sent again.
        if (have.get(name) === length) {
          sent += length
          io.progress(sent)
          continue
        }
        const res = await dav('PUT', new URL(`${state.dir}/${name}`), {
          headers: {
            'content-length': String(length),
            destination: target.href,
            'oc-total-length': String(file.size),
          },
          body: () =>
            sending(createReadStream(file.path, { start, end: start + length - 1 }), counting(sent, io)),
          signal,
          deadlineMs: null,
        })
        discard(res.body)
        sent += length
        io.saveResume(state)
      }
      const moved = await dav('MOVE', new URL(`${state.dir}/.file`), {
        headers: { destination: target.href, 'oc-total-length': String(file.size), overwrite: 'F' },
        signal,
        // A retry after a lost answer finds the target there (412) or the chunk folder gone (404).
        allow: [404, 412],
        deadlineMs: SLOW_ANSWER_MS,
      })
      discard(moved.body)
      if (moved.status === 404 || moved.status === 412) {
        // Phase 3d-3b final review (A5): accepted when the file in place is whole (the send job
        // checks it again); a different file is a conflict, nothing at all is not found.
        const st = await adapter.stat(key, signal)
        if (!st || st.size !== file.size)
          throw moved.status === 412
            ? new DestinationError('conflict', 'Another file with this name is already there', {
                status: 412,
              })
            : new DestinationError('not_found', 'Not found at the destination', { status: 404 })
      }
      io.saveResume(null)
      const st = await adapter.stat(key, signal)
      if (!st || st.size !== file.size)
        throw new DestinationError('verify', 'The uploaded size does not match the backup')
      return {}
    },
    async putSmall(key, body, signal) {
      await ensureDir(assertSafePath(key).slice(0, -1), signal)
      const res = await dav('PUT', urlOf(key), { body, signal })
      discard(res.body)
    },
    async stat(key, signal) {
      const found = await propfind(urlOf(key), 0, signal)
      const e = found?.[0]
      return e && !e.isDir && e.size !== null ? { size: e.size, archived: false } : null
    },
    async get(key, offset, signal) {
      const res = await dav('GET', urlOf(key), {
        headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
        signal,
        deadlineMs: null,
      })
      // A12: a 200 (the range ignored) is skipped up to the offset; a 206 must start where asked.
      return rangedBody(res, offset)
    },
    async getSmall(key, limit, signal) {
      const res = await dav('GET', urlOf(key), { signal, allow: [404] })
      if (res.status === 404) {
        discard(res.body)
        return null
      }
      return readBounded(res.body, limit)
    },
    async list(cursor, signal) {
      const base = decodeURIComponent(dirUrl([]).pathname)
      const items: RemoteItem[] = []
      const seenDirs = new Set<string>()
      const seenKeys = new Set<string>()
      let walked = 0
      // The layout's folders only: a year (4 digits) under the root, then a month (2 digits). A name
      // that decodes to "../" or repeats is never walked twice or followed out of the layout.
      // Phase 3d-3b final review (A14): newest first, and a bounded number of folders.
      const SEGMENT = [/^\d{4}$/, /^\d{2}$/]
      const walk = async (parts: string[], depth: number): Promise<void> => {
        const here = parts.join('/')
        if (seenDirs.has(here) || walked >= MAX_WALKED || items.length >= MAX_ITEMS) return
        seenDirs.add(here)
        walked++
        const entries = (await propfind(dirUrl(parts), 1, signal)) ?? []
        const below: string[][] = []
        for (const e of entries) {
          if (items.length >= MAX_ITEMS) break
          const rel = e.href.startsWith(base) ? e.href.slice(base.length).replace(/\/$/, '') : null
          if (!rel || rel === here) continue
          if (e.isDir) {
            const segs = rel.split('/')
            if (
              depth < 2 &&
              segs.length === parts.length + 1 &&
              rel.startsWith(`${here}/`) &&
              SEGMENT[depth]!.test(segs.at(-1)!)
            )
              below.push(segs)
          } else if (isSafeKey(rel, '') && !seenKeys.has(rel)) {
            seenKeys.add(rel)
            items.push({ key: rel, size: e.size ?? 0, modifiedAt: e.modifiedAt, archived: false })
          }
        }
        below.sort((a, b) => (a.at(-1)! < b.at(-1)! ? 1 : -1))
        for (const segs of below) await walk(segs, depth + 1)
      }
      await walk(layoutRoot('').split('/'), 0)
      items.sort((a, b) => (a.key < b.key ? 1 : -1))
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(key, signal) {
      const res = await dav('DELETE', urlOf(key), { signal, allow: [404] })
      discard(res.body)
    },
    async abandon(resume, signal) {
      const dir = (resume as Chunked | null)?.dir
      if (!ownChunkDir(dir)) return
      const res = await dav('DELETE', new URL(`${dir}/`), { signal, allow: [404] })
      discard(res.body)
    },
  }
  return adapter
}
