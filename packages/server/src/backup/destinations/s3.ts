// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { z } from 'zod'
import { ARCHIVE_STORAGE_CLASSES, type S3ConfigSchema } from '@mongo-manager/shared'
import type { Egress, EgressResponse } from '../../net/egress'
import {
  SLOW_ANSWER_MS,
  SMALL_ANSWER_MS,
  discard,
  rangedBody,
  readBounded,
  scrubText,
} from '../../net/egress'
import { childrenOf, parseXml, textOf } from '../../net/xml'
import { isSafeKey, layoutRoot } from './layout'
import { retryAfterMs, withRetry } from './retry'
import { EMPTY_SHA256, signRequest, type S3Credentials } from './s3-sign'
import {
  DestinationError,
  offsetOf,
  sizeOf,
  type DestinationAdapter,
  type RemoteItem,
  type ResumeState,
} from './types'

export type S3Config = z.infer<typeof S3ConfigSchema>
const MiB = 1024 * 1024
const MAX_PARTS = 10_000
const PAGE = 1000
/** Like the other adapters: a listing holds at most this many objects (the newest). */
const MAX_ITEMS = 10_000
/** ListObjectsV2 pages read for one listing at most (1000 keys each). */
const MAX_LIST_PAGES = 50
/** ListParts pages for one resume at most: 10 000 parts, 1000 to a page, and one to spare. */
const MAX_PART_PAGES = MAX_PARTS / 1000 + 1
/**
 * Body limits (phase 3d-3b final review, A27): error texts 64 KiB; answers 1 MiB as the spec says,
 * except a ListObjectsV2 page — 1000 keys of up to 1024 bytes with their dates, ETags, sizes and
 * classes can pass 1.3 MiB, so a listing page keeps 4 MiB.
 */
const ERROR_LIMIT = 64 * 1024
const XML_LIMIT = 1024 * 1024
const LISTING_LIMIT = 4 * 1024 * 1024

export function partSizeFor(size: number, partBytes: number): number {
  return Math.max(partBytes, Math.ceil(size / MAX_PARTS / MiB) * MiB)
}

interface Multipart extends ResumeState {
  key: string
  uploadId: string
  partSize: number
  parts: Array<{ n: number; etag: string; size: number }>
}

const encKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function hashRange(path: string, start: number, length: number): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(path, { start, end: start + length - 1 })) h.update(c as Buffer)
  return h.digest('hex')
}

const readSmall = async (body: Readable, limit = XML_LIMIT) =>
  (await readBounded(body, limit)).toString('utf8')

