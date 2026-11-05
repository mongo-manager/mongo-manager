// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startHttpsServer } from './https-server'

const xml = (res: ServerResponse, status: number, body: string) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/xml')
  res.end(`${BOM}<?xml version="1.0" encoding="utf-8"?>${body}`)
}
const error = (res: ServerResponse, status: number, code: string) => {
  res.setHeader('x-ms-error-code', code)
  xml(res, status, `<Error><Code>${code}</Code><Message>${code} — the string to sign was …</Message></Error>`)
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
/** Azure starts its XML answers with a byte order mark: the adapter's parser must take it. */
const BOM = String.fromCharCode(0xfeff)
const md5b64 = (b: Buffer) => createHash('md5').update(b).digest('base64')

export interface FakeBlob {
  body: Buffer
  tier: string
  md5?: string
  etag: string
  rehydrating?: string
  modified: string
}

/**
 * W4.5: an Azure Blob service for one account and container ("mmaccount", "mm-test"). Shared Key
 * signatures are checked by its own reading of Azure's documented string to sign (written apart from
 * the adapter's signer, so one cannot follow the other's mistake); a SAS is checked by its signature
 * field. Block uploads, block lists, tiers, rehydration and failures are modelled.
 */
export async function startFakeAzure(opts: { pageSize?: number } = {}) {
  const account = 'mmaccount'
  const containerName = 'mm-test'
  const accountKey = randomBytes(64).toString('base64')
  const sasToken =
    '?sv=2023-11-03&ss=b&srt=co&sp=rwdlac&se=2030-01-01T00%3A00%3A00Z&spr=https&sig=c2lnbmF0dXJl%2B%2F%3D'
  const blobs = new Map<string, FakeBlob>()
  const blocks = new Map<string, Map<string, Buffer>>()
  const requests: Array<{
    method: string
    path: string
    query: string
    headers: IncomingMessage['headers']
  }> = []
  const knobs = { failures: [] as number[], corruptBlock: false }
  let etags = 0

  function expectedSignature(req: IncomingMessage, url: URL): string {
    const h = (n: string) => {
      const v = req.headers[n]
      return Array.isArray(v) ? v.join(',') : (v ?? '')
    }
    const length = h('content-length')
    const lines = [
      req.method!,
      h('content-encoding'),
      h('content-language'),
      length === '0' ? '' : length,
      h('content-md5'),
      h('content-type'),
      h('date'),
      h('if-modified-since'),
      h('if-match'),
      h('if-none-match'),
      h('if-unmodified-since'),
      h('range'),
    ]
    const msHeaders = Object.keys(req.headers)
      .filter((n) => n.startsWith('x-ms-'))
      .sort()
      .map((n) => `${n}:${h(n).trim()}`)
    const params = [...new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()))].sort()
    const resource = [
      `/${account}${url.pathname}`,
      ...params.map((k) => `${k}:${url.searchParams.getAll(k).sort().join(',')}`),
    ].join('\n')
    const text = [...lines, ...msHeaders, resource].join('\n')
    return createHmac('sha256', Buffer.from(accountKey, 'base64')).update(text, 'utf8').digest('base64')
  }

  function authorized(req: IncomingMessage, url: URL): boolean {
    const auth = String(req.headers.authorization ?? '')
    if (auth) return auth === `SharedKey ${account}:${expectedSignature(req, url)}`
    return url.searchParams.get('sig') === 'c2lnbmF0dXJl+/=' && url.searchParams.get('sv') === '2023-11-03'
  }

  const server = await startHttpsServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `https://${req.headers.host}`)
    requests.push({ method: req.method!, path: url.pathname, query: url.search, headers: req.headers })
    const failure = knobs.failures.shift()
    if (failure) return error(res, failure, failure === 503 ? 'ServerBusy' : 'InternalError')
    if (!authorized(req, url)) return error(res, 403, 'AuthenticationFailed')
    const [, container, ...rest] = url.pathname.split('/')
    if (container !== containerName) return error(res, 404, 'ContainerNotFound')
    const name = rest.map(decodeURIComponent).join('/')
    const q = url.searchParams
    const comp = q.get('comp')
    const blob = blobs.get(name)

    if (!name && q.get('restype') === 'container' && comp === 'list') {
      const prefix = q.get('prefix') ?? ''
      const size = Math.min(Number(q.get('maxresults') ?? 5000), opts.pageSize ?? 5000)
      const names = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort()
      const from = q.get('marker') ? names.indexOf(q.get('marker')!) : 0
      const page = names.slice(Math.max(0, from), Math.max(0, from) + size)
      const next = names[Math.max(0, from) + size] ?? ''
      return xml(
        res,
        200,
        `<EnumerationResults ServiceEndpoint="${url.origin}/" ContainerName="${containerName}"><Prefix>${esc(prefix)}</Prefix><Blobs>${page
          .map((k) => {
            const b = blobs.get(k)!
            return `<Blob><Name>${esc(k)}</Name><Properties><Last-Modified>${b.modified}</Last-Modified><Content-Length>${b.body.length}</Content-Length><BlobType>BlockBlob</BlobType><AccessTier>${b.tier}</AccessTier></Properties></Blob>`
          })
          .join('')}</Blobs><NextMarker>${esc(next)}</NextMarker></EnumerationResults>`,
      )
    }
    if (!name) return error(res, 400, 'InvalidQueryParameterValue')

    const save = (data: Buffer, tier: string, md5?: string) => {
      const etag = `"0x${(++etags).toString(16)}"`
      blobs.set(name, { body: data, tier, etag, modified: new Date().toUTCString(), ...(md5 ? { md5 } : {}) })
      blocks.delete(name)
      res.setHeader('etag', etag)
      res.statusCode = 201
      res.end()
    }
    if (req.method === 'PUT' && !comp) {
      if (req.headers['x-ms-blob-type'] !== 'BlockBlob') return error(res, 400, 'MissingRequiredHeader')
      if (req.headers['if-none-match'] === '*' && blob) return error(res, 409, 'BlobAlreadyExists')
      const sent = req.headers['content-md5']
      if (sent && sent !== md5b64(body)) return error(res, 400, 'Md5Mismatch')
      return save(body, String(req.headers['x-ms-access-tier'] ?? 'Hot'), md5b64(body))
    }
    if (req.method === 'PUT' && comp === 'block') {
      const id = q.get('blockid') ?? ''
      const sent = req.headers['content-md5']
      if (sent && sent !== md5b64(body)) return error(res, 400, 'Md5Mismatch')
      const held = blocks.get(name) ?? new Map<string, Buffer>()
      if ([...held.keys()].some((k) => k.length !== id.length)) return error(res, 400, 'InvalidBlobOrBlock')
      held.set(id, knobs.corruptBlock ? Buffer.alloc(body.length) : body)
      blocks.set(name, held)
      res.statusCode = 201
      return res.end()
    }
    if (req.method === 'GET' && comp === 'blocklist') {
      const held = blocks.get(name)
      if (!held && !blob) return error(res, 404, 'BlobNotFound')
      return xml(
        res,
        200,
        `<BlockList><CommittedBlocks/><UncommittedBlocks>${[...(held ?? new Map<string, Buffer>()).entries()]
          .map(([id, b]) => `<Block><Name>${id}</Name><Size>${b.length}</Size></Block>`)
          .join('')}</UncommittedBlocks></BlockList>`,
      )
    }
    if (req.method === 'PUT' && comp === 'blocklist') {
      const held = blocks.get(name) ?? new Map<string, Buffer>()
      const ids = [...body.toString('utf8').matchAll(/<(?:Uncommitted|Latest)>([^<]+)</g)].map((m) => m[1]!)
      if (ids.some((id) => !held.has(id))) return error(res, 400, 'InvalidBlockList')
      return save(
        Buffer.concat(ids.map((id) => held.get(id)!)),
        String(req.headers['x-ms-access-tier'] ?? 'Hot'),
      )
    }
    if (req.method === 'PUT' && comp === 'tier') {
      if (!blob) return error(res, 404, 'BlobNotFound')
      if (blob.tier === 'Archive')
        blob.rehydrating = String(req.headers['x-ms-rehydrate-priority'] ?? 'Standard')
      else blob.tier = String(req.headers['x-ms-access-tier'])
      res.statusCode = blob.rehydrating ? 202 : 200
      return res.end()
    }
    if (req.method === 'HEAD') {
      if (!blob) {
        res.statusCode = 404
        res.setHeader('x-ms-error-code', 'BlobNotFound')
        return res.end()
      }
      res.setHeader('content-length', String(blob.body.length))
      res.setHeader('x-ms-access-tier', blob.tier)
      res.setHeader('etag', blob.etag)
      if (blob.md5) res.setHeader('content-md5', blob.md5)
      if (blob.rehydrating) res.setHeader('x-ms-archive-status', 'rehydrate-pending-to-cool')
      return res.end()
    }
    if (req.method === 'GET') {
      if (!blob) return error(res, 404, 'BlobNotFound')
      if (blob.tier === 'Archive') return error(res, 409, 'BlobArchived')
      const range = /^bytes=(\d+)-$/.exec(String(req.headers['x-ms-range'] ?? ''))
      const from = range ? Number(range[1]) : 0
      res.statusCode = range ? 206 : 200
      if (range) res.setHeader('content-range', `bytes ${from}-${blob.body.length - 1}/${blob.body.length}`)
      return res.end(blob.body.subarray(from))
    }
    if (req.method === 'DELETE') {
      if (!blob) return error(res, 404, 'BlobNotFound')
      if (req.headers['if-match'] && req.headers['if-match'] !== blob.etag)
        return error(res, 412, 'ConditionNotMet')
      blobs.delete(name)
      res.statusCode = 202
      return res.end()
    }
    return error(res, 400, 'UnsupportedHttpVerb')
  })
  return { ...server, account, containerName, accountKey, sasToken, blobs, blocks, requests, knobs }
}
export type FakeAzure = Awaited<ReturnType<typeof startFakeAzure>>
