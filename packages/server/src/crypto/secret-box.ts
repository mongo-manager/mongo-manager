import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDataDir } from '../store/datadir'
import { createWhole } from '../store/key-file'

export interface SecretBox {
  seal(plaintext: string, context?: string): string
  open(sealed: string, context?: string): string
  /** A keyed hash (hex): equal inputs are recognised without being readable (phase 2c). */
  mac(data: string): string
  /** A key for one purpose, derived from the master key; never the encryption key itself (phase 3c). */
  derive(label: string): Buffer
}

export const KEY_FILE = 'secret.key'
const KEY_BYTES = 32
const IV_BYTES = 12

function decryptError(): Error {
  return new Error('Unable to decrypt secret (wrong key or tampered data)')
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) throw new Error(`Secret key must be ${KEY_BYTES} bytes`)
  // A separate key for hashing: the encryption key is never used for two purposes.
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'mm-mac-v1', 32))
  return {
    derive: (label) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), label, 32)),
    mac(data) {
      return createHmac('sha256', macKey).update(data, 'utf8').digest('hex')
    },
    seal(plaintext, context = '') {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return ['v1', iv, cipher.getAuthTag(), ciphertext]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.')
    },
    open(sealed, context = '') {
      const parts = sealed.split('.')
      if (parts.length !== 4 || parts[0] !== 'v1') throw decryptError()
      try {
        const [, iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'))
        const decipher = createDecipheriv('aes-256-gcm', key, iv!)
        decipher.setAAD(Buffer.from(context, 'utf8'))
        decipher.setAuthTag(tag!)
        return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')
      } catch {
        throw decryptError()
      }
    },
  }
}

function decodeKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`${source} must contain a base64-encoded ${KEY_BYTES}-byte key (got ${key.length} bytes)`)
  }
  return key
}

/**
 * Spec §3.4: MM_SECRET_KEY wins; otherwise <dataDir>/secret.key is created once with mode 0600.
 * `create: false`: by one that does not hold the data directory's lock (a command beside a running
 * or starting server), which only ever reads it (fourth review of the CI fix 2026-10-20, minor 1).
 */
export function loadOrCreateKey(opts: { dataDir: string; envKey?: string; create?: boolean }): Buffer {
  if (opts.envKey) return decodeKey(opts.envKey, 'MM_SECRET_KEY')
  const path = join(opts.dataDir, KEY_FILE)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (opts.create === false && !text)
    throw new Error(
      `No key at ${path} to open it with: a server holds this data directory. If it is starting, ` +
        'try again; if it runs with MM_SECRET_KEY, give this command the same key.',
    )
  if (text !== null) {
    // An earlier start stopped before it wrote it: only one holding the lock takes it away
    // (setAsideEmpty, second review of the CI fix 2026-10-20, important 1).
    if (text === '') throw new Error(`${path} is empty: a start stopped before it wrote it`)
    return decodeKey(text, KEY_FILE)
  }
  ensureDataDir(opts.dataDir)
  const key = randomBytes(KEY_BYTES)
  if (createWhole(path, `${key.toString('base64')}\n`) === 'exists')
    return decodeKey(readFileSync(path, 'utf8'), KEY_FILE)
  return key
}
