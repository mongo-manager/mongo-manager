import { createHash, createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startHttpsServer } from './https-server'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  body: Buffer
  trashed: boolean
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Phase 3d-3b: Google's OAuth endpoints (device flow with scripted answers, refresh tokens, the
 * service-account JWT grant checked against a generated key) and, from Task 13, Drive v3.
 */
export async function startFakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const serviceKey = {
    client_email: 'backup@proj.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    private_key_id: 'kid-1',
    token_uri: 'https://oauth2.googleapis.com/token' as const,
  }
  const device = { answers: [] as string[] }
  const revoked = new Set<string>()
  const tokens = new Set<string>()
  const requests: string[] = []
  const scopes: string[] = []
  const files = new Map<string, DriveFile>()
  const sessions = new Map<string, { name: string; parents: string[]; size: number; received: Buffer[] }>()
  const knobs = {
    checksum: 'sha256' as 'sha256' | 'md5' | 'none' | 'wrong',
    sessionOrigin: null as string | null,
  }
  const issue = () => {
    const t = `ya29.${randomBytes(12).toString('hex')}`
    tokens.add(t)
    return t
  }
  let drive: ((req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) => void) | null = null

  const server = await startHttpsServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `https://${req.headers.host}`)
    requests.push(`${req.method} ${url.pathname}`)
    if (req.method === 'POST' && url.pathname === '/device/code') {
      const f = new URLSearchParams(body.toString())
      if (f.get('client_id') === 'bad-client-id') return json(res, 401, { error: 'invalid_client' })
      if (f.get('scope') !== 'https://www.googleapis.com/auth/drive.file')
        return json(res, 400, { error: 'invalid_scope' })
      return json(res, 200, {
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://www.google.com/device',
        expires_in: 900,
        interval: 5,
      })
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const f = new URLSearchParams(body.toString())
      const grant = f.get('grant_type')
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (f.get('client_secret') !== 'client-secret-1') return json(res, 401, { error: 'invalid_client' })
        const a = device.answers.shift() ?? 'authorization_pending'
        if (a === 'approved')
          return json(res, 200, { access_token: issue(), refresh_token: '1//refresh-1', expires_in: 3599 })
        return json(res, a === 'authorization_pending' ? 428 : 403, { error: a })
      }
      if (grant === 'refresh_token') {
        const rt = f.get('refresh_token') ?? ''
        if (revoked.has(rt)) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, { access_token: issue(), expires_in: 3599 })
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const [h, c, s] = (f.get('assertion') ?? '').split('.')
        const ok = createVerify('RSA-SHA256')
          .update(`${h}.${c}`)
          .verify(publicKey, Buffer.from(s ?? '', 'base64url'))
        const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}') as {
          aud?: string
          iss?: string
          scope?: string
        }
        if (
          !ok ||
          claims.aud !== 'https://oauth2.googleapis.com/token' ||
          claims.iss !== serviceKey.client_email
        )
          return json(res, 400, { error: 'invalid_grant' })
        // W4.5: the scope a service account asked for (Drive or Cloud Storage).
        scopes.push(String(claims.scope ?? ''))
        return json(res, 200, { access_token: issue(), expires_in: 3599 })
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!tokens.has(bearer)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } })
    if (drive) return drive(req, res, url, body)
    return json(res, 404, {})
  })
  const hosts = { oauth: server.url, api: server.url, upload: server.url, caPem: server.caPem }
  return {
    url: server.url,
    caPem: server.caPem,
    hosts,
    device,
    serviceKey,
    revoked,
    tokens,
    requests,
    scopes,
    files,
    sessions,
    knobs,
    /** Task 13 installs the Drive v3 handler here. */
    setDrive(handler: typeof drive) {
      drive = handler
    },
    close: () => server.close(),
  }
}
export type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>

const FOLDER = 'application/vnd.google-apps.folder'

