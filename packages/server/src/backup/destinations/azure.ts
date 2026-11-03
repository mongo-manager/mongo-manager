import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { z } from 'zod'
import { sasFields, type AzureConfigSchema } from '@mongo-manager/shared'
import type { Egress, EgressResponse } from '../../net/egress'
import { SLOW_ANSWER_MS, SMALL_ANSWER_MS, discard, rangedBody, readBounded } from '../../net/egress'
import { childrenOf, child, parseXml, textOf } from '../../net/xml'
import { AZURE_VERSION, sharedKeyAuthorization } from './azure-sign'
import { assertSafePath, isSafeKey, layoutRoot } from './layout'
import { retryAfterMs, withRetry } from './retry'
import {
  DestinationError,
  offsetOf,
  sizeOf,
  type DestinationAdapter,
  type RemoteItem,
  type ResumeState,
  type ThawState,
} from './types'

export type AzureConfig = z.infer<typeof AzureConfigSchema>
export type AzureSecrets = { sasToken?: string; accountKey?: string }
const MiB = 1024 * 1024
/** A block blob holds at most 50 000 blocks. */
const MAX_BLOCKS = 50_000
const PAGE = 1000
const MAX_ITEMS = 10_000
/** List Blobs pages read for one listing at most (5000 blobs each). */
const MAX_LIST_PAGES = 10
const ERROR_LIMIT = 64 * 1024
/** 5000 names of up to 1024 bytes with their properties. */
const LISTING_LIMIT = 16 * 1024 * 1024

interface Blocks extends ResumeState {
  key: string
  blockSize: number
  count: number
  /**
   * W4 review I3: this upload's own mark, in every block id it puts (kept in the sealed resume
   * state): blocks Azure holds from another attempt never pass for this one's.
   */
  nonce: string
}

const NONCE = /^[0-9a-f]{8}$/
/**
 * Every block id of an upload has the same length (Azure's rule): "mm-", the upload's nonce and six
 * digits, in base64.
 */
export const blockId = (nonce: string, n: number) =>
  Buffer.from(`mm-${nonce}-${String(n).padStart(6, '0')}`).toString('base64')
export const blockSizeFor = (size: number, partBytes: number) =>
  Math.max(partBytes, Math.ceil(size / MAX_BLOCKS / MiB) * MiB)

async function md5Range(path: string, start: number, length: number): Promise<string> {
  const h = createHash('md5')
  for await (const c of createReadStream(path, { start, end: start + length - 1 })) h.update(c as Buffer)
  return h.digest('base64')
}
const hexOf = (b64: unknown): string | undefined =>
  typeof b64 === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(b64)
    ? Buffer.from(b64, 'base64').toString('hex')
    : undefined
const header = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : (v ?? ''))

/**
 * W4.5 (completion design §2 W4.5): Azure Blob Storage over its REST API, through the egress guard
 * (and the proxy when one is set). Signed with the account's shared key (HMAC-SHA256 of the request,
 * the key never sent) or a SAS token appended to each request (only SAS fields, checked again here).
 * Large backups go up as blocks of one size, each checked by Azure against its MD5; an interrupted
 * upload resumes from the uncommitted blocks Azure still holds (Get Block List). Backups are written
 * in the chosen access tier; an Archive blob is reported archived, and "thaw" rehydrates it to Cool.
 */
