import { createHash, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { FakeGoogle } from './fake-google'

export interface GcsObject {
  body: Buffer
  storageClass: string
  updated: string
}

/**
 * W4.5: Cloud Storage's JSON API on the fake Google, enough for the adapter — objects (metadata,
 * media with ranges, delete), listing with pages, simple and resumable uploads (308 with Range,
 * cancel with 499), and knobs for a wrong MD5 and a session on another host.
 */
export function installGcs(g: FakeGoogle, opts: { bucket?: string; pageSize?: number } = {}) {
  const bucket = opts.bucket ?? 'mm-bucket'
  const objects = new Map<string, GcsObject>()
  const sessions = new Map<string, { name: string; size: number; storageClass: string; received: Buffer[] }>()
  const knobs = {
    wrongMd5: false,
    sessionOrigin: null as string | null,
    /** W4 review: parts stored, then answered 503 (the answer lost), this many times. */
    failAfterStore: 0,
    /** W4 review: a part sent again over bytes already held is refused, as Google may. */
    strictRanges: false,
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const meta = (name: string, o: GcsObject) => ({
    name,
    size: String(o.body.length),
    md5Hash: knobs.wrongMd5
      ? Buffer.alloc(16).toString('base64')
      : createHash('md5').update(o.body).digest('base64'),
    storageClass: o.storageClass,
    updated: o.updated,
  })
  g.setDrive((req, res, url, body) => {
    const p = url.pathname
    const listPath = `/storage/v1/b/${bucket}/o`
    if (p.startsWith('/storage/v1/b/') && !p.startsWith(`/storage/v1/b/${bucket}/`))
      return json(res, 404, { error: { code: 404, errors: [{ reason: 'notFound' }] } })
    if (p === listPath && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const max = Math.min(Number(url.searchParams.get('maxResults') ?? 1000), opts.pageSize ?? 1000)
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const from = Number(url.searchParams.get('pageToken') ?? 0)
      const items = all.slice(from, from + max)
      return json(res, 200, {
        items: items.map((k) => meta(k, objects.get(k)!)),
        ...(from + max < all.length ? { nextPageToken: String(from + max) } : {}),
      })
    }
    if (p === `/upload/storage/v1/b/${bucket}/o` && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? ''
      if (url.searchParams.get('uploadType') === 'media') {
        objects.set(name, { body, storageClass: 'STANDARD', updated: '2026-10-16T12:00:00.000Z' })
        return json(res, 200, meta(name, objects.get(name)!))
      }
      const m = JSON.parse(body.toString() || '{}') as { storageClass?: string }
      const id = randomUUID()
      sessions.set(id, {
        name,
        size: Number(req.headers['x-upload-content-length']),
        storageClass: m.storageClass ?? 'STANDARD',
        received: [],
      })
      res.setHeader(
        'location',
        `${knobs.sessionOrigin ?? g.url}/upload/storage/v1/b/${bucket}/o?uploadType=resumable&upload_id=${id}`,
      )
      return json(res, 200, {})
    }
    if (p === `/upload/storage/v1/b/${bucket}/o` && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = url.searchParams.get('upload_id') ?? ''
      const s = sessions.get(id)
      if (!s) return json(res, 404, {})
      if (req.method === 'DELETE') {
        sessions.delete(id)
        res.statusCode = 499
        return res.end()
      }
      const have = s.received.reduce((n, b) => n + b.length, 0)
      const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(String(req.headers['content-range']))
      if (range?.[1] !== undefined) {
        // Parts other than the last are multiples of 256 KiB (Google refuses them otherwise).
        const last = Number(range[2]) + 1 === s.size
        if (!last && body.length % (256 * 1024) !== 0) return json(res, 400, { error: { code: 400 } })
        if (knobs.strictRanges && Number(range[1]) < have) return json(res, 400, { error: { code: 400 } })
        if (Number(range[1]) === have) s.received.push(body)
        if (knobs.failAfterStore > 0) {
          knobs.failAfterStore--
          return json(res, 503, { error: { code: 503 } })
        }
      }
      const total = s.received.reduce((n, b) => n + b.length, 0)
      if (total === s.size) {
        objects.set(s.name, {
          body: Buffer.concat(s.received),
          storageClass: s.storageClass,
          updated: '2026-10-16T12:00:00.000Z',
        })
        sessions.delete(id)
        return json(res, 200, meta(s.name, objects.get(s.name)!))
      }
      res.statusCode = 308
      if (total > 0) res.setHeader('range', `bytes=0-${total - 1}`)
      return res.end()
    }
    const m = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(p)
    if (m) {
      const name = decodeURIComponent(m[1]!)
      const o = objects.get(name)
      if (!o) return json(res, 404, { error: { code: 404, errors: [{ reason: 'notFound' }] } })
      if (req.method === 'DELETE') {
        objects.delete(name)
        res.statusCode = 204
        return res.end()
      }
      if (url.searchParams.get('alt') === 'media') {
        const r = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
        res.statusCode = r ? 206 : 200
        if (r) res.setHeader('content-range', `bytes ${r[1]}-${o.body.length - 1}/${o.body.length}`)
        return res.end(r ? o.body.subarray(Number(r[1])) : o.body)
      }
      return json(res, 200, meta(name, o))
    }
    return json(res, 404, {})
  })
  return { bucket, objects, sessions, knobs }
}
