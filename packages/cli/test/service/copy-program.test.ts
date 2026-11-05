// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { makeInstallersOwn, realSys } from '../../src/service/sys'

const dirs: string[] = []
/** A package's bundle: cli.cjs and the shell worker the server starts beside it. */
const writeBundle = (cli: string, text: string) => {
  writeFileSync(cli, text)
  writeFileSync(join(dirname(cli), 'shell-worker.cjs'), 'worker')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('copying the program with its own Node (user decision: an nvm Node is enough)', () => {
  it('copies the running Node next to the program, and the copy runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const cli = join(dir, 'src', 'cli.cjs')
    const publicDir = join(dir, 'src', 'public')
    mkdirSync(publicDir, { recursive: true })
    writeBundle(cli, 'console.log(1)')
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    const to = join(dir, 'app')
    realSys().copyProgram({ cli, publicDir, node: process.execPath }, to)
    const node = join(to, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const version = spawnSync(node, ['--version'], { encoding: 'utf8' })
    expect(version.stdout.trim()).toBe(process.version)
    if (process.platform !== 'win32') {
      expect(statSync(node).mode & 0o777).toBe(0o755)
      expect(statSync(join(to, 'dist', 'cli.cjs')).mode & 0o777).toBe(0o644)
    }
  })

  // Third review of the CI fixes (I-1): the server starts the shell worker from beside its bundle, so
  // a service without it opened no shell; a package without one is refused, not installed half.
  it('copies the shell worker and the notices beside the bundle, and refuses a package without the worker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const cli = join(dir, 'pkg', 'dist', 'cli.cjs')
    const publicDir = join(dir, 'pkg', 'public')
    mkdirSync(publicDir, { recursive: true })
    mkdirSync(dirname(cli))
    writeBundle(cli, '1')
    writeFileSync(join(dirname(cli), 'THIRD-PARTY-NOTICES.txt'), 'notices')
    // Fifth review of the CI fixes (minor 5): and the package's own licence.
    writeFileSync(join(dir, 'pkg', 'LICENSE'), 'licence')
    // User request 2026-11-03: and the license's additional terms.
    writeFileSync(join(dir, 'pkg', 'NOTICE'), 'notice')
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    const to = join(dir, 'app')
    realSys().copyProgram({ cli, publicDir, node: process.execPath }, to)
    expect(readdirSync(join(to, 'dist')).sort()).toEqual([
      'THIRD-PARTY-NOTICES.txt',
      'cli.cjs',
      'shell-worker.cjs',
    ])
    expect(readFileSync(join(to, 'dist', 'shell-worker.cjs'), 'utf8')).toBe('worker')
    expect(readFileSync(join(to, 'LICENSE'), 'utf8')).toBe('licence')
    expect(readFileSync(join(to, 'NOTICE'), 'utf8')).toBe('notice')
    rmSync(join(dirname(cli), 'shell-worker.cjs'))
    expect(() => realSys().copyProgram({ cli, publicDir, node: process.execPath }, to)).toThrow(
      /shell-worker\.cjs is missing: the package is incomplete/,
    )
    // The earlier install stays as it was.
    expect(readFileSync(join(to, 'dist', 'shell-worker.cjs'), 'utf8')).toBe('worker')
  })

  // CI 2026-10-19: a file copied alone keeps its owner (libuv's copyfile), so run by root the
  // service's Node and cli.cjs stayed the installing user's, and the install refused its own copy.
  it.runIf(process.platform !== 'win32')(
    'gives every file it copies to whoever installs, whoever owned what it was copied from',
    (ctx) => {
      const uid = process.getuid!()
      const gid = process.getgid!()
      // Root gives the source away; anyone else can give it only a group of theirs.
      const other = process.getgroups!().find((g) => g !== gid)
      if (uid !== 0 && other === undefined) ctx.skip()
      const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
      dirs.push(dir)
      const src = join(dir, 'src')
      mkdirSync(join(src, 'public', 'assets'), { recursive: true })
      writeBundle(join(src, 'cli.cjs'), 'console.log(1)')
      writeFileSync(join(src, 'THIRD-PARTY-NOTICES.txt'), 'notices')
      writeFileSync(join(src, 'public', 'index.html'), '<!doctype html>')
      writeFileSync(join(src, 'public', 'assets', 'app.js'), '1')
      writeFileSync(join(src, 'node'), 'a node')
      mkdirSync(join(src, 'plugins', 'geojson-map'), { recursive: true })
      writeFileSync(join(src, 'plugins', 'geojson-map', 'mongo-manager-plugin.json'), '{}')
      writeFileSync(join(src, 'mongo-manager'), 'standalone')
      const giveAway = (p: string) => {
        if (uid === 0) chownSync(p, 65534, 65534)
        else chownSync(p, uid, other!)
        if (statSync(p).isDirectory()) for (const n of readdirSync(p)) giveAway(join(p, n))
      }
      giveAway(src)
      const owners = (root: string, p = root): string[] => {
        const s = lstatSync(p)
        const line = `${p.slice(root.length)} ${s.uid}:${s.gid}`
        return s.isDirectory() ? [line, ...readdirSync(p).flatMap((n) => owners(root, join(p, n)))] : [line]
      }
      const to = join(dir, 'app')
      realSys().copyProgram(
        { cli: join(src, 'cli.cjs'), publicDir: join(src, 'public'), node: join(src, 'node') },
        to,
      )
      const all = owners(to)
      expect(all.length).toBe(14)
      expect(all.filter((l) => !l.endsWith(` ${uid}:${gid}`))).toEqual([])
      // The standalone binary too (review of the CI fixes, M2).
      const sea = join(dir, 'sea')
      realSys().copyProgram({ binary: join(src, 'mongo-manager') }, sea)
      expect(owners(sea)).toEqual(['', '/bin', '/bin/mongo-manager'].map((p) => `${p} ${uid}:${gid}`))
      expect(statSync(join(sea, 'bin', 'mongo-manager')).mode & 0o777).toBe(0o755)
    },
  )

  // Review of the CI fixes (I1): a source swapped for a link after it was checked is refused, never
  // copied as a link a later chmod (run as root) would follow to what it points at.
  // Second review of the CI fixes (minor 9): on Windows too, where an elevated runner may make a file link; and the
  // earlier program stays as it was (minor 5).
  it('refuses a program file that is a link, changing nothing it points at', (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const victim = join(dir, 'shadow')
    writeFileSync(victim, 'secret', { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(victim, 0o600)
    const link = join(dir, 'node-link')
    try {
      symlinkSync(victim, link, 'file')
    } catch {
      ctx.skip() // No file links without a privilege on this Windows.
    }
    const publicDir = join(dir, 'pkg', 'public')
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    writeBundle(join(dir, 'pkg', 'cli.cjs'), '1')
    const to = join(dir, 'app')
    const earlier = join(to, 'bin', 'mongo-manager')
    mkdirSync(dirname(earlier), { recursive: true })
    writeFileSync(earlier, 'earlier')
    for (const from of [
      { cli: join(dir, 'pkg', 'cli.cjs'), publicDir, node: link },
      { cli: link, publicDir, node: process.execPath },
      { binary: link },
    ])
      expect(() => realSys().copyProgram(from, to)).toThrow(/node-link is a link or special file/)
    if (process.platform !== 'win32') expect(statSync(victim).mode & 0o777).toBe(0o600)
    expect(readdirSync(to)).toEqual(['bin'])
    expect(readFileSync(earlier, 'utf8')).toBe('earlier')
    expect(existsSync(`${to}.new`)).toBe(false)
  })

  // Second review of the CI fixes (I-A): Node's cp follows a junction on Windows and links one at the
  // top, so public/ or plugins/ that is a junction is refused, whichever folder of the package it is.
  it('refuses a public or plugins folder that is itself a link or junction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'index.html'), 'theirs')
    const pkg = join(dir, 'pkg')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeBundle(join(pkg, 'dist', 'cli.cjs'), '1')
    const cli = join(pkg, 'dist', 'cli.cjs')
    // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
    symlinkSync(elsewhere, join(pkg, 'public'), 'junction')
    expect(() =>
      realSys().copyProgram({ cli, publicDir: join(pkg, 'public'), node: process.execPath }, join(dir, 'a')),
    ).toThrow(/public is a link or special file/)
    rmSync(join(pkg, 'public'))
    mkdirSync(join(pkg, 'public'))
    writeFileSync(join(pkg, 'public', 'index.html'), '<!doctype html>')
    symlinkSync(elsewhere, join(pkg, 'plugins'), 'junction')
    expect(() =>
      realSys().copyProgram({ cli, publicDir: join(pkg, 'public'), node: process.execPath }, join(dir, 'b')),
    ).toThrow(/plugins is a link or special file/)
    expect(readdirSync(dir).sort()).toEqual(['elsewhere', 'pkg'])
  })

  // Third review of the CI fixes (minor 5): a folder above it that is a link to nothing stops the
  // install with what to do, following nothing.
  it('refuses a folder above the program that is a link to nothing, saying what to do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
    symlinkSync(join(dir, 'gone'), join(dir, 'opt'), 'junction')
    const binary = join(dir, 'mongo-manager')
    writeFileSync(binary, 'standalone')
    expect(() => realSys().copyProgram({ binary }, join(dir, 'opt', 'mongo-manager', 'app'))).toThrow(
      /opt is there but is no folder this install can use \(a link, or one it may not look into\): remove it/,
    )
    expect(existsSync(join(dir, 'gone'))).toBe(false)
  })

  // Fourth review of the CI fixes (minor 5): a folder its parent refuses to hold is said as that, with
  // what to do.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'says when a folder above the program could not be made',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
      dirs.push(dir)
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o555)
      const binary = join(dir, 'mongo-manager')
      writeFileSync(binary, 'standalone')
      try {
        expect(() => realSys().copyProgram({ binary }, join(locked, 'mongo-manager', 'app'))).toThrow(
          /mongo-manager could not be made in .*locked \(EACCES\): make it yourself/,
        )
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )

  // Fourth review of the CI fixes (minor 2): when the earlier program cannot be moved aside, the new
  // copy is not left behind and the earlier one stays.
  it('removes the new copy when the earlier program cannot be moved aside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const to = join(dir, 'app')
    const name = process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager'
    mkdirSync(join(to, 'bin'), { recursive: true })
    writeFileSync(join(to, 'bin', name), 'earlier')
    const binary = join(dir, 'mongo-manager-new')
    writeFileSync(binary, 'newer')
    const rename = (from: string, dest: string) => {
      if (dest.endsWith('.old')) throw Object.assign(new Error(`EBUSY: rename ${from}`), { code: 'EXDEV' })
      renameSync(from, dest)
    }
    expect(() => realSys({ rename }).copyProgram({ binary }, to)).toThrow(/EBUSY/)
    expect(existsSync(`${to}.new`)).toBe(false)
    expect(readFileSync(join(to, 'bin', name), 'utf8')).toBe('earlier')
  })

  // Third review of the CI fixes (minor 6): a socket is refused in the same words, not with the system's error.
  it.runIf(process.platform !== 'win32')('refuses a socket for a program file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const sock = join(dir, 'mongo-manager')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    try {
      expect(() => realSys().copyProgram({ binary: sock }, join(dir, 'app'))).toThrow(
        /mongo-manager is a link or special file/,
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  // Third review of the CI fixes (minor 2): when the earlier program cannot be put back either, both causes are
  // said and where it is; the next install puts it back.
  it('says both causes when the earlier program cannot be put back, and where it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const to = join(dir, 'app')
    const name = process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager'
    mkdirSync(join(to, 'bin'), { recursive: true })
    writeFileSync(join(to, 'bin', name), 'earlier')
    const binary = join(dir, 'mongo-manager-new')
    writeFileSync(binary, 'newer')
    const rename = (from: string, dest: string) => {
      if (from.endsWith('.new') || from.endsWith('.old'))
        throw Object.assign(new Error(`EXDEV: rename ${from}`), { code: 'EXDEV' })
      renameSync(from, dest)
    }
    expect(() => realSys({ rename }).copyProgram({ binary }, to)).toThrow(
      /could not be moved into place \(EXDEV: rename .*\.new\), nor the earlier one put back \(EXDEV: rename .*\.old\): it is at .*app\.old, which the next install puts back/,
    )
    expect(existsSync(`${to}.new`)).toBe(false)
    expect(readFileSync(join(`${to}.old`, 'bin', name), 'utf8')).toBe('earlier')
    // Third review of the CI fixes (minor 4): only a program is put back.
    rmSync(join(`${to}.old`, 'bin', name))
    writeFileSync(join(`${to}.old`, 'stray'), 'x')
    const newFails = (from: string, dest: string) => {
      if (from.endsWith('.new')) throw Object.assign(new Error(`EXDEV: rename ${from}`), { code: 'EXDEV' })
      renameSync(from, dest)
    }
    expect(() => realSys({ rename: newFails }).copyProgram({ binary }, to)).toThrow(/EXDEV/)
    expect(existsSync(to)).toBe(false)
    realSys().copyProgram({ binary }, to)
    expect(readdirSync(to)).toEqual(['bin'])
    expect(readFileSync(join(to, 'bin', name), 'utf8')).toBe('newer')
    expect(existsSync(`${to}.old`)).toBe(false)
  })

  // Second review of the CI fixes (minor 2): a FIFO is refused at once, never waited on.
  it.runIf(process.platform !== 'win32')('refuses a FIFO for a program file, without waiting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const fifo = join(dir, 'mongo-manager')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    expect(() => realSys().copyProgram({ binary: fifo }, join(dir, 'app'))).toThrow(
      /mongo-manager is a link or special file/,
    )
  })

  // Second review of the CI fixes (minor 3): a --node with other names (hard links) may be another file than it
  // seems; the running Node is what the install already runs as.
  it('refuses a --node that has other names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const node = join(dir, 'node')
    writeFileSync(node, 'a node')
    linkSync(node, join(dir, 'secret-name'))
    const publicDir = join(dir, 'public')
    mkdirSync(publicDir)
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    writeBundle(join(dir, 'cli.cjs'), '1')
    expect(() =>
      realSys().copyProgram({ cli: join(dir, 'cli.cjs'), publicDir, node }, join(dir, 'app')),
    ).toThrow(/node has other names \(hard links\)/)
    expect(existsSync(join(dir, 'app'))).toBe(false)
  })

  // Second review of the CI fixes (minor 5): a run that could not put the earlier program back left it as .old
  // alone; the next run puts it back instead of removing it, even when it fails too.
  it('keeps an earlier program left only as .old', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const to = join(dir, 'app')
    const name = process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager'
    mkdirSync(join(`${to}.old`, 'bin'), { recursive: true })
    writeFileSync(join(`${to}.old`, 'bin', name), 'earlier')
    const binary = join(dir, 'mongo-manager-new')
    writeFileSync(binary, 'newer')
    const rename = (from: string, dest: string) => {
      if (from.endsWith('.new')) throw Object.assign(new Error(`EXDEV: rename ${from}`), { code: 'EXDEV' })
      renameSync(from, dest)
    }
    expect(() => realSys({ rename }).copyProgram({ binary }, to)).toThrow(/EXDEV/)
    expect(readFileSync(join(to, 'bin', name), 'utf8')).toBe('earlier')
    realSys().copyProgram({ binary }, to)
    expect(readFileSync(join(to, 'bin', name), 'utf8')).toBe('newer')
    expect(existsSync(`${to}.old`)).toBe(false)
  })

  // Review of the CI fixes (I1): the copy itself is checked, where nothing can be swapped any more.
  it.runIf(process.platform !== 'win32')('stops at a link found in the copy, following none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const victim = join(dir, 'shadow')
    writeFileSync(victim, 'secret')
    chmodSync(victim, 0o600)
    const copy = join(dir, 'copy')
    mkdirSync(join(copy, 'public'), { recursive: true })
    symlinkSync(victim, join(copy, 'public', 'assets.js'))
    expect(() =>
      makeInstallersOwn(copy, process.getuid!(), process.getgid!(), join(copy, 'bin', 'node')),
    ).toThrow(/assets\.js is a link or special file/)
    expect(statSync(victim).mode & 0o777).toBe(0o600)
  })

  // Whatever a copy of a folder keeps of its source's owners (Node's cp has done both), the copy
  // ends the installer's, readable, its executable runnable.
  it.runIf(process.platform !== 'win32')("makes a copy that kept others' owners the installer's", (ctx) => {
    const uid = process.getuid!()
    const gid = process.getgid!()
    const other = process.getgroups!().find((g) => g !== gid)
    if (uid !== 0 && other === undefined) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const copy = join(dir, 'copy')
    mkdirSync(join(copy, 'bin'), { recursive: true })
    mkdirSync(join(copy, 'public'))
    const files = [join(copy, 'bin', 'node'), join(copy, 'public', 'index.html')]
    for (const f of files) writeFileSync(f, 'x', { mode: 0o600 })
    for (const p of [copy, join(copy, 'bin'), join(copy, 'public'), ...files])
      if (uid === 0) chownSync(p, 65534, 65534)
      else chownSync(p, uid, other!)
    makeInstallersOwn(copy, uid, gid, files[0]!)
    for (const p of [copy, join(copy, 'bin'), join(copy, 'public'), ...files]) {
      const s = statSync(p)
      expect([p, s.uid, s.gid]).toEqual([p, uid, gid])
    }
    expect(statSync(copy).mode & 0o777).toBe(0o755)
    expect(statSync(files[0]!).mode & 0o777).toBe(0o755)
    expect(statSync(files[1]!).mode & 0o777).toBe(0o644)
  })

  // Review of the CI fixes (I2): the folders it makes above the program are enterable by the
  // service's account whatever the installing shell's umask.
  it.runIf(process.platform !== 'win32')(
    'makes the folders above the program open to read, under a strict umask',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
      dirs.push(dir)
      const binary = join(dir, 'mongo-manager')
      writeFileSync(binary, 'standalone')
      const to = join(dir, 'opt', 'mongo-manager', 'app')
      const was = process.umask(0o077)
      try {
        realSys().copyProgram({ binary }, to)
      } finally {
        process.umask(was)
      }
      for (const p of [join(dir, 'opt'), join(dir, 'opt', 'mongo-manager'), to, join(to, 'bin')])
        expect([p, statSync(p).mode & 0o777]).toEqual([p, 0o755])
      expect(statSync(join(to, 'bin', 'mongo-manager')).mode & 0o777).toBe(0o755)
    },
  )

  it('copies the bundled plugins beside the program, refusing a link among them (4b map review I2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const cli = join(dir, 'src', 'dist', 'cli.cjs')
    const publicDir = join(dir, 'src', 'public')
    mkdirSync(publicDir, { recursive: true })
    mkdirSync(join(dir, 'src', 'dist'))
    writeBundle(cli, 'console.log(1)')
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    mkdirSync(join(dir, 'src', 'plugins', 'geojson-map'), { recursive: true })
    writeFileSync(join(dir, 'src', 'plugins', 'geojson-map', 'mongo-manager-plugin.json'), '{}')
    const to = join(dir, 'app')
    realSys().copyProgram({ cli, publicDir, node: process.execPath }, to)
    expect(existsSync(join(to, 'plugins', 'geojson-map', 'mongo-manager-plugin.json'))).toBe(true)
    let linked = false
    try {
      symlinkSync(join(dir, 'src', 'public'), join(dir, 'src', 'plugins', 'up'), 'junction')
      linked = true
    } catch {
      // No links on this system: nothing more to check.
    }
    if (linked)
      expect(() =>
        realSys().copyProgram({ cli, publicDir, node: process.execPath }, join(dir, 'app2')),
      ).toThrow()
  })

  it('copies only the standalone binary, replacing an earlier package install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const to = join(dir, 'app')
    mkdirSync(join(to, 'dist'), { recursive: true })
    writeFileSync(join(to, 'dist', 'cli.cjs'), 'old')
    const binary = join(dir, 'download', 'mongo-manager')
    mkdirSync(join(dir, 'download'))
    writeFileSync(binary, 'standalone')
    realSys().copyProgram({ binary }, to)
    const exe = join(to, 'bin', process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager')
    expect(readFileSync(exe, 'utf8')).toBe('standalone')
    expect(readdirSync(to)).toEqual(['bin'])
    if (process.platform !== 'win32') expect(statSync(exe).mode & 0o777).toBe(0o755)
  })

  it('puts the earlier program back when the new one cannot be moved into place (final review Important 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const to = join(dir, 'app')
    mkdirSync(join(to, 'bin'), { recursive: true })
    writeFileSync(join(to, 'bin', 'mongo-manager'), 'earlier')
    const binary = join(dir, 'mongo-manager-new')
    writeFileSync(binary, 'newer')
    // Moving the earlier program aside works; moving the new one in fails (e.g. a scanner holds it open).
    const rename = (from: string, dest: string) => {
      if (from.endsWith('.new')) throw Object.assign(new Error(`EXDEV: rename ${from}`), { code: 'EXDEV' })
      renameSync(from, dest)
    }
    expect(() => realSys({ rename }).copyProgram({ binary }, to)).toThrow(/EXDEV/)
    const exe = join(to, 'bin', process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager')
    expect(
      existsSync(exe) ? readFileSync(exe, 'utf8') : readFileSync(join(to, 'bin', 'mongo-manager'), 'utf8'),
    ).toBe('earlier')
    expect(existsSync(`${to}.old`)).toBe(false)
  })

  it('refuses links inside the package instead of copying or following them (final review Minor 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-copy-'))
    dirs.push(dir)
    const publicDir = join(dir, 'pkg', 'public')
    mkdirSync(join(dir, 'elsewhere'), { recursive: true })
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html>')
    // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
    symlinkSync(join(dir, 'elsewhere'), join(publicDir, 'assets'), 'junction')
    const cli = join(dir, 'pkg', 'cli.cjs')
    writeBundle(cli, '1')
    const to = join(dir, 'app')
    expect(() => realSys().copyProgram({ cli, publicDir, node: process.execPath }, to)).toThrow(
      /assets is a link/,
    )
    expect(existsSync(to)).toBe(false)
  })
})