/** Phase 3d-3b spec §2.3: AWS, MinIO, R2, B2, DigitalOcean Spaces (and Cold Storage), Wasabi. */
export function createS3Adapter(o: {
  egress: Egress
  config: S3Config
  secrets: S3Credentials
  partBytes: number
  now: () => number
  /** Retries per request (default: the full policy); 0 when someone waits on the answer. */
  retries?: number
}): DestinationAdapter {
  const { config } = o
  const base = new URL(config.endpoint)
  // Phase 3d-3b final review (A20): the endpoint is a host. A path would be dropped without a word,
  // and a query or a fragment would carry the keys somewhere else.
  if (base.pathname !== '/' || base.search || base.hash || /[?#]/.test(config.endpoint))
    throw new DestinationError(
      'bad_url',
      'The S3 endpoint must be an address without a path, query or fragment',
    )
  const root = layoutRoot(config.prefix)

  const urlFor = (key: string | null, query: Record<string, string> = {}) => {
    const path = key ? `/${encKey(key)}` : '/'
    const url = config.pathStyle
      ? new URL(`${base.origin}/${config.bucket}${path === '/' ? '' : path}`)
      : new URL(`${base.protocol}//${config.bucket}.${base.host}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return url
  }

  async function fail(res: EgressResponse): Promise<never> {
    const text = await readBounded(res.body, ERROR_LIMIT, { truncate: true, ms: 30_000 })
      .then((b) => b.toString('utf8'))
      .catch(() => '')
    let code = ''
    let message = ''
    try {
      const doc = parseXml(text)
      code = textOf(doc, 'Code') ?? ''
      message = textOf(doc, 'Message') ?? ''
    } catch {
      // An answer that is not XML: the status speaks.
    }
    const extra = {
      status: res.status,
      ...(code ? { code } : {}),
      ...(retryAfterMs(res.headers['retry-after'], o.now()) !== undefined
        ? { retryAfterMs: retryAfterMs(res.headers['retry-after'], o.now())! }
        : {}),
    }
    const said = scrubText(`${code}${message ? `: ${message}` : ''}`)
    if (code === 'RequestTimeTooSkewed')
      throw new DestinationError(
        'clock',
        'The server’s clock is too far from the provider’s; correct the time',
        extra,
      )
    if (code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' || res.status === 401)
      throw new DestinationError('auth', 'The access key or the secret key is wrong', extra)
    // Specific codes first: S3 answers several of them with a plain 403.
    if (code === 'NoSuchBucket')
      throw new DestinationError('bucket', 'The bucket does not exist in this region', extra)
    if (code === 'InvalidObjectState')
      throw new DestinationError(
        'archived',
        'The backup is archived; thaw it first (Thaw… in the destination’s backups)',
        extra,
      )
    if (code === 'AccessDenied' || res.status === 403)
      throw new DestinationError('forbidden', `The key may not do this (${said || res.status})`, extra)
    if (res.status === 404) throw new DestinationError('not_found', 'Not found at the destination', extra)
    throw new DestinationError('provider', `The provider refused the request (${said || res.status})`, extra)
  }

  async function call(
    method: string,
    key: string | null,
    opts: {
      query?: Record<string, string>
      headers?: Record<string, string>
      body?: Buffer | (() => Readable)
      payloadHash?: string
      signal: AbortSignal
      notFound?: 'null'
      /**
       * Phase 3d-3b final review (A16): the overall deadline — small answers by default; null for
       * the object's own bytes (they flow, the idle timer watches them); longer for a completion.
       */
      deadlineMs?: number | null
    },
  ): Promise<EgressResponse | null> {
    const deadlineMs = opts.deadlineMs === undefined ? SMALL_ANSWER_MS : opts.deadlineMs
    return withRetry(
      async () => {
        const url = urlFor(key, opts.query)
        const body = typeof opts.body === 'function' ? opts.body() : opts.body
        const payloadHash = opts.payloadHash ?? (Buffer.isBuffer(body) ? sha256(body) : EMPTY_SHA256)
        const headers = signRequest({
          method,
          url,
          headers: {
            ...opts.headers,
            ...(Buffer.isBuffer(body) ? { 'content-length': String(body.length) } : {}),
          },
          payloadHash,
          region: config.region,
          now: new Date(o.now()),
          credentials: o.secrets,
        })
        const res = await o.egress.request({
          method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(config.caPem ? { caPem: config.caPem } : {}),
          ...(deadlineMs !== null ? { deadlineMs } : {}),
          signal: opts.signal,
        })
        if (res.status === 404 && opts.notFound === 'null') {
          discard(res.body)
          return null
        }
        if (res.status >= 300) return fail(res)
        return res
      },
      { signal: opts.signal, retries: o.retries },
    )
  }
  const must = async (p: Promise<EgressResponse | null>) => (await p)!
  // Phase 3d-3b final review (A1): an answer that is not read is dropped, never drained.
  const drain = (res: EgressResponse) => discard(res.body)

  /**
   * The backup is written in its storage class; a small object (a manifest, the test probe) never is
   * (A7) — in GLACIER or DEEP_ARCHIVE it could not be read back without a thaw.
   */
  const writeHeaders = (small = false) => ({
    'content-type': 'application/octet-stream',
    ...(config.storageClass !== 'STANDARD' && !small ? { 'x-amz-storage-class': config.storageClass } : {}),
    ...(config.sse.kind === 'AES256' ? { 'x-amz-server-side-encryption': 'AES256' } : {}),
    ...(config.sse.kind === 'aws:kms'
      ? {
          'x-amz-server-side-encryption': 'aws:kms',
          ...(config.sse.keyId ? { 'x-amz-server-side-encryption-aws-kms-key-id': config.sse.keyId } : {}),
        }
      : {}),
  })

  /**
   * The parts the provider holds, numbers 1..count only. Phase 3d-3b final review (A2): the marker
   * must move forward and the pages are capped — a provider repeating itself, or listing parts that
   * are not ours for ever, never keeps us asking (a part not listed is simply sent again).
   */
  async function listParts(
    m: Multipart,
    count: number,
    signal: AbortSignal,
  ): Promise<Map<number, { etag: string; size: number }> | null> {
    const out = new Map<number, { etag: string; size: number }>()
    let marker = 0
    for (let page = 0; page < MAX_PART_PAGES; page++) {
      const res = await call('GET', m.key, {
        query: { uploadId: m.uploadId, 'part-number-marker': String(marker) },
        signal,
        notFound: 'null',
      })
      if (!res) return null
      const doc = parseXml(await readSmall(res.body))
      let highest = marker
      for (const p of childrenOf(doc, 'Part')) {
        const n = sizeOf(textOf(p, 'PartNumber'))
        const size = sizeOf(textOf(p, 'Size'))
        if (n === null || n < 1 || n > count || size === null) continue
        out.set(n, { etag: textOf(p, 'ETag') ?? '', size })
        highest = Math.max(highest, n)
      }
      if (textOf(doc, 'IsTruncated') !== 'true') break
      const next = sizeOf(textOf(doc, 'NextPartNumberMarker')) ?? highest
      if (next <= marker || next >= count) break
      marker = next
    }
    return out
  }

  const adapter: DestinationAdapter = {
    readBack: false,
    endpoint: () => urlFor(null),
    caPem: () => config.caPem,
    async authCheck(signal) {
      drain(
        await must(
          call('GET', null, { query: { 'list-type': '2', 'max-keys': '1', prefix: `${root}/` }, signal }),
        ),
      )
      return {}
    },
    async put(key, file, resume, io, signal) {
      if (file.size <= o.partBytes) {
        // Phase 3d-3b final review (A22): a multipart upload an earlier attempt saved (the part size
        // has grown since) is aborted, not left behind to be billed.
        const old = resume as Multipart | null
        if (old && typeof old.uploadId === 'string') {
          await adapter.abandon(old, signal).catch(() => undefined)
          io.saveResume(null)
        }
        drain(
          await must(
            call('PUT', key, {
              headers: { ...writeHeaders(), 'content-length': String(file.size) },
              body: () => createReadStream(file.path),
              payloadHash: file.sha256,
              signal,
              deadlineMs: null,
            }),
          ),
        )
        io.progress(file.size)
      } else {
        const partSize = partSizeFor(file.size, o.partBytes)
        const count = Math.ceil(file.size / partSize)
        let m = resume as Multipart | null
        if (m && (m.key !== key || m.partSize !== partSize)) {
          await adapter.abandon(m, signal).catch(() => undefined)
          m = null
        }
        let done = new Map<number, { etag: string; size: number }>()
        if (m) {
          const listed = await listParts(m, count, signal)
          if (!listed) m = null
          else {
            // Review Focus 1: a part whose size or ETag differs from the record is sent again.
            const kept = m.parts.filter(
              (p) => listed.get(p.n)?.etag === p.etag && listed.get(p.n)?.size === p.size,
            )
            m.parts = kept
            done = new Map(kept.map((p) => [p.n, p]))
          }
        }
        if (!m) {
          const res = await must(
            call('POST', key, { query: { uploads: '' }, headers: writeHeaders(), signal }),
          )
          const uploadId = textOf(parseXml(await readSmall(res.body)), 'UploadId')
          if (!uploadId) throw new DestinationError('provider', 'The provider did not start the upload')
          m = { key, uploadId, partSize, parts: [] }
        }
        io.saveResume(m)
        let sent = m.parts.reduce((s, p) => s + p.size, 0)
        io.progress(sent)
        for (let n = 1; n <= count; n++) {
          if (done.has(n)) continue
          const start = (n - 1) * partSize
          const length = Math.min(partSize, file.size - start)
          const hash = await hashRange(file.path, start, length)
          const res = await must(
            call('PUT', key, {
              query: { partNumber: String(n), uploadId: m.uploadId },
              headers: { 'content-length': String(length) },
              body: () => createReadStream(file.path, { start, end: start + length - 1 }),
              payloadHash: hash,
              signal,
              deadlineMs: null,
            }),
          )
          drain(res)
          const etag = String(res.headers.etag ?? '')
          m.parts = [...m.parts.filter((p) => p.n !== n), { n, etag, size: length }]
          io.saveResume(m)
          sent += length
          io.progress(sent)
        }
        const xml = Buffer.from(
          `<CompleteMultipartUpload>${[...m.parts]
            .sort((a, b) => a.n - b.n)
            .map(
              (p) =>
                `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`,
            )
            .join('')}</CompleteMultipartUpload>`,
        )
        let res: EgressResponse | null
        try {
          res = await must(
            call('POST', key, {
              query: { uploadId: m.uploadId },
              body: xml,
              signal,
              deadlineMs: SLOW_ANSWER_MS,
            }),
          )
        } catch (e) {
          // Phase 3d-3b final review (A5): a completion retried after its first answer was lost
          // finds the upload gone because the object is there. Accepted when it is whole (the send
          // job checks it again); anything else still fails.
          if (!(e instanceof DestinationError) || e.extra.code !== 'NoSuchUpload') throw e
          const st = await adapter.stat(key, signal)
          if (!st || st.size !== file.size) throw e
          res = null
        }
        if (res) {
          // S3 may answer 200 with an <Error> body to a completion.
          const answer = parseXml(await readSmall(res.body))
          if (answer.local === 'Error')
            throw new DestinationError(
              'provider',
              `The provider did not complete the upload (${scrubText(textOf(answer, 'Code') ?? '')})`,
            )
        }
        io.saveResume(null)
      }
      const st = await adapter.stat(key, signal)
      if (!st || st.size !== file.size)
        throw new DestinationError('verify', 'The uploaded size does not match the backup')
      return {}
    },
    async putSmall(key, body, signal) {
      drain(await must(call('PUT', key, { headers: writeHeaders(true), body, signal })))
    },
    async stat(key, signal) {
      const res = await call('HEAD', key, { signal, notFound: 'null' })
      if (!res) return null
      drain(res)
      const cls = String(res.headers['x-amz-storage-class'] ?? 'STANDARD')
      const restore = String(res.headers['x-amz-restore'] ?? '')
      const thawed = /ongoing-request="false"/.test(restore)
      const thawing = /ongoing-request="true"/.test(restore)
      // Phase 3d-3b final review (A15): a size is a non-negative integer, never NaN or -1.
      const size = sizeOf(res.headers['content-length'])
      if (size === null)
        throw new DestinationError('provider', 'The provider did not report the object’s size')
      const archivedClass = ARCHIVE_STORAGE_CLASSES.includes(cls)
      return {
        size,
        archived: archivedClass && !thawed,
        // W4.5: where an archived object's thaw stands.
        ...(archivedClass ? { thaw: thawed ? 'thawed' : thawing ? 'thawing' : 'none' } : {}),
      }
    },
    /**
     * W4.5: S3 RestoreObject — a temporary readable copy of an archived object for `days`, at the
     * tier's speed (and price). 202 started, 409 already under way, 200 already thawed. The days and
     * the tier are checked by the route; the XML is built from them only.
     */
    async thaw(key, { days, tier }, signal) {
      const xml = Buffer.from(
        `<RestoreRequest xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Days>${Math.trunc(days)}</Days>` +
          `<GlacierJobParameters><Tier>${tier}</Tier></GlacierJobParameters></RestoreRequest>`,
      )
      try {
        const res = await must(call('POST', key, { query: { restore: '' }, body: xml, signal }))
        drain(res)
        return { state: res.status === 200 ? 'thawed' : 'thawing' }
      } catch (e) {
        if (e instanceof DestinationError && e.extra.code === 'RestoreAlreadyInProgress')
          return { state: 'thawing' }
        if (e instanceof DestinationError && e.reason === 'archived')
          throw new DestinationError(
            'not_archived',
            'This backup is not archived: it can be restored as it is',
          )
        throw e
      }
    },
    async get(key, offset, signal) {
      const res = await must(
        call('GET', key, {
          headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
          signal,
          deadlineMs: null,
        }),
      )
      // A12: a 200 (the range ignored) is skipped up to the offset; a 206 must start where asked.
      return rangedBody(res, offset)
    },
    async getSmall(key, limit, signal) {
      const res = await call('GET', key, { signal, notFound: 'null' })
      if (!res) return null
      return readBounded(res.body, limit)
    },
    async list(cursor, signal) {
      // Phase 3d-3b final review (A9): S3 lists oldest first, a page at a time. Like the other
      // adapters the listing is gathered (the newest MAX_ITEMS kept) and served newest first with an
      // offset cursor, so the first page holds the latest backups.
      const found = new Map<string, RemoteItem>()
      const keepNewest = () => {
        const newest = [...found.values()].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, MAX_ITEMS)
        found.clear()
        for (const i of newest) found.set(i.key, i)
      }
      let token: string | null = null
      const tokens = new Set<string>()
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await must(
          call('GET', null, {
            query: {
              'list-type': '2',
              prefix: `${root}/`,
              'max-keys': String(PAGE),
              ...(token ? { 'continuation-token': token } : {}),
            },
            signal,
          }),
        )
        const doc = parseXml(await readSmall(res.body, LISTING_LIMIT))
        for (const c of childrenOf(doc, 'Contents')) {
          const key = textOf(c, 'Key') ?? ''
          if (!isSafeKey(key, config.prefix)) continue
          const modified = Date.parse(textOf(c, 'LastModified') ?? '')
          found.set(key, {
            key,
            size: sizeOf(textOf(c, 'Size')) ?? 0,
            modifiedAt: Number.isNaN(modified) ? null : modified,
            archived: ARCHIVE_STORAGE_CLASSES.includes(textOf(c, 'StorageClass') ?? ''),
          })
        }
        if (found.size > 2 * MAX_ITEMS) keepNewest()
        const next = textOf(doc, 'IsTruncated') === 'true' ? textOf(doc, 'NextContinuationToken') : null
        // No token, or one seen before: the listing ends (a provider repeating itself is not followed).
        if (!next || tokens.has(next)) break
        tokens.add(next)
        token = next
      }
      keepNewest()
      const items = [...found.values()]
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(key, signal) {
      const res = await call('DELETE', key, { signal, notFound: 'null' })
      if (res) drain(res)
    },
    async abandon(resume, signal) {
      const m = resume as Multipart
      if (typeof m.uploadId !== 'string' || typeof m.key !== 'string') return
      const res = await call('DELETE', m.key, { query: { uploadId: m.uploadId }, signal, notFound: 'null' })
      if (res) drain(res)
    },
  }
  return adapter
}
