import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realSys } from '../../src/service/sys'
import { aclSids, inspectStateRoot } from '../../src/service/acl'
import { trustProblems } from '../../src/service/trust'
import { checkProgramLocation } from '../../src/service/common'
import { taskState } from '../../src/service/windows'
import { layoutFor } from '../../src/service/layout'
import { mySid, ownedByMe } from '../support'

/**
 * A new folder in the temporary one, by its long name: GitHub's runner has TEMP as
 * C:\Users\RUNNER~1\..., while the checks name what they find in full (third review of the CI fix
 * 2026-10-20, important 1).
 */
const tempFolder = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))

// Real PowerShell on Windows with the kinds of paths that broke argument passing (second review Y1):
// spaces, a semicolon and a subexpression. Only folders under the user's own temp are touched.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')(
  'PowerShell checks with hostile path names (second review Y1, Y3)',
  () => {
    const hostile = () => {
      const base = tempFolder('mm ps ')
      dirs.push(base)
      const dir = join(
        base,
        'Mongo Manager; Set-Content -Path pwned -Value 1 $(Set-Content -Path pwned2 -Value 1)',
      )
      mkdirSync(dir)
      return { base, dir }
    }

    it('reads SIDs of a folder with spaces and metacharacters, running none of them', () => {
      const { base, dir } = hostile()
      const sids = aclSids(realSys(), dir)!
      expect(sids.length).toBeGreaterThan(0)
      expect(sids.every((s) => /^S-1-/.test(s))).toBe(true)
      expect(existsSync(join(process.cwd(), 'pwned')) || existsSync(join(process.cwd(), 'pwned2'))).toBe(
        false,
      )
      expect(existsSync(join(base, 'pwned'))).toBe(false)
    })

    it('flags a user-owned state folder and a user-writable node.exe at such paths', () => {
      const { dir } = hostile()
      ownedByMe(dir)
      const sys = realSys()
      expect(inspectStateRoot(sys, dir, []).join()).toContain(`is owned by ${mySid()}`)
      const node = join(dir, 'node.exe')
      writeFileSync(node, '')
      expect(trustProblems(sys, node).length).toBeGreaterThan(0)
    })

    it('fails closed when the path does not exist or cannot be read', () => {
      expect(
        trustProblems(realSys(), join(tmpdir(), 'mm-missing folder', 'node.exe')).length,
      ).toBeGreaterThan(0)
    })

    it('refuses to prepare a state folder a user created, before changing its security (second review Y2)', async () => {
      const { dir } = hostile()
      ownedByMe(dir)
      const { prepareStateRoot } = await import('../../src/service/acl')
      const sys = realSys()
      const before = aclSids(sys, dir)!.sort()
      expect(() => prepareStateRoot(sys, dir, [join(dir, 'data')])).toThrow(`is owned by ${mySid()}`)
      expect(aclSids(sys, dir)!.sort()).toEqual(before)
      expect(existsSync(join(dir, 'data'))).toBe(false)
    })
  },
)

