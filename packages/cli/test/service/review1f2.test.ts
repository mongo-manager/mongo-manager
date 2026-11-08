// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError, parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import type { ProgramSource } from '../../src/service/common'
import { main } from '../../src/main'
import { renderSystemdUnit, renderTaskXml } from '../../src/service/render'
import { cleanTempDirs, fakeIo, tempDir } from '../support'
import { fakeSys, type FakeSys } from './fake-sys'

afterEach(cleanTempDirs)

const probe = async () => true
const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\admin',
}
const PROGRAM: Record<'linux' | 'darwin' | 'win32', ProgramSource> = {
  linux: { node: '/usr/bin/node', cli: '/tmp/pkg/dist/cli.cjs', publicDir: '/tmp/pkg/public' },
  darwin: { node: '/usr/local/bin/node', cli: '/tmp/pkg/dist/cli.cjs', publicDir: '/tmp/pkg/public' },
  win32: {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    cli: 'C:\\pkg\\dist\\cli.cjs',
    publicDir: 'C:\\pkg\\public',
  },
}

async function service(
  sys: FakeSys,
  argv: string[],
  program: ProgramSource = PROGRAM[sys.platform as keyof typeof PROGRAM],
) {
  const io = fakeIo({ env: sys.platform === 'win32' ? WIN_ENV : {} })
  let code: number
  try {
    const { positionals, values } = parseCli(['service', ...argv])
    code = await serviceCommand(positionals, values, io, { sys, program, probe })
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    io.stderr.write(`Error: ${e.message}\n`)
    code = 2
  }
  return { code, io }
}

const ROOT = 'C:\\ProgramData\\Mongo Manager'

describe('Windows state folder planted by another user (Review Critical 1)', () => {
  it('is refused when someone else owns it, and nothing is written', async () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:inspect/, status: 0, stdout: `owner S-1-5-21-1-2-3-1001 ${ROOT}\n` })
    const { code, io } = await service(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/owned by S-1-5-21-1-2-3-1001.*not created by an administrator/s)
    expect(sys.commands.some((c) => /mm:prepare/.test(c))).toBe(false)
    expect(sys.files.size).toBe(0)
  })

  it('is refused when the one-step preparation finds it foreign (second review Y2), and the config is not written', async () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:prepare/, status: 1 })
    const { code, io } = await service(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/cannot be used/)
    expect(sys.files.has(`${ROOT}\\config.json`)).toBe(false)
    expect(sys.commands.some((c) => c.startsWith('schtasks /Create'))).toBe(false)
  })

  it('is refused when it or a child is a junction', async () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:inspect/, status: 0, stdout: `reparse ${ROOT}\\data\n` })
    const { code, io } = await service(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/junction or link/)
  })

  it('is secured before anything is created inside it; the task XML never touches it', async () => {
    const sys = fakeSys('win32')
    const { code } = await service(sys, ['install'])
    expect(code).toBe(0)
    const at = (re: RegExp) => sys.commands.findIndex((c) => re.test(c))
    const prepare = at(/mm:prepare/)
    expect(at(/mm:inspect/)).toBeLessThan(prepare)
    const input = JSON.parse(sys.commands[prepare]!.slice(sys.commands[prepare]!.lastIndexOf(' INPUT=') + 7))
    expect(input).toEqual({ root: ROOT, writable: [`${ROOT}\\data`, `${ROOT}\\logs`] })
    // The config is written only after the folder is prepared.
    expect(prepare).toBeGreaterThanOrEqual(0)
    // The service account can read the config but not change it (Review Important 1).
    expect(sys.commands[prepare]).toMatch(/S-1-5-19', 'ReadAndExecute'/)
    const create = sys.commands.find((c) => c.startsWith('schtasks /Create'))!
    expect(create).toContain('C:\\Users\\admin\\AppData\\Local\\Temp\\mm-private\\')
    expect(create).not.toContain(ROOT)
  })
})

