import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { ensureDataDir, repairPrivate } from '../src/store/datadir'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'
import { openLogFile } from '../src/http/log-file'
import { powershellEnv, windowsTool } from '../src/windows-tools'

/**
 * Security review 2026-10-13 (ops): POSIX data directories are made 0700, but on Windows a data
 * directory made under a shared folder inherited its ACL — often readable by every user of the
 * computer (the key, sealed secrets and password hashes inside). A directory Mongo Manager makes is
 * made with its own ACL in one step (its review, I1); one the person made is left as it is.
 * Compared by SID, never by name: names differ by the language of Windows (its review, I3).
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
/** The SIDs a directory's ACL allows, read with Windows' own tools. */
const sids = (dir: string): string[] =>
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Acl -LiteralPath $env:MM_PROBE).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }",
    ],
    { encoding: 'utf8', env: powershellEnv({ MM_PROBE: dir }) },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
/** Who owns a path, by SID. */
const ownerOf = (path: string): string =>
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Item -LiteralPath $env:MM_PROBE -Force).GetAccessControl('Owner').GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    ],
    { encoding: 'utf8', env: powershellEnv({ MM_PROBE: path }) },
  ).trim()
/** Whether this process runs with an administrator's full rights (Windows only). */
const elevated = () =>
  process.platform === 'win32' && spawnSync(windowsTool('net'), ['session'], { stdio: 'ignore' }).status === 0
/** Everyone, Users, Authenticated Users, Interactive. */
const BROAD = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4']
let me: string | undefined
/**
 * Makes paths this account's own, as a person's own folder is. CI 2026-10-19: GitHub's runner runs
 * elevated, so what a test makes is owned by Administrators, and the repair rightly leaves it alone
 * (see the elevated tests below); these tests are about what this account owns.
 */
const ownedByMe = (...paths: string[]) => {
  me ??= execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', env: powershellEnv() },
  ).trim()
  for (const p of paths) {
    execFileSync(icacls, [p, '/setowner', `*${me}`])
    expect(ownerOf(p)).toBe(me)
  }
}

