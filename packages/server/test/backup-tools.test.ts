import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import {
  ToolSlots,
  findTools,
  scrubToolOutput,
  toolFailure,
  spawnTool,
  toolSafeName,
  toolsAvailability,
  versionOk,
  withToolConfig,
  sweepToolDirs,
} from '../src/backup/tools'
import type { Principal } from '../src/http/context'
import { mongoTools } from './support/mongo-tools'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { slow } from './support/slowness'

const tools = await mongoTools()
const principal = (userId: string, role: Role): Principal =>
  ({ kind: 'user', userId, username: 'x', role, csrfToken: 't', sessionId: 's' }) as Principal

describe('tools discovery (spec §5.3)', () => {
  it('compares versions with the 100.9 floor', () => {
    expect(versionOk('100.19.1')).toBe(true)
    expect(versionOk('100.9.0')).toBe(true)
    expect(versionOk('101.0.0')).toBe(true)
    expect(versionOk('100.8.9')).toBe(false)
    expect(versionOk('r4.0.3')).toBe(false)
    expect(versionOk('nonsense')).toBe(false)
    expect(versionOk('100.15.9', [100, 16, 0])).toBe(false)
    expect(versionOk('100.16.0', [100, 16, 0])).toBe(true)
  })

  it.skipIf(!tools)('finds the tools on a configured path, and nothing in an empty one', async () => {
    expect(await findTools(dirname(tools!.dump), { PATH: '' })).toMatchObject({ version: '100.19.1' })
    const empty = mkdtempSync(join(tmpdir(), 'mm-empty-'))
    expect(await findTools(empty, { PATH: '' })).toBeNull()
    rmSync(empty, { recursive: true, force: true })
  })

  // Review of the CI fixes: a relative PATH entry names the folder the server runs from.
  it.skipIf(!tools)(
    'never takes tools from the folder it runs in through a relative PATH entry',
    async () => {
      const here = mkdtempSync(join(tmpdir(), 'mm-here-'))
      const exe = process.platform === 'win32' ? '.exe' : ''
      mkdirSync(join(here, 'planted'))
      copyFileSync(tools!.dump, join(here, 'planted', `mongodump${exe}`))
      copyFileSync(tools!.restore, join(here, 'planted', `mongorestore${exe}`))
      const from = process.cwd()
      process.chdir(here)
      try {
        expect(await findTools(null, { PATH: `planted${delimiter}.` })).toBeNull()
      } finally {
        process.chdir(from)
        rmSync(here, { recursive: true, force: true })
      }
    },
  )

  // Fourth review (minor 11): tools that are there but do not run are said as that, never "not found".
  it('finds tools that do not run as tools of no known version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-dead-'))
    try {
      const exe = process.platform === 'win32' ? '.exe' : ''
      for (const name of ['mongodump', 'mongorestore']) writeFileSync(join(dir, name + exe), '')
      expect(await findTools(dir, { PATH: '' })).toMatchObject({ version: 'unknown' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Review of the CI fixes (minor 7): mongorestore is asked too, and the older of the two counts.
  it.skipIf(!tools)('takes the version of the older of mongodump and mongorestore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pair-'))
    try {
      const exe = process.platform === 'win32' ? '.exe' : ''
      copyFileSync(tools!.dump, join(dir, `mongodump${exe}`))
      if (process.platform === 'win32') {
        // A mongorestore that does not say its version (Node's own executable answers v24...).
        copyFileSync(process.execPath, join(dir, 'mongorestore.exe'))
        expect(await findTools(dir, { PATH: '' })).toMatchObject({ version: 'unknown' })
      } else {
        writeFileSync(join(dir, 'mongorestore'), '#!/bin/sh\necho "mongorestore version: 100.15.2"\n', {
          mode: 0o755,
        })
        expect(await findTools(dir, { PATH: '' })).toMatchObject({ version: '100.15.2' })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tools availability (B8)', () => {
  let a: TestMongo
  let b: TestMongo
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
  }, slow(120_000))
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  it('is for admins of a connection without a tunnel; never for a masked user', async () => {
    const h = await transferHarness(a, b)
    try {
      const found = { dump: 'd', restore: 'r', version: '100.19.1' }
      const admin = principal(h.user({ role: 'admin' }).id, 'admin')
      const editor = principal(h.user({ role: 'editor' }).id, 'editor')
      const masked = principal(h.user({ role: 'editor', masked: ['A'] }).id, 'editor')
      expect(toolsAvailability(h.ctx, admin, h.ids.A, found)).toEqual({
        available: true,
        version: '100.19.1',
      })
      expect(toolsAvailability(h.ctx, editor, h.ids.A, found)).toEqual({
        available: false,
        reason: 'not_admin',
      })
      expect(toolsAvailability(h.ctx, masked, h.ids.A, found)).toEqual({
        available: false,
        reason: 'not_admin',
      })
      expect(toolsAvailability(h.ctx, admin, h.ids.A, null)).toEqual({ available: false, reason: 'missing' })
      // Fifth review (minor 4): tools there that do not run are not "too old".
      expect(toolsAvailability(h.ctx, admin, h.ids.A, { ...found, version: 'unknown' })).toEqual({
        available: false,
        reason: 'broken',
      })
      expect(toolsAvailability(h.ctx, admin, h.ids.A, { ...found, version: '100.8.0' })).toEqual({
        available: false,
        reason: 'old',
        version: '100.8.0',
      })
      expect(toolsAvailability(h.ctx, editor, h.ids.A, { ...found, version: '100.8.0' })).toEqual({
        available: false,
        reason: 'old',
      })
      // CI 2026-10-18: before 100.16, mongodump keeps an 8.3 server's time series where mongorestore
      // 100.16 and later no longer looks for them (backup/series.ts): too old for 8.3 and later.
      const before = { ...found, version: '100.15.9' }
      expect(toolsAvailability(h.ctx, admin, h.ids.A, before, '8.3.11')).toEqual({
        available: false,
        reason: 'old',
        version: '100.15.9',
      })
      expect(toolsAvailability(h.ctx, admin, h.ids.A, before, '9.0.0')).toMatchObject({ reason: 'old' })
      expect(toolsAvailability(h.ctx, admin, h.ids.A, before, '8.2.6')).toEqual({
        available: true,
        version: '100.15.9',
      })
      expect(toolsAvailability(h.ctx, admin, h.ids.A, before, null)).toMatchObject({ available: true })
      expect(
        toolsAvailability(h.ctx, admin, h.ids.A, { ...found, version: '100.16.0' }, '8.3.11'),
      ).toMatchObject({ available: true })
      const record = h.ctx.connections.get(h.ids.B)!
      h.ctx.connections.update(h.ids.B, {
        settings: {
          ...record.settings,
          ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', method: 'password', password: 'p' },
        },
      } as never)
      expect(toolsAvailability(h.ctx, admin, h.ids.B, found)).toEqual({
        available: false,
        reason: 'unsupported',
      })
    } finally {
      await h.t.close()
    }
  })
})

describe('safe spawning (B14, B15, B16)', () => {
  it('refuses names that look like options or carry quotes, spaces or $', () => {
    for (const ok of ['shop', 'orders_2026', 'a.b-c']) expect(toolSafeName(ok)).toBe(true)
    for (const bad of ['-drop', '--archive', 'a b', 'a"b', "a'b", 'a$b', 'a\nb', ''])
      expect(toolSafeName(bad), JSON.stringify(bad)).toBe(false)
  })

  it('writes credentials only to a 0600 file in a private directory, removed after a failure', async () => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      auth: { mechanism: 'SCRAM-SHA-256', username: 'ana', password: 's3cr3t:@/pw', authSource: 'admin' },
      tls: { enabled: true, caPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----' },
    })
    let seen: { args: string[]; dir: string; config: string } | null = null
    await expect(
      withToolConfig(settings, async (args) => {
        const configArg = args.find((x) => x.startsWith('--config='))!
        const path = configArg.slice('--config='.length)
        seen = { args, dir: dirname(path), config: readFileSync(path, 'utf8') }
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        throw new Error('the tool failed')
      }),
    ).rejects.toThrow('the tool failed')
    expect(seen!.args.join(' ')).not.toContain('s3cr3t')
    expect(seen!.config).toContain(JSON.stringify('s3cr3t:@/pw'))
    expect(seen!.config).toMatch(/uri: "mongodb:\/\/ana@db\.example:27017/)
    expect(seen!.config).toContain('tlsCAFile=')
    // Final review (declined item): tls once, never twice.
    expect(seen!.config.match(/tls=true/g)).toHaveLength(1)
    expect(existsSync(seen!.dir)).toBe(false)
  })

  it('passes the auth mechanism properties in the private file, never as an argument', async () => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      auth: {
        mechanism: 'MONGODB-AWS',
        username: 'AKIA',
        password: 'secret-key',
        mechanismProperties: 'AWS_SESSION_TOKEN:tok-123',
      },
    })
    await withToolConfig(settings, async (args) => {
      const path = args.find((x) => x.startsWith('--config='))!.slice('--config='.length)
      expect(readFileSync(path, 'utf8')).toContain('authMechanismProperties=AWS_SESSION_TOKEN%3Atok-123')
      expect(args.join(' ')).not.toContain('tok-123')
    })
  })

  // CI on Linux: a PEM pasted with its blocks run together ("-----END X----------BEGIN Y") is read
  // by the driver, which mends it, and was written as it is for the tools, whose OpenSSL refuses it
  // ("bad end line"): the same connection's backups failed there.
  it('writes pasted PEM blocks run together one per line for the tools, as the connection reads them', async () => {
    const block = (kind: string) => `-----BEGIN ${kind}-----\nAAA\n-----END ${kind}-----`
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      tls: {
        enabled: true,
        caPem: `  ${block('CERTIFICATE')}${block('CERTIFICATE')}\n`,
        certificateKeyPem: `${block('CERTIFICATE')}${block('PRIVATE KEY')}`,
      },
    })
    await withToolConfig(settings, async (args) => {
      const dir = dirname(args.find((x) => x.startsWith('--config='))!.slice('--config='.length))
      expect(readFileSync(join(dir, 'ca.pem'), 'utf8')).toBe(
        `${block('CERTIFICATE')}\n${block('CERTIFICATE')}\n`,
      )
      expect(readFileSync(join(dir, 'client.pem'), 'utf8')).toBe(
        `${block('CERTIFICATE')}\n${block('PRIVATE KEY')}\n`,
      )
    })
  })

  // Review 2026-10-17 (minor 10): a PEM field of white space only named a file holding nothing, and
  // the tool failed with an unclear TLS error. Nothing pasted is nothing to name.
  it('names no certificate file for a PEM field of white space only', async () => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'db.example', port: 27017 }],
      tls: { enabled: true, caPem: ' \n ', certificateKeyPem: '\n' },
    })
    await withToolConfig(settings, async (args) => {
      const path = args.find((x) => x.startsWith('--config='))!.slice('--config='.length)
      const config = readFileSync(path, 'utf8')
      expect(config).not.toMatch(/tlsCAFile|tlsCertificateKeyFile/)
      expect(existsSync(join(dirname(path), 'ca.pem'))).toBe(false)
      expect(existsSync(join(dirname(path), 'client.pem'))).toBe(false)
    })
  })

  // The tools' own AWS credential chain reads the host's identity (an instance role) when a
  // connection brings no keys: never run them so.
  it('refuses to run a tool for MONGODB-AWS without the connection’s own keys', async () => {
    const bare = { ...ConnectionSettingsSchema.parse({ hosts: [{ host: 'db.example' }] }) }
    bare.auth = { mechanism: 'MONGODB-AWS' } as never
    const fn = vi.fn()
    await expect(withToolConfig(bare, fn)).rejects.toThrow(/access key ID and a secret access key/)
    expect(fn).not.toHaveBeenCalled()
  })

  // Review minor 7: the tools would read the host's Kerberos ticket cache.
  it('refuses to run a tool for a Kerberos connection', async () => {
    const stored = { ...ConnectionSettingsSchema.parse({ hosts: [{ host: 'db.example' }] }) }
    stored.auth = { mechanism: 'GSSAPI', username: 'u' } as never
    const fn = vi.fn()
    await expect(withToolConfig(stored, fn)).rejects.toThrow(/Kerberos/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('scrubs connection strings and passwords from tool output', () => {
    const out = scrubToolOutput('Failed: mongodb://ana:pw@db:27017/?tls=true password=hunter2 --password=x')
    expect(out).not.toMatch(/pw@|hunter2|password=x/)
    expect(out).toContain('[connection string]')
    // A token in the query, wherever the tool prints it (final review).
    const token = scrubToolOutput('error with authMechanismProperties=AWS_SESSION_TOKEN:tok-123&x=1')
    expect(token).not.toContain('tok-123')
  })

  // MongoDB 9.0 (local run, 2026-10-20): a failed mongorestore said only its last line, "0 document(s)
  // restored successfully…"; why it failed was in the line before. The tool's last "Failed:" line is
  // the reason, without its timestamp; with none, its last line.
  it("says a failed tool's reason, not its closing count", () => {
    const log = [
      '2026-10-20T21:09:23.850+0300\treading metadata for `shop2.ts` from `archive on stdin`',
      '2026-10-20T21:09:23.851+0300\tFailed: shop2.ts: error creating collection shop2.ts: (IDLUnknownField) x',
      '2026-10-20T21:09:23.851+0300\t0 document(s) restored successfully. 0 document(s) failed to restore.',
    ]
    expect(toolFailure(log)).toBe('Failed: shop2.ts: error creating collection shop2.ts: (IDLUnknownField) x')
    expect(toolFailure(['2026-10-20T21:09:23.851+0300\tsomething went wrong'])).toBe(
      '2026-10-20T21:09:23.851+0300\tsomething went wrong',
    )
    expect(toolFailure(['Failed: no timestamp', 'done'])).toBe('Failed: no timestamp')
    expect(toolFailure([])).toBe('')
  })

  it('kills the process on cancel and on timeout', async () => {
    for (const how of ['cancel', 'timeout'] as const) {
      const ctl = new AbortController()
      const started = Date.now()
      const { exit } = spawnTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdin: null,
        signal: ctl.signal,
        timeoutMs: how === 'timeout' ? 500 : 60_000,
      })
      if (how === 'cancel') setTimeout(() => ctl.abort(), 300)
      await exit.catch(() => undefined)
      expect(Date.now() - started, how).toBeLessThan(10_000)
    }
  })

  it('lets go of its input when the process ends without reading it all (final review minor 9)', async () => {
    let closed = false
    const input = (async function* () {
      try {
        for (;;) {
          yield Buffer.alloc(64 * 1024)
          await new Promise((r) => setTimeout(r, 5))
        }
      } finally {
        closed = true
      }
    })()
    const { exit } = spawnTool(process.execPath, ['-e', 'process.exit(3)'], {
      stdin: input,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    })
    expect(await exit).toBe(3)
    await new Promise((r) => setTimeout(r, 100))
    expect(closed).toBe(true)
  })

  it("keeps tool folders in the server's own directory and sweeps a crash's leftovers (final review minor 10)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-tools-root-'))
    try {
      const stale = join(root, 'mm-tools-crashed')
      mkdirSync(stale)
      writeFileSync(join(stale, 'config.yaml'), 'password: s3cr3t')
      await sweepToolDirs(root)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(root)).toBe(true)
      const settings = ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] })
      await withToolConfig(
        settings,
        async (args) => {
          const config = args.find((a) => a.startsWith('--config='))!.slice('--config='.length)
          expect(dirname(dirname(config))).toBe(root)
        },
        root,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('limits tool processes per server', () => {
    const slots = new ToolSlots(2)
    const r1 = slots.acquire()
    slots.acquire()
    expect(() => slots.acquire()).toThrow(/busy/i)
    r1()
    expect(() => slots.acquire()).not.toThrow()
  })
})
