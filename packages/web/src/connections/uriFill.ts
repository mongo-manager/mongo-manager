import type { ConnectionSettings } from '@mongo-manager/shared'
import { applySettings, type ConnectionForm } from './formModel'

/**
 * Applies a pasted connection string. A URI never carries TLS PEMs or SSH settings, so those
 * stay; the stored password stays too when the URI has none and names the same user.
 */
export function applyUri(form: ConnectionForm, s: ConnectionSettings): void {
  const kept = {
    password: form.auth.password,
    username: form.auth.username,
    caPem: form.tls.caPem,
    certificateKeyPem: form.tls.certificateKeyPem,
    certificateKeyPassword: form.tls.certificateKeyPassword,
  }
  applySettings(form, s, { keepSsh: true })
  form.tls.caPem = kept.caPem
  form.tls.certificateKeyPem = kept.certificateKeyPem
  form.tls.certificateKeyPassword = kept.certificateKeyPassword
  if (!s.auth.password && kept.password && form.auth.username === kept.username)
    form.auth.password = kept.password
}

/**
 * A connection string as typed, "mongodb://" put in front when it names no scheme (user report
 * 2026-10-16: "localhost:27017" was refused for its missing scheme). Empty stays empty.
 */
export function withScheme(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `mongodb://${trimmed}`
}

/**
 * parse-uri masks secret mechanism properties too (an AWS session token): read them from the
 * pasted URI itself.
 */
export function propertiesFromUri(uri: string): string | undefined {
  const query = uri.trim().split('#')[0]!.split('?')[1]
  if (!query) return undefined
  try {
    return new URLSearchParams(query).get('authMechanismProperties') ?? undefined
  } catch {
    return undefined
  }
}

/** parse-uri masks the password it parsed; read it from the pasted URI itself. */
export function passwordFromUri(uri: string): string | undefined {
  const m = /^mongodb(?:\+srv)?:\/\/([^@/?#]*)@/i.exec(uri.trim())
  const userinfo = m?.[1]
  if (!userinfo || !userinfo.includes(':')) return undefined
  try {
    return decodeURIComponent(userinfo.slice(userinfo.indexOf(':') + 1))
  } catch {
    return undefined
  }
}
