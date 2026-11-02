import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import { doctor } from '../../src/commands/doctor'
import { resolveConfig } from '@mongo-manager/server'
import { fakeIo, tempDir } from '../support'
import { fakeSys } from './fake-sys'
import { layoutFor } from '../../src/service/layout'
import { uninstallWindows } from '../../src/service/windows'
import { runPowerShell } from '../../src/service/powershell'

const program = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  cli: 'C:\\pkg\\dist\\cli.cjs',
  publicDir: 'C:\\pkg\\public',
}
const probe = async () => true
const env = {
  ProgramFiles: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\ada',
}
const run = (sys: ReturnType<typeof fakeSys>, argv: string[]) => {
  const io = fakeIo({ env })
  const { positionals, values } = parseCli(['service', ...argv])
  return serviceCommand(positionals, values, io, { sys, program, probe }).then((code) => ({ code, io }))
}

describe('service install on Windows', () => {
  it('locks down the state folder first, registers a boot task as LocalService and starts it', async () => {
    const sys = fakeSys('win32')
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(0)
    const aclAt = sys.commands.findIndex(
      (c) => /mm:prepare/.test(c) && c.includes('"root":"C:\\\\ProgramData\\\\Mongo Manager"'),
    )
    expect(aclAt).toBeGreaterThanOrEqual(0)
    expect(
      sys.files.get('C:\\Program Files\\Mongo Manager\\app/dist/cli.cjs') ??
        sys.files.get('C:\\Program Files\\Mongo Manager\\app\\dist\\cli.cjs'),
    ).toBeDefined()
    const config = JSON.parse(sys.files.get('C:\\ProgramData\\Mongo Manager\\config.json')!.content)
    expect(config).toMatchObject({
      auth: true,
      logFile: 'C:\\ProgramData\\Mongo Manager\\logs\\mongo-manager.log',
    })
    const create = sys.commands.find((c) => c.startsWith('schtasks /Create'))!
    // The XML is written to the administrator's private temp folder, never into ProgramData.
    expect(create).toMatch(
      /^schtasks \/Create \/TN Mongo Manager \/XML C:\\Users\\admin\\AppData\\Local\\Temp\\\S+\.xml \/F$/,
    )
    // Review of the CI fix 2026-10-20 (minor 1): registering starts it (its registration trigger);
    // it is run, never ended, after: an end could stop it while it writes its first key files.
    expect(sys.commands.slice(sys.commands.indexOf(create) + 1)).toEqual(['schtasks /Run /TN Mongo Manager'])
    expect([...sys.files.keys()].some((k) => k.endsWith('.xml'))).toBe(false)
    expect(io.out()).toMatch(/running at http:\/\/127\.0\.0\.1:4321\//)
    // The setup token is read from its file, never from the log (security review 2026-10-13).
    expect(io.out()).toMatch(/setup token is in a file .*\\data\\setup-token/)
  })

  it('copies a Node from the user profile (nvm) into Program Files and needs an elevated prompt', async () => {
    const io = fakeIo({ env })
    const { positionals, values } = parseCli(['service', 'install'])
    const sys = fakeSys('win32')
    const code = await serviceCommand(positionals, values, io, {
      sys,
      program: { ...program, node: 'C:\\Users\\ada\\AppData\\Local\\nvm\\v24.21.0\\node.exe' },
      probe,
    })
    expect(code).toBe(0)
    expect(sys.files.get('C:\\Program Files\\Mongo Manager\\app\\bin\\node.exe')!.content).toContain('nvm')
    expect((await run(fakeSys('win32', { admin: false }), ['install'])).io.err()).toMatch(/Administrator/)
  })

  it('stops the running task before replacing the program, whose files Windows keeps locked', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    const end = sys.commands.indexOf('schtasks /End /TN Mongo Manager')
    const copy = sys.commands.indexOf('copyProgram C:\\Program Files\\Mongo Manager\\app')
    expect(end).toBeGreaterThanOrEqual(0)
    expect(end).toBeLessThan(copy)
  })

  // Review of the CI fix 2026-10-20 (minor 1): an end only asks; the program is replaced once its
  // server has stopped, and not at all while it still runs.
  const taskState = (sys: ReturnType<typeof fakeSys>, enabled: boolean, running: number) => {
    const state = {
      match: /mm:task-state/,
      status: 0,
      stdout: `enabled ${enabled}\nrunning ${running}\nprocesses 0`,
    }
    sys.responses.unshift(state)
    return state
  }
  it('replaces the program once the ended server has stopped', async () => {
    const sys = fakeSys('win32')
    const state = taskState(sys, true, 1)
    sys.onSleep = () => (state.stdout = 'enabled False\nrunning 0\nprocesses 0')
    const { code } = await run(sys, ['install'])
    expect(code).toBe(0)
    const end = sys.commands.indexOf('schtasks /End /TN Mongo Manager')
    const slept = sys.commands.indexOf('sleep 500')
    const copy = sys.commands.indexOf('copyProgram C:\\Program Files\\Mongo Manager\\app')
    expect(end).toBeLessThan(slept)
    expect(slept).toBeLessThan(copy)
  })

  it('replaces nothing while the ended server still runs, and leaves the task as it was', async () => {
    const sys = fakeSys('win32')
    taskState(sys, true, 1)
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/did not stop within 30 seconds/)
    expect(sys.commands.filter((c) => c === 'sleep 500')).toHaveLength(60)
    expect(sys.commands.some((c) => c.startsWith('copyProgram'))).toBe(false)
    expect(sys.commands.slice(-2)).toEqual([
      'schtasks /Change /TN Mongo Manager /ENABLE',
      'schtasks /Run /TN Mongo Manager',
    ])
  })

  // Review of the CI fix 2026-10-20 (minor 2): a task its administrator had disabled stays so.
  it('leaves a disabled task disabled when replacing the program fails', async () => {
    const sys = fakeSys('win32')
    taskState(sys, false, 0)
    sys.copyProgram = () => {
      throw new Error('EPERM: operation not permitted, rename')
    }
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    // Third review (minor 9): it was still ended for the copy, and nothing said it was started.
    expect(sys.commands).toContain('schtasks /End /TN Mongo Manager')
    expect(sys.commands).not.toContain('schtasks /Change /TN Mongo Manager /ENABLE')
    expect(sys.commands).not.toContain('schtasks /Run /TN Mongo Manager')
    expect(io.err()).not.toMatch(/started again/)
  })

  // Third review of the CI fix 2026-10-20 (minor 6): nor when its server did not stop.
  it('leaves a disabled task disabled when its server does not stop', async () => {
    const sys = fakeSys('win32')
    taskState(sys, false, 1)
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/did not stop within 30 seconds/)
    expect(sys.commands).not.toContain('schtasks /Change /TN Mongo Manager /ENABLE')
    expect(sys.commands).not.toContain('schtasks /Run /TN Mongo Manager')
  })

  // Third review (minor 1): a state that cannot be read is never taken for a stopped server.
  it('changes nothing when the registered task cannot be read', async () => {
    const sys = fakeSys('win32')
    sys.responses.unshift({ match: /mm:task-state/, status: 1 })
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/could not read the scheduled task/)
    expect(sys.commands.some((c) => /^schtasks \/(Change|End|Create|Run)/.test(c))).toBe(false)
    expect(sys.commands.some((c) => c.startsWith('copyProgram'))).toBe(false)
  })

  // Third review (minor 8): a program its server's own processes (a shell worker) still run is not
  // replaced either.
  it('waits for the processes the program runs, after the task has stopped', async () => {
    const sys = fakeSys('win32')
    const state = taskState(sys, true, 0)
    state.stdout = state.stdout.replace('processes 0', 'processes 1')
    sys.onSleep = () => (state.stdout = 'enabled False\nrunning 0\nprocesses 0')
    expect((await run(sys, ['install'])).code).toBe(0)
    expect(sys.commands).toContain('sleep 500')
    expect(sys.commands.indexOf('sleep 500')).toBeLessThan(
      sys.commands.indexOf('copyProgram C:\\Program Files\\Mongo Manager\\app'),
    )
  })

  // Third review (minor 3): a reinstall enables the task again, and says so.
  it('says when the install enabled a task its administrator had disabled', async () => {
    const sys = fakeSys('win32')
    taskState(sys, false, 0)
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(0)
    expect(io.err()).toMatch(/had been disabled; this install enabled it again/)
  })

  it('disables it again when the install stops after registering it', async () => {
    const sys = fakeSys('win32')
    taskState(sys, false, 0)
    sys.responses.push({ match: /^schtasks \/Run/, status: 1 })
    const { code } = await run(sys, ['install'])
    expect(code).toBe(1)
    // Fifth review (minor 4): and the server its registration started is ended.
    const after = sys.commands.slice(sys.commands.lastIndexOf('schtasks /Change /TN Mongo Manager /DISABLE'))
    expect(after[0]).toBe('schtasks /Change /TN Mongo Manager /DISABLE')
    expect(after[1]).toBe('schtasks /End /TN Mongo Manager')
  })

  // Fifth review of the CI fix 2026-10-20 (important 1): run from the installed copy, the
  // installer's own process runs from the program folder; it is not waited for.
  it('waits for what runs from the program folder, the installer itself aside', async () => {
    const sys = fakeSys('win32')
    taskState(sys, true, 0)
    expect((await run(sys, ['install'])).code).toBe(0)
    const look = sys.commands.find((c) => /mm:task-state/.test(c))!
    expect(JSON.parse(look.slice(look.lastIndexOf(' INPUT=') + 7))).toMatchObject({ self: process.pid })
    expect(look).toMatch(/\$_\.ProcessId -ne \$in\.self/)
  })

  // Fifth review (minor 5): what could not be read is said, and a look without the processes is
  // one that could not be read.
  it('says why the task could not be read', async () => {
    const sys = fakeSys('win32')
    sys.responses.unshift({ match: /mm:task-state/, status: 0, stdout: 'enabled True\nrunning 0' })
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/could not read the scheduled task/)
    expect(io.err()).not.toMatch(/elevated/)
  })

  // Sixth review of the CI fix 2026-10-20 (minor 4, 7): what Windows said is passed on, and a count
  // that is not one is no count.
  it('passes on what Windows said, and takes no number for nothing running', async () => {
    const said = fakeSys('win32')
    said.responses.unshift({ match: /mm:task-state/, status: 1, stdout: 'COM error 0x80070005' })
    expect((await run(said, ['install'])).io.err()).toMatch(/\(COM error 0x80070005\)/)
    const silent = fakeSys('win32')
    silent.responses.unshift({ match: /mm:task-state/, status: 1 })
    expect((await run(silent, ['install'])).io.err()).toMatch(/\(no answer\)/)
    const odd = fakeSys('win32')
    odd.responses.unshift({
      match: /mm:task-state/,
      status: 0,
      stdout: 'enabled True\nrunning 0\nprocesses many',
    })
    const { code, io } = await run(odd, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/could not read the scheduled task/)
  })

  // Sixth review (minor 3): a server the failed registration started and that does not end is said.
  it('says when the server a failed registration started may still run', async () => {
    const sys = fakeSys('win32')
    taskState(sys, false, 0)
    sys.responses.push({ match: /^schtasks \/Run/, status: 1 })
    const state = sys.responses.find((r) => r.match.source === 'mm:task-state')!
    // Running from its registration on, it never ends (seventh review, minor 4: told by a hook).
    sys.onRun = (line) => {
      if (line.startsWith('schtasks /Create')) state.stdout = 'enabled False\nrunning 1\nprocesses 0'
    }
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/the server it started may still run; stop it with schtasks \/End/)
    const created = sys.commands.findIndex((c) => c.startsWith('schtasks /Create'))
    expect(sys.commands.slice(created)).toContain('schtasks /Change /TN Mongo Manager /DISABLE')
  })

  it('brings the earlier server back when replacing the program fails', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    sys.copyProgram = () => {
      throw new Error('EPERM: operation not permitted, rename')
    }
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/EPERM/)
    expect(sys.commands.slice(-2)).toEqual([
      'schtasks /Change /TN Mongo Manager /ENABLE',
      'schtasks /Run /TN Mongo Manager',
    ])
  })

  it('uninstalls the task and program and keeps ProgramData', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    // Third review of the CI fixes (minor 4): what a failed install left beside it goes too.
    const app = 'C:\\Program Files\\Mongo Manager\\app'
    sys.files.set(`${app}.new\\bin\\node.exe`, { content: 'half', mode: 0o755 })
    const done = sys.commands.length
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(0)
    // Review of the CI fix 2026-10-20 (minor 2): disabled first, so its one-minute repetition
    // cannot start it again between the end and the removal.
    expect(
      sys.commands
        .slice(done)
        .filter((c) => c.startsWith('schtasks') && !c.startsWith('schtasks /Query'))
        .slice(0, 3),
    ).toEqual([
      'schtasks /Change /TN Mongo Manager /DISABLE',
      'schtasks /End /TN Mongo Manager',
      'schtasks /Delete /TN Mongo Manager /F',
    ])
    expect([...sys.files.keys()].filter((k) => k.startsWith(app))).toEqual([])
    expect(sys.files.has('C:\\ProgramData\\Mongo Manager\\config.json')).toBe(true)
    // Seventh review of the CI fix 2026-10-20 (minor 3): the folder that held it goes when empty.
    expect(sys.commands).toContain('rmdir-if-empty C:\\Program Files\\Mongo Manager')
  })

  // Review of the CI fix 2026-10-20 (minor 1, 2, 4).
  it('removes the program once the ended server has stopped', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    const state = { match: /mm:task-state/, status: 0, stdout: 'enabled True\nrunning 1\nprocesses 0' }
    sys.responses.unshift(state)
    sys.onSleep = () => (state.stdout = 'enabled False\nrunning 0\nprocesses 0')
    const done = sys.commands.length
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(0)
    const after = sys.commands.slice(done)
    expect(after.indexOf('schtasks /End /TN Mongo Manager')).toBeLessThan(after.indexOf('sleep 500'))
    expect(after.indexOf('sleep 500')).toBeLessThan(after.indexOf('schtasks /Delete /TN Mongo Manager /F'))
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(false)
  })

  it('removes nothing while the ended server still runs', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    sys.responses.unshift({
      match: /mm:task-state/,
      status: 0,
      stdout: 'enabled True\nrunning 1\nprocesses 0',
    })
    const done = sys.commands.length
    const { code, io } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/did not stop within 30 seconds; nothing was removed/)
    expect(sys.commands.slice(done)).not.toContain('schtasks /Delete /TN Mongo Manager /F')
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(true)
    expect(sys.commands.slice(-2)).toEqual([
      'schtasks /Change /TN Mongo Manager /ENABLE',
      'schtasks /Run /TN Mongo Manager',
    ])
  })

  it('keeps a disabled task disabled when it cannot be removed', async () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    sys.responses.unshift({
      match: /mm:task-state/,
      status: 0,
      stdout: 'enabled False\nrunning 0\nprocesses 0',
    })
    sys.responses.push({ match: /^schtasks \/Delete/, status: 1 })
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(sys.commands).not.toContain('schtasks /Change /TN Mongo Manager /ENABLE')
    expect(sys.commands).not.toContain('schtasks /Run /TN Mongo Manager')
  })

  it('removes nothing when the registered task cannot be read', async () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    sys.responses.unshift({ match: /mm:task-state/, status: 1 })
    const { code, io } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(/could not read the scheduled task/)
    expect(sys.commands.some((c) => /^schtasks \/(Change|End|Delete)/.test(c))).toBe(false)
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(true)
  })

  it('refuses to uninstall from the installed copy, which runs from the folder it would remove', () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    const io = fakeIo({ env })
    const layout = layoutFor('win32', env)
    expect(() =>
      uninstallWindows(sys, io, layout, 'C:\\Program Files\\Mongo Manager\\app\\bin\\node.exe'),
    ).toThrow(/from the mongo-manager package.*not from the installed copy/)
    // Sixth review (minor 1, 6): the standalone binary, named in another case or by another path
    // to it, too; and it is told how.
    expect(() =>
      uninstallWindows(sys, io, layout, 'c:\\program files\\MONGO MANAGER\\app\\bin\\mongo-manager.exe'),
    ).toThrow(/copy bin\\mongo-manager\.exe elsewhere and run it from there/)
    // Seventh review (minor 1): a short (8.3) name is only made long by the system's own resolving.
    sys.longNames.set(
      'C:\\PROGRA~1\\MONGOM~1\\app\\bin\\mongo-manager.exe',
      'C:\\Program Files\\Mongo Manager\\app\\bin\\mongo-manager.exe',
    )
    expect(() =>
      uninstallWindows(sys, io, layout, 'C:\\PROGRA~1\\MONGOM~1\\app\\bin\\mongo-manager.exe'),
    ).toThrow(/not from the installed copy/)
    // Seventh review (minor 5): only the standalone binary is told to copy itself elsewhere.
    expect(() =>
      uninstallWindows(sys, io, layout, 'C:\\Program Files\\Mongo Manager\\app\\bin\\node.exe'),
    ).not.toThrow(/mongo-manager\.exe elsewhere/)
    // Eighth review (minor 1): nor in what a failed install left beside it, removed too.
    expect(() =>
      uninstallWindows(
        sys,
        io,
        layout,
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files\\Mongo Manager\\app.old\\bin',
      ),
    ).toThrow(/a prompt whose folder is .*app\.old\\bin/)
    // Seventh review: nor from a prompt whose folder is in it (Windows cannot remove that either).
    expect(() =>
      uninstallWindows(
        sys,
        io,
        layout,
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files\\Mongo Manager\\app\\dist',
      ),
    ).toThrow(/a prompt whose folder is .*app\\dist/)
    expect(sys.commands.some((c) => /^schtasks \/(Change|End|Delete)/.test(c))).toBe(false)
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(true)
  })

  // Eighth review (minor 2): a folder something else holds says what was done and what to do.
  it('says the task went and how to finish when a folder cannot be removed', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    const remove = sys.remove
    sys.remove = (p) => {
      if (p === 'C:\\Program Files\\Mongo Manager\\app')
        throw new Error('EBUSY: resource busy or locked, rmdir')
      remove(p)
    }
    const { code, io } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(io.err()).toMatch(
      /The scheduled task was removed, but .*app could not be: EBUSY.*Close what uses it and run service uninstall again/,
    )
  })

  // Ninth review (important 1): the folder that held it is only tidied; one held is said, the
  // uninstall still done.
  it('is done when the folder that held the program cannot be removed', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    sys.removeEmptyDir = () => 'EBUSY'
    const { code, io } = await run(sys, ['uninstall'])
    expect(code).toBe(0)
    expect(io.out()).toMatch(/Mongo Manager was removed/)
    expect(io.out()).toMatch(/C:\\Program Files\\Mongo Manager was left \(EBUSY\); remove it yourself/)
  })

  // Sixth review (minor 2): a state it could not read enables nothing.
  it('enables nothing when no task is registered and the state cannot be read', async () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    sys.responses.push({ match: /^schtasks /, status: 1 })
    sys.responses.unshift({ match: /mm:task-state/, status: 1 })
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(sys.commands).not.toContain('schtasks /Change /TN Mongo Manager /ENABLE')
    expect(sys.commands).not.toContain('schtasks /Run /TN Mongo Manager')
  })

  it('removes the program when no task is registered', async () => {
    const sys = fakeSys('win32')
    sys.dirs.set('C:\\Program Files\\Mongo Manager\\app', 0o755)
    // No task: the state script finds none, and every schtasks call fails.
    sys.responses.push({ match: /^schtasks /, status: 1 })
    const { code, io } = await run(sys, ['uninstall'])
    expect(code).toBe(0)
    expect(io.out()).toMatch(/Mongo Manager was removed/)
    expect(sys.dirs.has('C:\\Program Files\\Mongo Manager\\app')).toBe(false)
    expect(sys.commands).not.toContain('schtasks /Change /TN Mongo Manager /ENABLE')
    expect(sys.commands).not.toContain('schtasks /Run /TN Mongo Manager')
  })

  // Fourth review of the CI fixes (minor 4): a removal that fails leaves the program in place, never
  // an .old alone that a later install would put back.
  it('removes the program last, so a failed removal leaves it in place', async () => {
    const sys = fakeSys('win32')
    await run(sys, ['install'])
    const app = 'C:\\Program Files\\Mongo Manager\\app'
    sys.files.set(`${app}.old\\bin\\node.exe`, { content: 'earlier', mode: 0o755 })
    const remove = sys.remove
    sys.remove = (p) => {
      if (p.endsWith('.old')) throw new Error(`EBUSY: ${p}`)
      remove(p)
    }
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(1)
    expect(sys.files.has(`${app}\\bin\\node.exe`)).toBe(true)
  })
})

