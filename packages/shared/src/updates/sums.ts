import { createPublicKey, verify } from 'node:crypto'
import { RELEASE_PUBLIC_KEYS } from './source'

const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/

/**
 * A release's SHA256SUMS against its SHA256SUMS.sig (base64 of a raw Ed25519 signature): true when
 * one of the keys made it. Never throws: a malformed key or signature is a refusal.
 */
export function verifySums(
  sums: Buffer,
  signature: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): boolean {
  const text = signature.trim()
  if (!SIGNATURE.test(text)) return false
  const sig = Buffer.from(text, 'base64')
  for (const k of keys) {
    try {
      const key = createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType === 'ed25519' && verify(null, sums, key, sig)) return true
    } catch {
      // A key that is not one: the next may be.
    }
  }
  return false
}

/** sha256sum's output: "<64 hex>  <name>" (or " *<name>"); names are plain file names, each once. */
export function parseSums(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (!m) throw new Error('SHA256SUMS holds a line it should not')
    const name = m[2]!
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..')
      throw new Error('SHA256SUMS names something that is not a plain file')
    if (map.has(name)) throw new Error('SHA256SUMS names a file twice')
    map.set(name, m[1]!)
  }
  return map
}
