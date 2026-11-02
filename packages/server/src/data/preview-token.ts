import { createHmac, randomBytes } from 'node:crypto'
import { safeEqual } from '../http/security'

/** Per-process signing key: preview tokens cannot be forged and die with the process. */
const KEY = randomBytes(32)

/** Signs claims a later request must present unchanged (bulk and aggregation write previews). */
export function signToken(claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${createHmac('sha256', KEY).update(payload).digest('base64url')}`
}

/** The claims of a token this process signed, or null. */
export function readToken<T>(token: string): T | null {
  const [payload, mac] = token.split('.')
  if (!payload || !mac || !safeEqual(mac, createHmac('sha256', KEY).update(payload).digest('base64url')))
    return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}