describe('doctor on Windows (Review Focus 3)', () => {
  it('warns when everyone on the machine can read the data directory', async () => {
    const dir = tempDir()
    const io = fakeIo()
    const sys = fakeSys('win32')
    sys.responses.push({ match: /^powershell/, status: 0, stdout: 'S-1-5-18\nS-1-5-32-545\n' })
    await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
    expect(io.out()).toMatch(/\[warn\] Data directory .* is readable by all users.*icacls/)
  })

  // Review of the ACL reads (second review, minors 1 to 3): each data file's own ACL is read, its
  // own grants alone where the directory already said so, and the service's are given its folder's
  // rules back.
  describe('reads each data file', () => {
    const files = ['mongo-manager.db', 'secret.key']
    const make = (dir: string) => {
      mkdirSync(dir, { recursive: true })
      for (const f of files) writeFileSync(join(dir, f), 'x')
    }
    const looks = (sys: ReturnType<typeof fakeSys>, path: string) =>
      sys.commands.filter((c) => /mm:acl-sids/.test(c) && c.includes(JSON.stringify({ path }).slice(1, -1)))

    it('warns of a file open on its own, with the command that closes it', async () => {
      const dir = tempDir()
      make(dir)
      const key = join(dir, 'secret.key')
      const io = fakeIo()
      const sys = fakeSys('win32')
      sys.responses.push({
        match: /mm:acl-sids[\s\S]*secret\.key/,
        status: 0,
        stdout: 'S-1-5-18\nS-1-5-32-545\n',
      })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\n' })
      await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
      expect(io.out()).toContain(`[ok] Data directory ${dir}\n`)
      expect(io.out()).toContain(
        `[warn] ${key} is readable by all users of this computer; restrict it in Command Prompt with: ` +
          `icacls "${key}" /inheritance:r /remove:g *S-1-1-0 *S-1-5-32-545 *S-1-5-11 *S-1-5-4 ` +
          '/grant:r *S-1-5-18:F *S-1-5-32-544:F "%USERNAME%:F"',
      )
      expect(io.out().match(/readable by all users/g)).toHaveLength(1)
      // All its grants: the directory said nothing.
      expect(looks(sys, key)[0]).not.toMatch(/IsInherited/)
    })

    it('reads only the files’ own grants where the directory is open, and says the directory once', async () => {
      const dir = tempDir()
      make(dir)
      const io = fakeIo()
      const sys = fakeSys('win32')
      sys.responses.push({ match: /mm:acl-sids[\s\S]*IsInherited/, status: 0, stdout: '' })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\nS-1-1-0\n' })
      await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
      expect(io.out().match(/readable by all users/g)).toHaveLength(1)
      expect(io.out()).toContain(`[warn] Data directory ${dir} is readable by all users`)
      for (const f of files) expect(looks(sys, join(dir, f))[0]).toMatch(/IsInherited/)
    })

    it('says when a file’s permissions could not be read', async () => {
      const dir = tempDir()
      make(dir)
      const db = join(dir, 'mongo-manager.db')
      const io = fakeIo()
      const sys = fakeSys('win32')
      sys.responses.push({ match: /mm:acl-sids[\s\S]*mongo-manager\.db/, status: 1 })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\n' })
      await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
      expect(io.out()).toContain(
        `[warn] The permissions of data file ${db} could not be read; check them with: icacls "${db}"`,
      )
    })

    it('takes only the broad grants from the service’s data directory and files', async () => {
      const programData = tempDir()
      const io = fakeIo({ env: { ProgramData: programData } })
      // A path of this system's (third review, minor: win32.join made a relative one on POSIX).
      const dir = join(programData, 'Mongo Manager', 'data')
      make(dir)
      const key = join(dir, 'secret.key')
      const sys = fakeSys('win32')
      sys.responses.push({ match: /mm:acl-sids[\s\S]*secret\.key/, status: 0, stdout: 'S-1-5-32-545\n' })
      sys.responses.push({ match: /mm:acl-sids[\s\S]*IsInherited/, status: 0, stdout: '' })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-11\n' })
      await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
      const remove = '/remove:g *S-1-1-0 *S-1-5-32-545 *S-1-5-11 *S-1-5-4'
      expect(io.out()).toContain(
        `[warn] Data directory ${dir} is readable by all users of this computer; restrict it keeping the ` +
          `service's own access, with: icacls "${dir}" ${remove} /T`,
      )
      expect(io.out()).toContain(
        `[warn] ${key} is readable by all users of this computer; restrict it keeping the service's own ` +
          `access, with: icacls "${key}" ${remove}`,
      )
    })
  })

  // Review of the ops fixes (I1): another account that owns it can change its ACL whenever it likes.
  it('warns when another account owns the data directory, and not when this one does', async () => {
    const dir = tempDir()
    const ask = async (owner: string) => {
      const io = fakeIo()
      const sys = fakeSys('win32')
      sys.responses.push({
        match: /mm:acl-owner/,
        status: 0,
        stdout: `owner ${owner}\nme S-1-5-21-1-2-3-1001\n`,
      })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\nS-1-5-21-1-2-3-1001\n' })
      await doctor(resolveConfig({ cli: { dataDir: dir } }), { ...io, platform: 'win32' }, { sys })
      return io.out()
    }
    expect(await ask('S-1-5-21-1-2-3-1005')).toMatch(
      /\[warn\] Data directory .* is owned by S-1-5-21-1-2-3-1005/,
    )
    expect(await ask('S-1-5-21-1-2-3-1001')).not.toMatch(/is owned by/)
    expect(await ask('S-1-5-32-544')).not.toMatch(/is owned by/)
  })

  // Fourth review of the CI fixes (minor 8): the same of a log file named for it; the service's own
  // is its account's.
  it('warns when another account owns the log file, not for the service its own', async () => {
    const dir = tempDir()
    const ask = async (log: string, owner: string) => {
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(log, 'line\n')
      const io = fakeIo({ env: { ProgramData: dir } })
      const sys = fakeSys('win32')
      sys.responses.push({
        match: /mm:acl-owner/,
        status: 0,
        stdout: `owner ${owner}\nme S-1-5-21-1-2-3-1001\n`,
      })
      sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\nS-1-5-21-1-2-3-1001\n' })
      await doctor(
        resolveConfig({ cli: { dataDir: join(dir, 'data'), logFile: log } }),
        { ...io, platform: 'win32' },
        { sys },
      )
      return io.out()
    }
    const mine = join(dir, 'mm.log')
    expect(await ask(mine, 'S-1-5-21-1-2-3-1005')).toContain(
      `[warn] Log file ${mine} is owned by S-1-5-21-1-2-3-1005, not by this account or the administrators: that account can change who reads it. Name a log file this account makes.`,
    )
    expect(await ask(mine, 'S-1-5-21-1-2-3-1001')).toContain(`[ok] Log file ${mine}\n`)
    const service = join(dir, 'Mongo Manager', 'logs', 'mongo-manager.log')
    expect(await ask(service, 'S-1-5-19')).toContain(`[ok] Log file ${service}\n`)
  })

  // Fifth review of the CI fixes (minor 3): an owner that cannot be read is said, as for the data
  // directory.
  it('warns when the owner of the log file cannot be read', async () => {
    const dir = tempDir()
    const log = join(dir, 'mm.log')
    writeFileSync(log, 'line\n')
    const io = fakeIo({ env: { ProgramData: dir } })
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:acl-owner/, status: 1 })
    sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\nS-1-5-21-1-2-3-1001\n' })
    await doctor(
      resolveConfig({ cli: { dataDir: join(dir, 'data'), logFile: log } }),
      { ...io, platform: 'win32' },
      { sys },
    )
    expect(io.out()).toContain(
      `[warn] The owner of log file ${log} could not be read; check it with: icacls "${log}"\n`,
    )
    expect(io.out()).not.toContain(`[ok] Log file ${log}\n`)
  })
})

// CI 2026-10-21: every script is run as powershellArgs makes it, so it looks for no module.
describe('PowerShell on Windows', () => {
  it('runs each script importing the modules it uses, those every script uses and any it names', () => {
    const sys = fakeSys('win32')
    runPowerShell(sys, "'plain'", {})
    runPowerShell(sys, "'more'", {}, ['CimCmdlets'])
    const head =
      /^powershell [\s\S]*?\n\$PSModuleAutoLoadingPreference = 'None'\nImport-Module -Name "\$PSHOME\\Modules\\Microsoft\.PowerShell\.Management", [^\n]*/
    const [plain, more] = sys.commands.map((c) => c.match(head)?.[0])
    expect(plain).toMatch(/Utility"$/)
    expect(more).toMatch(/Utility", "\$PSHOME\\Modules\\CimCmdlets"$/)
  })
})