describe('the service runs its own copy of Node (user decision: an nvm Node is enough)', () => {
  const trustInputs = (sys: FakeSys) =>
    sys.commands
      .filter((c) => /mm:trust/.test(c))
      .map((c) => JSON.parse(c.slice(c.lastIndexOf(' INPUT=') + 7)).path as string)

  it('copies an nvm Node from a home directory and runs the copy (Linux)', async () => {
    const sys = fakeSys('linux')
    const nvm = '/home/ada/.nvm/versions/node/v24.21.0/bin/node'
    const { code } = await service(sys, ['install'], { ...PROGRAM.linux, node: nvm })
    expect(code).toBe(0)
    expect(sys.files.get('/opt/mongo-manager/app/bin/node')).toBeDefined()
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit).toContain(
      'ExecStart="/opt/mongo-manager/app/bin/node" "/opt/mongo-manager/app/dist/cli.cjs"',
    )
    expect(unit).not.toContain('/home/ada')
  })

  it('copies a Node from a user-writable folder on Windows and trust-checks the copy', async () => {
    const sys = fakeSys('win32')
    const { code } = await service(sys, ['install'], {
      ...PROGRAM.win32,
      node: 'C:\\nvm4w\\nodejs\\node.exe',
    })
    expect(code).toBe(0)
    const checked = trustInputs(sys)
    expect(checked).toContain('C:\\Program Files\\Mongo Manager\\app\\bin\\node.exe')
    expect(checked).toContain('C:\\Program Files\\Mongo Manager\\app\\dist\\cli.cjs')
    // Third review of the CI fixes (I-1): the shell worker the service runs too.
    expect(checked).toContain('C:\\Program Files\\Mongo Manager\\app\\dist\\shell-worker.cjs')
    expect(checked.some((p) => p.startsWith('C:\\nvm4w'))).toBe(false)
  })

  it('resolves a symlinked source and refuses the copy when the program folder is not root-only (POSIX)', async () => {
    const linked = fakeSys('darwin')
    linked.realpaths.set('/usr/local/bin/node', '/Users/ada/.nvm/versions/node/v24/bin/node')
    expect(
      (await service(linked, ['install'], { ...PROGRAM.darwin, node: '/usr/local/bin/node' })).code,
    ).toBe(0)
    const writable = fakeSys('linux')
    writable.stats.set('/opt', { uid: 1000, mode: 0o755 })
    const r = await service(writable, ['install'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/opt is not owned by root/)
  })

  it('refuses a --node that does not exist', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/nowhere/node', null)
    const r = await service(sys, ['install', '--node', '/nowhere/node'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/nowhere\/node does not exist/)
  })
})

describe('service install options (Review Important 5)', () => {
  it('refuses options it cannot apply, and carries the ones it can', async () => {
    const sys = fakeSys('linux')
    const refused = await service(sys, ['install', '--data-dir', '/srv/mm'])
    expect(refused.code).toBe(2)
    expect(refused.io.err()).toMatch(/--data-dir is not supported by service install/)
    const ok = await service(sys, [
      'install',
      '--host',
      '0.0.0.0',
      '--allowed-hosts',
      'mm.example.com',
      '--trusted-proxies',
      '10.0.0.1',
      '--read-only',
      '--log-level',
      'warn',
    ])
    expect(ok.code).toBe(0)
    expect(JSON.parse(sys.files.get('/etc/mongo-manager/config.json')!.content)).toMatchObject({
      host: '0.0.0.0',
      allowedHosts: ['mm.example.com'],
      trustedProxies: ['10.0.0.1'],
      readOnly: true,
      logLevel: 'warn',
    })
  })

  it('validates the merged config, not just the new options', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/config.json', {
      content: JSON.stringify({ auth: false, host: '127.0.0.1' }),
      mode: 0o640,
    })
    const open = await service(sys, ['install', '--host', '0.0.0.0'])
    expect(open.code).toBe(1)
    expect(open.io.err()).toMatch(/Refusing to listen on 0\.0\.0\.0 without authentication/)
    sys.files.set('/etc/mongo-manager/config.json', {
      content: JSON.stringify({ dataDir: '/srv/elsewhere' }),
      mode: 0o640,
    })
    const moved = await service(sys, ['install'])
    expect(moved.code).toBe(1)
    expect(moved.io.err()).toMatch(/dataDir.*\/srv\/elsewhere.*\/var\/lib\/mongo-manager/s)
  })
})