describe.runIf(process.platform === 'win32')('a data directory made on Windows', () => {
  it('is kept to the system, administrators and its own account, whatever its parent allows', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    execFileSync(icacls, [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    expect(sids(parent)).toContain('S-1-5-32-545')
    const made = join(parent, 'data with spaces; $(x)')
    ensureDataDir(made)
    const allowed = sids(made)
    expect(allowed.filter((s) => BROAD.includes(s))).toEqual([])
    expect(allowed).toContain('S-1-5-18')
    expect(allowed).toContain('S-1-5-32-544')
    writeFileSync(join(made, 'secret.key'), 'x')
    // One the person made is theirs to set.
    const own = join(parent, 'own')
    mkdirSync(own)
    ensureDataDir(own)
    expect(sids(own)).toContain('S-1-5-32-545')
  })

  // Security audit 2026-10-16 (minor): one already there that every user may read (made by an older
  // version, or by hand under a shared folder) is made private at start, its key and log file too;
  // one the person narrowed themselves is left as it is.
  it('makes an existing directory, key and log file private when every user may read them', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    execFileSync(icacls, [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    const dir = join(parent, 'data')
    mkdirSync(dir)
    writeFileSync(join(dir, 'secret.key'), 'k')
    writeFileSync(join(parent, 'mm.log'), 'l')
    ownedByMe(dir, join(dir, 'secret.key'), join(parent, 'mm.log'))
    for (const p of [dir, join(dir, 'secret.key'), join(parent, 'mm.log')])
      expect(sids(p)).toContain('S-1-5-32-545')
    // The key inherits from the directory: repairing the directory repairs it too.
    const repaired = repairPrivate([
      dir,
      join(dir, 'secret.key'),
      join(parent, 'mm.log'),
      join(dir, 'missing'),
    ])
    expect(repaired.map((r) => r.path)).toEqual([dir, join(parent, 'mm.log')])
    // What the ACL was is kept for the log (it can be put back by hand).
    for (const r of repaired) expect(r.was).toMatch(/^D:/)
    for (const p of [dir, join(dir, 'secret.key'), join(parent, 'mm.log')]) {
      const allowed = sids(p)
      expect(allowed.filter((s) => BROAD.includes(s))).toEqual([])
      expect(allowed).toContain('S-1-5-18')
    }
    // A file made inside it later is private too (it inherits the directory's own rules).
    writeFileSync(join(dir, 'later.db'), 'x')
    expect(sids(join(dir, 'later.db')).filter((s) => BROAD.includes(s))).toEqual([])
    // Nothing left to repair.
    expect(repairPrivate([dir, join(dir, 'secret.key')])).toEqual([])
  })

  // Independent review of the security pass (I5): the repair must never strip a shared folder.
  it('takes only the broad grants away, keeping every other one', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const dir = join(parent, 'data')
    mkdirSync(dir)
    writeFileSync(join(dir, 'mongo-manager.db'), 'x')
    execFileSync(icacls, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)R', '*S-1-5-19:(OI)(CI)R'])
    ownedByMe(dir)
    expect(repairPrivate([dir]).map((r) => r.path)).toEqual([dir])
    const allowed = sids(dir)
    expect(allowed).toContain('S-1-5-19')
    expect(allowed.filter((s) => BROAD.includes(s))).toEqual([])
    // This account keeps its own access (it may have had it through Users alone).
    writeFileSync(join(dir, 'still-writable'), 'y')
  })

  // Review of the module imports (outside it): ALL APPLICATION PACKAGES has a name Windows cannot
  // turn back into its SID, so a repair that named each entry stopped, leaving the directory open.
  it('takes the broad grants away beside an app package’s, keeping that', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const dir = join(parent, 'data')
    mkdirSync(dir)
    writeFileSync(join(dir, 'mongo-manager.db'), 'x')
    execFileSync(icacls, [dir, '/grant', '*S-1-1-0:(OI)(CI)R', '*S-1-15-2-1:(OI)(CI)R'])
    ownedByMe(dir)
    expect(repairPrivate([dir]).map((r) => r.path)).toEqual([dir])
    const allowed = sids(dir)
    expect(allowed).toContain('S-1-15-2-1')
    expect(allowed.filter((s) => BROAD.includes(s))).toEqual([])
  })

  it('leaves alone a folder that is not a data directory, a drive root, a share and another owner’s', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const shared = join(parent, 'team')
    mkdirSync(shared)
    writeFileSync(join(shared, 'notes.txt'), 'n')
    execFileSync(icacls, [shared, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    expect(repairPrivate([shared])).toEqual([])
    expect(sids(shared)).toContain('S-1-5-32-545')
    // Owned by SYSTEM, open to Users: looked at only (a dry run), never repaired — a full one, and an
    // empty one (which looks like a new data directory) found under Windows' own folder.
    const programData = process.env.ProgramData ?? win32.join('C:', 'ProgramData')
    expect(repairPrivate([programData], { dryRun: true })).toEqual([])
    const systemEmpty = execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-ChildItem $env:SystemRoot -Directory -ErrorAction SilentlyContinue | Where-Object { try { (@(Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction Stop).Count -eq 0) -and ($_.GetAccessControl('Owner').GetOwner([System.Security.Principal.SecurityIdentifier]).Value -in @('S-1-5-18','S-1-5-32-544')) -and (@($_.GetAccessControl('Access').GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' }).Count -gt 0) } catch { $false } } | Select-Object -First 1 -ExpandProperty FullName",
      ],
      { encoding: 'utf8', env: powershellEnv() },
    ).trim()
    if (systemEmpty) expect(repairPrivate([systemEmpty], { dryRun: true })).toEqual([])
    const roots = ['C:/', 'D:/', '//server/share/data'].map((p) => win32.normalize(p))
    expect(repairPrivate(roots, { dryRun: true })).toEqual([])
  })

  // Second review of the security pass (minor): the check is made before the start writes its own
  // files (its lock among them), so a shared folder named as the data directory stays as it is.
  it('leaves a shared folder named as the data directory as it is, through the real start', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const shared = join(parent, 'team')
    mkdirSync(shared)
    writeFileSync(join(shared, 'notes.txt'), 'n')
    execFileSync(icacls, [shared, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    const server = await startServer(resolveConfig({ cli: { dataDir: shared, webPort: 0 } }))
    await server.close()
    expect(sids(shared)).toContain('S-1-5-32-545')
  }, 60_000)

  it('makes a log file it opens in an open folder private, and notes it in the log', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    execFileSync(icacls, [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    const path = join(parent, 'mm.log')
    const stream = openLogFile(path)
    await new Promise<void>((r) => stream.end(r))
    expect(sids(path).filter((s) => BROAD.includes(s))).toEqual([])
    expect(readFileSync(path, 'utf8')).toMatch(/made private to this account/)
  })

  // CI 2026-10-18: GitHub's Windows steps run in PowerShell 7, which leaves its own module folders
  // first on PSModulePath; Windows PowerShell found a Get-Acl there it could not load, so no data
  // directory could be made, and the repair answered nothing.
  it('makes and repairs a data directory when started from PowerShell 7', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const modules = join(parent, 'ps7', 'Microsoft.PowerShell.Security', '7.0.0.0')
    mkdirSync(modules, { recursive: true })
    writeFileSync(
      join(modules, 'Microsoft.PowerShell.Security.psd1'),
      `@{ GUID = 'A94C8C7E-9810-47C0-B8AF-65089C13A35A'; ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '7.0'; CmdletsToExport = @('Get-Acl', 'Set-Acl'); NestedModules = @('Microsoft.PowerShell.Security.dll') }
`,
    )
    const was = process.env.PSModulePath
    process.env.PSModulePath = `${join(parent, 'ps7')};${was ?? ''}`
    try {
      ensureDataDir(join(parent, 'made'))
      const open = join(parent, 'open')
      mkdirSync(open)
      execFileSync(icacls, [open, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
      ownedByMe(open)
      expect(repairPrivate([open], { dryRun: true }).map((r) => r.path)).toEqual([open])
    } finally {
      if (was === undefined) delete process.env.PSModulePath
      else process.env.PSModulePath = was
    }
  })

  // CI 2026-10-18: run elevated (GitHub's runner, an administrator's console), what the server makes
  // is owned by Administrators, not by its account, and its own open data directory went unrepaired.
  it.runIf(elevated())('repairs what it makes when it runs elevated, owned by Administrators', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const dir = join(parent, 'data')
    mkdirSync(dir)
    writeFileSync(join(dir, 'secret.key'), 'k')
    expect(ownerOf(dir)).toBe('S-1-5-32-544')
    execFileSync(icacls, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    // Only where the caller says it is its own (review of the CI fixes, minor 5).
    expect(repairPrivate([dir])).toEqual([])
    expect(repairPrivate([dir], { made: true }).map((r) => r.path)).toEqual([dir])
    expect(sids(dir).filter((s) => BROAD.includes(s))).toEqual([])
  })

  // Review of the CI fixes (minor 5): run elevated, what Administrators own is not all the server's.
  it.runIf(elevated())('leaves alone what Administrators own that is not its own, run elevated', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const shared = join(parent, 'team')
    mkdirSync(shared)
    writeFileSync(join(shared, 'notes.txt'), 'n')
    execFileSync(icacls, [shared, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    expect(ownerOf(shared)).toBe('S-1-5-32-544')
    expect(repairPrivate([shared], { made: true })).toEqual([])
    expect(sids(shared)).toContain('S-1-5-32-545')
    // Another tool's log, already there: the server writes to it, but leaves its ACL as it is.
    const theirs = join(shared, 'tool.log')
    writeFileSync(theirs, 'theirs\n')
    const stream = openLogFile(theirs)
    await new Promise<void>((r) => stream.end(r))
    expect(sids(theirs)).toContain('S-1-5-32-545')
    // One the server's start made is its own.
    const ours = join(shared, 'mm.log')
    const made = openLogFile(ours)
    await new Promise<void>((r) => made.end(r))
    expect(sids(ours).filter((s) => BROAD.includes(s))).toEqual([])
  })

  // Second review (minor 11): one over its limit at the start is rotated first; the new one is private.
  it('makes the log file it rotates to at the start private too', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    execFileSync(icacls, [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    const path = join(parent, 'mm.log')
    writeFileSync(path, 'x'.repeat(200))
    ownedByMe(path)
    const stream = openLogFile(path, 100)
    // Third review (minor 2): the old content is made private before it is rotated away, the new
    // file after, and so is the file a rotation while writing opens.
    expect(readFileSync(`${path}.1`, 'utf8').startsWith('x'.repeat(200))).toBe(true)
    expect(sids(`${path}.1`).filter((s) => BROAD.includes(s))).toEqual([])
    expect(sids(path).filter((s) => BROAD.includes(s))).toEqual([])
    expect(readFileSync(path, 'utf8')).toMatch(/made private to this account/)
    stream.write(`${'y'.repeat(150)}\n`)
    // The repair runs apart from the write (PowerShell starts slowly on a busy machine): waited for.
    const end = Date.now() + 30_000
    while (sids(path).some((s) => BROAD.includes(s)) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 200))
    await new Promise<void>((r) => stream.end(r))
    expect(sids(path).filter((s) => BROAD.includes(s))).toEqual([])
    expect(sids(`${path}.1`).filter((s) => BROAD.includes(s))).toEqual([])
  }, 60_000)

  it('stops instead of leaving a directory it could not make private', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    // A file where a folder of the path should be: the directory cannot be made.
    writeFileSync(join(parent, 'file'), 'x')
    expect(() => ensureDataDir(join(parent, 'file', 'data'))).toThrow(/could not be made private/)
  })
})

describe.runIf(process.platform !== 'win32')('an existing data directory on POSIX', () => {
  // Security audit 2026-10-16 (minor): the same repair where modes are the permissions.
  it('takes group and other access away from the directory and its key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(dir)
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'secret.key'), 'k')
    chmodSync(join(dir, 'secret.key'), 0o644)
    expect(repairPrivate([dir, join(dir, 'secret.key')]).map((r) => r.path)).toEqual([
      dir,
      join(dir, 'secret.key'),
    ])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600)
    expect(repairPrivate([dir, join(dir, 'secret.key')])).toEqual([])
  })
})

describe('the server start repairs what it keeps (security audit 2026-10-16)', () => {
  it('makes an open data directory private and says so in its log', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    dirs.push(parent)
    const data = join(parent, 'data')
    mkdirSync(data)
    if (process.platform === 'win32') execFileSync(icacls, [data, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    else chmodSync(data, 0o755)
    const logFile = join(parent, 'mm.log')
    const server = await startServer(
      resolveConfig({ cli: { dataDir: data, webPort: 0, logLevel: 'info', logFile } }),
      { logger: true },
    )
    await server.close()
    expect(readFileSync(logFile, 'utf8')).toMatch(/made private to this account/)
    if (process.platform === 'win32') expect(sids(data).filter((s) => BROAD.includes(s))).toEqual([])
    else expect(statSync(data).mode & 0o777).toBe(0o700)
  }, 60_000)
})
