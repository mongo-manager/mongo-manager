// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  linkSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import {
  DB_FILE,
  KEY_FILE,
  LAUNCH_FILE,
  acquireInstanceLock,
  resolveConfig,
  type Config,
} from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { doctor } from '../src/commands/doctor'
import { cleanTempDirs, fakeIo, tempDir } from './support'
import { fakeSys } from './service/fake-sys'
import { mongoTools } from '../../server/test/support/mongo-tools'

const tools = await mongoTools()

afterEach(cleanTempDirs)

async function run(argv: string[], env: Record<string, string> = {}) {
  const io = fakeIo({ env })
  return { code: await main(argv, io), io }
}

describe('rotate-key', () => {
  it('rotates without printing the key and refuses while the server runs', async () => {
    const dir = tempDir()
    await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
    const lock = acquireInstanceLock(dir)
    expect((await run(['rotate-key', '--data-dir', dir])).code).toBe(1)
    lock.release()
    const { code, io } = await run(['rotate-key', '--data-dir', dir])
    expect(code).toBe(0)
    const key = readFileSync(join(dir, 'secret.key'), 'utf8').trim()
    expect(io.out()).toMatch(
      /Re-encrypted 0 connection\(s\), 0 authenticator secret\(s\), 0 query history entry\(ies\), 0 favourite\(s\), 0 saved pipeline\(s\), 0 shell history entry\(ies\), 0 snippet\(s\), 0 personal-field list\(s\), 0 saved transfer setting\(s\), 0 backup destination\(s\), 0 interrupted upload\(s\), 0 backup key\(s\), 0 live sync place\(s\), 0 AI provider key\(s\), 0 AI chat\(s\) with 0 message\(s\), 0 plugin setting list\(s\), 0 alert channel secret\(s\) and 0 OIDC sign-in\(s\)/,
    )
    expect(io.out()).toMatch(/Backup:/)
    expect(io.out() + io.err()).not.toContain(key)
  })
})

describe('doctor', () => {
  it('passes on a fresh setup and names what will be created', async () => {
    const { code, io } = await run(['doctor', '--data-dir', join(tempDir(), 'new')])
    expect(code).toBe(0)
    expect(io.out()).toMatch(/\[ok\] Node\.js \d+/)
    expect(io.out()).toMatch(/\[warn\] Data directory .* does not exist yet/)
  })

  // Security review 2026-10-13 (low): a rotation's previous key and the backup sealed with it stayed in
  // the data directory unnoticed; together they open every secret as it was before.
  it('names what a key rotation left in the data directory', async () => {
    const dir = tempDir()
    await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
    expect((await run(['rotate-key', '--data-dir', dir])).code).toBe(0)
    writeFileSync(join(dir, 'secret.key.new.discarded-1'), 'x')
    const { code, io } = await run(['doctor', '--data-dir', dir])
    expect(code).toBe(0)
    const warning = io
      .out()
      .split('\n')
      .find((l) => l.includes('key rotation left'))!
    expect(warning).toMatch(/^\[warn\]/)
    expect(warning).toMatch(/secret\.key\.old-\d+/)
    expect(warning).toMatch(/\.bak-rotate-\d+/)
    expect(warning).toMatch(/secret\.key\.new\.discarded-1/)
    const fresh = tempDir()
    await (await openData(resolveConfig({ cli: { dataDir: fresh } }))).close()
    expect((await run(['doctor', '--data-dir', fresh])).io.out()).not.toContain('key rotation left')
  })

  it('fails on an unsafe bind and on a key that does not match the data', async () => {
    const dir = tempDir()
    await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
    const unsafe = await run(['doctor', '--data-dir', dir, '--host', '0.0.0.0'])
    expect(unsafe.code).toBe(1)
    expect(unsafe.io.out()).toMatch(/\[fail\] Refusing to listen on 0\.0\.0\.0/)
    const wrongKey = await run(['doctor', '--data-dir', dir], {
      MM_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    })
    expect(wrongKey.code).toBe(1)
    expect(wrongKey.io.out()).toMatch(/\[fail\] The secret key does not match/)
  })

  it('reports the backup folder roots and private networks (phase 3d-3b)', async () => {
    const dir = tempDir()
    const roots = [join(dir, 'missing'), join(dir, 'ok')]
    mkdirSync(roots[1]!)
    const env = { MM_BACKUP_FOLDER_ROOTS: roots.join(delimiter), MM_BACKUP_PRIVATE_NETWORKS: '10.0.0.0/8' }
    const io = fakeIo({ env })
    // As an ordinary user, whoever runs the suite: as root, doctor judges a root for the server's user
    // (doctor: backup folder roots, run as root).
    await doctor(resolveConfig({ cli: { dataDir: join(dir, 'data') }, env }), io, { uid: 1000 })
    expect(io.out()).toMatch(/\[warn\] Backup folder root .*missing does not exist/)
    expect(io.out()).toMatch(/\[ok\] Backup folder root .*ok/)
    expect(io.out()).toMatch(/\[ok\] Destinations may reach private networks: 10\.0\.0\.0\/8/)
  })

  // Phase 3d-3b: a root inside the data directory would let a destination write next to the keys.
  it('warns when a backup folder root is inside the data directory', async () => {
    const dir = tempDir()
    const data = join(dir, 'data')
    const inside = join(data, 'exports')
    mkdirSync(inside, { recursive: true })
    const { io } = await run(['doctor', '--data-dir', data], { MM_BACKUP_FOLDER_ROOTS: inside })
    expect(io.out()).toMatch(
      /\[warn\] Backup folder root .*exports is inside the data directory; folder destinations there are refused/,
    )
    expect(io.out()).not.toMatch(/Destinations may reach private networks/)
  })

  it.skipIf(!tools)('reports a running server and mongodb-tools', async () => {
    const dir = tempDir()
    const lock = acquireInstanceLock(dir)
    try {
      const { io } = await run(['doctor', '--data-dir', dir], { MM_MONGODB_TOOLS_PATH: dirname(tools!.dump) })
      expect(io.out()).toMatch(new RegExp(`Mongo Manager is running \\(pid ${process.pid}\\)`))
      expect(io.out()).toContain(`[ok] mongodump and mongorestore ${tools!.version} found`)
    } finally {
      lock.release()
    }
  })

  // Review of the CI fixes (minor 9): what doctor finds is what the server finds — files that are
  // not tools that answer, or tools on a relative path, are not.
  it('finds mongodb-tools as the server does', async () => {
    const dir = tempDir()
    const fake = join(dir, 'tools')
    mkdirSync(fake)
    const exe = process.platform === 'win32' ? '.exe' : ''
    for (const name of ['mongodump', 'mongorestore']) writeFileSync(join(fake, name + exe), '')
    const { io } = await run(['doctor', '--data-dir', dir], { MM_MONGODB_TOOLS_PATH: fake, PATH: '' })
    // Fourth review (minor 11): there but not running is not "not found".
    expect(io.out()).toMatch(/do not run or do not say their version/)
    const none = join(dir, 'none')
    mkdirSync(none)
    const nothing = await run(['doctor', '--data-dir', dir], { MM_MONGODB_TOOLS_PATH: none, PATH: '' })
    expect(nothing.io.out()).toMatch(/\[warn\] mongodump\/mongorestore not found/)
    // Third review (minor 4): tools that do not say their version are said to be that.
    const silent = join(dir, 'silent')
    mkdirSync(silent)
    for (const name of ['mongodump', 'mongorestore'])
      if (process.platform === 'win32') copyFileSync(process.execPath, join(silent, `${name}.exe`))
      else writeFileSync(join(silent, name), '#!/bin/sh\necho hello\n', { mode: 0o755 })
    const unsaid = await run(['doctor', '--data-dir', dir], { MM_MONGODB_TOOLS_PATH: silent, PATH: '' })
    expect(unsaid.io.out()).toMatch(/do not run or do not say their version: they are not used/)
    const relative = await run(['doctor', '--data-dir', dir], { MM_MONGODB_TOOLS_PATH: 'tools', PATH: '' })
    expect(relative.io.out() + relative.io.err()).toMatch(/must be an absolute path/)
  })

  it.skipIf(process.platform === 'win32')(
    'warns when the data directory is readable by other users',
    async () => {
      const dir = tempDir()
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      chmodSync(dir, 0o755)
      const { io } = await run(['doctor', '--data-dir', dir])
      // CI 2026-10-17, its first run on Linux: the mode is in brackets, so a match on ` mode 755`
      // never fit.
      expect(io.out()).toContain(
        `[warn] Data directory ${dir} is readable by other users (mode 755); run: chmod 700 '${dir}'`,
      )
    },
  )

  // Third review of the CI fixes (I-2): a log file this user may not look at is said, and every
  // check after it still runs.
  it.skipIf(process.getuid?.() === 0)('says when it may not look at the log file, and goes on', async () => {
    const dir = tempDir()
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    const log = join(locked, 'mm.log')
    writeFileSync(log, 'line\n')
    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
    const me =
      process.platform === 'win32'
        ? execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), [
            '/user',
            '/fo',
            'csv',
            '/nh',
          ])
            .toString()
            .trim()
            .split(',')[1]!
            .replace(/"/g, '')
        : ''
    if (process.platform === 'win32') execFileSync(icacls, [locked, '/deny', `*${me}:(OI)(CI)F`])
    else chmodSync(locked, 0o000)
    try {
      const { io, code } = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', log])
      expect(io.out()).toContain(
        `[warn] Log file ${log} cannot be looked at by this user; run doctor again ` +
          (process.platform === 'win32'
            ? `from an administrator prompt, with the same options; if it is still refused, check it with: icacls "${log}"`
            : 'with sudo, with the same options'),
      )
      // The checks after it ran.
      expect(io.out()).toMatch(/Mongo Manager is not running on this data directory/)
      expect(io.err()).not.toMatch(/EPERM|EACCES/)
      expect(code).toBe(0)
    } finally {
      // The file's deny rule is inherited: taken away with the folder's (fourth review, nit 2).
      if (process.platform === 'win32') execFileSync(icacls, [locked, '/remove:d', `*${me}`])
      else chmodSync(locked, 0o700)
    }
  })

  // Fifth review of the CI fixes (minor 2): a log file the server rotates away while doctor looks at
  // it is one it makes again, not a failure.
  it('takes a log file gone while it was looked at for one made at the first start', async () => {
    const dir = tempDir()
    const log = join(dir, 'mm.log')
    writeFileSync(log, 'line\n')
    const io = { ...fakeIo(), platform: 'linux' as const }
    const gone = (path: string) => {
      if (path === log)
        throw Object.assign(new Error(`ENOENT: no such file, stat '${path}'`), { code: 'ENOENT' })
      return statSync(path)
    }
    await doctor(resolveConfig({ cli: { dataDir: join(dir, 'data'), logFile: log } }), io, { stat: gone })
    expect(io.out()).toContain(`[ok] Log file ${log} (made at the first start)\n`)
    expect(io.out()).not.toMatch(/\[fail\] Log file/)
  })

  // Fifth review (minor 5): any other reason a log file cannot be looked at (a link that leads to
  // itself on its way) is said, and every check after it runs.
  it.runIf(process.platform !== 'win32')('fails a log file whose path loops, and goes on', async () => {
    const dir = tempDir()
    symlinkSync('loop', join(dir, 'loop'))
    const log = join(dir, 'loop', 'mm.log')
    const { io } = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', log])
    expect(io.out()).toMatch(
      new RegExp(
        `\\[fail\\] Log file ${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cannot be looked at \\(ELOOP[^)]*\\); the server does not start with it\\n`,
      ),
    )
    expect(io.out()).toMatch(/Mongo Manager is not running on this data directory/)
  })

  // Fifth review (minor 4): on Windows, a log file under a drive that is not there or with a name
  // Windows does not allow cannot be made either.
  it.runIf(process.platform === 'win32')('fails a log file Windows cannot make', async () => {
    const dir = tempDir()
    const bad = join(dir, 'bad?name', 'mm.log')
    const named = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', bad])
    expect(named.io.out()).toContain(
      `[fail] Log file ${bad} cannot be made: bad?name is no name Windows allows; the server does not start with it\n`,
    )
    const reserved = join(dir, 'logs', 'con')
    const device = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', reserved])
    expect(device.io.out()).toContain(
      `[fail] Log file ${reserved} cannot be made: con is no name Windows allows`,
    )
    const drive = 'QRSTUVWXYZ'.split('').find((l) => !existsSync(`${l}:\\`))
    if (drive) {
      const far = `${drive}:\\logs\\mm.log`
      const away = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', far])
      expect(away.io.out()).toContain(`[fail] Log file ${far} cannot be made: ${drive}:\\ does not exist`)
    }
  })

  // Fourth review of the CI fixes (minor 1): a log file whose folder cannot be made (a file is where
  // a folder of its path should be) is said as that, and every check after it runs.
  it('fails a log file whose folder cannot be made, and goes on', async () => {
    const dir = tempDir()
    const file = join(dir, 'afile')
    writeFileSync(file, 'x')
    const log = join(file, 'logs', 'mm.log')
    const { io } = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', log])
    expect(io.out()).toContain(
      `[fail] Log file ${log} cannot be made: ${file} is not a folder; the server does not start with it\n`,
    )
    expect(io.out()).not.toMatch(/made at the first start/)
    expect(io.out()).toMatch(/Mongo Manager is not running on this data directory/)
  })

  // Second review of the CI fixes (I-B): a log file the server refuses is said as that, never given a
  // chmod that would change what a link points at.
  it('fails a log file that is a link or has other names, as the server refuses it', async () => {
    const dir = tempDir()
    const target = join(dir, 'passwd')
    writeFileSync(target, 'root:x:0:0\n')
    if (process.platform !== 'win32') chmodSync(target, 0o644)
    const hard = join(dir, 'hard.log')
    linkSync(target, hard)
    const named = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', hard])
    expect(named.io.out()).toMatch(
      /\[fail\] Log file .*hard\.log has other names \(hard links\): .*; the server does not start with it\n/,
    )
    expect(named.io.out()).not.toMatch(/chmod 600|icacls ".*hard\.log"/)
    const link = join(dir, 'link.log')
    try {
      symlinkSync(target, link)
    } catch {
      return // No links without a privilege on this Windows.
    }
    const linked = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', link])
    expect(linked.io.out()).toMatch(
      /\[fail\] Log file .*link\.log is a link: .*; the server does not start with it\n/,
    )
    expect(linked.io.out()).not.toMatch(/chmod 600/)
  })
})

