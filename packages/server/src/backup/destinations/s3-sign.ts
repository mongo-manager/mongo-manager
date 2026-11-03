import { createHash, createHmac } from 'node:crypto'

/** Phase 3d-3b spec §2.3: AWS Signature Version 4 for S3, with the real payload hash. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

/** Each segment decoded, then encoded once (S3 does not double-encode). */
export const canonicalUri = (pathname: string) =>
  pathname
    .split('/')
    .map((s) => enc(decodeURIComponent(s)))
    .join('/') || '/'

export function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export const amzDate = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

export function signRequest(input: {
  method: string
  url: URL
  headers: Record<string, string>
  payloadHash: string
  region: string
  service?: string
  now: Date
  credentials: S3Credentials
}): Record<string, string> {
  const stamp = amzDate(input.now)
  const day = stamp.slice(0, 8)
  const service = input.service ?? 's3'
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers))
    headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  headers.host = input.url.host
  headers['x-amz-date'] = stamp
  headers['x-amz-content-sha256'] = input.payloadHash
  const names = Object.keys(headers).sort()
  const signed = names.join(';')
  const canonical = [
    input.method,
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signed,
    input.payloadHash,
  ].join('\n')
  const scope = `${day}/${input.region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n')
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), service),
    'aws4_request',
  )
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}