/** Drive v3, enough for the adapter: q with name, parent, mimeType and trashed; resumable sessions. */
export function installDrive(g: FakeGoogle): void {
  const view = (f: DriveFile, fields: string) => {
    const out: Record<string, unknown> = { id: f.id, name: f.name, mimeType: f.mimeType }
    if (fields.includes('size')) out.size = String(f.body.length)
    if (fields.includes('sha256Checksum') && g.knobs.checksum === 'sha256')
      out.sha256Checksum = createHash('sha256').update(f.body).digest('hex')
    if (fields.includes('sha256Checksum') && g.knobs.checksum === 'wrong') out.sha256Checksum = '0'.repeat(64)
    if (fields.includes('md5Checksum') && (g.knobs.checksum === 'md5' || g.knobs.checksum === 'sha256'))
      out.md5Checksum = createHash('md5').update(f.body).digest('hex')
    if (fields.includes('modifiedTime')) out.modifiedTime = '2026-10-03T12:00:00.000Z'
    return out
  }
  const match = (f: DriveFile, q: string) => {
    const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1')
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    if (name !== undefined && f.name !== name) return false
    if (parent !== undefined && !f.parents.includes(parent)) return false
    if (q.includes(`mimeType='${FOLDER}'`) && f.mimeType !== FOLDER) return false
    if (q.includes(`mimeType!='${FOLDER}'`) && f.mimeType === FOLDER) return false
    if (q.includes('trashed=false') && f.trashed) return false
    return true
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const create = (name: string, mimeType: string, parents: string[], body = Buffer.alloc(0)) => {
    const f: DriveFile = { id: `f-${randomUUID()}`, name, mimeType, parents, body, trashed: false }
    g.files.set(f.id, f)
    return f
  }
  g.setDrive((req, res, url, body) => {
    const p = url.pathname
    const fields = url.searchParams.get('fields') ?? ''
    if (p === '/drive/v3/about') return json(res, 200, { user: { emailAddress: 'ops@example.com' } })
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const list = [...g.files.values()].filter((f) => match(f, q))
      return json(res, 200, { files: list.map((f) => view(f, fields)) })
    }
    if (p === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString()) as { name: string; mimeType: string; parents: string[] }
      return json(res, 200, view(create(meta.name, meta.mimeType, meta.parents ?? ['root']), 'id'))
    }
    if (p === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'multipart') {
      const text = body.toString('latin1')
      const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type']))![1]!
      const parts = text.split(`--${boundary}`).slice(1, 3)
      const meta = JSON.parse(parts[0]!.split('\r\n\r\n')[1]!) as { name: string; parents: string[] }
      const content = parts[1]!.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
      return json(
        res,
        200,
        view(
          create(meta.name, 'application/octet-stream', meta.parents, Buffer.from(content, 'latin1')),
          'id',
        ),
      )
    }
    if (
      p === '/upload/drive/v3/files' &&
      url.searchParams.get('uploadType') === 'resumable' &&
      req.method === 'POST' &&
      !url.searchParams.get('upload_id')
    ) {
      const meta = JSON.parse(body.toString()) as { name: string; parents: string[] }
      const id = randomUUID()
      g.sessions.set(id, {
        name: meta.name,
        parents: meta.parents,
        size: Number(req.headers['x-upload-content-length']),
        received: [],
      })
      res.setHeader(
        'location',
        `${g.knobs.sessionOrigin ?? g.url}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`,
      )
      return json(res, 200, {})
    }
    if (p === '/upload/drive/v3/files' && req.method === 'PUT') {
      const s = g.sessions.get(url.searchParams.get('upload_id') ?? '')
      if (!s) return json(res, 404, {})
      const have = s.received.reduce((n, b) => n + b.length, 0)
      const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(String(req.headers['content-range']))
      if (range?.[1] !== undefined && Number(range[1]) === have) s.received.push(body)
      const total = s.received.reduce((n, b) => n + b.length, 0)
      if (total === s.size) {
        const f = create(s.name, 'application/octet-stream', s.parents, Buffer.concat(s.received))
        g.sessions.delete(url.searchParams.get('upload_id')!)
        return json(res, 200, view(f, 'id'))
      }
      res.statusCode = 308
      if (total > 0) res.setHeader('range', `bytes=0-${total - 1}`)
      return res.end()
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)
    const f = m ? g.files.get(m[1]!) : undefined
    if (m && !f) return json(res, 404, { error: { code: 404 } })
    if (f && req.method === 'DELETE') {
      g.files.delete(f.id)
      res.statusCode = 204
      return res.end()
    }
    if (f && url.searchParams.get('alt') === 'media') {
      const r = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
      res.statusCode = r ? 206 : 200
      return res.end(r ? f.body.subarray(Number(r[1])) : f.body)
    }
    if (f) return json(res, 200, view(f, fields))
    return json(res, 404, {})
  })
}