// Phase 3d-3b final review B18: doctor checks what a folder destination will meet at its first use.
describe('doctor: backup folder roots', () => {
  it('warns when a root is not a writable directory', async () => {
    const dir = tempDir()
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    const { io } = await run(['doctor', '--data-dir', join(dir, 'data')], { MM_BACKUP_FOLDER_ROOTS: file })
    expect(io.out()).toMatch(/\[warn\] Backup folder root .*a-file is not a writable directory/)
  })

  // Root writes through a mode that forbids it (a container's user): no warning is then right.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'warns when the server cannot write into a root',
    async () => {
      const dir = tempDir()
      const root = join(dir, 'locked')
      mkdirSync(root)
      chmodSync(root, 0o500)
      const { io } = await run(['doctor', '--data-dir', join(dir, 'data')], { MM_BACKUP_FOLDER_ROOTS: root })
      chmodSync(root, 0o700)
      expect(io.out()).toMatch(/\[warn\] Backup folder root .*locked is not a writable directory/)
    },
  )

  it('sees through a link or junction to a root inside the data directory', async () => {
    const dir = tempDir()
    const data = join(dir, 'data')
    const inside = join(data, 'exports')
    mkdirSync(inside, { recursive: true })
    const link = join(dir, 'looks-outside')
    symlinkSync(inside, link, 'junction')
    const { io } = await run(['doctor', '--data-dir', data], { MM_BACKUP_FOLDER_ROOTS: link })
    expect(io.out()).toMatch(/\[warn\] Backup folder root .*looks-outside is inside the data directory/)
  })

  it('warns about a root that is not an absolute path', async () => {
    const dir = tempDir()
    const config = resolveConfig({ cli: { dataDir: join(dir, 'data') } })
    const io = fakeIo()
    await doctor({ ...config, backup: { ...config.backup, folderRoots: ['relative/exports'] } }, io)
    expect(io.out()).toMatch(/\[warn\] Backup folder root relative\/exports is not an absolute path/)
  })

  // Review 2026-10-17 (note): `sudo mongo-manager doctor` for a service install checked write access
  // as root, which writes anywhere, and said ok for a root the service's own user cannot write into.
  // That user owns the data directory: the root is checked for it, by owner, group and mode.
  describe('run as root on Linux and macOS', () => {
    function setup() {
      const dir = tempDir()
      const data = join(dir, 'data')
      const root = join(dir, 'exports')
      mkdirSync(data)
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: data } })
      return { data, root, config: { ...config, backup: { ...config.backup, folderRoots: [root] } } }
    }
    /** Owners and modes as a POSIX system reports them; any other path: the server's user, 700. */
    const owned =
      (paths: Record<string, { uid: number; gid: number; mode: number }>) =>
      (path: string): { uid: number; gid: number; mode: number } =>
        paths[path] ?? { uid: 1000, gid: 1000, mode: 0o40700 }
    const asRoot = async (config: Config, stat: ReturnType<typeof owned>) => {
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(config, io, { uid: 0, stat })
      return io.out()
    }

    it("warns of a root the data directory's owner cannot write into, and says how to check", async () => {
      const { data, root, config } = setup()
      const out = await asRoot(
        config,
        owned({ [data]: { uid: 1000, gid: 1000, mode: 0o40700 }, [root]: { uid: 0, gid: 0, mode: 0o40755 } }),
      )
      expect(out).toContain(
        `[warn] Backup folder root ${root} may not be writable by the server's user (uid 1000, who owns ` +
          `the data directory); check with: sudo -u '#1000' test -w '${root}' && echo writable\n`,
      )
      expect(out).not.toContain(`[ok] Backup folder root ${root}`)
    })

    // Third review 2026-10-17 (minor 8): the owner's bits decide for the owner, whatever the others'.
    it('warns of a root its owner, the server, may not write into though everyone else may', async () => {
      const { data, root, config } = setup()
      const out = await asRoot(
        config,
        owned({
          [data]: { uid: 1000, gid: 1000, mode: 0o40700 },
          [root]: { uid: 1000, gid: 1000, mode: 0o40577 },
        }),
      )
      expect(out).toContain(`[warn] Backup folder root ${root} may not be writable by the server's user`)
    })

    it.each([
      ['the owner', { uid: 1000, gid: 0, mode: 0o40700 }],
      ['the group', { uid: 0, gid: 1000, mode: 0o40770 }],
      ['everyone', { uid: 0, gid: 0, mode: 0o40777 }],
    ])('vouches for a root its user may write into as %s', async (_, rootStat) => {
      const { data, root, config } = setup()
      const out = await asRoot(
        config,
        owned({ [data]: { uid: 1000, gid: 1000, mode: 0o40700 }, [root]: rootStat }),
      )
      expect(out).toContain(`[ok] Backup folder root ${root}\n`)
    })

    it('vouches for a root when root owns the data directory (the server runs as root, and writes anywhere)', async () => {
      const { data, root, config } = setup()
      const out = await asRoot(
        config,
        owned({ [data]: { uid: 0, gid: 0, mode: 0o40700 }, [root]: { uid: 1000, gid: 1000, mode: 0o40700 } }),
      )
      expect(out).toContain(`[ok] Backup folder root ${root}\n`)
    })

    it("asks for a check by hand before a data directory names the server's user", async () => {
      const { root, config } = setup()
      const out = await asRoot({ ...config, dataDir: join(config.dataDir, 'not-yet') }, owned({}))
      expect(out).toContain(
        `[warn] Backup folder root ${root}: doctor runs as root, which writes anywhere, and no data ` +
          `directory names the server's user yet; check with: sudo -u SERVER_USER test -w '${root}'\n`,
      )
    })

    // Final review 2026-10-17 (minor 3): a data directory open to others (a bind mount the image's
    // uid 10001 uses) does not name the server's user, as for the files in it.
    it.each([
      ['open to others', { uid: 1000, gid: 1000, mode: 0o40777 }],
      ['open to its group', { uid: 1000, gid: 1000, mode: 0o40750 }],
    ])('asks for a check by hand when the data directory is %s', async (_, dataStat) => {
      const { data, root, config } = setup()
      const out = await asRoot(config, owned({ [data]: dataStat, [root]: { uid: 0, gid: 0, mode: 0o40755 } }))
      expect(out).toContain(
        `[warn] Backup folder root ${root}: doctor runs as root, which writes anywhere, and the data ` +
          "directory, open to others, does not name the server's user; check with: sudo -u SERVER_USER " +
          `test -w '${root}'\n`,
      )
    })

    // Review 2026-10-17 (second, minor 4): Windows has no root; uid 0 there means nothing.
    it('leaves Windows alone', async () => {
      const { root, config } = setup()
      const io = { ...fakeIo(), platform: 'win32' as const }
      await doctor(config, io, { uid: 0, stat: owned({}), sys: fakeSys('win32') })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })
  })

  // Third review 2026-10-17 (important): the systemd unit lets the service write where it is told
  // alone, and doctor, outside that sandbox, said ok for a root the service met as read-only.
  describe("the systemd service's sandbox", () => {
    const SHOW = /^systemctl show mongo-manager -p ReadWritePaths --value$/
    function service(paths: string, status = 0) {
      const sys = fakeSys('linux')
      sys.files.set('/etc/systemd/system/mongo-manager.service', { content: '', mode: 0o644 })
      sys.responses.push({ match: SHOW, status, stdout: `${paths}\n` })
      return sys
    }
    /** Every folder root's, 755, but those given: as a POSIX system would report them. */
    const rootOwned =
      (paths: Record<string, { uid: number; gid: number; mode: number }> = {}) =>
      (path: string) =>
        paths[path] ?? { uid: 0, gid: 0, mode: 0o40755 }
    async function check(sys: ReturnType<typeof fakeSys>, dataDir = '/var/lib/mongo-manager') {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
      })
      return { root, out: io.out() }
    }

    it('warns of a root outside it, and says how to let the service in', async () => {
      const { root, out } = await check(service('/var/lib/mongo-manager -/srv/other'))
      expect(out).toContain(
        `[warn] Backup folder root ${root} is outside the systemd service's sandbox, which lets it write ` +
          "into its data directory and the folder roots it was installed with: run 'mongo-manager service " +
          "install' again with sudo (it adds the roots it finds in the service's config and env file)\n",
      )
      expect(out).not.toContain(`[ok] Backup folder root ${root}`)
    })

    // Final review 2026-10-17 (minor 2): install never adds such a root, so it says how to by hand.
    it('says to add by hand a root outside it with a space in its name', async () => {
      const root = join(tempDir(), 'my exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys: service('/var/lib/mongo-manager'),
        unreachable: () => null,
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${root} is outside the systemd service's sandbox, and service install ` +
          'cannot add it (a space, quote, backslash or % in it): add it with: sudo systemctl edit ' +
          `mongo-manager, as ReadWritePaths=-"${realpathSync(root).split(sep).join('/')}" in [Service]\n`,
      )
    })

    it('vouches for a root inside it', async () => {
      const sys = fakeSys('linux')
      sys.files.set('/etc/systemd/system/mongo-manager.service', { content: '', mode: 0o644 })
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      sys.responses.push({ match: SHOW, status: 0, stdout: `/var/lib/mongo-manager -${root}\n` })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })

    // Final re-review 2026-10-18 (minor 2): what install warned of, doctor says after it too.
    it('warns of a folder above a root inside it that a user other than root may change', async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const parent = dirname(root).split(sep).join('/')
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${root}`),
        unreachable: () => null,
        stat: rootOwned({ [parent]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(
        `[warn] ${parent}, above the folder root ${root}, can be changed by a user other than root`,
      )
    })

    // Last review 2026-10-18 (minor 4): a root not made yet, judged as install judges it.
    it.skipIf(process.platform === 'win32')(
      'warns of a folder above a root not made yet that a user other than root may change',
      async () => {
        const parent = tempDir()
        const root = join(parent, 'not-yet')
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
          uid: 1000,
          sys: service(`/var/lib/mongo-manager -${root}`),
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(parent)]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
        })
        expect(io.out()).toContain(`[warn] Backup folder root ${root} does not exist\n`)
        expect(io.out()).toContain(
          `[warn] ${realpathSync(parent)}, above the folder root ${root}, can be changed`,
        )
      },
    )

    // Last review 2026-10-18 (minor 6): judged where a link above it leads, as systemd follows it.
    it.skipIf(process.platform === 'win32')(
      'warns of a folder a link above a root not made yet leads to',
      async () => {
        const target = tempDir()
        const link = join(tempDir(), 'to-target')
        symlinkSync(target, link)
        const root = join(link, 'not-yet')
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
          uid: 1000,
          sys: service(`/var/lib/mongo-manager -${join(realpathSync(target), 'not-yet')}`),
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(target)]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
        })
        expect(io.out()).toContain(
          `[warn] ${realpathSync(target)}, above the folder root ${root}, can be changed`,
        )
      },
    )

    // Last review 2026-10-18 (minor 2): systemd makes no root writable the unit does not name.
    it.skipIf(process.platform === 'win32')(
      'says nothing of the folders above a root not made yet that the unit does not name',
      async () => {
        const parent = tempDir()
        const root = join(parent, 'not-yet')
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
          uid: 1000,
          sys: service('/var/lib/mongo-manager'),
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(parent)]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
        })
        expect(io.out()).toContain(`[warn] Backup folder root ${root} does not exist\n`)
        expect(io.out()).not.toContain('can be changed')
      },
    )

    // Last review 2026-10-18 (important): systemd follows a link to nothing yet wherever whoever makes
    // that folder points it, /etc included.
    it.skipIf(process.platform === 'win32')('warns of a root that is a link to nothing yet', async () => {
      const dir = tempDir()
      const link = join(dir, 'later')
      symlinkSync(join(dir, 'missing'), link)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [link] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${link}`),
        unreachable: () => null,
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${link}: ${link} is a link that leads nowhere (to a folder not made ` +
          'yet), which systemd follows wherever it leads at each start, and the unit ' +
          "names it: run 'mongo-manager service install' again with sudo now, to leave it out\n",
      )
      expect(io.out()).not.toContain(`Backup folder root ${link} does not exist`)
      expect(io.out()).not.toContain('The systemd service may write into')
    })

    // Last review 2026-10-18 (minor 3): what the unit lets the service write into, whatever the config.
    it('warns of a folder the unit names that is no root in the config, and of the folders above it', async () => {
      const parent = tempDir()
      const stale = join(parent, 'stale')
      mkdirSync(stale)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      const sys = service(`/var/lib/mongo-manager -${stale}`)
      sys.files.set('/etc/mongo-manager/config.json', { content: '{}', mode: 0o640 })
      await doctor(config, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({ [parent.split(sep).join('/')]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(
        `[warn] The systemd service may write into ${stale}, which no folder root leads to now (one ` +
          'removed since, a link that leads elsewhere now, or one added with systemctl edit): run ' +
          "'mongo-manager service install' again with sudo; if the unit still names it, drop it with: sudo " +
          'systemctl edit mongo-manager\n',
      )
      expect(io.out()).toContain(
        `[warn] ${parent.split(sep).join('/')}, above the unit entry ${stale}, can be changed`,
      )
    })

    // Fourth review 2026-10-17 (important 2): systemd drops a ReadWritePaths entry it hides, without a word.
    it('warns of a root the sandbox hides, though the unit names it', async () => {
      const sys = service('/var/lib/mongo-manager -/home/me/backups')
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: ['/home/me/backups'] } }, io, {
        uid: 1000,
        sys,
      })
      expect(io.out()).toContain(
        "[warn] Backup folder root /home/me/backups is out of the systemd service's reach: systemd hides " +
          // Final re-review (minor 1): and the unit names it.
          '/home from the service (ProtectHome=yes). The unit names it all the same: to leave it out, ' +
          "run 'mongo-manager service install' again with sudo; if the unit still names it, drop it with: " +
          'sudo systemctl edit mongo-manager\n',
      )
    })

    // Fourth review 2026-10-17 (minor 5): systemd follows a link, and so must the comparison.
    // Fifth review 2026-10-17 (important): judged where it leads, as systemd follows it.
    // Not on macOS, where /etc is a link itself (to /private/etc).
    it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
      'warns of a root that links to a system directory',
      async () => {
        const link = join(tempDir(), 'to-etc')
        symlinkSync('/etc', link)
        const sys = service(`/var/lib/mongo-manager -${link}`)
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [link] } }, io, { uid: 1000, sys })
        expect(io.out()).toContain(
          `[warn] Backup folder root ${link} is out of the systemd service's reach: it leads to /etc; it holds /etc, ` +
            '/etc/mongo-manager: letting the service write there would undo its sandbox. The unit names it all ' +
            'the same',
        )
      },
    )

    it('warns of a link in it that leads out of it', async () => {
      const dir = tempDir()
      const inside = join(dir, 'allowed')
      const outside = join(dir, 'elsewhere')
      mkdirSync(inside)
      mkdirSync(outside)
      const link = join(inside, 'link')
      symlinkSync(outside, link, 'junction')
      const sys = service(`/var/lib/mongo-manager -${inside}`)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [link] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
      })
      expect(io.out()).toContain(`[warn] Backup folder root ${link} is outside the systemd service's sandbox`)
    })

    // Re-review 2026-10-18 (minor 11): a link round in a loop leads nowhere either.
    it.skipIf(process.platform === 'win32')(
      'warns of a root above which a link leads nowhere, and says what to do',
      async () => {
        const dir = tempDir()
        const loop = join(dir, 'loop')
        symlinkSync(loop, loop)
        const root = join(loop, 'exports')
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        // Who runs the service is known, so who may point the link is judged.
        const sys = service('/var/lib/mongo-manager')
        sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
        })
        expect(io.out()).toContain(
          `[warn] Backup folder root ${root}: ${loop} is a link that leads nowhere (round in a loop), ` +
            // Re-re-re-review (minor 1): a loop is no folder to make.
            'which systemd follows wherever it leads at each start: choose ' +
            'another folder, or remove the link\n',
        )
      },
    )

    // Re-review 2026-10-18 (minor 9): a '..' is judged as written first, as install judges it.
    it.skipIf(process.platform === 'win32')("judges a root with a '..' by that first", async () => {
      const dir = tempDir()
      symlinkSync(join(dir, 'missing'), join(dir, 'later'))
      const root = `${dir}/x/../later`
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${root}`),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${root} is out of the systemd service's reach: it has a '..' in it`,
      )
      expect(io.out()).not.toContain('leads nowhere')
    })

    // Re-review 2026-10-18 (minor 2): what an earlier install, or systemctl edit, put in the unit.
    it.skipIf(process.platform === 'win32')('warns of a link to nothing yet the unit names', async () => {
      const dir = tempDir()
      const link = join(dir, 'later')
      symlinkSync(join(dir, 'missing'), link)
      const io = { ...fakeIo(), platform: 'linux' as const }
      const sys = service(`/var/lib/mongo-manager -${link}`)
      sys.files.set('/etc/mongo-manager/config.json', { content: '{}', mode: 0o640 })
      await doctor(resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } }), io, { uid: 1000, sys })
      expect(io.out()).toContain(
        `[warn] The systemd service's unit names ${link}: ${link} is a link that leads nowhere (to a ` +
          'folder not made yet), which systemd follows wherever it leads at each ' +
          "start; run 'mongo-manager service install' again with sudo; if the unit still names it, drop it " +
          'with: sudo systemctl edit mongo-manager\n',
      )
    })

    // Re-review 2026-10-18 (important 1): the service takes its roots from its env file, when it sets
    // them, as install does; sudo drops the variable from doctor's own.
    it.skipIf(process.platform === 'win32')(
      "checks the roots the service's env file names, in place of those doctor was given",
      async () => {
        const root = join(tempDir(), 'exports')
        mkdirSync(root)
        const given = join(tempDir(), 'given')
        mkdirSync(given)
        const sys = service(`/var/lib/mongo-manager -${root}`)
        sys.files.set('/etc/mongo-manager/env', {
          content: `MM_SECRET_KEY=x\nMM_BACKUP_FOLDER_ROOTS=${root}\n`,
          mode: 0o600,
        })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [given] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
          stat: rootOwned(),
        })
        expect(io.out()).toContain(
          `[warn] The systemd service uses the folder roots its config and env file name (${root}), not ` +
            `those doctor was given (${given}); doctor checks the service's\n`,
        )
        expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
        expect(io.out()).not.toContain(`Backup folder root ${given}`)
        expect(io.out()).not.toContain('The systemd service may write into')
      },
    )

    it("says when it cannot read the service's env file, and checks the roots it was given", async () => {
      const sys = service('/var/lib/mongo-manager -/srv/other')
      sys.files.set('/etc/mongo-manager/env', { content: '', mode: 0o600 })
      const read = sys.read
      sys.read = (p) => {
        if (p === '/etc/mongo-manager/env') throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' })
        return read(p)
      }
      const { root, out } = await check(sys)
      expect(out).toContain(
        "[warn] The systemd service's env file /etc/mongo-manager/env cannot be read by this user: run " +
          'doctor again with sudo to check the folder roots the service uses, and what else its unit lets ' +
          'it write into\n',
      )
      expect(out).toContain(`Backup folder root ${root} is outside the systemd service's sandbox`)
      expect(out).not.toContain('The systemd service may write into')
    })

    // Re-review 2026-10-18 (minor 1): systemctl show parts names at spaces; a root added by hand has one.
    it('reads a path with a space in it from the sandbox as one', async () => {
      const root = join(tempDir(), 'my exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${root}`),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
      expect(io.out()).not.toContain('The systemd service may write into')
    })

    // Re-review 2026-10-18 (important 2): the service itself could put a link in a folder's place there.
    // Third review (important 1, minors 3 and 8): every folder up to /, the unit's User= as systemd
    // shows it (a drop-in's included), and a root the unit does not name too.
    const USER = /^systemctl show mongo-manager -p User -p Group -p SupplementaryGroups -p DynamicUser$/
    it.each([
      ['the unit names', true],
      ['the unit does not name', false],
    ])("warns of a root %s below a folder the service's user may change", async (_, inUnit) => {
      const root = join(tempDir(), 'team', 'exports')
      mkdirSync(root, { recursive: true })
      const team = dirname(root).split(sep).join('/')
      const top = dirname(dirname(root)).split(sep).join('/')
      const sys = service(inUnit ? `/var/lib/mongo-manager -${root}` : '/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({
          [top]: { uid: 999, gid: 999, mode: 0o40755 },
          [team]: { uid: 1000, gid: 1000, mode: 0o40755 },
        }),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${root}: ${top}, above it, is owned by the service's user: a process ` +
          "running as that user could put a link to any folder in a folder's place there, and systemd " +
          'would make that writable to the service at its next start; ' +
          (inUnit
            ? "the unit names it: run 'mongo-manager service install' again with sudo now, which leaves it " +
              'out, and to use it, '
            : 'service install leaves such a root out: to use it, ') +
          'put the root inside a folder owned by root that no other user may write into\n',
      )
    })

    it("knows the service's user by the groups id gives it", async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const parent = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      sys.responses.push({ match: /^id -G mongo-manager$/, status: 0, stdout: '999 34\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({ [parent]: { uid: 0, gid: 34, mode: 0o42775 } }),
      })
      expect(io.out()).toContain(`${parent}, above it, may be written into by the service's user`)
    })

    // Fourth review (important 2): a root install leaves out takes in no root inside it.
    it('judges a root inside one install leaves out as its own', async () => {
      const outer = tempDir()
      const root = join(outer, 'team', 'backups')
      mkdirSync(root, { recursive: true })
      const team = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, root] } }, io, {
        uid: 1000,
        sys,
        unreachable: (r) => (r === outer ? 'it is refused here' : null),
        stat: rootOwned({ [team]: { uid: 999, gid: 999, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(`[warn] Backup folder root ${root}: ${team}, above it, is owned by`)
      expect(io.out()).not.toContain(`${root} is inside the folder root`)
    })

    // Fourth review (minor 6, minor 7): run as root, the kernel says what the service's user may change.
    it('asks the kernel, run as root, what the service may write into', async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const parent = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      sys.responses.push({ match: /^setpriv --reuid=999 --regid=999 --groups=999 -- true$/, status: 0 })
      sys.responses.push({
        match: new RegExp(
          `^setpriv --reuid=999 --regid=999 --groups=999 -- test -w ${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        ),
        status: 0,
      })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 0,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`${parent}, above it, may be written into by the service's user`)
    })

    // Fourth review (minor 5): one inside a root the sandbox does not take in yet.
    it('says of a root inside one the sandbox does not take in where to look', async () => {
      const outer = tempDir()
      const inner = join(outer, 'daily')
      mkdirSync(inner)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
        uid: 1000,
        sys: service('/var/lib/mongo-manager'),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${inner} is inside the folder root ${outer}, which the systemd ` +
          `service's sandbox does not take in: see what is said of ${outer}\n`,
      )
      expect(io.out()).toContain(
        `[warn] Backup folder root ${outer} is outside the systemd service's sandbox`,
      )
    })

    // Whole-branch review (important 3): no User= runs the service as root, which install stops for.
    it('says the service runs as root when its unit names no User=', async () => {
      const { out } = await check(service('/var/lib/mongo-manager'))
      expect(out).toContain(
        '[warn] The systemd service runs as root: its unit, with its drop-ins, names no User=, and service ' +
          'install stops for that; remove the empty User= with: sudo systemctl edit mongo-manager\n',
      )
      expect(out).not.toContain('could not be determined')
    })

    // Whole-branch re-review (important 1): a link in a link's target is on the way, for doctor too.
    it.skipIf(process.platform === 'win32')(
      'warns of a root behind a link in a link the service may point',
      async () => {
        const outer = tempDir()
        const target = tempDir()
        symlinkSync(target, join(outer, 'daily'))
        const root = join(tempDir(), 'daily')
        symlinkSync(join(outer, 'daily'), root)
        const sys = service(`/var/lib/mongo-manager -${outer} -${realpathSync(target)}`)
        sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, root] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(outer)]: { uid: 999, gid: 999, mode: 0o40700 } }),
        })
        expect(io.out()).toContain(
          `[warn] Backup folder root ${root}: ${realpathSync(outer)}, above it, is owned by the service's user`,
        )
      },
    )

    // Whole-branch re-re-review (minor 3): doctor takes '..' after a link as the kernel and install do.
    it.skipIf(process.platform === 'win32')("takes '..' after a link as the kernel does", async () => {
      const dir = realpathSync(tempDir())
      mkdirSync(join(dir, 'deep', 'a'), { recursive: true })
      mkdirSync(join(dir, 'deep', 'x'))
      symlinkSync(join(dir, 'deep', 'a'), join(dir, 'sub'))
      const root = join(dir, 'dd')
      symlinkSync('sub/../x', root)
      const sys = service(`/var/lib/mongo-manager -${join(dir, 'deep', 'x')}`)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).not.toContain(`Backup folder root ${root} is outside the systemd service's sandbox`)
      // Whole-branch re-re-re-review (minor 4): judged in it, as install judges it.
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })

    // Whole-branch re-re-review (minor 4): with no one to judge for, no advice to make the folder.
    it.skipIf(process.platform === 'win32')(
      'does not say to make where a link leads when it cannot judge who may point it',
      async () => {
        const dir = tempDir()
        const link = join(dir, 'later')
        symlinkSync(join(dir, 'missing'), link)
        const sys = service('/var/lib/mongo-manager')
        sys.responses.push({ match: USER, status: 1 })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [link] } }, io, { uid: 1000, sys })
        expect(io.out()).toContain('who may point it elsewhere could not be judged')
        expect(io.out()).not.toContain('make the folder it leads to')
      },
    )

    // Final review (minor 5): a file system of the test's own, for doctor to walk. Paths not given are
    // root's folders; a null one is nothing there; links lead where given; a function value is asked
    // at each read.
    type Entry = { uid: number; gid?: number; mode: number }
    const fsOf = (
      tree: Record<string, Entry | null | (() => Entry)>,
      links: Record<string, string | (() => string)> = {},
    ) => ({
      lstat: (p: string) => {
        if (!(p in tree)) return { uid: 0, gid: 0, mode: 0o40755 }
        const e = tree[p]
        // null: nothing there.
        return typeof e === 'function' ? e() : (e ?? null)
      },
      readlink: (p: string) => {
        const t = links[p]
        if (t === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
        return typeof t === 'function' ? t() : t
      },
    })
    const LINK = (uid = 0) => ({ uid, gid: uid, mode: 0o120777 })
    const withUser = (stdout = 'User=mongo-manager\n') => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout })
      return sys
    }
    async function walkDoctor(
      roots: string[],
      fs: ReturnType<typeof fsOf>,
      sys = withUser(),
      // null: doctor's own refusals (54a541b1 review, minor 2).
      unreachable: ((root: string) => string | null) | null = () => null,
    ) {
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: roots } }, io, {
        uid: 1000,
        sys,
        ...(unreachable ? { unreachable } : {}),
        fs,
      })
      return io.out()
    }
    // The service's own roots, and what its unit names (final re-review, minor 6).
    const unitOf = (roots: string[], entries: string) => {
      const sys = withUser()
      sys.files.set('/etc/mongo-manager/config.json', {
        content: JSON.stringify({ backup: { folderRoots: roots } }),
        mode: 0o640,
      })
      sys.responses.unshift({
        match: /^systemctl show mongo-manager -p ReadWritePaths --value$/,
        status: 0,
        stdout: `/var/lib/mongo-manager ${entries}\n`,
      })
      return sys
    }
    const STALE =
      "run 'mongo-manager service install' again with sudo; if the unit still names it, drop it with: sudo " +
      'systemctl edit mongo-manager'

    // Whole-branch re-re-re-review (important 1): one walk a root, whatever the file system says after.
    it.skipIf(process.platform === 'win32')(
      'judges a root by one walk, though the folder turns into a link after it',
      async () => {
        let reads = 0
        const fs = fsOf(
          {
            '/srv/grp': { uid: 0, gid: 999, mode: 0o41770 },
            // A folder of the service's at the walk, its link to a root-owned folder at every read after.
            '/srv/grp/svc': () => (reads++ === 0 ? { uid: 999, gid: 999, mode: 0o40755 } : LINK(999)),
          },
          { '/srv/grp/svc': '/srv/rootdir' },
        )
        const out = await walkDoctor(['/srv/grp/svc/backups'], fs)
        expect(out).toContain('[warn] Backup folder root /srv/grp/svc/backups: /srv/grp/svc')
        expect(out).not.toContain('[ok] Backup folder root /srv/grp/svc/backups')
      },
    )

    // Final review (important 1): a unit entry that leads to a root's folder through a link the
    // service's user may change is judged by that link.
    it.skipIf(process.platform === 'win32')(
      'warns of a unit entry that leads to a root through a link the service may point',
      async () => {
        const fs = fsOf(
          { '/srv/grp': { uid: 0, gid: 999, mode: 0o41770 }, '/srv/grp/svclink': LINK(999) },
          { '/srv/grp/svclink': '/srv/rootdir' },
        )
        const sys = withUser()
        sys.files.set('/etc/mongo-manager/config.json', {
          content: '{"backup":{"folderRoots":["/srv/rootdir/backups"]}}',
          mode: 0o640,
        })
        sys.responses.unshift({
          match: /^systemctl show mongo-manager -p ReadWritePaths --value$/,
          status: 0,
          stdout: '/var/lib/mongo-manager -/srv/rootdir/backups -/srv/grp/svclink/backups\n',
        })
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain(
          "[warn] The systemd service's unit entry /srv/grp/svclink/backups leads to a folder root through " +
            "links: /srv/grp, above it, is sticky, but /srv/grp/svclink in it is the service's user's",
        )
        expect(out).toContain(`; to leave the entry out, ${STALE}\n`)
        // Final re-review (minor 6): judged as that, not as one no root leads to.
        expect(out).not.toContain('which no folder root leads to now')
      },
    )

    // Final re-review (minor 3): one that leads to the data directory is said to.
    it.skipIf(process.platform === 'win32')(
      'warns of a unit entry that leads to the data directory through a link the service may point',
      async () => {
        const fs = fsOf(
          { '/srv/grp': { uid: 0, gid: 999, mode: 0o41770 }, '/srv/grp/svclink': LINK(999) },
          { '/srv/grp/svclink': '/var/lib/mongo-manager' },
        )
        const sys = unitOf(['/srv/rootdir/backups'], '-/srv/rootdir/backups -/srv/grp/svclink')
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain(
          "[warn] The systemd service's unit entry /srv/grp/svclink leads to the data directory through links: " +
            '/srv/grp, above it,',
        )
      },
    )

    // Final re-review (minor 4): a link on an entry's way someone other than root may change.
    it.skipIf(process.platform === 'win32')(
      'warns of a unit entry that leads to a root through a link another user may change, and what to do',
      async () => {
        const fs = fsOf(
          { '/srv/other': { uid: 1234, gid: 1234, mode: 0o40755 }, '/srv/other/l': LINK(1234) },
          { '/srv/other/l': '/srv/rootdir' },
        )
        const sys = unitOf(['/srv/rootdir/backups'], '-/srv/rootdir/backups -/srv/other/l/backups')
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain(
          '[warn] /srv/other, above the unit entry /srv/other/l/backups, can be changed by a user other than root',
        )
        expect(out).toContain(`inside that one. To leave the entry out, ${STALE}.\n`)
        expect(out).not.toContain('which no folder root leads to now')
      },
    )

    // Final re-review (minor 2): a root the unit names by its own name is said of once.
    it.skipIf(process.platform === 'win32')(
      'says of a root the unit names through a link the service may point once, as a root',
      async () => {
        const fs = fsOf(
          { '/srv/grp': { uid: 0, gid: 999, mode: 0o41770 }, '/srv/grp/svclink': LINK(999) },
          { '/srv/grp/svclink': '/srv/rootdir' },
        )
        const sys = unitOf(['/srv/grp/svclink/backups'], '-/srv/grp/svclink/backups')
        const out = await walkDoctor(['/srv/grp/svclink/backups'], fs, sys)
        expect(out).toContain('[warn] Backup folder root /srv/grp/svclink/backups: /srv/grp, above it,')
        expect(out).not.toContain('unit entry /srv/grp/svclink/backups')
      },
    )

    // Final re-review (minor 1): a refused root added by hand is in the unit all the same.
    it.skipIf(process.platform === 'win32')(
      'says of a refused root the unit names that the unit lets the service write there',
      async () => {
        const sys = unitOf(['/srv'], '-/srv')
        const out = await walkDoctor(['/srv'], fsOf({}), sys, (r) =>
          r === '/srv' ? 'it holds /srv/app' : null,
        )
        expect(out).toContain(
          "[warn] Backup folder root /srv is out of the systemd service's reach: it holds /srv/app. The unit " +
            `names it all the same: to leave it out, ${STALE}\n`,
        )
        expect(out).not.toContain('which no folder root leads to now')
      },
    )

    // Final re-re-re-review (minor 1): another root that keeps the folder only if usable itself.
    it.skipIf(process.platform === 'win32')(
      'tells to leave out a refused root whose folder another root leads to that is refused or changeable',
      async () => {
        const hidden = (r: string) =>
          r.startsWith('/home') ? 'systemd hides /home from the service (ProtectHome=yes)' : null
        const advice = (root: string) =>
          `[warn] Backup folder root ${root} is out of the systemd service's reach: systemd hides /home from ` +
          `the service (ProtectHome=yes). The unit names it all the same: to leave it out, ${STALE}\n`
        const changeableFs = fsOf(
          { '/home/u/link': LINK(0), '/srv/svc': { uid: 999, gid: 999, mode: 0o40755 } },
          { '/home/u/link': '/srv/svc/b' },
        )
        const one = await walkDoctor(
          ['/srv/svc/b', '/home/u/link'],
          changeableFs,
          unitOf(['/srv/svc/b', '/home/u/link'], '-/srv/svc/b'),
          hidden,
        )
        expect(one).toContain(advice('/home/u/link'))
        const refusedFs = fsOf(
          { '/home/u/link': LINK(0), '/home/u/l2': LINK(0) },
          { '/home/u/link': '/srv/b', '/home/u/l2': '/srv/b' },
        )
        const two = await walkDoctor(
          ['/home/u/l2', '/home/u/link'],
          refusedFs,
          unitOf(['/home/u/l2', '/home/u/link'], '-/srv/b'),
          hidden,
        )
        expect(two).toContain(advice('/home/u/l2'))
        expect(two).toContain(advice('/home/u/link'))
      },
    )

    // f45efa13 review (minor 2): an entry another root keeps is not to be left out by install.
    it.skipIf(process.platform === 'win32')(
      'does not tell install to leave out the entry of a link root another root keeps',
      async () => {
        const dangling = await walkDoctor(
          ['/srv/missing', '/srv/l'],
          fsOf({ '/srv/l': LINK(0), '/srv/missing': null }, { '/srv/l': '/srv/missing' }),
          unitOf(['/srv/missing', '/srv/l'], '-/srv/missing'),
        )
        expect(dangling).toContain(
          '[warn] Backup folder root /srv/l: /srv/l is a link that leads nowhere (to a folder not made yet), ' +
            "which systemd follows wherever it leads at each start: make the folder it leads to, then run 'mongo-" +
            "manager service install' again with sudo\n",
        )
        const changeable = await walkDoctor(
          ['/srv/b', '/srv/svc/l'],
          fsOf(
            { '/srv/svc': { uid: 999, gid: 999, mode: 0o40755 }, '/srv/svc/l': LINK(999) },
            { '/srv/svc/l': '/srv/b' },
          ),
          unitOf(['/srv/b', '/srv/svc/l'], '-/srv/b'),
        )
        expect(changeable).toMatch(
          /Backup folder root \/srv\/svc\/l: [^\n]*; service install leaves such a root out: to use it,/,
        )
        expect(changeable).not.toContain('which leaves it out')
      },
    )

    // 54a541b1 review (minor 2): two links to one folder not made yet, each refused, keep neither's entry.
    it.skipIf(process.platform === 'win32')(
      "tells install to leave out the entry two links to nothing name, by doctor's own refusals",
      async () => {
        const out = await walkDoctor(
          ['/srv/l1', '/srv/l2'],
          fsOf(
            { '/srv/l1': LINK(0), '/srv/l2': LINK(0), '/srv/missing': null },
            { '/srv/l1': '/srv/missing', '/srv/l2': '/srv/missing' },
          ),
          unitOf(['/srv/l1', '/srv/l2'], '-/srv/missing'),
          null,
        )
        for (const root of ['/srv/l1', '/srv/l2'])
          expect(out).toContain(
            `[warn] Backup folder root ${root}: ${root} is a link that leads nowhere (to a folder not made yet), ` +
              'which systemd follows wherever it leads at each start, and the unit names it: run ' +
              "'mongo-manager service install' again with sudo now, to leave it out\n",
          )
      },
    )

    // Final re-re-re-review (minor 4): with no one to judge for, install names no root to keep it.
    it.skipIf(process.platform === 'win32')(
      'tells to leave out a refused root when who runs the service is not known',
      async () => {
        const fs = fsOf({ '/home/u/link': LINK(0) }, { '/home/u/link': '/srv/b' })
        const sys = unitOf(['/srv/b', '/home/u/link'], '-/srv/b')
        sys.responses.unshift({ match: USER, status: 1 })
        const out = await walkDoctor(['/srv/b', '/home/u/link'], fs, sys, (r) =>
          r === '/home/u/link' ? 'systemd hides /home from the service (ProtectHome=yes)' : null,
        )
        expect(out).toContain(
          '(ProtectHome=yes). The unit names it all the same: to leave it out, ' + `${STALE}\n`,
        )
      },
    )

    // Final re-re-re-review (minor 2): one the unit names while install leaves every root out.
    it.skipIf(process.platform === 'win32')(
      'says of a root the unit names, though a lost group leaves every root out',
      async () => {
        const sys = unitOf(['/srv/b'], '-/srv/b')
        sys.responses.unshift({
          match: USER,
          status: 0,
          stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=ldapgroup\nDynamicUser=no\n',
        })
        sys.responses.unshift({ match: /^getent group ldapgroup$/, status: 1 })
        const out = await walkDoctor(['/srv/b'], fsOf({}), sys)
        expect(out).toContain(
          '[warn] Backup folder root /srv/b: service install leaves it out, as a group the unit gives the ' +
            `service could not be looked up (see above). The unit names it all the same: to leave it out, ${STALE}\n`,
        )
      },
    )

    // Final re-re-re-review (minor 3): a change while an entry no root leads to was judged.
    it.skipIf(process.platform === 'win32')(
      'says of an entry no root leads to whose way changed while judged that it changed',
      async () => {
        let reads = 0
        const fs = fsOf(
          {
            '/srv/grp': () => (reads++ === 0 ? { uid: 0, gid: 999, mode: 0o41770 } : LINK(999)),
            '/srv/grp/a': LINK(999),
          },
          { '/srv/grp/a': '/srv/nowhere', '/srv/grp': '/srv/elsewhere' },
        )
        const sys = unitOf(['/srv/rootdir/backups'], '-/srv/rootdir/backups -/srv/grp/a/backups')
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain(
          "[warn] The systemd service's unit entry /srv/grp/a/backups: /srv/grp changed while the unit entry " +
            'was judged',
        )
      },
    )

    // Final re-re-review (minor 1): the unit names the folder for another root that leads there too.
    it.skipIf(process.platform === 'win32')(
      'does not tell to leave out a refused root whose folder another root keeps in the unit',
      async () => {
        const fs = fsOf({ '/home/u/link': LINK(0) }, { '/home/u/link': '/srv/b' })
        const sys = unitOf(['/srv/b', '/home/u/link'], '-/srv/b')
        const out = await walkDoctor(['/srv/b', '/home/u/link'], fs, sys, (r) =>
          r === '/home/u/link' ? 'systemd hides /home from the service (ProtectHome=yes)' : null,
        )
        expect(out).toContain(
          "[warn] Backup folder root /home/u/link is out of the systemd service's reach: systemd hides /home " +
            'from the service (ProtectHome=yes)\n',
        )
      },
    )

    // Final re-re-review (minor 2): two ways to one folder, each through a folder another user may change.
    it.skipIf(process.platform === 'win32')(
      'warns of a unit entry through a loose folder, though a root through another leads to the same folder',
      async () => {
        const fs = fsOf(
          {
            '/srv/other': { uid: 1234, gid: 1234, mode: 0o40755 },
            '/srv/other/l': LINK(1234),
            '/srv/third': { uid: 1234, gid: 1234, mode: 0o40755 },
            '/srv/third/m': LINK(1234),
          },
          { '/srv/other/l': '/srv/a', '/srv/third/m': '/srv/a' },
        )
        const sys = unitOf(['/srv/other/l/b'], '-/srv/a/b -/srv/third/m/b')
        const out = await walkDoctor(['/srv/other/l/b'], fs, sys)
        expect(out).toContain('[warn] /srv/other, above the folder root /srv/other/l/b, can be changed')
        expect(out).toContain('[warn] /srv/third, above the unit entry /srv/third/m/b, can be changed')
      },
    )

    // Final re-re-review (minor 4): a way that changed while the entry was judged says that alone.
    it.skipIf(process.platform === 'win32')(
      'says of a unit entry whose way changed while judged only that it changed',
      async () => {
        let reads = 0
        const fs = fsOf(
          {
            // A folder at the walk, a link at every read after.
            '/srv/grp': () => (reads++ === 0 ? { uid: 0, gid: 999, mode: 0o41770 } : LINK(999)),
            '/srv/grp/a': LINK(999),
          },
          { '/srv/grp/a': '/srv/rootdir', '/srv/grp': '/srv/elsewhere' },
        )
        const sys = unitOf(['/srv/rootdir/backups'], '-/srv/rootdir/backups -/srv/grp/a/backups')
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain(
          "[warn] The systemd service's unit entry /srv/grp/a/backups leads to a folder root through links: " +
            '/srv/grp changed while the unit entry was judged',
        )
        expect(out).not.toContain('to leave the entry out')
      },
    )

    // Final re-re-re-review (minor 3): the same, with no one to judge for: judged as loose.
    it.skipIf(process.platform === 'win32')(
      'says of a unit entry whose way changed while judged, with no service user known, only that',
      async () => {
        let reads = 0
        const fs = fsOf(
          {
            '/srv/grp': () => (reads++ === 0 ? { uid: 0, gid: 999, mode: 0o41770 } : LINK(999)),
            '/srv/grp/a': LINK(999),
          },
          { '/srv/grp/a': '/srv/rootdir', '/srv/grp': '/srv/elsewhere' },
        )
        const sys = unitOf(['/srv/rootdir/backups'], '-/srv/rootdir/backups -/srv/grp/a/backups')
        sys.responses.unshift({ match: USER, status: 1 })
        const out = await walkDoctor(['/srv/rootdir/backups'], fs, sys)
        expect(out).toContain('[warn] /srv/grp changed while the unit entry was judged')
        expect(out).not.toContain('To leave the entry out')
      },
    )

    // Final review (minor 5): a link that changed while it was walked, and one through a file.
    it.skipIf(process.platform === 'win32')(
      'says of a link that changed while walked, or goes through a file, what to do',
      async () => {
        const fs = fsOf(
          { '/srv/swap': LINK(), '/srv/via-file': LINK(), '/srv/f/file': { uid: 0, mode: 0o100644 } },
          { '/srv/via-file': '/srv/f/file/../../ok' },
        )
        const out = await walkDoctor(['/srv/swap', '/srv/via-file'], fs)
        expect(out).toContain(
          '[warn] Backup folder root /srv/swap: /srv/swap changed while it was walked: it was a link, then none: ' +
            "run 'mongo-manager service install' again with sudo once nothing changes it\n",
        )
        expect(out).toContain(
          '[warn] Backup folder root /srv/via-file: /srv/via-file is a link that leads nowhere (through a file), ' +
            'which systemd follows wherever it leads at each start: choose another folder, or remove the link\n',
        )
      },
    )

    // Whole-branch re-review (minors 2 and 3): root by name or uid, and said with no folder roots too.
    it('says the service runs as root when User= names root, with no folder roots set', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=root\n' })
      sys.responses.push({ match: /^id -u root$/, status: 0, stdout: '0\n' })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } }), io, { uid: 1000, sys })
      expect(io.out()).toContain(
        '[warn] The systemd service runs as root: its unit, with its drop-ins, names User=root, and ' +
          'service install stops for that',
      )
    })

    // Whole-branch re-review (minor 4): the service's key is in its env file.
    it("takes the service's key from its env file", async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.files.set('/etc/mongo-manager/env', {
        content: `MM_SECRET_KEY=${Buffer.alloc(32, 7).toString('base64')}\n`,
        mode: 0o600,
      })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } }), io, { uid: 1000, sys })
      expect(io.out()).toContain('[ok] Secret key from MM_SECRET_KEY in /etc/mongo-manager/env\n')
      expect(io.out()).not.toContain('No secret key yet')
    })

    // Whole-branch re-review (minor 1): a refused root is judged by the links on its way alone, as
    // install judges it, not by the folders above it.
    it('judges a refused root by the links on its way alone', async () => {
      const parent = tempDir()
      const root = join(parent, 'exports')
      mkdirSync(root)
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: (r) => (r === root ? 'it is refused here' : null),
        stat: rootOwned({
          [realpathSync(parent).split(sep).join('/')]: { uid: 999, gid: 999, mode: 0o40700 },
        }),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${root} is out of the systemd service's reach: it is refused here\n`,
      )
      expect(io.out()).not.toContain("is owned by the service's user")
    })

    // Whole-branch re-review (minor 1): a refused root is said refused, as install says it.
    it('says a root inside the data directory is refused, as install does', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(
        { ...config, backup: { ...config.backup, folderRoots: ['/var/lib/mongo-manager/exports'] } },
        io,
        {
          uid: 1000,
          sys,
          stat: rootOwned({ '/var/lib/mongo-manager': { uid: 999, gid: 999, mode: 0o40700 } }),
        },
      )
      expect(io.out()).toContain(
        "[warn] Backup folder root /var/lib/mongo-manager/exports is out of the systemd service's reach: " +
          'it is inside the data directory',
      )
      expect(io.out()).not.toContain("is owned by the service's user")
    })

    // Whole-branch review (important 2): the installed service is not what doctor checks by default.
    it('says how to check the installed service when it checks another data directory', async () => {
      const sys = service('/var/lib/mongo-manager')
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(resolveConfig({ cli: { dataDir: join(tempDir(), 'mine') } }), io, { uid: 1000, sys })
      expect(io.out()).toContain('[warn] The systemd service is installed, but doctor checks ')
      expect(io.out()).toContain(
        'not its data directory: check the service with: sudo mongo-manager doctor --config ' +
          '/etc/mongo-manager/config.json\n',
      )
    })

    // Whole-branch review (important 1): a link the service planted in an outer root it writes into.
    it.skipIf(process.platform === 'win32')(
      "warns of a root behind a link in a folder the service's user owns",
      async () => {
        const outer = tempDir()
        const target = tempDir()
        const inner = join(outer, 'daily')
        symlinkSync(target, inner)
        const sys = service(`/var/lib/mongo-manager -${outer} -${realpathSync(target)}`)
        sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(outer)]: { uid: 999, gid: 999, mode: 0o40700 } }),
        })
        expect(io.out()).toContain(
          `[warn] Backup folder root ${inner}: ${realpathSync(outer)}, above it, is owned by the service's user`,
        )
        expect(io.out()).not.toContain(`[ok] Backup folder root ${inner}`)
      },
    )

    it("says nothing of telling the service's user when its unit names one", async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const { out } = await check(sys)
      expect(out).not.toContain('could not be determined')
    })

    // Fifth review (minor 1): run as root, a setpriv that cannot run as the user is said.
    it("says, run as root, when setpriv cannot run as the service's user", async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 0,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(
        "[warn] setpriv could not run as the service's user mongo-manager, so the folders above the " +
          "folder roots were judged by their modes and that user's groups alone: an ACL that lets the " +
          'user write into one is not seen\n',
      )
      // Sixth review (minor 8): once, and no folder asked of it.
      expect(io.out().split("setpriv could not run as the service's user").length).toBe(2)
      expect(sys.commands.filter((c) => c.includes(' -- test -w '))).toEqual([])
    })

    // Fifth review (minor 3): an entry of the unit's own, inside a root it does not take in yet, is
    // judged for the service's user too.
    it('judges a root the unit names inside one it does not take in yet', async () => {
      const outer = tempDir()
      const root = join(outer, 'team', 'backups')
      mkdirSync(root, { recursive: true })
      const team = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({ [team]: { uid: 999, gid: 999, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(`[warn] Backup folder root ${root}: ${team}, above it, is owned by`)
    })

    // Fifth review (minor 4): of two roots that lead to the same folder, the one install can name
    // takes in the roots inside it, as install takes it.
    it.skipIf(process.platform === 'win32')(
      'takes a root in by the outer root install can name, of two that lead to the same folder',
      async () => {
        const dir = tempDir()
        const outer = join(dir, 'a')
        const inner = join(outer, 'x')
        mkdirSync(inner, { recursive: true })
        const link = join(dir, 'my link')
        symlinkSync(outer, link)
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [link, outer, inner] } }, io, {
          uid: 1000,
          sys: service(`/var/lib/mongo-manager -${realpathSync(outer)} -${realpathSync(inner)}`),
          unreachable: () => null,
          stat: rootOwned(),
        })
        expect(io.out()).toContain(
          `[warn] Backup folder root ${inner} is inside the folder root ${outer}, and the unit names it`,
        )
      },
    )

    // Seventh review (minor 4): one word to run it with sudo, not two.
    it('says once to run doctor with sudo', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      sys.files.set('/etc/mongo-manager/env', { content: '', mode: 0o600 })
      const read = sys.read
      sys.read = (p) => {
        if (p === '/etc/mongo-manager/env') throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' })
        return read(p)
      }
      const { out } = await check(sys)
      expect(out).toContain('cannot be read by this user: run doctor again with sudo')
      expect(out).not.toContain('doctor runs without root')
    })

    // Sixth review (minor 6): a User= of digits is a uid, which id is given as one.
    it('gives id a numeric User= as a number', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=1234\n' })
      await check(sys)
      expect(sys.commands).toContain('id -u +1234')
      expect(sys.commands).not.toContain('id -u 1234')
    })

    // Sixth review (minor 3, minor 8): without root the system is not asked, and that is said.
    it('asks nothing of setpriv without root, and says so', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const { out } = await check(sys)
      expect(sys.commands.filter((c) => c.startsWith('setpriv') || c.startsWith('id -g '))).toEqual([])
      expect(out).toContain(
        '[warn] doctor runs without root, so the folders above the folder roots were judged by their ' +
          "modes and the service user's groups alone, not by its ACLs: run it with sudo to have the " +
          'system asked\n',
      )
    })

    // Sixth review (minor 1): the inner root's entry keeps it in until the outer one is added by hand.
    it('says to add first by hand an outer root install cannot name', async () => {
      const outer = join(tempDir(), 'my backups')
      const inner = join(outer, 'x')
      mkdirSync(inner, { recursive: true })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${inner}`),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${inner} is inside the folder root ${outer}, which service install ` +
          `cannot add (a space, quote, backslash or % in it): add ${outer} with: sudo systemctl edit ` +
          `mongo-manager, as ReadWritePaths=-"${realpathSync(outer).split(sep).join('/')}" in [Service], ` +
          "then run 'mongo-manager service install' again with sudo\n",
      )
    })

    // Sixth review (minor 5): a root inside another the sandbox takes in stays in by that one.
    it('says a root the service may change, inside one the unit names, stays in by that one', async () => {
      const outer = tempDir()
      const root = join(outer, 'team', 'backups')
      mkdirSync(root, { recursive: true })
      const team = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${outer} -${root}`)
      sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({ [team]: { uid: 999, gid: 999, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(
        `that writable to the service at its next start; the unit names it as an entry of its own: run ` +
          `'mongo-manager service install' again with sudo now, which leaves that entry out; it stays in ` +
          `the sandbox by ${outer}\n`,
      )
    })

    // Sixth review (minor 7): the groups the unit gives the service count in doctor too.
    it('judges a folder by the groups the unit gives the service', async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const parent = dirname(root).split(sep).join('/')
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=backup\n',
      })
      sys.responses.push({ match: /^getent group backup$/, status: 0, stdout: 'backup:x:34:\n' })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned({ [parent]: { uid: 0, gid: 34, mode: 0o42775 } }),
      })
      expect(io.out()).toContain(`${parent}, above it, may be written into by the service's user`)
    })

    // Seventh review (minor 2): said without root too.
    it('says the service will not start with a group the system does not know', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=nosuch\n',
      })
      sys.responses.push({ match: /^getent group nosuch$/, status: 2 })
      const { out } = await check(sys)
      expect(out).toContain(
        '[warn] the unit gives the service the group nosuch, which the system does not know: systemd ' +
          'refuses to start the service (216/GROUP); check Group= and SupplementaryGroups= with: ' +
          'systemctl cat mongo-manager\n',
      )
    })

    // Eighth review (important): a user of systemd's own is none doctor can judge for.
    // Ninth review (important 1): DynamicUser=yes takes an account of that name when one exists.
    it('judges for the account DynamicUser=yes takes, and cannot tell when there is none', async () => {
      const taken = service('/var/lib/mongo-manager')
      taken.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=\nDynamicUser=yes\n',
      })
      expect((await check(taken)).out).not.toContain('could not be determined')
      expect(taken.commands).toContain('id -u mongo-manager')
      const none = service('/var/lib/mongo-manager')
      none.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=dyn\nGroup=\nSupplementaryGroups=\nDynamicUser=yes\n',
      })
      none.responses.push({ match: /^id -u dyn$/, status: 1 })
      expect((await check(none)).out).toContain("[warn] The systemd service's user could not be determined")
    })

    // Ninth review (important 2): a systemctl show that failed tells no one, and is said as that.
    it('says when systemd cannot be asked who runs the service', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 1 })
      const { out } = await check(sys)
      expect(out).toContain(
        '[warn] systemd could not be asked who runs the service (systemctl show failed): the folders above ' +
          'the folder roots are not checked for it\n',
      )
    })

    // Not the data directory's owner in its place: systemd's word on who runs it is what counts.
    it('judges for no one when systemd cannot be asked, though the data directory has an owner', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({ match: USER, status: 1 })
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
        owner: { uid: 4321, gid: 4322, mode: 0o40700 },
      })
      expect(io.out()).toContain('[warn] systemd could not be asked who runs the service')
      expect(sys.commands).not.toContain('id -u +4321')
    })

    // Ninth review (minor 5): as install judges it, a lookup that failed leaves every root out.
    it('says install leaves every root out when a group lookup fails', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=ldapgroup\nDynamicUser=no\n',
      })
      sys.responses.push({ match: /^getent group ldapgroup$/, status: 1 })
      const { root, out } = await check(sys)
      expect(out).toContain(
        `[warn] Backup folder root ${root}: service install leaves it out, as a group the unit gives the ` +
          'service could not be looked up (see above)\n',
      )
    })

    // Eighth review (minors 3 and 4): a lookup that failed is said, and each limit is said, none
    // hiding another.
    it('says each limit on what it checked, a lookup that failed among them', async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.responses.push({
        match: USER,
        status: 0,
        stdout: 'User=mongo-manager\nGroup=\nSupplementaryGroups=nosuch ldapgroup\nDynamicUser=no\n',
      })
      sys.responses.push({ match: /^getent group nosuch$/, status: 2 })
      sys.responses.push({ match: /^getent group ldapgroup$/, status: 1 })
      const { out } = await check(sys)
      expect(out).toContain(
        '[warn] the unit gives the service the group nosuch, which the system does not know',
      )
      expect(out).toContain(
        '[warn] the group ldapgroup the unit gives the service could not be looked up (getent failed), so ' +
          'whether its members may change a folder above a folder root is not known\n',
      )
      expect(out).toContain('[warn] doctor runs without root')
    })

    // Eighth review (minor 7): the loose-folder warning once a folder, as install gives it.
    it.skipIf(process.platform === 'win32')(
      'warns of a folder above two roots that lead to one once',
      async () => {
        const parent = tempDir()
        const root = join(parent, 'exports')
        mkdirSync(root)
        const link = join(tempDir(), 'to-exports')
        symlinkSync(root, link)
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root, link] } }, io, {
          uid: 1000,
          sys: service(`/var/lib/mongo-manager -${realpathSync(root)}`),
          unreachable: () => null,
          stat: rootOwned({ [realpathSync(parent)]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
        })
        expect(io.out().split(`${realpathSync(parent)}, above the folder root`).length).toBe(2)
      },
    )

    // Seventh review (minor 1): a root the service may change, inside one the unit does not take in yet.
    it.each([
      [
        'install can name',
        'later',
        "run 'mongo-manager service install' again with sudo now, which leaves its own entry out and " +
          'takes it in by the folder root OUTER\n',
      ],
      [
        'only a drop-in can name',
        'my later',
        'add the folder root OUTER with: sudo systemctl edit mongo-manager, as ReadWritePaths=-"REAL" in ' +
          '[Service] (service install cannot add it: a space, quote, backslash or % in it), then run ' +
          "'mongo-manager service install' again with sudo, which leaves its own entry out\n",
      ],
    ])(
      'says of a root the service may change, inside one %s, what install will do',
      async (_, name, text) => {
        const outer = join(tempDir(), name)
        const root = join(outer, 'team', 'backups')
        mkdirSync(root, { recursive: true })
        const team = dirname(root).split(sep).join('/')
        const sys = service(`/var/lib/mongo-manager -${root}`)
        sys.responses.push({ match: USER, status: 0, stdout: 'User=mongo-manager\n' })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, root] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
          stat: rootOwned({ [team]: { uid: 999, gid: 999, mode: 0o40755 } }),
        })
        expect(io.out()).toContain(
          text.replace('OUTER', outer).replace('REAL', realpathSync(outer).split(sep).join('/')),
        )
      },
    )

    // Seventh review (minor 11): one install cannot name stays in by the drop-in that adds it.
    it('says a root install cannot name stays in by its drop-in', async () => {
      const outer = join(tempDir(), 'my backups')
      const inner = join(outer, 'x')
      mkdirSync(inner, { recursive: true })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${outer} -${inner}`),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${inner} is inside the folder root ${outer}, and the unit names it as ` +
          `well: run 'mongo-manager service install' again with sudo, which leaves the entry of ${inner} ` +
          `out; ${outer} stays in by the drop-in that adds it, which systemctl edit (not --full) keeps ` +
          'out of the unit file install writes\n',
      )
    })

    // Fifth review (minor 9): '-' and '+' over D-Bus as well.
    it("reads a path with both '-' and '+' before it over D-Bus", async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const sys = service('/var/lib/mongo-manager')
      sys.responses.unshift({
        match: /^busctl /,
        status: 0,
        stdout: JSON.stringify({ type: 'as', data: ['/var/lib/mongo-manager', `-+${root}`] }),
      })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })

    // Fourth review (minor 1): systemd keeps '-' and then '+' before a path.
    it("reads a path with both '-' and '+' before it", async () => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -+${root}`),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })

    // Fourth review (minor 7): systemctl show, when D-Bus fails or answers what is not its list.
    it.each([
      ['fails', 1, ''],
      ['answers what is not its list', 0, '{"type":"s","data":"x"}'],
      ['answers what is not JSON', 0, '{nope'],
    ])('reads the sandbox with systemctl show when busctl %s', async (_, status, stdout) => {
      const root = join(tempDir(), 'exports')
      mkdirSync(root)
      const sys = service(`/var/lib/mongo-manager -${root}`)
      sys.responses.unshift({ match: /^busctl /, status, stdout })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
      expect(sys.commands).toContain('systemctl show mongo-manager -p ReadWritePaths --value')
    })

    // Third review (minor 4): an entry an earlier install gave a root inside another.
    it('says to install again of a root inside another that the unit names as well', async () => {
      const outer = tempDir()
      const inner = join(outer, 'daily')
      mkdirSync(inner)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${outer} -${inner}`),
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(
        `[warn] Backup folder root ${inner} is inside the folder root ${outer}, and the unit names it as ` +
          `well: run 'mongo-manager service install' again with sudo, which names ${outer} alone\n`,
      )
    })

    // Re-review 2026-10-18 (important 2): a root inside another is no entry of the unit of its own.
    it('says nothing of the folders above a root inside another one', async () => {
      const outer = tempDir()
      const inner = join(outer, 'daily')
      mkdirSync(inner)
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [outer, inner] } }, io, {
        uid: 1000,
        sys: service(`/var/lib/mongo-manager -${outer}`),
        unreachable: () => null,
        stat: rootOwned({ [outer.split(sep).join('/')]: { uid: 1000, gid: 1000, mode: 0o40755 } }),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${inner}\n`)
      expect(io.out()).not.toContain('can be changed')
    })

    // Re-review 2026-10-18 (minor 10): with no folder roots too.
    it('says when it cannot read the sandbox, though no root is set', async () => {
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor(resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } }), io, {
        uid: 1000,
        sys: service('', 1),
      })
      expect(io.out()).toContain(
        "[warn] The systemd service's sandbox could not be read; check with: systemctl show mongo-manager " +
          '-p ReadWritePaths\n',
      )
    })

    it('says when it cannot read the sandbox', async () => {
      const { root, out } = await check(service('', 1))
      expect(out).toContain(
        "[warn] The systemd service's sandbox could not be read; check with: systemctl show mongo-manager " +
          '-p ReadWritePaths\n',
      )
      expect(out).toContain(
        `[warn] Backup folder root ${root} is not checked against the systemd service's sandbox\n`,
      )
    })

    // Third review (minor 7): said whatever became of the roots.
    it('says when it cannot read the sandbox, though no root gets that far', async () => {
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: ['/nowhere/at/all'] } }, io, {
        uid: 1000,
        sys: service('', 1),
        unreachable: () => null,
      })
      expect(io.out()).toContain("[warn] The systemd service's sandbox could not be read")
      expect(io.out()).toContain('[warn] Backup folder root /nowhere/at/all does not exist\n')
    })

    // Third review (minor 6): systemd's own list, over D-Bus, keeps each path whole.
    it('reads the sandbox from systemd over D-Bus first', async () => {
      const root = join(tempDir(), 'my  two  spaces')
      mkdirSync(root)
      const sys = service('/var/lib/mongo-manager')
      sys.responses.unshift({
        match:
          /^busctl --json=short get-property org\.freedesktop\.systemd1 \/org\/freedesktop\/systemd1\/unit\/mongo_2dmanager_2eservice org\.freedesktop\.systemd1\.Service ReadWritePaths$/,
        status: 0,
        stdout: JSON.stringify({ type: 'as', data: ['/var/lib/mongo-manager', `-${root}`] }),
      })
      const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
      const io = { ...fakeIo(), platform: 'linux' as const }
      await doctor({ ...config, backup: { ...config.backup, folderRoots: [root] } }, io, {
        uid: 1000,
        sys,
        unreachable: () => null,
        stat: rootOwned(),
      })
      expect(io.out()).toContain(`[ok] Backup folder root ${root}\n`)
    })

    // Third review (minor 5): the same roots, written twice or with a space after one.
    // The service's roots are POSIX paths: not on Windows.
    it.skipIf(process.platform === 'win32')(
      'takes the same roots, however written, for the same',
      async () => {
        const root = join(tempDir(), 'exports')
        mkdirSync(root)
        const sys = service(`/var/lib/mongo-manager -${root}`)
        sys.files.set('/etc/mongo-manager/config.json', {
          content: JSON.stringify({ backup: { folderRoots: [root] } }),
          mode: 0o640,
        })
        const config = resolveConfig({ cli: { dataDir: '/var/lib/mongo-manager' } })
        const io = { ...fakeIo(), platform: 'linux' as const }
        await doctor({ ...config, backup: { ...config.backup, folderRoots: [root, `${root} `] } }, io, {
          uid: 1000,
          sys,
          unreachable: () => null,
          stat: rootOwned(),
        })
        expect(io.out()).not.toContain('not those doctor was given')
      },
    )

    // Third review (minor 12): the config file, 640, is what a user not in its group meets first.
    it("says when it cannot read the service's config file", async () => {
      const sys = service('/var/lib/mongo-manager')
      sys.files.set('/etc/mongo-manager/config.json', { content: '{}', mode: 0o640 })
      const read = sys.read
      sys.read = (p) => {
        if (p === '/etc/mongo-manager/config.json')
          throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' })
        return read(p)
      }
      const { out } = await check(sys)
      expect(out).toContain(
        "[warn] The systemd service's config file /etc/mongo-manager/config.json cannot be read by this user",
      )
    })

    // Third review (minor 10): with neither file, what the unit names is not judged against doctor's roots.
    it("says when the service's config file is missing, and judges nothing else the unit names", async () => {
      const { out } = await check(service('/var/lib/mongo-manager -/srv/other'))
      expect(out).toContain(
        "[warn] The systemd service's config file /etc/mongo-manager/config.json does not exist: run " +
          "'mongo-manager service install' again with sudo\n",
      )
      expect(out).not.toContain('The systemd service may write into')
    })

    it("is not asked of a data directory that is not the service's", async () => {
      const sys = service('/var/lib/mongo-manager')
      const { root, out } = await check(sys, join(tempDir(), 'mine'))
      expect(out).toContain(`[ok] Backup folder root ${root}\n`)
      expect(sys.commands.some((c) => SHOW.test(c))).toBe(false)
    })
  })
})

