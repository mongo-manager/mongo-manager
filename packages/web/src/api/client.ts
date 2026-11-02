export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Tagged template for API paths: every interpolation is URL-encoded (spec §7). */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''),
    '',
  )
}

/**
 * A 401 from these is their answer, not a session that ended: wrong credentials, or (security audit
 * 2026-10-16) the status of a local-mode browser that has no launch cookie — read by the session.
 */
const SIGN_IN_PATHS = /^\/?auth\/(?:login(?:\/|$)|setup$|status$|local\/claim$)/

let csrfToken: string | undefined
let unauthenticatedHandler: (() => void) | undefined

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token
}

export function onUnauthenticated(handler: () => void): void {
  unauthenticatedHandler = handler
}

let oidcSignInHandler: ((connectionId: string) => void) | undefined
/** W7: called with a connection's id when it needs this person's OIDC sign-in. */
export function onOidcSignIn(handler: (connectionId: string) => void): void {
  oidcSignInHandler = handler
}

/** The current CSRF token, for the real-time channel's hello. */
export function csrfTokenNow(): string | undefined {
  return csrfToken
}

/**
 * Review of the audit fixes (important 1): in local mode the server answers only with this
 * browser's page key besides its cookie. The cookie goes to every port of the host; the key stays in
 * this origin's storage, which no other port can read. Claimed once, right after a launch link.
 */
const LOCAL_KEY_STORE = 'mm:local-key'
/** The stored key, read at every use: another tab may have claimed a new one (second review, minor 2). */
const storedKey = (): string | undefined => {
  try {
    return localStorage.getItem(LOCAL_KEY_STORE) ?? undefined
  } catch {
    return undefined
  }
}
/** The key this page holds when storage refuses it (a private window). */
let localKey: string | undefined = storedKey()

export function setLocalKey(key: string | undefined): void {
  localKey = key
  try {
    if (key) localStorage.setItem(LOCAL_KEY_STORE, key)
    else localStorage.removeItem(LOCAL_KEY_STORE)
  } catch {
    // Storage refused (a private window): the key lives as long as the page.
  }
}

export const localKeyNow = (): string | undefined => storedKey() ?? localKey

/** The headers that prove this browser in local mode (none in team mode or before a claim). */
export function proofHeaders(): Record<string, string> {
  const key = localKeyNow()
  return key ? { 'x-mm-local': key } : {}
}

