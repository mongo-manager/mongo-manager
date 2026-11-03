import { describe, expect, it } from 'vitest'
import { UsageError, parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import type { ProgramSource } from '../../src/service/common'
import { fakeIo } from '../support'
import { elf64, macho64 } from './binaries'
import { fakeSys, type FakeSys } from './fake-sys'

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

describe('a Node that loads libraries users can change is refused (final review 1f-3, Critical 1)', () => {
  it('Homebrew on macOS: the copy would still load /opt/homebrew libraries', async () => {
    const sys = fakeSys('darwin')
    const brew = '/opt/homebrew/Cellar/node/26.1.0/bin/node'
    sys.binaries.set(
      brew,
      macho64({ dylibs: ['/usr/lib/libSystem.B.dylib', '/opt/homebrew/opt/icu4c@77/lib/libicuuc.77.dylib'] }),
    )
    sys.stats.set('/opt/homebrew', { uid: 501, mode: 0o755 })
    const r = await service(sys, ['install'], { ...PROGRAM.darwin, node: brew })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/loads code from \/opt\/homebrew\/opt\/icu4c@77\/lib\/libicuuc\.77\.dylib/)
    expect(r.io.err()).toMatch(/\/opt\/homebrew is not owned by root/)
    expect(sys.files.has('/Library/LaunchDaemons/com.mongo-manager.server.plist')).toBe(false)
  })

  it('Linuxbrew: its own loader and run path live in the linuxbrew home', async () => {
    const sys = fakeSys('linux')
    const brew = '/home/linuxbrew/.linuxbrew/bin/node'
    sys.binaries.set(
      brew,
      elf64({
        interpreter: '/home/linuxbrew/.linuxbrew/lib/ld.so',
        runpath: '/home/linuxbrew/.linuxbrew/lib',
      }),
    )
    sys.stats.set('/home/linuxbrew', { uid: 1001, mode: 0o755 })
    const r = await service(sys, ['install'], { ...PROGRAM.linux, node: brew })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/loads code from \/home\/linuxbrew\/\.linuxbrew\/lib\/ld\.so/)
    expect(sys.files.has('/etc/systemd/system/mongo-manager.service')).toBe(false)
  })

  it('a run path that does not exist is judged by the folder that would hold it', async () => {
    const sys = fakeSys('linux')
    sys.binaries.set('/usr/bin/node', elf64({ runpath: '/srv/shared/lib' }))
    sys.stats.set('/srv/shared/lib', null)
    sys.stats.set('/srv/shared', { uid: 0, mode: 0o777 })
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/srv\/shared is writable by others/)
  })

  it('an official build (nvm, nodejs.org) and the standalone binary install', async () => {
    expect((await service(fakeSys('darwin'), ['install'])).code).toBe(0)
    expect((await service(fakeSys('linux'), ['install'])).code).toBe(0)
    const sea = fakeSys('linux')
    sea.binaries.set('/home/ada/mongo-manager', elf64())
    expect((await service(sea, ['install'], { binary: '/home/ada/mongo-manager' })).code).toBe(0)
  })

  it('a file that is not an executable is refused', async () => {
    const sys = fakeSys('linux')
    sys.binaries.set('/home/ada/mongo-manager', Buffer.from('#!/bin/sh\nexec node x\n'.padEnd(80)))
    const r = await service(sys, ['install'], { binary: '/home/ada/mongo-manager' })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/not an ELF or Mach-O executable/)
  })
})

describe('the program location is checked before copying; a failed check stops the service (Minor 2)', () => {
  it('a program folder under a user-owned parent is refused before anything is copied', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/opt', { uid: 1000, mode: 0o755 })
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/opt is not owned by root/)
    expect(sys.commands.some((c) => c.startsWith('copyProgram'))).toBe(false)
  })

  // CI 2026-10-18: GitHub's Ubuntu runner has a /opt every user may write to. The program folder is
  // fixed, so the refusal says how to fix the folder it names, never to choose another location.
  it('says how to fix an open parent, the program folder being fixed', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/opt', { uid: 0, mode: 0o777 })
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/opt is writable by others \(mode 777\)/)
    expect(r.io.err()).toMatch(/sudo chmod go-w <path>/)
    expect(r.io.err()).not.toMatch(/Choose a system location/)
    expect(sys.commands.some((c) => c.startsWith('copyProgram'))).toBe(false)
    const win = fakeSys('win32')
    win.responses.push({
      match: /mm:trust/,
      status: 0,
      stdout: 'write S-1-5-32-545 C:\\Program Files',
    })
    const w = await service(win, ['install'])
    expect(w.code).toBe(1)
    expect(w.io.err()).toMatch(/S-1-5-32-545 can change C:\\Program Files/)
    expect(w.io.err()).toMatch(/Properties > Security, or icacls/)
    expect(w.io.err()).not.toMatch(/Choose a system location/)
  })

  it('when the copied program fails its check, the old unit is stopped and disabled (Linux, macOS)', async () => {
    const linux = fakeSys('linux')
    linux.stats.set('/opt/mongo-manager/app/bin/node', { uid: 1000, mode: 0o755 })
    const l = await service(linux, ['install'])
    expect(l.code).toBe(1)
    expect(linux.commands).toContain('systemctl disable --now mongo-manager')
    expect(l.io.err()).toMatch(/stopped and disabled/)
    const mac = fakeSys('darwin')
    mac.stats.set('/Library/Application Support/Mongo Manager/app/bin/node', { uid: 501, mode: 0o755 })
    const m = await service(mac, ['install'])
    expect(m.code).toBe(1)
    expect(mac.commands).toContain('launchctl bootout system/com.mongo-manager.server')
    expect(m.io.err()).toMatch(/stopped and disabled/)
  })
})