// Review 2026-10-17 (second, minor 2): `sudo cp` of a backed-up key leaves it root's, mode 600; doctor
// said ok as root, and the service, its directory's owner, then could not read it at its start.
describe('doctor: files the server does not own', () => {
  /** A data directory with its files, as a POSIX system would report them: dir as given, files 600. */
  async function check(name: string, fileUid: number, dirStat = { uid: 1000, gid: 1001, mode: 0o40700 }) {
    const dir = tempDir()
    await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
    const file = join(dir, name)
    // Made when the data directory has none; one it has is left as it is.
    writeFileSync(file, '', { flag: 'a' })
    const stat = (path: string) =>
      path === dir
        ? dirStat
        : { uid: path === file ? fileUid : dirStat.uid, gid: dirStat.gid, mode: 0o100600 }
    const io = { ...fakeIo(), platform: 'linux' as const }
    await doctor(resolveConfig({ cli: { dataDir: dir } }), io, { uid: 0, stat })
    return { file, out: io.out() }
  }

  // Third review 2026-10-17 (minor 6, 8): the write-ahead log and launch secret too, given back to
  // the owner's group as well.
  it.each([KEY_FILE, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, LAUNCH_FILE])(
    'warns of a %s owned by someone else than the data directory',
    async (name) => {
      const { file, out } = await check(name, 0)
      expect(out).toContain(
        `[warn] ${file} is owned by uid 0, not by the data directory's owner (uid 1000), the server's ` +
          `user, who may not read it; run: sudo chown 1000:1001 '${file}'\n`,
      )
    },
  )

  it('says nothing of files the owner of the data directory owns', async () => {
    expect((await check(KEY_FILE, 1000)).out).not.toContain('is owned by')
  })

  // Third review 2026-10-17 (important 2): its owner names the server's user only when no one else
  // may enter it. A bind mount opened to everyone serves another uid (the image's 10001), and a
  // root-owned directory a server that reads anything: chown would have locked them out.
  it.each([
    ['opened to everyone (a bind mount)', { uid: 1000, gid: 1000, mode: 0o40777 }],
    ['opened to its group', { uid: 1000, gid: 1000, mode: 0o40750 }],
    ["root's (a server running as root)", { uid: 0, gid: 0, mode: 0o40700 }],
  ])('says nothing of the owners in a data directory %s', async (_, dirStat) => {
    expect((await check(KEY_FILE, 4242, dirStat)).out).not.toContain('is owned by')
  })
})

