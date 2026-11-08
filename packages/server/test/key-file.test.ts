// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWhole, removeHeld, setAsideEmpty, sweepPartials } from '../src/store/key-file'
import { KEY_FILE, createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { verifyKeyCheck } from '../src/crypto/rotate'
import { openStore } from '../src/store/db'
import { LAUNCH_FILE } from '../src/auth/launch'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

// Review of the CI fix 2026-10-20 (minor 3): a key file was opened, then written; a server stopped
// in between (an end, a crash, a power cut) left it empty, and every start after failed on it.
const dirs: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-keyfile-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const config = (dataDir: string, extra = {}) =>
  resolveConfig({ cli: { dataDir, webPort: 0, logLevel: 'silent', ...extra } })

describe('a key file is made whole or not at all', () => {
  it('makes it with its text, owner-only, and leaves nothing beside it', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    expect(createWhole(file, 'abc\n')).toBe('made')
    expect(readFileSync(file, 'utf8')).toBe('abc\n')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['secret.key'])
  })

  it('writes it once, under a name of its own, and only then gives it its name', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    const seen: string[] = []
    const write = (fd: number, text: string) => {
      seen.push(readdirSync(dir).join())
      writeSync(fd, text)
    }
    expect(createWhole(file, 'abc\n', { write })).toBe('made')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^secret\.key\.\d+\.[0-9a-f]{12}\.partial$/)
  })

  it('never writes over one that is there, nor over one made meanwhile', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    writeFileSync(file, 'first\n')
    expect(createWhole(file, 'second\n')).toBe('exists')
    expect(readFileSync(file, 'utf8')).toBe('first\n')
    rmSync(file)
    // Another start names its own between this one's write and its link.
    const link = (from: string, to: string) => {
      writeFileSync(to, 'theirs\n')
      linkSync(from, to)
    }
    expect(createWhole(file, 'mine\n', { link })).toBe('exists')
    expect(readFileSync(file, 'utf8')).toBe('theirs\n')
    expect(readdirSync(dir)).toEqual(['secret.key'])
  })

  // Second review (minor 5): any other refusal of a hard link makes it in place, as before.
  it('makes it in place where the file system will not link it', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    const link = () => {
      throw Object.assign(new Error('no links here'), { code: 'EIO' })
    }
    expect(createWhole(file, 'abc\n', { link })).toBe('made')
    expect(readFileSync(file, 'utf8')).toBe('abc\n')
    expect(readdirSync(dir)).toEqual(['secret.key'])
  })

  it('leaves no file, and nothing beside it, when the write stops part way', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    const write = () => {
      throw new Error('stopped')
    }
    expect(() => createWhole(file, 'abc\n', { write })).toThrow('stopped')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('an empty key file an earlier start left', () => {
  it('is set aside only when it is empty', () => {
    const dir = temp()
    const file = join(dir, 'secret.key')
    writeFileSync(file, '')
    expect(setAsideEmpty(file)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    writeFileSync(file, 'key\n')
    expect(setAsideEmpty(file)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('key\n')
    expect(setAsideEmpty(join(dir, 'missing.key'))).toBe(false)
  })

  // Second review (important 1): a command running beside a starting server holds no lock: it never
  // takes an empty key away (the server's start might be making one in its place).
  it('is refused, and left, by a command that does not hold the lock', () => {
    const dir = temp()
    writeFileSync(join(dir, KEY_FILE), '')
    expect(() => loadOrCreateKey({ dataDir: dir })).toThrow(/is empty/)
    expect(readFileSync(join(dir, KEY_FILE), 'utf8')).toBe('')
  })

  // Second review (important 2): taken as no key at all, so data sealed with the lost one is never
  // given a new key beside it.
  it('makes a start refuse a data directory with encrypted data, writing no key', async () => {
    const dir = temp()
    await (await startServer(config(dir))).close()
    writeFileSync(join(dir, KEY_FILE), '')
    await expect(startServer(config(dir))).rejects.toThrow(/holds encrypted data but no key/)
    expect(existsSync(join(dir, KEY_FILE))).toBe(false)
  })

  it('is made again by the start of a data directory with nothing sealed', async () => {
    const dir = temp()
    writeFileSync(join(dir, KEY_FILE), '')
    await (await startServer(config(dir))).close()
    expect(readFileSync(join(dir, KEY_FILE), 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('is made again for the launch secret by a local-mode start', async () => {
    const dir = temp()
    await (await startServer(config(dir, { auth: false }))).close()
    writeFileSync(join(dir, LAUNCH_FILE), '')
    await (await startServer(config(dir, { auth: false }))).close()
    expect(readFileSync(join(dir, LAUNCH_FILE), 'utf8').trim().length).toBeGreaterThan(0)
  })

  // Second review (minor 4): a start stopped between writing and naming left a second name of a key.
  it('goes at the next start, with what a stopped start left beside a key', async () => {
    const dir = temp()
    await (await startServer(config(dir))).close()
    const left = join(dir, `${KEY_FILE}.1234.0123456789ab.partial`)
    const launch = join(dir, `${LAUNCH_FILE}.99.abcdef012345.partial`)
    // Fifth review (minor 6): only files such a start leaves, not a folder named so.
    const folder = join(dir, `${KEY_FILE}.7.000000000000.partial`)
    writeFileSync(left, 'old key\n')
    writeFileSync(launch, 'old secret\n')
    mkdirSync(folder)
    await (await startServer(config(dir))).close()
    expect(existsSync(left)).toBe(false)
    expect(existsSync(launch)).toBe(false)
    expect(existsSync(folder)).toBe(true)
  })

  // Eighth review (minor 4): one that cannot be removed (held open) stops it, said; one gone
  // meanwhile does not.
  it('says which one could not be removed, and passes over one gone meanwhile', () => {
    const dir = temp()
    const left = join(dir, `${KEY_FILE}.1234.0123456789ab.partial`)
    writeFileSync(left, 'old key\n')
    const busy = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    expect(() => sweepPartials(dir, busy)).toThrow(/Could not remove .*left by a stopped start: EBUSY/)
    expect(existsSync(left)).toBe(true)
    const gone = () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }
    expect(() => sweepPartials(dir, gone)).not.toThrow()
  })

  // Ninth review (minor 4): a file held a moment is retried by our own loop, not by an option Node
  // only documents for folders.
  it('removes one held a moment, trying again, and gives up on one held for good', () => {
    const dir = temp()
    const file = join(dir, 'held')
    writeFileSync(file, 'x')
    let tries = 0
    const waits: number[] = []
    removeHeld(
      file,
      (p) => {
        if (++tries < 3) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        rmSync(p)
      },
      (ms) => waits.push(ms),
    )
    expect(tries).toBe(3)
    expect(waits).toEqual([100, 100])
    expect(existsSync(file)).toBe(false)
    // Tenth review (minor 3): ten tries, nine waits, for one held for good; none for another error;
    // and one gone between tries is fine.
    let calls = 0
    const held: number[] = []
    const always = () => {
      calls++
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    expect(() => removeHeld(file, always, (ms) => held.push(ms))).toThrow(/EBUSY/)
    expect({ calls, waits: held.length }).toEqual({ calls: 10, waits: 9 })
    let other = 0
    const folder = () => {
      other++
      throw Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' })
    }
    expect(() => removeHeld(file, folder, () => undefined)).toThrow(/EISDIR/)
    expect(other).toBe(1)
    let second = 0
    const goneThen = () => {
      if (++second === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    expect(() => removeHeld(file, goneThen, () => undefined)).not.toThrow()
    expect(second).toBe(2)
  })

  // Fifth review (minor 6): nor is one a key file the hints name.
  it('is no key file a refused key names', async () => {
    const dir = temp()
    await (await startServer(config(dir))).close()
    const store = await openStore(dir)
    try {
      writeFileSync(join(dir, `${KEY_FILE}.old-123`), 'k\n')
      writeFileSync(join(dir, `${KEY_FILE}.1234.0123456789ab.partial`), 'k\n')
      const other = createSecretBox(randomBytes(32))
      let message = ''
      try {
        verifyKeyCheck(store.db, other, dir)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/does not match/)
      expect(message).toContain(`${KEY_FILE}.old-123`)
      expect(message).not.toContain('.partial')
    } finally {
      store.close()
    }
  })
})