/** API root relative to <base href>, so Mongo Manager works under any basePath. */
function apiUrl(p: string): URL {
  return new URL(p.replace(/^\//, ''), new URL('api/', document.baseURI))
}

/** An API address for a link (a download the browser makes with the session's cookie). */
export const apiHref = (p: string): string => apiUrl(p).href

let ipNotAllowedHandler: ((address: string) => void) | undefined
/** Panel access (2026-10-30): the panel does not answer this address (with the address it saw). */
export function onIpNotAllowed(handler: (address: string) => void): void {
  ipNotAllowedHandler = handler
}

let twoFactorRequiredHandler: (() => void) | undefined
/** Phase 4c §4: the server asks an administrator to set 2FA up before anything else. */
export function onTwoFactorRequired(handler: () => void): void {
  twoFactorRequiredHandler = handler
}

async function request<T>(
  method: string,
  p: string,
  body?: unknown,
  init: { signal?: AbortSignal; keepalive?: boolean } = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...proofHeaders() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['x-csrf-token'] = csrfToken
  const response = await fetch(apiUrl(p), {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    // Phase 3d-3a: a request sent while the page goes away (it outlives the page).
    ...(init.keepalive ? { keepalive: true } : {}),
  })
  if (response.status === 204) return undefined as T
  if (!response.ok) {
    const error = await errorOf(response, p, init, retried)
    if (error === 'retry') return request<T>(method, p, body, init, true)
    throw error
  }
  return (await readJson(response)) as T
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/**
 * Phase 4b §1 (review): an XMLHttpRequest's answer that is not ok (an upload, for its progress),
 * judged as every other: a 401 signs out, 2FA set-up is asked for, a rotated CSRF token is taken once.
 */
export function failureOf(
  status: number,
  text: string,
  p: string,
  retried: boolean,
): Promise<ApiError | 'retry'> {
  return errorOf(new Response(text || null, { status }), p, {}, retried)
}

/** The error an answer that is not ok carries, or 'retry' once the CSRF token was refreshed. */
async function errorOf(
  response: Response,
  p: string,
  init: { signal?: AbortSignal },
  retried: boolean,
): Promise<ApiError | 'retry'> {
  const e = ((await readJson(response)) ?? {}) as {
    code?: string
    message?: string
    details?: unknown
    correlationId?: string
  }
  // A 401 from a sign-in step means wrong credentials, not an expired session.
  if (response.status === 401 && !SIGN_IN_PATHS.test(p)) unauthenticatedHandler?.()
  if (
    response.status === 403 &&
    (e.details as { reason?: unknown } | undefined)?.reason === 'two_factor_setup_required'
  )
    twoFactorRequiredHandler?.()
  if (response.status === 403 && (e.details as { reason?: unknown } | undefined)?.reason === 'ip_not_allowed')
    ipNotAllowedHandler?.(String((e.details as { address?: unknown }).address ?? ''))
  // W7: a connection that signs this person in with OIDC, and they have not (or no longer): the app
  // offers the sign-in, whichever screen asked.
  if ((e.details as { reason?: unknown } | undefined)?.reason === 'oidc_sign_in') {
    const id = /^\/?connections\/([^/?]+)/.exec(p)?.[1]
    if (id) oidcSignInHandler?.(decodeURIComponent(id))
  }
  // Another tab rotated the session (e.g. a password change): take the new token once and retry.
  if (
    response.status === 403 &&
    !retried &&
    (e.details as { reason?: unknown } | undefined)?.reason === 'csrf'
  ) {
    const me = await request<{ csrfToken?: string }>('GET', 'auth/me', undefined, init)
    if (me?.csrfToken) {
      csrfToken = me.csrfToken
      return 'retry'
    }
  }
  return new ApiError(
    response.status,
    e.code ?? 'INTERNAL',
    e.message ?? response.statusText,
    e.details,
    e.correlationId,
  )
}

/**
 * A POST answered with a stream (NDJSON, phase 2a): its body once the server accepted the request.
 * An error before the stream starts is thrown like any other answer's.
 */
async function stream(
  p: string,
  body: unknown,
  init: { signal?: AbortSignal } = {},
  retried = false,
): Promise<ReadableStream<Uint8Array>> {
  const headers: Record<string, string> = {
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
    ...proofHeaders(),
  }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const response = await fetch(apiUrl(p), {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (!response.ok) {
    const error = await errorOf(response, p, init, retried)
    if (error === 'retry') return stream(p, body, init, true)
    throw error
  }
  if (!response.body) throw new ApiError(response.status, 'INTERNAL', 'The answer has no body')
  return response.body
}

/** Phase 3d-3a: raw bytes (a part of a resumable upload), with the same session and CSRF handling. */
async function putBytes<T>(
  p: string,
  body: Blob,
  init: { signal?: AbortSignal } = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/octet-stream',
    ...proofHeaders(),
  }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const response = await fetch(apiUrl(p), {
    method: 'PUT',
    headers,
    credentials: 'same-origin',
    body,
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (!response.ok) {
    const error = await errorOf(response, p, init, retried)
    if (error === 'retry') return putBytes<T>(p, body, init, true)
    throw error
  }
  return (await readJson(response)) as T
}

/** A file's bytes from the API with its headers (a preview); failures judged as every other. */
async function getBytes(
  p: string,
  init: { signal?: AbortSignal } = {},
  retried = false,
): Promise<{ blob: Blob; headers: Headers }> {
  const response = await fetch(apiUrl(p), {
    method: 'GET',
    headers: proofHeaders(),
    credentials: 'same-origin',
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (!response.ok) {
    const error = await errorOf(response, p, init, retried)
    if (error === 'retry') return getBytes(p, init, true)
    throw error
  }
  return { blob: await response.blob(), headers: response.headers }
}

export const api = {
  get: <T>(p: string, init?: { signal?: AbortSignal }) => request<T>('GET', p, undefined, init),
  getBytes: (p: string, init?: { signal?: AbortSignal }) => getBytes(p, init),
  putBytes: <T>(p: string, body: Blob, init?: { signal?: AbortSignal }) => putBytes<T>(p, body, init),
  post: <T>(p: string, body?: unknown, init?: { signal?: AbortSignal }) => request<T>('POST', p, body, init),
  patch: <T>(p: string, body?: unknown) => request<T>('PATCH', p, body),
  put: <T>(p: string, body?: unknown, init?: { keepalive?: boolean }) => request<T>('PUT', p, body, init),
  delete: <T>(p: string, body?: unknown, init?: { keepalive?: boolean }) =>
    request<T>('DELETE', p, body, init),
  stream: (p: string, body: unknown, init?: { signal?: AbortSignal }) => stream(p, body, init),
}
