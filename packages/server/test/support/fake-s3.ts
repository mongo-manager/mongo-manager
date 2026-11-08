// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { signRequest } from '../../src/backup/destinations/s3-sign'
import { startHttpsServer } from './https-server'

const xml = (res: ServerResponse, status: number, body: string) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/xml')
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`)
}
const error = (res: ServerResponse, status: number, code: string, message = code) =>
  xml(res, status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`)
const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&#34;')

/**
 * Phase 3d-3b: an S3 that verifies SigV4 (with our signer — it pins that what is signed is what is
 * sent: host with port, query, payload hash), path-style, bucket "mm", with the operations the
 * adapter uses and knobs for failures, archived classes and clock skew.
 */
export async function startFakeS3(opts: { pageSize?: number } = {}) {
  const credentials = { accessKeyId: 'AKIAFAKE00000001', secretAccessKey: 'fake-secret-key-0001' }
  const objects = new Map<
    string,
    { body: Buffer; storageClass: string; restored?: boolean; restoring?: boolean }
  >()
  /** W4.5: the RestoreObject bodies received, per key. */
  const restores: Array<{ key: string; body: string }> = []
  const uploads = new Map<string, Map<number, Buffer>>()
  const requests: string[] = []
  let failures: Array<{ status: number; retryAfter?: string }> = []
  const state = { skew: false }

  const verify = (req: IncomingMessage, url: URL, body: Buffer): string | null => {
    const auth = String(req.headers.authorization ?? '')
    // Anchored and bounded, with no two parts able to take the same characters: linear on any header.
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^/,\s]{1,128})\/(\d{8})\/([^/,\s]{1,64})\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]{1,1024}), Signature=([0-9a-f]{64})$/.exec(
        auth,
      )
    if (!m || m[1] !== credentials.accessKeyId) return 'InvalidAccessKeyId'
    const stamp = String(req.headers['x-amz-date'])
    const now = new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    )
    // The signed header names come from the request: kept off any prototype, and never one of its keys.
    const headers: Record<string, string> = Object.create(null) as Record<string, string>
    for (const n of m[4]!.split(';')) {
      if (n === 'host' || n === 'x-amz-date' || n === 'x-amz-content-sha256') continue
      if (n === '__proto__' || n === 'constructor' || n === 'prototype') return 'SignatureDoesNotMatch'
      headers[n] = String(req.headers[n])
    }
    const payloadHash = String(req.headers['x-amz-content-sha256'])
    if (body.length && payloadHash !== createHash('sha256').update(body).digest('hex'))
      return 'XAmzContentSHA256Mismatch'
    const again = signRequest({
      method: req.method!,
      url,
      headers,
      payloadHash,
      region: m[3]!,
      now,
      credentials,
    })
    return again.authorization === auth ? null : 'SignatureDoesNotMatch'
  }

  const server = await startHttpsServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `https://${req.headers.host}`)
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const failure = failures.shift()
    if (failure) {
      if (failure.retryAfter) res.setHeader('retry-after', failure.retryAfter)
      return error(res, failure.status, failure.status === 503 ? 'SlowDown' : 'InternalError')
    }
    if (state.skew) return error(res, 403, 'RequestTimeTooSkewed')
    const problem = verify(req, url, body)
    if (problem) return error(res, problem === 'XAmzContentSHA256Mismatch' ? 400 : 403, problem)
    const [, bucket, ...rest] = url.pathname.split('/')
    if (bucket !== 'mm-test') return error(res, 404, 'NoSuchBucket')
    const key = rest.map(decodeURIComponent).join('/')
    const q = url.searchParams
    if (!key && req.method === 'GET') {
      const prefix = q.get('prefix') ?? ''
      const page = Math.min(Number(q.get('max-keys') ?? 1000), opts.pageSize ?? 1000)
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const from = Number(q.get('continuation-token') ?? 0)
      const items = all.slice(from, from + page)
      const more = from + page < all.length
      return xml(
        res,
        200,
        `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + page}</NextContinuationToken>` : ''}${items
          .map(
            (k) =>
              `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>2026-10-03T12:00:00.000Z</LastModified><ETag>${esc(etagOf(objects.get(k)!.body))}</ETag><StorageClass>${objects.get(k)!.storageClass}</StorageClass></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      )
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = randomUUID()
      uploads.set(id, new Map())
      return xml(
        res,
        200,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      )
    }
    const uploadId = q.get('uploadId')
    if (uploadId !== null) {
      const parts = uploads.get(uploadId)
      if (!parts) return error(res, 404, 'NoSuchUpload')
      if (req.method === 'PUT') {
        parts.set(Number(q.get('partNumber')), body)
        res.setHeader('etag', etagOf(body))
        return res.end()
      }
      if (req.method === 'GET')
        return xml(
          res,
          200,
          `<ListPartsResult><IsTruncated>false</IsTruncated>${[...parts]
            .sort((a, b) => a[0] - b[0])
            .map(
              ([n, b]) =>
                `<Part><PartNumber>${n}</PartNumber><ETag>${esc(etagOf(b))}</ETag><Size>${b.length}</Size></Part>`,
            )
            .join('')}</ListPartsResult>`,
        )
      if (req.method === 'POST') {
        const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) =>
          Number(x[1]),
        )
        objects.set(key, { body: Buffer.concat(numbers.map((n) => parts.get(n)!)), storageClass: 'STANDARD' })
        uploads.delete(uploadId)
        return xml(
          res,
          200,
          `<CompleteMultipartUploadResult><Key>${esc(key)}</Key></CompleteMultipartUploadResult>`,
        )
      }
      if (req.method === 'DELETE') {
        uploads.delete(uploadId)
        res.statusCode = 204
        return res.end()
      }
    }
    const obj = objects.get(key)
    // W4.5: RestoreObject — 202 started, 409 already under way, 200 already thawed; not archived: 403.
    if (req.method === 'POST' && q.has('restore')) {
      if (!obj) return error(res, 404, 'NoSuchKey')
      if (obj.storageClass !== 'GLACIER' && obj.storageClass !== 'DEEP_ARCHIVE')
        return error(res, 403, 'InvalidObjectState')
      restores.push({ key, body: body.toString() })
      if (obj.restoring) return error(res, 409, 'RestoreAlreadyInProgress')
      res.statusCode = obj.restored ? 200 : 202
      obj.restoring = !obj.restored
      return res.end()
    }
    if (req.method === 'PUT') {
      objects.set(key, { body, storageClass: String(req.headers['x-amz-storage-class'] ?? 'STANDARD') })
      res.setHeader('etag', etagOf(body))
      return res.end()
    }
    if (req.method === 'DELETE') {
      objects.delete(key)
      res.statusCode = 204
      return res.end()
    }
    if (!obj) {
      if (req.method === 'HEAD') {
        res.statusCode = 404
        return res.end()
      }
      return error(res, 404, 'NoSuchKey')
    }
    const archived = (obj.storageClass === 'GLACIER' || obj.storageClass === 'DEEP_ARCHIVE') && !obj.restored
    res.setHeader('x-amz-storage-class', obj.storageClass)
    if (obj.restored)
      res.setHeader('x-amz-restore', 'ongoing-request="false", expiry-date="Fri, 23 Dec 2030 00:00:00 GMT"')
    else if (obj.restoring) res.setHeader('x-amz-restore', 'ongoing-request="true"')
    if (req.method === 'HEAD') {
      res.setHeader('content-length', String(obj.body.length))
      return res.end()
    }
    if (archived) return error(res, 403, 'InvalidObjectState')
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
    if (range) {
      res.statusCode = 206
      return res.end(obj.body.subarray(Number(range[1])))
    }
    return res.end(obj.body)
  })

  return {
    url: server.url,
    caPem: server.caPem,
    bucket: 'mm-test',
    credentials,
    objects,
    uploads,
    requests,
    restores,
    get skew() {
      return state.skew
    },
    set skew(v: boolean) {
      state.skew = v
    },
    failNext(count: number, status: number, retryAfter?: string) {
      failures = [
        ...failures,
        ...Array.from({ length: count }, () => ({ status, ...(retryAfter ? { retryAfter } : {}) })),
      ]
    },
    close: () => server.close(),
  }
}
export type FakeS3 = Awaited<ReturnType<typeof startFakeS3>>