describe.skipIf(process.platform !== 'win32')('third review findings on a real Windows', () => {
  const temp = () => {
    const d = tempFolder('mm-third ')
    dirs.push(d)
    return d
  }

  it('does not trust an NTFS stream path (Important 1)', () => {
    const dir = temp()
    const file = join(dir, 'user.exe')
    writeFileSync(file, '')
    for (const p of [`${file}::$DATA`, `${file}:alt`])
      expect(trustProblems(realSys(), p).length).toBeGreaterThan(0)
  })

  it('reports errors as plain readable text (Minor 1)', async () => {
    const { runPowerShell } = await import('../../src/service/powershell')
    const r = runPowerShell(realSys(), `throw ('boom ' + $in.word)`, { word: 'çğüşöı' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom çğüşöı')
    expect(r.error).not.toContain('CLIXML')
  })

  // Review of the module imports (outside it): ALL APPLICATION PACKAGES has a name Windows cannot
  // turn back into its SID; read by name, the ACL could not be read at all.
  it('reads an app package’s grant beside a broad one', () => {
    const dir = join(temp(), 'packages')
    mkdirSync(dir)
    expect(spawnSync('icacls', [dir, '/grant', '*S-1-1-0:(R)', '*S-1-15-2-1:(R)']).status).toBe(0)
    expect(aclSids(realSys(), dir)).toEqual(expect.arrayContaining(['S-1-1-0', 'S-1-15-2-1']))
  })

  // Review of the ACL reads (minor 2; second review, nit): a grant a directory passes on counts where
  // it reaches the files made there, not where it reaches folders alone.
  it('reads a grant passed on to files, not one passed on to folders alone', () => {
    const files = join(temp(), 'files')
    const folders = join(temp(), 'folders')
    mkdirSync(files)
    mkdirSync(folders)
    expect(spawnSync('icacls', [files, '/grant', '*S-1-1-0:(OI)(IO)R']).status).toBe(0)
    expect(spawnSync('icacls', [folders, '/grant', '*S-1-1-0:(CI)(IO)R']).status).toBe(0)
    expect(aclSids(realSys(), files)).toContain('S-1-1-0')
    expect(aclSids(realSys(), folders)).not.toContain('S-1-1-0')
    expect(aclSids(realSys(), files, { own: true })).toContain('S-1-1-0')
  })

  it('lists only allowing entries (Minor 2)', () => {
    const dir = join(temp(), 'denied')
    mkdirSync(dir)
    expect(spawnSync('icacls', [dir, '/deny', '*S-1-1-0:(WD)']).status).toBe(0)
    expect(aclSids(realSys(), dir)).not.toContain('S-1-1-0')
  })
})

// CI 2026-10-20: a first install refused Program Files, since every signed-in user may make a
// folder in C:\ (Authenticated Users: AD). A folder is changed through its own rights; above it only
// what could take it away or change who may enter it counts. A file's folder is kept to all of them
// (DLLs load from there).
describe.skipIf(process.platform !== 'win32')(
  'trust of a folder and the folders above it (CI 2026-10-20)',
  () => {
    const temp = () => {
      const d = tempFolder('mm-up ')
      dirs.push(d)
      return d
    }
    const grant = (path: string, rights: string, sid = 'S-1-5-32-545') =>
      expect(spawnSync('icacls', [path, '/grant', `*${sid}:${rights}`]).status).toBe(0)
    const users = (problems: string[], where: string) => problems.includes(`S-1-5-32-545 can change ${where}`)
    const passes = (problems: string[], where: string, sid = 'S-1-5-32-545') =>
      problems.includes(`${sid} can change what is made in ${where}`)

    // Seventh review of the CI fix 2026-10-20 (minor 1): the system's own resolving makes a short
    // (8.3) name long, which the uninstall's check of where it runs from relies on.
    it('resolves a short (8.3) name to its long one', (ctx) => {
      const long = join(temp(), 'a long folder name')
      mkdirSync(long)
      // The path goes as data, the answer as UTF-8, whatever is in either (eighth review, minor 5).
      const r = spawnSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-Command',
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
            '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:MM_LONG).ShortPath',
        ],
        { encoding: 'utf8', env: { ...process.env, MM_LONG: long } },
      )
      expect(r.status, r.stderr).toBe(0)
      const short = r.stdout.trim()
      // A volume with short names turned off has none to resolve.
      if (short.toLowerCase() === long.toLowerCase()) ctx.skip()
      expect(short).not.toBe('')
      expect(realSys().realpathNative(short).toLowerCase()).toBe(long.toLowerCase())
    })

    // Ninth review of the CI fix 2026-10-20 (minor 2, 3): only an empty folder of its own goes;
    // anything else is left, said, never thrown.
    it('removes an empty folder only, never a link, and says why one is left', () => {
      const sys = realSys()
      const top = temp()
      const empty = join(top, 'empty')
      mkdirSync(empty)
      expect(sys.removeEmptyDir(empty)).toBeNull()
      expect(existsSync(empty)).toBe(false)
      expect(sys.removeEmptyDir(join(top, 'missing'))).toBeNull()
      const full = join(top, 'full')
      mkdirSync(full)
      writeFileSync(join(full, 'mine.txt'), 'x')
      expect(sys.removeEmptyDir(full)).toBeNull()
      expect(existsSync(join(full, 'mine.txt'))).toBe(true)
      const link = join(top, 'link')
      symlinkSync(full, link, 'junction')
      expect(sys.removeEmptyDir(link)).toBeNull()
      expect(existsSync(link)).toBe(true)
      const held = join(top, 'held')
      mkdirSync(held)
      const from = process.cwd()
      process.chdir(held)
      try {
        expect(sys.removeEmptyDir(held)).toMatch(/EBUSY|EPERM/)
      } finally {
        process.chdir(from)
      }
    })

    it('trusts Program Files, under a C:\\ where every user may make a folder', () => {
      const programs = process.env.ProgramFiles ?? 'C:\\Program Files'
      expect(trustProblems(realSys(), programs)).toEqual([])
      // As a first install finds it: no folder of ours yet, so Program Files itself is checked.
      const first = layoutFor('win32', { ...process.env, ProgramFiles: join(programs, 'mm-not-installed') })
      expect(existsSync(join(programs, 'mm-not-installed'))).toBe(false)
      expect(() => checkProgramLocation(realSys(), first)).not.toThrow()
    })

    it('flags a folder others may add to, but not its parent that only lets them make folders', () => {
      const top = temp()
      const dir = join(top, 'program')
      mkdirSync(dir)
      grant(top, '(AD)')
      expect(users(trustProblems(realSys(), dir), top)).toBe(false)
      grant(dir, '(AD)')
      expect(users(trustProblems(realSys(), dir), dir)).toBe(true)
      // Security review 2026-10-20 (minor 1): and one they may delete in.
      const emptied = join(top, 'emptied')
      mkdirSync(emptied)
      grant(emptied, '(DC)')
      expect(users(trustProblems(realSys(), emptied), emptied)).toBe(true)
    })

    // Security review 2026-10-20 (minor 3, 4): the folder the install makes its own in is checked on
    // what it passes on to them too, generic rights included; CREATOR OWNER is the administrator.
    it('flags what a folder passes on to what is made in it, where the install makes it', () => {
      const top = temp()
      grant(top, '(OI)(CI)(IO)(M)')
      expect(passes(trustProblems(realSys(), top), top)).toBe(false)
      expect(passes(trustProblems(realSys(), top, { below: true }), top)).toBe(true)
      // Above that folder, only what it was given counts (checked as its own entries).
      const inner = join(top, 'inner')
      mkdirSync(inner)
      expect(passes(trustProblems(realSys(), inner, { below: true }), top)).toBe(false)
      const generic = temp()
      grant(generic, '(OI)(CI)(IO)(GA)')
      expect(passes(trustProblems(realSys(), generic, { below: true }), generic)).toBe(true)
      const creator = temp()
      grant(creator, '(OI)(CI)(IO)(F)', 'S-1-3-0')
      expect(passes(trustProblems(realSys(), creator, { below: true }), creator, 'S-1-3-0')).toBe(false)
      grant(creator, '(OI)(CI)(IO)(F)', 'S-1-3-1')
      expect(passes(trustProblems(realSys(), creator, { below: true }), creator, 'S-1-3-1')).toBe(true)
    })

    it("flags a folder's parent others may delete in, and a file's folder others may add to", () => {
      const top = temp()
      const dir = join(top, 'program')
      mkdirSync(dir)
      grant(top, '(DC)')
      expect(users(trustProblems(realSys(), dir), top)).toBe(true)
      const other = temp()
      const file = join(other, 'node.exe')
      writeFileSync(file, '')
      grant(other, '(AD)')
      expect(users(trustProblems(realSys(), file), other)).toBe(true)
    })
  },
)

