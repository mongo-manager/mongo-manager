// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export type ConnectionErrorKind =
  | 'auth'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'ssh'
  | 'ssh-host-key'
  | 'dependency'
  | 'config'
  | 'busy'
  | 'unsupported'
  /** W7: this person must sign in with the identity provider (or sign in again). */
  | 'oidc'
  /** W8: client-side encryption could not start (its library, a key provider). */
  | 'encryption'
  /** CI 2026-10-22: an open stopped, the app closing or its connection changed meanwhile. */
  | 'closed'
  | 'unknown'

export class ConnectionError extends Error {
  override name = 'ConnectionError'

  constructor(
    readonly kind: ConnectionErrorKind,
    message: string,
    readonly fingerprint?: string,
    /** A refused sign-in kept by the manager, said again without dialling (manager.ts, refusals). */
    readonly remembered?: boolean,
  ) {
    super(message)
  }
}

/** Sixth review (nit 1): a refusal the shell met, whatever its mechanism (X.509 has no password). */
export const SIGN_IN_REFUSED =
  'The server refused the sign-in: check the credentials, mechanism and auth source'
/** A sign-in the server refused (MongoDB's own words name no user). */
export const AUTH_FAILED = 'Authentication failed: check the username, password, mechanism and auth source'

/** MONGODB-AWS: the connection's own keys or nothing; never the server's own AWS identity. */
export const AWS_KEYS_NEEDED =
  "MONGODB-AWS needs an access key ID and a secret access key on the connection: the server's own AWS identity is never used"

/**
 * W7: the broker's answer when a person has no usable tokens. The driver passes the callback's error
 * on, perhaps wrapped: it is recognised by this text, as AWS_KEYS_NEEDED is.
 */
export const OIDC_SIGN_IN_NEEDED = 'Sign in with your identity provider to use this connection (OIDC)'

/** W7: a per-person OIDC connection asked for with no person (work that runs on its own). */
export const OIDC_PER_PERSON =
  'This connection signs each person in with OIDC: in team mode, work that runs on its own (monitoring, schedules, live syncs) cannot use it'

export function redactUris(text: string): string {
  return text.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[connection string]')
}

/**
 * Security audit 2026-10-16 (minor): a message about a connection string with none of its
 * credentials. A password may hold an unencoded "@", "/" or ":", so a connection string's userinfo
 * is everything from "//" to the LAST "@" of it; and a parser that split it elsewhere may quote a
 * piece ("Invalid host "ss/w0rd@db""), so the userinfo and every piece of the password (3 characters
 * or more, split at each of those) are hidden wherever they appear too. Over-hiding is the safe side.
 */
export function redactUriSecrets(message: string, uri: string): string {
  let out = message.replace(/(\/\/)[^\s"'<>]*@/g, '$1***@')
  const start = uri.indexOf('://')
  const at = uri.lastIndexOf('@')
  if (start < 0 || at <= start) return out
  const userinfo = uri.slice(start + 3, at)
  const encoded = userinfo.slice(userinfo.indexOf(':') + 1)
  // Independent review of the security pass (minor): the password as the parser decoded it too.
  let decoded = encoded
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    // Malformed escapes: as written only.
  }
  const pieces = new Set([userinfo])
  for (const password of [encoded, decoded]) {
    pieces.add(password)
    for (const p of password.split(/[:@/]/)) pieces.add(p)
    for (const d of [':', '@', '/']) for (const p of password.split(d)) pieces.add(p)
  }
  pieces.delete('')
  for (const piece of [...pieces].sort((a, b) => b.length - a.length)) {
    if (piece.length >= 3) out = out.split(piece).join('***')
    // A piece of one or two characters only where it stands alone: inside a word it says nothing.
    else out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegex(piece)}(?![A-Za-z0-9])`, 'g'), '***')
  }
  return out
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function firstLine(text: string): string {
  return redactUris(text.split('\n')[0] ?? '').slice(0, 300)
}

/** Maps driver, DNS, TLS and socket failures to a stable kind with a message safe to show users. */
export function classifyError(e: unknown): ConnectionError {
  if (e instanceof ConnectionError) return e
  const err = e as {
    name?: string
    code?: unknown
    codeName?: string
    message?: string
    cause?: { message?: string }
  }
  const text = `${err.message ?? String(e)} ${err.cause?.message ?? ''}`
  if (err.name === 'MongoParseError' || err.name === 'MongoInvalidArgumentError') {
    return new ConnectionError('config', `Invalid connection option: ${firstLine(text)}`)
  }
  // The connection's own AWS keys are missing: it is never signed in as the server.
  if (text.includes(AWS_KEYS_NEEDED)) return new ConnectionError('auth', AWS_KEYS_NEEDED)
  // W7: no tokens for this person (or they were refused): they sign in again; nothing else said.
  if (text.includes(OIDC_SIGN_IN_NEEDED)) return new ConnectionError('oidc', OIDC_SIGN_IN_NEEDED)
  if (err.name === 'MongoOIDCError')
    return new ConnectionError('oidc', `OIDC sign-in failed: ${firstLine(text)}`)
  // W8: libmongocrypt's own errors (a library that does not load, a key provider that refused).
  if (err.name === 'MongoCryptError' || err.name === 'MongoCryptInvalidArgumentError')
    return new ConnectionError('encryption', `Client-side encryption failed: ${firstLine(text)}`)
  if (err.name === 'MongoMissingDependencyError') {
    return new ConnectionError(
      'dependency',
      `This authentication method needs an optional package that is not installed: ${firstLine(text)}`,
    )
  }
  if (err.code === 18 || err.codeName === 'AuthenticationFailed' || /Authentication failed/i.test(text)) {
    return new ConnectionError('auth', AUTH_FAILED)
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv|querytxt/i.test(text)) {
    return new ConnectionError('dns', `The host name could not be resolved: ${firstLine(text)}`)
  }
  if (/certificate|self[- ]signed|SSL|TLS|ERR_TLS|handshake/i.test(text)) {
    return new ConnectionError('tls', `TLS handshake failed: ${firstLine(text)}`)
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(text)) {
    return new ConnectionError('network', `Could not reach the server: ${firstLine(text)}`)
  }
  if (err.name === 'MongoServerSelectionError' || /timed out/i.test(text)) {
    return new ConnectionError('timeout', 'No server was reachable before the timeout')
  }
  return new ConnectionError('unknown', firstLine(text))
}