export function createAzureAdapter(o: {
  egress: Egress
  config: AzureConfig
  secrets: AzureSecrets
  partBytes: number
  now: () => number
  retries?: number
}): DestinationAdapter {
  const { config } = o
  const base = new URL(config.endpoint ?? `https://${config.account}.blob.core.windows.net`)
  if (base.pathname !== '/' || base.search || base.hash)
    throw new DestinationError('bad_url', 'The Blob endpoint must be an address without a path')
  const sas = config.auth === 'sas' ? sasFields(o.secrets.sasToken ?? '') : null
  const key = config.auth === 'sharedKey' ? Buffer.from(o.secrets.accountKey ?? '', 'base64') : null
  if (config.auth === 'sas' ? !sas : key?.length !== 64)
    throw new DestinationError(
      'secrets_missing',
      'The destination’s credentials are missing; enter them again',
    )
  const root = layoutRoot(config.prefix)
  const container = config.container

  const urlFor = (blob: string | null, query: Record<string, string> = {}) => {
    const path = blob ? `/${container}/${blob.split('/').map(encodeURIComponent).join('/')}` : `/${container}`
    const url = new URL(`${base.origin}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return url
  }

  async function fail(res: EgressResponse): Promise<never> {
    const text = await readBounded(res.body, ERROR_LIMIT, { truncate: true, ms: 30_000 })
      .then((b) => b.toString('utf8'))
      .catch(() => '')
    let code = header(res.headers['x-ms-error-code'])
    try {
      code ||= textOf(parseXml(text), 'Code') ?? ''
    } catch {
      // An answer that is not XML: the status and the header speak.
    }
    if (!/^[A-Za-z]{1,64}$/.test(code)) code = ''
    const after = retryAfterMs(res.headers['retry-after'], o.now())
    const extra = {
      status: res.status,
      ...(code ? { code } : {}),
      ...(after !== undefined ? { retryAfterMs: after } : {}),
    }
    // Azure's messages are not repeated: one about a refused signature quotes the string it signed.
    if (code === 'AuthenticationFailed' || res.status === 401)
      throw new DestinationError('auth', 'Azure refused the key or the SAS token', extra)
    if (code === 'ContainerNotFound')
      throw new DestinationError('bucket', 'The container does not exist in this storage account', extra)
    if (code === 'BlobArchived' || code === 'BlobBeingRehydrated')
      throw new DestinationError('archived', 'The backup is archived; thaw it first', extra)
    if (res.status === 403)
      throw new DestinationError(
        'forbidden',
        `The key or token may not do this (${code || res.status})`,
        extra,
      )
    if (res.status === 404) throw new DestinationError('not_found', 'Not found at the destination', extra)
    throw new DestinationError('provider', `Azure refused the request (${code || res.status})`, extra)
  }

  async function call(
    method: string,
    blob: string | null,
    opts: {
      query?: Record<string, string>
      headers?: Record<string, string>
      body?: Buffer | (() => Readable)
      signal: AbortSignal
      allow?: number[]
      deadlineMs?: number | null
    },
  ): Promise<EgressResponse> {
    const deadlineMs = opts.deadlineMs === undefined ? SMALL_ANSWER_MS : opts.deadlineMs
    return withRetry(
      async () => {
        const url = urlFor(blob, opts.query)
        // The SAS fields go last; they can only be SAS fields (sasFields), never one of ours.
        for (const [k, v] of sas ?? []) url.searchParams.append(k, v)
        const body = typeof opts.body === 'function' ? opts.body() : opts.body
        const headers: Record<string, string> = {
          'x-ms-date': new Date(o.now()).toUTCString(),
          'x-ms-version': AZURE_VERSION,
          ...(Buffer.isBuffer(body) ? { 'content-length': String(body.length) } : {}),
          ...(body === undefined && (method === 'PUT' || method === 'POST') ? { 'content-length': '0' } : {}),
          ...opts.headers,
        }
        if (key) headers.authorization = sharedKeyAuthorization(method, url, headers, config.account, key)
        const res = await o.egress.request({
          method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(config.caPem ? { caPem: config.caPem } : {}),
          ...(deadlineMs !== null ? { deadlineMs } : {}),
          signal: opts.signal,
        })
        if (res.status < 300 || opts.allow?.includes(res.status)) return res
        return fail(res)
      },
      { signal: opts.signal, retries: o.retries },
    )
  }
  const drain = (res: EgressResponse) => discard(res.body)
  const tierHeader = (small: boolean): Record<string, string> =>
    // A manifest or the test probe is never archived: it must be read back at once.
    config.accessTier !== 'default' && !(small && config.accessTier === 'Archive')
      ? { 'x-ms-access-tier': config.accessTier }
      : {}

  /** The uncommitted blocks Azure holds for the blob, this upload's only (its nonce, the size expected). */
  async function heldBlocks(b: Blocks, size: number, signal: AbortSignal): Promise<Set<number>> {
    const res = await call('GET', b.key, {
      query: { comp: 'blocklist', blocklisttype: 'uncommitted' },
      signal,
      allow: [404],
    })
    if (res.status === 404) {
      drain(res)
      return new Set()
    }
    const doc = parseXml((await readBounded(res.body, 8 * MiB)).toString('utf8'))
    const held = new Set<number>()
    const list = child(doc, 'UncommittedBlocks')
    for (const blk of list ? childrenOf(list, 'Block') : []) {
      const name = Buffer.from(textOf(blk, 'Name') ?? '', 'base64').toString('latin1')
      const m = /^mm-([0-9a-f]{8})-([0-9]{6})$/.exec(name)
      if (!m || m[1] !== b.nonce) continue
      const n = Number(m[2])
      if (n < 1 || n > b.count) continue
      const expected = Math.min(b.blockSize, size - (n - 1) * b.blockSize)
      if (sizeOf(textOf(blk, 'Size')) === expected) held.add(n)
    }
    return held
  }

  const adapter: DestinationAdapter = {
    readBack: false,
    endpoint: () => new URL(base.origin),
    caPem: () => config.caPem,
    async authCheck(signal) {
      drain(
        await call('GET', null, {
          query: { restype: 'container', comp: 'list', prefix: `${root}/`, maxresults: '1' },
          signal,
        }),
      )
      return {}
    },
    async put(blob, file, resume, io, signal) {
      assertSafePath(blob)
      if (file.size <= o.partBytes) {
        if (resume) io.saveResume(null)
        // Put Blob with the file's MD5: Azure refuses a body that does not match it.
        const res = await call('PUT', blob, {
          headers: {
            'x-ms-blob-type': 'BlockBlob',
            'content-type': 'application/octet-stream',
            'content-length': String(file.size),
            'content-md5': Buffer.from(file.md5, 'hex').toString('base64'),
            ...tierHeader(false),
          },
          body: () => createReadStream(file.path),
          signal,
          deadlineMs: null,
        })
        drain(res)
        io.progress(file.size)
        return { checksums: { md5: file.md5 } }
      }
      const blockSize = blockSizeFor(file.size, o.partBytes)
      const count = Math.ceil(file.size / blockSize)
      let b = resume as Blocks | null
      if (
        b &&
        (b.key !== blob ||
          b.blockSize !== blockSize ||
          b.count !== count ||
          typeof b.nonce !== 'string' ||
          !NONCE.test(b.nonce))
      )
        b = null
      // W4 review I3: Azure's held blocks are looked at only when resuming this upload (its nonce).
      const resuming = b !== null
      b ??= { key: blob, blockSize, count, nonce: randomBytes(4).toString('hex') }
      const held = resuming ? await heldBlocks(b, file.size, signal) : new Set<number>()
      io.saveResume(b)
      let sent = [...held].reduce((s, n) => s + Math.min(blockSize, file.size - (n - 1) * blockSize), 0)
      io.progress(sent)
      for (let n = 1; n <= count; n++) {
        if (held.has(n)) continue
        const start = (n - 1) * blockSize
        const length = Math.min(blockSize, file.size - start)
        const md5 = await md5Range(file.path, start, length)
        drain(
          await call('PUT', blob, {
            query: { comp: 'block', blockid: blockId(b.nonce, n) },
            headers: { 'content-length': String(length), 'content-md5': md5 },
            body: () => createReadStream(file.path, { start, end: start + length - 1 }),
            signal,
            deadlineMs: null,
          }),
        )
        sent += length
        io.progress(sent)
      }
      const xml = Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><BlockList>${Array.from(
          { length: count },
          (_, i) => `<Uncommitted>${blockId(b.nonce, i + 1)}</Uncommitted>`,
        ).join('')}</BlockList>`,
      )
      drain(
        await call('PUT', blob, {
          query: { comp: 'blocklist' },
          headers: { 'content-type': 'application/xml', ...tierHeader(false) },
          body: xml,
          signal,
          deadlineMs: SLOW_ANSWER_MS,
        }),
      )
      io.saveResume(null)
      // Each block was checked against its MD5 on the way; the whole is checked by its size here
      // (and by the send job). No whole-file MD5 is claimed: Azure did not compute one.
      const st = await adapter.stat(blob, signal)
      if (!st || st.size !== file.size)
        throw new DestinationError('verify', 'The uploaded size does not match the backup')
      return {}
    },
    async putSmall(blob, body, signal) {
      assertSafePath(blob)
      drain(
        await call('PUT', blob, {
          headers: {
            'x-ms-blob-type': 'BlockBlob',
            'content-type': 'application/octet-stream',
            'content-md5': createHash('md5').update(body).digest('base64'),
            ...tierHeader(true),
          },
          body,
          signal,
        }),
      )
    },
    async stat(blob, signal) {
      const res = await call('HEAD', blob, { signal, allow: [404] })
      drain(res)
      if (res.status === 404) return null
      const size = sizeOf(res.headers['content-length'])
      if (size === null) throw new DestinationError('provider', 'Azure did not report the blob’s size')
      const tier = header(res.headers['x-ms-access-tier'])
      const archiveStatus = header(res.headers['x-ms-archive-status'])
      const archived = tier === 'Archive'
      const md5 = hexOf(header(res.headers['content-md5']))
      const thaw: ThawState = archiveStatus.startsWith('rehydrate-pending') ? 'thawing' : 'none'
      return { size, archived, ...(archived ? { thaw } : {}), ...(md5 ? { md5 } : {}) }
    },
    /**
     * W4.5: an Archive blob is rehydrated to the Cool tier (it stays there: Azure has no temporary
     * copy like S3's); Expedited asks for High priority, the others for Standard. `days` does not apply.
     */
    async thaw(blob, { tier }, signal) {
      const st = await adapter.stat(blob, signal)
      if (!st) throw new DestinationError('not_found', 'Not found at the destination')
      if (!st.archived)
        throw new DestinationError('not_archived', 'This backup is not archived: it can be restored as it is')
      if (st.thaw === 'thawing') return { state: 'thawing' }
      drain(
        await call('PUT', blob, {
          query: { comp: 'tier' },
          headers: {
            'x-ms-access-tier': 'Cool',
            'x-ms-rehydrate-priority': tier === 'Expedited' ? 'High' : 'Standard',
          },
          signal,
        }),
      )
      return { state: 'thawing' }
    },
    async get(blob, offset, signal) {
      const res = await call('GET', blob, {
        headers: offset > 0 ? { 'x-ms-range': `bytes=${offset}-` } : {},
        signal,
        deadlineMs: null,
      })
      return rangedBody(res, offset)
    },
    async getSmall(blob, limit, signal) {
      const res = await call('GET', blob, { signal, allow: [404] })
      if (res.status === 404) {
        drain(res)
        return null
      }
      return readBounded(res.body, limit)
    },
    async list(cursor, signal) {
      const found: RemoteItem[] = []
      let marker = ''
      const markers = new Set<string>()
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await call('GET', null, {
          query: {
            restype: 'container',
            comp: 'list',
            prefix: `${root}/`,
            maxresults: '5000',
            ...(marker ? { marker } : {}),
          },
          signal,
        })
        const doc = parseXml((await readBounded(res.body, LISTING_LIMIT)).toString('utf8'))
        const blobs = child(doc, 'Blobs')
        for (const it of blobs ? childrenOf(blobs, 'Blob') : []) {
          const name = textOf(it, 'Name') ?? ''
          if (!isSafeKey(name, config.prefix)) continue
          const props = child(it, 'Properties')
          const modified = Date.parse((props && textOf(props, 'Last-Modified')) ?? '')
          found.push({
            key: name,
            size: sizeOf(props && textOf(props, 'Content-Length')) ?? 0,
            modifiedAt: Number.isNaN(modified) ? null : modified,
            archived: (props && textOf(props, 'AccessTier')) === 'Archive',
          })
        }
        const next = textOf(doc, 'NextMarker') ?? ''
        if (!next || markers.has(next) || found.length >= 2 * MAX_ITEMS) break
        markers.add(next)
        marker = next
      }
      const items = found.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, MAX_ITEMS)
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(blob, signal) {
      drain(
        await call('DELETE', blob, { headers: { 'x-ms-delete-snapshots': 'include' }, signal, allow: [404] }),
      )
    },
    /**
     * Uncommitted blocks have no delete of their own (Azure drops them after 7 days). An empty blob
     * put where none is (If-None-Match: *) discards them, and is deleted at once by its ETag — a
     * blob that is there already is never touched.
     */
    async abandon(resume, signal) {
      const b = resume as Blocks
      if (typeof b.key !== 'string' || !isSafeKey(b.key, config.prefix)) return
      const res = await call('PUT', b.key, {
        headers: { 'x-ms-blob-type': 'BlockBlob', 'if-none-match': '*' },
        signal,
        allow: [409],
      })
      drain(res)
      const etag = header(res.headers.etag)
      if (res.status === 409 || !etag) return
      drain(await call('DELETE', b.key, { headers: { 'if-match': etag }, signal, allow: [404, 412] }))
    },
  }
  return adapter
}