// CI 2026-10-18: GitHub's Windows steps run in PowerShell 7, which leaves its own module folders
// first on PSModulePath; Windows PowerShell then finds a Get-Acl there it cannot load, and every ACL
// check failed. And a bare name is looked up in the current folder, then the PATH: a schtasks.exe or
// powershell.exe left where an administrator runs `service install` would run as them.
describe.skipIf(process.platform !== 'win32')("Windows' own tools, by their place (CI 2026-10-18)", () => {
  const temp = () => {
    const d = tempFolder('mm-tools ')
    dirs.push(d)
    return d
  }
  /** A module folder like PowerShell 7's: a Microsoft.PowerShell.Security Windows PowerShell cannot load. */
  const ps7Modules = () => {
    const root = temp()
    const dir = join(root, 'Microsoft.PowerShell.Security', '7.0.0.0')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'Microsoft.PowerShell.Security.psd1'),
      `@{ GUID = 'A94C8C7E-9810-47C0-B8AF-65089C13A35A'; ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '7.0'; CmdletsToExport = @('Get-Acl', 'Set-Acl'); NestedModules = @('Microsoft.PowerShell.Security.dll') }\n`,
    )
    return root
  }
  const withEnv = <T>(name: string, value: string, run: () => T): T => {
    const was = process.env[name]
    process.env[name] = value
    try {
      return run()
    } finally {
      if (was === undefined) delete process.env[name]
      else process.env[name] = was
    }
  }

  it('reads an ACL when started from PowerShell 7', () => {
    const dir = temp()
    const sids = withEnv('PSModulePath', `${ps7Modules()};${process.env.PSModulePath ?? ''}`, () =>
      aclSids(realSys(), dir),
    )
    expect(sids).not.toBeNull()
    expect(sids!.length).toBeGreaterThan(0)
  })

  it('runs the schtasks of Windows, never one of the same name in the current folder or on the PATH', () => {
    const planted = temp()
    copyFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
      join(planted, 'schtasks.exe'),
    )
    const from = process.cwd()
    // Second review (important 1): Node looks in the current folder unless this is set, as it is in
    // some shells; a person's console does not set it.
    const was = process.env.NoDefaultCurrentDirectoryInExePath
    delete process.env.NoDefaultCurrentDirectoryInExePath
    try {
      // In the current folder only.
      process.chdir(planted)
      expect(realSys().run('schtasks', ['/?']).stdout).toMatch(/SCHTASKS/)
      process.chdir(from)
      // Earlier on the PATH only.
      const r = withEnv('PATH', `${planted};${process.env.PATH ?? ''}`, () =>
        realSys().run('schtasks', ['/?']),
      )
      expect(r.stdout).toMatch(/SCHTASKS/)
    } finally {
      process.chdir(from)
      if (was !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = was
    }
  })
})

// CI 2026-10-21: Windows PowerShell looks for no module (see powershellArgs), so a look that uses one
// beyond those every script imports names it.
describe.skipIf(process.platform !== 'win32')('the scheduled task, read on a real Windows', () => {
  it('reads a task that is not there, and that nothing runs from its folder', () => {
    const dir = tempFolder('mm-task ')
    dirs.push(dir)
    const layout = {
      ...layoutFor('win32', process.env),
      unit: `mongo-manager-none-${process.pid}`,
      programDir: dir,
    }
    expect(taskState(realSys(), layout)).toEqual({ task: null, processes: 0 })
  })
})
