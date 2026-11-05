// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { UsageError, parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import type { ProgramSource } from '../../src/service/common'
import { fakeIo } from '../support'
import { fakeSys, type FakeSys } from './fake-sys'

const probe = async () => true
const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\admin',
}

async function service(sys: FakeSys, argv: string[], program: ProgramSource) {
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

const trustInputs = (sys: FakeSys) =>
  sys.commands
    .filter((c) => /mm:trust/.test(c))
    .map((c) => JSON.parse(c.slice(c.lastIndexOf(' INPUT=') + 7)).path as string)

describe('service install from the standalone binary (Review Focus 1, 2)', () => {
  it('copies the one binary and the systemd unit runs it directly (Linux)', async () => {
    const sys = fakeSys('linux')
    const { code } = await service(sys, ['install'], { binary: '/home/ada/Downloads/mongo-manager' })
    expect(code).toBe(0)
    expect(sys.files.get('/opt/mongo-manager/app/bin/mongo-manager')!.content).toContain(
      '/home/ada/Downloads/mongo-manager',
    )
    expect(sys.files.has('/opt/mongo-manager/app/bin/node')).toBe(false)
    expect(sys.files.has('/opt/mongo-manager/app/dist/cli.cjs')).toBe(false)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit).toContain(
      'ExecStart="/opt/mongo-manager/app/bin/mongo-manager" start --config "/etc/mongo-manager/config.json" --no-open',
    )
    expect(unit).not.toContain('/home/ada')
  })

  it('refuses the copy when the program folder is not root-only (POSIX)', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/opt/mongo-manager/app/bin', { uid: 1000, mode: 0o755 })
    const r = await service(sys, ['install'], { binary: '/home/ada/mongo-manager' })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/app\/bin is not owned by root/)
  })

  it('launchd runs the copied binary (macOS)', async () => {
    const sys = fakeSys('darwin')
    const { code } = await service(sys, ['install'], { binary: '/Users/ada/mongo-manager' })
    expect(code).toBe(0)
    const plist = sys.files.get('/Library/LaunchDaemons/com.mongo-manager.server.plist')!.content
    expect(plist).toMatch(
      /<array>\s*<string>\/Library\/Application Support\/Mongo Manager\/app\/bin\/mongo-manager<\/string>\s*<string>start<\/string>/,
    )
  })

  it('the Windows task runs the copied binary, which is trust-checked', async () => {
    const sys = fakeSys('win32')
    const { code } = await service(sys, ['install'], {
      binary: 'C:\\Users\\ada\\Downloads\\mongo-manager.exe',
    })
    expect(code).toBe(0)
    const exe = 'C:\\Program Files\\Mongo Manager\\app\\bin\\mongo-manager.exe'
    expect(sys.files.get(exe)).toBeDefined()
    expect(trustInputs(sys)).toContain(exe)
    // Security review 2026-10-20 (minor 3): the folder the program is made in is checked on what it
    // passes on to it too; what the service runs, on its own rights.
    const below = sys.commands
      .filter((c) => /mm:trust/.test(c))
      .map((c) => JSON.parse(c.slice(c.lastIndexOf(' INPUT=') + 7)) as { path: string; below: boolean })
    expect(below.filter((i) => i.below).map((i) => i.path)).toEqual(['C:\\Program Files\\Mongo Manager'])
    expect(below.find((i) => i.path === exe)?.below).toBe(false)
    const xml = sys.writtenXml.at(-1)!
    expect(xml).toContain(`<Command>"${exe}"</Command>`)
    expect(xml).toMatch(/<Arguments>start --config "C:\\ProgramData\\Mongo Manager\\config\.json" --no-open/)
  })

  it('refuses --node, which the standalone binary does not use', async () => {
    const r = await service(fakeSys('linux'), ['install', '--node', '/usr/bin/node'], {
      binary: '/home/ada/mongo-manager',
    })
    expect(r.code).toBe(2)
    expect(r.io.err()).toMatch(/--node.*standalone binary/)
  })

  it('refuses a binary that does not exist', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/gone/mongo-manager', null)
    const r = await service(sys, ['install'], { binary: '/gone/mongo-manager' })
    expect(r.code).toBe(1)
    expect(r.io.err()).toMatch(/\/gone\/mongo-manager does not exist/)
  })
})