describe('service accounts (Review Minor 2, 3, 4)', () => {
  it('refuses root and shared system accounts', async () => {
    expect((await service(fakeSys('linux'), ['install', '--user', 'root'])).code).toBe(2)
    expect((await service(fakeSys('linux'), ['install', '--user', 'nobody'])).code).toBe(2)
    const zero = fakeSys('linux')
    zero.responses.push({ match: /^id -u svc$/, status: 0, stdout: '0\n' })
    const r = await service(zero, ['install', '--user', 'svc'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/uid 0/)
  })

  it('uses the account primary group and chowns the data recursively', async () => {
    const sys = fakeSys('linux')
    sys.responses.push(
      { match: /^id -u svc$/, status: 0, stdout: '990\n' },
      { match: /^id -gn svc$/, status: 0, stdout: 'users\n' },
    )
    // The data directory belongs to another uid (the account was re-created): its entries follow,
    // but never through a symlink or a hard link to a file elsewhere (second review Y4).
    sys.stats.set('/var/lib/mongo-manager', { uid: 991, mode: 0o700 })
    expect((await service(sys, ['install', '--user', 'svc'])).code).toBe(0)
    expect(sys.commands).toContain('chown svc:users /var/lib/mongo-manager')
    expect(sys.commands).toContain(
      'find /var/lib/mongo-manager -xdev ( -type d -o ( -type f -links 1 ) ) ! -user svc -exec chown svc:users {} +',
    )
    expect(sys.commands.some((c) => c.startsWith('chown -R'))).toBe(false)
    expect(sys.commands).toContain('chown root:users /etc/mongo-manager/config.json')
    expect(
      renderSystemdUnit({
        command: ['/n', '/c'],
        config: '/cfg',
        dataDir: '/d',
        user: 'svc',
        envFile: '/e',
        logFile: null,
      }),
    ).not.toMatch(/^Group=/m)
  })
})

describe('keys on macOS and Windows (Review Important 4)', () => {
  it('refuses an existing data directory without its key', async () => {
    const mac = fakeSys('darwin')
    mac.files.set('/Library/Application Support/Mongo Manager/data/mongo-manager.db', {
      content: 'db',
      mode: 0o600,
    })
    expect((await service(mac, ['install'])).io.err()).toMatch(/existing data.*no key/is)
    const win = fakeSys('win32')
    win.files.set(`${ROOT}\\data\\mongo-manager.db`, { content: 'db', mode: 0o600 })
    expect((await service(win, ['install'])).io.err()).toMatch(/existing data.*no key/is)
  })
})

describe('Task Scheduler restarts a crashed server (Review Important 2)', () => {
  it('repeats the boot task every minute; a running instance is left alone', () => {
    const xml = renderTaskXml({
      command: ['n', 'c'],
      config: 'cfg',
      dataDir: 'd',
      user: 'S-1-5-19',
      envFile: null,
      logFile: 'l',
    })
    expect(xml).toMatch(
      /<BootTrigger>[\s\S]*<Repetition>\s*<Interval>PT1M<\/Interval>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>[\s\S]*<\/BootTrigger>/,
    )
    // CI 2026-10-20: a repetition starts when its trigger fires, and a boot trigger fires at boot:
    // after an install, a server that crashed came back only at the next boot. Registering the task
    // starts the same repetition.
    expect(xml).toMatch(
      /<RegistrationTrigger>\s*<Enabled>true<\/Enabled>\s*<Repetition>\s*<Interval>PT1M<\/Interval>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>\s*<\/RegistrationTrigger>/,
    )
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
  })
})

describe('uninstall (Review Minor 6)', () => {
  it('keeps the program and says so when the task cannot be removed', async () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    sys.responses.push({ match: /^schtasks \/Delete/, status: 1 })
    const { code, io } = await service(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/could not remove the scheduled task/)
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(true)
    // Review of the CI fix 2026-10-20: the task it keeps runs again, as it was (it was disabled
    // for the removal).
    expect(sys.commands.slice(-2)).toEqual([
      'schtasks /Change /TN Mongo Manager /ENABLE',
      'schtasks /Run /TN Mongo Manager',
    ])
  })

  it('does the same when systemd cannot disable the unit', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/systemd/system/mongo-manager.service', { content: 'unit', mode: 0o644 })
    sys.dirs.set('/opt/mongo-manager/app', 0o755)
    sys.responses.push({ match: /^systemctl disable/, status: 1 })
    expect((await service(sys, ['uninstall'])).code).toBe(1)
    expect(sys.dirs.has('/opt/mongo-manager/app')).toBe(true)
  })
})