describe('Windows: a failed reinstall says what state the service is in (Minor 3)', () => {
  it('a failure after a good copy re-enables and restarts the task', async () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:prepare/, status: 1 })
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(sys.commands.slice(-2)).toEqual([
      'schtasks /Change /TN Mongo Manager /ENABLE',
      'schtasks /Run /TN Mongo Manager',
    ])
    expect(r.io.err()).toMatch(/started again/)
  })

  // Fourth review of the CI fixes (minor 3): a copy that left no program in place is said as such,
  // never "started again".
  it('says the service was not started again when no program is in place', async () => {
    const sys = fakeSys('win32')
    sys.copyProgram = () => {
      throw new Error('The new program could not be moved into place, nor the earlier one put back')
    }
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(sys.commands.some((c) => c.includes('/ENABLE') || c.includes('/Run'))).toBe(false)
    expect(r.io.err()).toMatch(/The earlier service was not started again: no program is in place/)
    expect(r.io.err()).not.toMatch(/was started again/)
  })

  it('a program that fails its check stays stopped and disabled, and the user is told', async () => {
    const sys = fakeSys('win32')
    sys.responses.push({
      match: /mm:trust[\s\S]*app\\\\bin\\\\node\.exe/,
      status: 0,
      stdout: 'write S-1-5-32-545 C:\\Program Files\\Mongo Manager\\app\\bin',
    })
    const r = await service(sys, ['install'])
    expect(r.code).toBe(1)
    expect(sys.commands.some((c) => c.includes('/ENABLE'))).toBe(false)
    expect(r.io.err()).toMatch(/stopped and disabled/)
  })
})

describe('reinstalling from the installed copy (Minor 4)', () => {
  it('keeps the program in place instead of replacing the files it runs from (Windows)', async () => {
    const sys = fakeSys('win32')
    const exe = 'C:\\Program Files\\Mongo Manager\\app\\bin\\mongo-manager.exe'
    sys.files.set(exe, { content: 'installed', mode: 0o755 })
    const r = await service(sys, ['install', '--web-port', '4400'], { binary: exe })
    expect(r.code).toBe(0)
    expect(sys.commands.some((c) => c.startsWith('copyProgram'))).toBe(false)
    expect(sys.commands.some((c) => /mm:trust/.test(c) && c.includes('mongo-manager.exe'))).toBe(true)
  })

  // Fourth review of the CI fixes (minor 7): a copy without the shell worker says to install from the
  // package; fifth review (minor 1): before anything changes, so the server is not stopped.
  it('refuses a copy without the shell worker in place, saying to install from the package', async () => {
    const sys = fakeSys('linux')
    const app = '/opt/mongo-manager/app'
    sys.files.set(`${app}/bin/node`, { content: 'node', mode: 0o755 })
    sys.files.set(`${app}/dist/cli.cjs`, { content: 'bundle', mode: 0o644 })
    const r = await service(sys, ['install'], {
      node: `${app}/bin/node`,
      cli: `${app}/dist/cli.cjs`,
      publicDir: `${app}/public`,
    })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(
      /The installed copy has no shell worker \(\/opt\/mongo-manager\/app\/dist\/shell-worker\.cjs\): it was removed since the install\. Run service install from the mongo-manager package/,
    )
    // Nothing was changed: no account made, nothing copied, the service not stopped.
    expect(sys.commands.filter((c) => /^(useradd|copyProgram|systemctl)/.test(c))).toEqual([])
    expect(r.io.err()).not.toMatch(/stopped and disabled/)
  })

  it('refuses a mix of installed and outside files', async () => {
    const sys = fakeSys('linux')
    const r = await service(sys, ['install'], {
      node: '/opt/mongo-manager/app/bin/node',
      cli: '/tmp/pkg/dist/cli.cjs',
      publicDir: '/tmp/pkg/public',
    })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/partly from the installed program/)
  })
})
