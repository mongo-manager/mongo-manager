import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY_FILE, createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-key-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createSecretBox', () => {
  const box = createSecretBox(randomBytes(32))

  it('round-trips unicode and uses a fresh IV each time', () => {
    const secret = 'mongodb://ağ:şifre🔑@host/db'
    const a = box.seal(secret, 'connection:1:uri')
    const b = box.seal(secret, 'connection:1:uri')
    expect(a).not.toBe(b)
    expect(a.startsWith('v1.')).toBe(true)
    expect(box.open(a, 'connection:1:uri')).toBe(secret)
  })

  it('rejects tampering, the wrong context and the wrong key', () => {
    const sealed = box.seal('secret', 'ctx')
    const [v, iv, tag, ct] = sealed.split('.')
    const flipped = Buffer.from(ct!, 'base64url')
    flipped[0] = flipped[0]! ^ 1
    expect(() => box.open([v, iv, tag, flipped.toString('base64url')].join('.'), 'ctx')).toThrow(/decrypt/)
    expect(() => box.open(sealed, 'other')).toThrow(/decrypt/)
    expect(() => createSecretBox(randomBytes(32)).open(sealed, 'ctx')).toThrow(/decrypt/)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', 'v1.a.b', 'v9.a.b.c', 'not-sealed']) expect(() => box.open(bad)).toThrow(/decrypt/)
  })

  it('requires a 32-byte key', () => {
    expect(() => createSecretBox(randomBytes(16))).toThrow(/32 bytes/)
  })
})

describe('loadOrCreateKey', () => {
  it('uses MM_SECRET_KEY when given and validates its length', () => {
    const key = randomBytes(32)
    expect(loadOrCreateKey({ dataDir: tempDir(), envKey: key.toString('base64') }).equals(key)).toBe(true)
    expect(() => loadOrCreateKey({ dataDir: tempDir(), envKey: randomBytes(8).toString('base64') })).toThrow(
      /MM_SECRET_KEY/,
    )
  })

  it('creates the key file once and reuses it', () => {
    const dir = tempDir()
    const first = loadOrCreateKey({ dataDir: dir })
    const second = loadOrCreateKey({ dataDir: dir })
    expect(first).toHaveLength(32)
    expect(second.equals(first)).toBe(true)
    expect(readFileSync(join(dir, KEY_FILE), 'utf8').trim()).toBe(first.toString('base64'))
  })

  it.skipIf(process.platform === 'win32')('writes the key file with mode 0600', () => {
    const dir = tempDir()
    loadOrCreateKey({ dataDir: dir })
    expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600)
  })

  it('refuses a corrupt key file instead of silently replacing it', () => {
    const dir = tempDir()
    writeFileSync(join(dir, KEY_FILE), 'short')
    expect(() => loadOrCreateKey({ dataDir: dir })).toThrow(/secret.key/)
  })
})