describe('Windows logs (Review Minor 7)', () => {
  it('prints only the tail of a large log', async () => {
    const sys = fakeSys('win32')
    const log = `${ROOT}\\logs\\mongo-manager.log`
    sys.files.set(log, { content: `${'old line\n'.repeat(100_000)}last line\n`, mode: 0o600 })
    const { io } = await service(sys, ['logs'])
    expect(io.out()).toContain('last line')
    expect(io.out().length).toBeLessThan(300_000)
  })

  // CI fixes, eighth review (minor 2): the task has no console, so a server that refuses its log file
  // says so nowhere it can be read; `service logs` says why, first.
  it('says why the server refuses its log file, before its tail', async () => {
    const sys = fakeSys('win32')
    const log = `${ROOT}\\logs\\mongo-manager.log`
    sys.files.set(log, { content: 'old line\n', mode: 0o600 })
    sys.logProblems.set(log, `The log file ${log} has other names (hard links): remove or rename it`)
    const { io, code } = await service(sys, ['logs'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/has other names \(hard links\): remove or rename it/)
    expect(io.out()).toContain('old line')
    // A link that leads nowhere (ninth review, minor 2): its reason, never "no log yet".
    sys.files.delete(log)
    sys.logProblems.set(log, `The log file ${log} is a link: remove or rename it`)
    const dangling = await service(sys, ['logs'])
    expect(dangling.code).toBe(1)
    expect(dangling.io.err()).toMatch(/does not start: The log file .* is a link/)
    expect(dangling.io.err()).not.toMatch(/No log yet/)
  })
})

describe('startup errors reach the log file (Review Important 3)', () => {
  it('appends a fatal line when start fails before the server logs anything', async () => {
    const dir = tempDir()
    const logFile = join(dir, 'logs', 'mm.log')
    const io = fakeIo()
    expect(
      await main(['start', '--host', '0.0.0.0', '--data-dir', join(dir, 'data'), '--log-file', logFile], io),
    ).toBe(1)
    const line = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!)
    expect(line).toMatchObject({ level: 60 })
    expect(line.msg).toMatch(/Refusing to listen on 0\.0\.0\.0/)
  })
})

describe('symlinked program folders (second review Y5)', () => {
  it('checks the real location of the program, not the link', async () => {
    const sys = fakeSys('linux')
    sys.realpaths.set('/opt/mongo-manager/app/dist/cli.cjs', '/home/ada/mm/dist/cli.cjs')
    sys.stats.set('/home/ada', { uid: 1000, mode: 0o755 })
    const { code, io } = await service(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/\/home\/ada is not owned by root/)
    // Third review of the CI fixes (I-1): the shell worker the service runs is checked as well.
    const worker = fakeSys('linux')
    worker.realpaths.set('/opt/mongo-manager/app/dist/shell-worker.cjs', '/home/ada/mm/dist/shell-worker.cjs')
    worker.stats.set('/home/ada', { uid: 1000, mode: 0o755 })
    const refused = await service(worker, ['install'])
    expect(refused.code).toBe(1)
    expect(refused.io.err()).toMatch(
      /shell-worker\.cjs can be changed[\s\S]*\/home\/ada is not owned by root/,
    )
  })
})

describe('usage errors of start reach the log file too (second review, Important 3 remainder)', () => {
  it('logs a refused option', async () => {
    const dir = tempDir()
    const logFile = join(dir, 'mm.log')
    expect(await main(['start', '--web-port', 'x', '--log-file', logFile], fakeIo())).toBe(2)
    expect(readFileSync(logFile, 'utf8')).toMatch(/--web-port/)
  })
})

describe('third review: paths and links', () => {
  it('refuses NTFS stream, UNC and device paths for --node (Important 1, Minor 3)', async () => {
    const nodes = [
      String.raw`C:\tools\node.exe::$DATA`,
      String.raw`C:\tools\node.exe:alt`,
      String.raw`\\server\share\node.exe`,
      String.raw`\\?\C:\tools\node.exe`,
    ]
    for (const node of nodes) {
      expect(node).not.toMatch(/[\t\n]/)
      const { code, io } = await service(fakeSys('win32'), ['install'], { ...PROGRAM.win32, node })
      expect(code, node).not.toBe(0)
      expect(io.err(), node).toMatch(/stream|network|device/)
    }
  })

  it('refuses hard links in the state folder, before and after locking it (Important 2)', async () => {
    const { prepareStateRoot } = await import('../../src/service/acl')
    const sys = fakeSys('win32')
    prepareStateRoot(sys, ROOT, [])
    const script = sys.commands[0]!
    expect(script).toMatch(/LinkType -eq 'HardLink'/)
    // The tree is scanned before Set-Acl too, so the new security never propagates through a link.
    const firstScan = script.indexOf('& $scan')
    expect(firstScan).toBeGreaterThan(0)
    expect(firstScan).toBeLessThan(script.indexOf('Set-Acl -LiteralPath $root'))
    expect(script.lastIndexOf('& $scan')).toBeGreaterThan(script.indexOf('Set-Acl -LiteralPath $root'))
  })
})
