// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createSign } from 'node:crypto'
import { z } from 'zod'
import { scrubText, type Egress } from '../../net/egress'
import { DestinationError } from './types'

/** Phase 3d-3b spec §2.4. Tests point these at a fake Google through the context, never the environment. */
export interface GoogleHosts {
  oauth: string
  api: string
  upload: string
  /** W4.5: Cloud Storage's JSON API (objects, resumable uploads, media). */
  storage?: string
  /** Tests only: the fake Google's CA. */
  caPem?: string
}
export const GOOGLE_HOSTS: GoogleHosts = {
  oauth: 'https://oauth2.googleapis.com',
  api: 'https://www.googleapis.com',
  upload: 'https://www.googleapis.com',
  storage: 'https://storage.googleapis.com',
}
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
/** W4.5: read and write objects of the buckets the service account may use — no bucket administration. */
export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write'
const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token'

export const ServiceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().email().max(320),
  private_key: z
    .string()
    .max(8192)
    .refine((k) => k.includes('PRIVATE KEY')),
  private_key_id: z.string().min(1).max(128),
  token_uri: z.literal(TOKEN_AUDIENCE),
})
export type ServiceAccountKey = Omit<z.infer<typeof ServiceAccountKeySchema>, 'type'>

/** Only the four fields that are used are kept (spec §2.4). */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Short names review 7 (M-1): a key that cannot be read is a credential not valid, not Google's
    // refusal — Google is never asked.
    throw new DestinationError('secrets_invalid', 'The service account key is not valid JSON')
  }
  const r = ServiceAccountKeySchema.safeParse(raw)
  if (!r.success) throw new DestinationError('secrets_invalid', 'This is not a Google service account key')
  const { client_email, private_key, private_key_id, token_uri } = r.data
  return { client_email, private_key, private_key_id, token_uri }
}

async function form(
  egress: Egress,
  hosts: GoogleHosts,
  path: string,
  fields: Record<string, string>,
  signal: AbortSignal,
) {
  const body = Buffer.from(new URLSearchParams(fields).toString())
  const res = await egress.buffer({
    method: 'POST',
    url: `${hosts.oauth}${path}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) },
    body,
    ...(hosts.caPem ? { caPem: hosts.caPem } : {}),
    signal,
  })
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
  } catch {
    // keep {}
  }
  return { status: res.status, json }
}

export async function startDeviceFlow(
  egress: Egress,
  hosts: GoogleHosts,
  clientId: string,
  signal: AbortSignal,
) {
  const { status, json } = await form(
    egress,
    hosts,
    '/device/code',
    { client_id: clientId, scope: DRIVE_SCOPE },
    signal,
  )
  if (json.error === 'invalid_client' || status === 401)
    throw new DestinationError('auth', 'Google does not know this OAuth client')
  // Review 2026-10-13 (web): the page links to the address — an https URL only, never a script.
  const verificationUrl = httpsUrl(json.verification_url ?? json.verification_uri)
  if (status >= 300 || typeof json.device_code !== 'string') {
    // Phase 3d-3b final review: an OAuth error code is a short word; anything else is the status.
    const code = typeof json.error === 'string' && /^[a-z_]{1,64}$/.test(json.error) ? json.error : status
    throw new DestinationError('provider', scrubText(`Google refused the device sign-in (${code})`))
  }
  if (!verificationUrl)
    throw new DestinationError('provider', 'Google’s answer named no https sign-in address')
  // Odd timings are replaced: a NaN expiry would never expire, a zero interval would poll in a loop.
  const expiresIn = Number(json.expires_in)
  const interval = Number(json.interval ?? 5)
  return {
    deviceCode: json.device_code,
    userCode: String(json.user_code),
    verificationUrl,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 1800) : 900,
    interval: Number.isInteger(interval) && interval >= 1 && interval <= 60 ? interval : 5,
  }
}

/** An https URL of reasonable length, else null. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

export async function pollDeviceFlow(
  egress: Egress,
  hosts: GoogleHosts,
  input: { clientId: string; clientSecret: string; deviceCode: string },
  signal: AbortSignal,
): Promise<
  | { state: 'pending' | 'slow_down' | 'denied' | 'expired' }
  | { state: 'approved'; refreshToken: string; accessToken: string; expiresIn: number }
> {
  const { json } = await form(
    egress,
    hosts,
    '/token',
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      device_code: input.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    signal,
  )
  if (typeof json.access_token === 'string' && typeof json.refresh_token === 'string')
    return {
      state: 'approved',
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      expiresIn: Number(json.expires_in ?? 3600),
    }
  switch (json.error) {
    case 'authorization_pending':
      return { state: 'pending' }
    case 'slow_down':
      return { state: 'slow_down' }
    case 'access_denied':
      return { state: 'denied' }
    case 'expired_token':
      return { state: 'expired' }
    case 'invalid_client':
      throw new DestinationError('auth', 'The OAuth client id or secret is wrong')
    default:
      throw new DestinationError('provider', 'Google refused the device sign-in')
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

export function serviceAccountAssertion(key: ServiceAccountKey, scope: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id })}.${b64({ iss: key.client_email, scope, aud: TOKEN_AUDIENCE, iat, exp: iat + 3600 })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')
  return `${unsigned}.${signature}`
}

export type TokenSource =
  | { kind: 'oauth'; clientId: string; clientSecret: string; refreshToken: string }
  | { kind: 'serviceAccount'; key: ServiceAccountKey }

/** Access tokens live in memory only, until a minute before they expire (spec §2.4). */
export class GoogleTokens {
  private cached: { value: string; until: number } | null = null
  constructor(
    private readonly o: {
      egress: Egress
      hosts: GoogleHosts
      source: TokenSource
      now: () => number
      /** A service account's scope (W4.5: Cloud Storage); Drive's by default. */
      scope?: string
    },
  ) {}

  invalidate(): void {
    this.cached = null
  }

  async token(signal: AbortSignal): Promise<string> {
    const now = this.o.now()
    if (this.cached && this.cached.until > now) return this.cached.value
    const s = this.o.source
    const fields: Record<string, string> =
      s.kind === 'oauth'
        ? {
            client_id: s.clientId,
            client_secret: s.clientSecret,
            refresh_token: s.refreshToken,
            grant_type: 'refresh_token',
          }
        : {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: serviceAccountAssertion(s.key, this.o.scope ?? DRIVE_SCOPE, now),
          }
    const { json } = await form(this.o.egress, this.o.hosts, '/token', fields, signal)
    if (typeof json.access_token !== 'string') {
      if (json.error === 'invalid_grant' && s.kind === 'oauth')
        throw new DestinationError(
          'reconnect',
          'Google no longer accepts this connection; connect the account again',
        )
      if (json.error === 'invalid_client' || json.error === 'invalid_grant')
        throw new DestinationError('auth', 'Google refused the credentials')
      throw new DestinationError('provider', 'Google did not issue an access token')
    }
    this.cached = { value: json.access_token, until: now + (Number(json.expires_in ?? 3600) - 60) * 1000 }
    return json.access_token
  }
}
