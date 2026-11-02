import type { IncomingMessage, ServerResponse } from 'node:http'
import { startHttpsServer } from './https-server'

/**
 * Phase 3d-3b: a WebDAV server with Basic authentication: MKCOL, PUT, GET (ranges), PROPFIND
 * (depth 0 and 1), DELETE and MOVE; with `nextcloud`, the chunked-upload folders under
 * remote.php/dav/uploads/<user>/ whose `.file` MOVE assembles the chunks in name order.
 */
export async function startFakeWebdav(opts: {
  user: string
  password: string
  nextcloud?: boolean
  ignoreRange?: boolean
}) {
  const files = new Map<string, Buffer>()
  const dirs = new Set<string>([''])
  const requests: string[] = []
  let failures: number[] = []
  const filesRoot = opts.nextcloud ? `remote.php/dav/files/${opts.user}/` : 'dav/'
  const uploadsRoot = `remote.php/dav/uploads/${opts.user}/`
  if (opts.nextcloud) {
    for (const d of [
      'remote.php',
      'remote.php/dav',
      'remote.php/dav/files',
      `remote.php/dav/files/${opts.user}`,
      'remote.php/dav/uploads',
      `remote.php/dav/uploads/${opts.user}`,
    ])
      dirs.add(d)
  } else dirs.add('dav')
  const pathOf = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/+/, '').replace(/\/+$/, '')
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const reply = (res: ServerResponse, status: number, body = '') => {
    res.statusCode = status
    res.end(body)
  }
  const propEntry = (p: string) => {
    const isDir = dirs.has(p)
    const size = files.get(p)?.length
    return `<d:response><d:href>/${p.split('/').map(encodeURIComponent).join('/')}${isDir && p ? '/' : ''}</d:href><d:propstat><d:prop>${isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Sat, 03 Oct 2026 12:00:00 GMT</d:getlastmodified>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }

  const server = await startHttpsServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `https://${req.headers.host}`)
    requests.push(`${req.method} ${url.pathname}`)
    const f = failures.shift()
    if (f) return reply(res, f)
    const expected = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`
    if (req.headers.authorization !== expected) {
      res.setHeader('www-authenticate', 'Basic realm="fake"')
      return reply(res, 401)
    }
    const p = pathOf(url)
    const destination = req.headers.destination ? pathOf(new URL(String(req.headers.destination))) : null
    switch (req.method) {
      case 'MKCOL':
        if (dirs.has(p) || files.has(p)) return reply(res, 405)
        if (!dirs.has(parentOf(p))) return reply(res, 409)
        dirs.add(p)
        return reply(res, 201)
      case 'PUT':
        if (!dirs.has(parentOf(p))) return reply(res, 409)
        files.set(p, body)
        return reply(res, 201)
      case 'GET': {
        const b = files.get(p)
        if (!b) return reply(res, 404)
        const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
        if (range && !opts.ignoreRange) {
          res.statusCode = 206
          return res.end(b.subarray(Number(range[1])))
        }
        return res.end(b)
      }
      case 'DELETE':
        if (dirs.has(p)) {
          for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k)
          for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
          return reply(res, 204)
        }
        return reply(res, files.delete(p) ? 204 : 404)
      case 'MOVE': {
        if (!destination) return reply(res, 400)
        if (!dirs.has(parentOf(destination))) return reply(res, 409)
        if (opts.nextcloud && p.startsWith(uploadsRoot) && p.endsWith('/.file')) {
          const dir = p.slice(0, -'/.file'.length)
          const names = [...files.keys()].filter((k) => parentOf(k) === dir).sort()
          files.set(destination, Buffer.concat(names.map((n) => files.get(n)!)))
          for (const n of names) files.delete(n)
          dirs.delete(dir)
          return reply(res, 201)
        }
        const b = files.get(p)
        if (!b) return reply(res, 404)
        files.set(destination, b)
        files.delete(p)
        return reply(res, 201)
      }
      case 'PROPFIND': {
        if (!dirs.has(p) && !files.has(p)) return reply(res, 404)
        const depth = req.headers.depth === '0' ? 0 : 1
        const entries = [p]
        if (depth === 1 && dirs.has(p))
          entries.push(
            ...[...dirs].filter((d) => d && parentOf(d) === p),
            ...[...files.keys()].filter((k) => parentOf(k) === p),
          )
        res.statusCode = 207
        res.setHeader('content-type', 'application/xml')
        return res.end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.map(propEntry).join('')}</d:multistatus>`,
        )
      }
      default:
        return reply(res, 405)
    }
  })
  return {
    url: `${server.url}/${opts.nextcloud ? '' : 'dav/'}`,
    root: `${server.url}/`,
    caPem: server.caPem,
    files,
    filesRoot,
    requests,
    failNext(n: number, status: number) {
      failures = [...failures, ...Array<number>(n).fill(status)]
    },
    close: () => server.close(),
  }
}
