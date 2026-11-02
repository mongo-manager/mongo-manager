import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  KEY_FILE,
  acquireInstanceLock,
  createSecretBox,
  keyFingerprint,
  openStore,
  resolveConfig,
  runningInstance,
  verifyKeyCheck,
} from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { readSecret } from '../src/prompt'
import { spawnSync } from 'node:child_process'
import { rolldown } from 'rolldown'
import { missingModulesPlugin } from '../scripts/missing-module.mjs'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

const PW = 'tarçın-kavanoz-42-mavi'

async function run(
  argv: string[],
  opts: { env?: Record<string, string>; stdin?: string; tty?: boolean } = {},
) {
  const io = fakeIo({ env: opts.env, tty: opts.tty })
  const code = main(argv, io)
  if (opts.stdin !== undefined) io.input.end(opts.stdin)
  return { code: await code, io }
}

async function initialised(): Promise<string> {
  const dir = tempDir()
  ;(await openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })).close()
  return dir
}

describe('admin commands and the instance lock (Review Important 1)', () => {
  it('refuse to run during a key rotation', async () => {
    const dir = await initialised()
    const lock = acquireInstanceLock(dir, 'key rotation')
    try {
      const { code, io } = await run(['user', 'list', '--data-dir', dir])
      expect(code).toBe(1)
      expect(io.err()).toMatch(/key rotation.*in progress|in use by Mongo Manager \(key rotation/s)
    } finally {
      lock.release()
    }
  })

  it('work next to a running server without touching a pending rotation', async () => {
    const dir = await initialised()
    writeFileSync(join(dir, `${KEY_FILE}.new`), `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 })
    const lock = acquireInstanceLock(dir, 'server')
    try {
      expect((await run(['user', 'list', '--data-dir', dir])).code).toBe(0)
      expect(existsSync(join(dir, `${KEY_FILE}.new`))).toBe(true)
    } finally {
      lock.release()
    }
  })

  it('hold the lock themselves when nothing else runs, and release it', async () => {
    const dir = await initialised()
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(runningInstance(dir)?.what).toBe('admin command')
    } finally {
      data.close()
    }
    expect(runningInstance(dir)).toBeNull()
  })
})

// Fourth review of the CI fix 2026-10-20 (minor 1, 2): beside a running (or starting) server a
// command holds no lock and so never makes a key, nor takes an empty one away; holding the lock, it
// sets an empty one aside as a starting server does.
describe('admin commands and an empty or missing key', () => {
  it('beside a running server, make no key', async () => {
    const dir = tempDir()
    const lock = acquireInstanceLock(dir, 'server')
    try {
      await expect(openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })).rejects.toThrow(
        /a server holds this data directory/,
      )
      expect(existsSync(join(dir, KEY_FILE))).toBe(false)
    } finally {
      lock.release()
    }
  })

  it('beside a running server, leave an empty key and say why', async () => {
    const dir = await initialised()
    writeFileSync(join(dir, KEY_FILE), '')
    const lock = acquireInstanceLock(dir, 'server')
    try {
      await expect(openData(resolveConfig({ cli: { dataDir: dir } }))).rejects.toThrow(
        /a server holds this data directory/,
      )
      expect(readFileSync(join(dir, KEY_FILE), 'utf8')).toBe('')
    } finally {
      lock.release()
    }
  })

  it('holding the lock, refuse encrypted data whose key was left empty, writing none', async () => {
    const dir = await initialised()
    writeFileSync(join(dir, KEY_FILE), '')
    await expect(openData(resolveConfig({ cli: { dataDir: dir } }))).rejects.toThrow(
      /holds encrypted data but no key/,
    )
    expect(existsSync(join(dir, KEY_FILE))).toBe(false)
  })

  it('holding the lock, make the key of a new data directory in place of an empty one', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, KEY_FILE), '')
    ;(await openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })).close()
    expect(readFileSync(join(dir, KEY_FILE), 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })
})

describe('mistyped data directories (Review Minor 6)', () => {
  it('are refused by commands that read or change existing users', async () => {
    const dir = join(tempDir(), 'typo')
    for (const argv of [
      ['user', 'list'],
      ['user', 'reset-2fa', 'ada'],
    ]) {
      const { code, io } = await run([...argv, '--data-dir', dir])
      expect(code).toBe(1)
      expect(io.err()).toMatch(/does not exist/)
    }
    expect(existsSync(dir)).toBe(false)
  })

  it('are created, with a notice, by commands that add data', async () => {
    const dir = join(tempDir(), 'fresh')
    const { code, io } = await run(
      ['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', dir],
      { stdin: PW },
    )
    expect(code).toBe(0)
    expect(io.err()).toMatch(/Creating a new data directory/)
  })
})

describe('rotate-key output with a configured key (Review Minor 3)', () => {
  it('tells to keep the previous key with the backup', async () => {
    const dir = tempDir()
    const envKey = randomBytes(32).toString('base64')
    const store = await openStore(dir)
    verifyKeyCheck(store.db, createSecretBox(Buffer.from(envKey, 'base64')))
    store.close()
    const target = join(tempDir(), 'new.key')
    const { code, io } = await run(['rotate-key', '--new-key-file', target, '--data-dir', dir], {
      env: { MM_SECRET_KEY: envKey },
    })
    expect(code).toBe(0)
    expect(io.out()).toMatch(/Keep the previous key .* together with the backup/)
    expect(io.out()).not.toContain(readFileSync(target, 'utf8').trim())
  })
})

describe('stubbed optional modules (Review Minor 4)', () => {
  it('report themselves as missing on every load inside the bundle', async () => {
    const dir = tempDir()
    // The MongoDB driver's pattern: require in try/catch, then check for kModuleError.
    writeFileSync(
      join(dir, 'entry.cjs'),
      `const load = () => { try { const m = require('kerberos'); return 'kModuleError' in m ? 'missing: ' + m.kModuleError.message : 'loaded' } catch (e) { return 'missing: ' + e.message } }
       console.log(JSON.stringify([load(), load()]))`,
    )
    const bundle = await rolldown({
      input: join(dir, 'entry.cjs'),
      platform: 'node',
      logLevel: 'silent',
      plugins: [missingModulesPlugin()],
    })
    await bundle.write({ file: join(dir, 'out.cjs'), format: 'cjs', codeSplitting: false })
    await bundle.close()
    const out = spawnSync(process.execPath, [join(dir, 'out.cjs')], { encoding: 'utf8' })
    expect(JSON.parse(out.stdout)).toEqual([
      'missing: Optional module not bundled: kerberos',
      'missing: Optional module not bundled: kerberos',
    ])
  })
})

describe('the AWS SDK in the bundle', () => {
  // The driver checks the SDK before it calls a credential provider: a module reporting itself
  // missing would fail every MONGODB-AWS sign-in. It stands in, loaded, and gives no identity of
  // the host's own.
  it('is a stand-in the driver accepts, which never reads the host’s own AWS identity', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'entry.cjs'),
      `const m = require('@aws-sdk/credential-providers')
       let chain
       try { m.fromNodeProviderChain() } catch (e) { chain = e.message }
       console.log(JSON.stringify(['kModuleError' in m, chain]))`,
    )
    const bundle = await rolldown({
      input: join(dir, 'entry.cjs'),
      platform: 'node',
      logLevel: 'silent',
      plugins: [missingModulesPlugin()],
    })
    await bundle.write({ file: join(dir, 'out.cjs'), format: 'cjs', codeSplitting: false })
    await bundle.close()
    const out = spawnSync(process.execPath, [join(dir, 'out.cjs')], { encoding: 'utf8' })
    expect(JSON.parse(out.stdout)).toEqual([
      false,
      'Mongo Manager signs in to AWS with the keys of the connection only, never its host’s own identity',
    ])
  })
})

describe('password input (Review Minor 5)', () => {
  it('rejects when the terminal input ends instead of hanging', async () => {
    const io = fakeIo({ tty: true })
    const pending = readSecret(io, 'Password: ')
    io.input.end()
    await expect(pending).rejects.toThrow(/No password entered/)
  })

  it('refuses --password-stdin on a terminal, where the password would be echoed', async () => {
    const { code, io } = await run(
      ['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', tempDir()],
      { tty: true },
    )
    expect(code).toBe(2)
    expect(io.err()).toMatch(/--password-stdin reads from a pipe/)
  })
})

describe.skipIf(process.platform === 'win32')('config files with credentials (Review Minor 7)', () => {
  it('are refused when others can read a connection string with a password', () => {
    const dir = tempDir()
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ uri: 'mongodb://app:pw@db/' }))
    chmodSync(file, 0o644)
    return run(['doctor', '--config', file, '--data-dir', dir]).then(({ code, io }) => {
      expect(code).toBe(2)
      expect(io.err()).toMatch(/readable by other users/)
    })
  })
})

describe('doctor key checks (Review Minor 9)', () => {
  it('checks the key on a data directory from before the key check existed', async () => {
    const dir = tempDir()
    const good = randomBytes(32)
    const store = await openStore(dir)
    store.db
      .prepare('INSERT INTO connections (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, 0, 0)')
      .run('c1', 'Prod', createSecretBox(good).seal('{}', 'connection:c1:settings'))
    store.close()
    const wrong = await run(['doctor', '--data-dir', dir], {
      env: { MM_SECRET_KEY: randomBytes(32).toString('base64') },
    })
    expect(wrong.code).toBe(1)
    expect(wrong.io.out()).toMatch(/\[fail\] The secret key does not match/)
    const right = await run(['doctor', '--data-dir', dir], {
      env: { MM_SECRET_KEY: good.toString('base64') },
    })
    expect(right.io.out()).toMatch(/\[ok\] The secret key matches/)
  })

  // Sixth review of the CI fix 2026-10-20 (minor 7): an empty key says what it is.
  it('says what an empty key file is, and what the next start does with it', async () => {
    const dir = await initialised()
    writeFileSync(join(dir, KEY_FILE), '')
    const { code, io } = await run(['doctor', '--data-dir', dir])
    expect(code).toBe(1)
    expect(io.out()).toMatch(
      /\[fail\] .*secret\.key is empty: a start stopped before it wrote it\. The next start/,
    )
    expect(readFileSync(join(dir, KEY_FILE), 'utf8')).toBe('')
  })

  // Seventh review (minor 3): a link the next start leaves as it is.
  it('says a key that is a link to an empty file stays so', async (ctx) => {
    const dir = await initialised()
    const empty = join(tempDir(), 'empty.key')
    writeFileSync(empty, '')
    rmSync(join(dir, KEY_FILE))
    // Eighth review (minor 6): on Windows too, where this account may make links.
    try {
      symlinkSync(empty, join(dir, KEY_FILE))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') ctx.skip()
      throw e
    }
    const { io } = await run(['doctor', '--data-dir', dir])
    expect(io.out()).toMatch(
      /\[fail\] .*secret\.key is a link to an empty file; a start leaves a link as it is/,
    )
  })

  it('reports a committed but unfinished rotation as a warning, not a failure', async () => {
    const dir = await initialised()
    const next = randomBytes(32)
    const store = await openStore(dir)
    store.db.prepare("DELETE FROM settings WHERE key = 'key_check'").run()
    verifyKeyCheck(store.db, createSecretBox(next))
    store.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('key_rotation', ?)")
      .run(keyFingerprint(next))
    store.close()
    writeFileSync(join(dir, `${KEY_FILE}.new`), `${next.toString('base64')}\n`, { mode: 0o600 })
    const { code, io } = await run(['doctor', '--data-dir', dir])
    expect(code).toBe(0)
    expect(io.out()).toMatch(
      /\[warn\] A key rotation was committed but not finished; the next start completes it/,
    )
    expect(io.out()).not.toMatch(/\[fail\]/)
    mkdirSync(join(dir, 'unused'), { recursive: true })
  })
})