describe('doctor: a data directory that is a file', () => {
  it('fails, and checks nothing in it', async () => {
    const file = join(tempDir(), 'data')
    writeFileSync(file, 'x')
    const { code, io } = await run(['doctor', '--data-dir', file])
    expect(code).toBe(1)
    expect(io.out()).toContain(`[fail] Data directory ${file} is not a directory\n`)
    expect(io.out()).not.toMatch(/No secret key yet|Mongo Manager is not running/)
  })
})

// Review 2026-10-17 (second, note): run as another user than a service's, doctor met a 700 data
// directory it cannot list: it threw, and before that took the key it could not see for no key at all.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'doctor: a data directory it cannot read',
  () => {
    // Third review 2026-10-17 (minor 3): sudo with the same options, not `sudo -u` the owner, which
    // drops the service's config and env file, and often the command itself from its PATH.
    it('fails, says to run it again with sudo, and reports nothing it could not check', async () => {
      const dir = tempDir()
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      chmodSync(dir, 0o000)
      try {
        const { code, io } = await run(['doctor', '--data-dir', dir])
        expect(code).toBe(1)
        expect(io.out()).toContain(
          `[fail] Data directory ${dir} cannot be read by this user (it belongs to uid ${process.getuid!()}); ` +
            'run doctor again with sudo, with the same options\n',
        )
        expect(io.out()).not.toMatch(/No secret key yet|Mongo Manager is not running|\[ok\] Data directory/)
      } finally {
        chmodSync(dir, 0o700)
      }
    })

    // Third review 2026-10-17 (minor 8): a key given another way is still checked.
    it('still checks a key from MM_SECRET_KEY', async () => {
      const dir = tempDir()
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      chmodSync(dir, 0o000)
      try {
        const { io } = await run(['doctor', '--data-dir', dir], {
          MM_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
        })
        expect(io.out()).toContain('[ok] Secret key from MM_SECRET_KEY\n')
      } finally {
        chmodSync(dir, 0o700)
      }
    })

    // Third review 2026-10-17 (minor 7): a key it cannot read threw, and the checks after it went unsaid.
    it('fails on a key file it cannot read, and goes on checking', async () => {
      const dir = tempDir()
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      const key = join(dir, KEY_FILE)
      chmodSync(key, 0o000)
      try {
        const { code, io } = await run(['doctor', '--data-dir', dir])
        expect(code).toBe(1)
        expect(io.out()).toContain(
          `[fail] ${key} cannot be read by this user (EACCES); run doctor again with sudo, with the same options\n`,
        )
        expect(io.out()).toMatch(/mongodump/)
      } finally {
        chmodSync(key, 0o600)
      }
    })
  },
)
