// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { powershellArgs, powershellEnv, systemRoot, windowsTool } from '../windows-tools'

const DONE = 'MM-DATA-DIR-DONE'
const INPUT = 'MM_DATA_DIR'

/**
 * Made in one step with its final security, so nobody else can ever add to it or hold it open
 * (review of the first fix, I1: made first and restricted after, another user had a moment to plant
 * a file or keep a handle). SYSTEM, Administrators and this account only; then the result is
 * checked: no link, owned by one of those, empty.
 */
const MAKE_PRIVATE = `trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$path = $env:${INPUT}
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
$sec = New-Object System.Security.AccessControl.DirectorySecurity
$sec.SetAccessRuleProtection($true, $false)
foreach ($sid in @((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')), $me)) {
  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $none, 'Allow')))
}
if (Test-Path -LiteralPath $path) { throw "$path appeared while it was being made" }
$null = [System.IO.Directory]::CreateDirectory($path, $sec)
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "$path is a junction or link" }
$owner = (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if (@('S-1-5-18', 'S-1-5-32-544', $me.Value) -notcontains $owner) { throw "$path is owned by $owner" }
if (@(Get-ChildItem -LiteralPath $path -Force).Count -gt 0) { throw "$path is not empty" }
'${DONE}'`

function makePrivateWindows(dir: string): void {
  let out = ''
  let failure = ''
  try {
    out = execFileSync(windowsTool('powershell'), powershellArgs(MAKE_PRIVATE), {
      encoding: 'utf8',
      windowsHide: true,
      env: powershellEnv({ [INPUT]: dir }),
    })
  } catch (e) {
    failure = String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()
  }
  if (out.trim().split(/\r?\n/).at(-1)?.trim() !== DONE)
    throw new Error(
      `The data directory ${dir} could not be made private to this account (${failure || 'no answer'}). ` +
        'Create it yourself, readable by this account only, and start again.',
    )
}

const REPAIRED = 'MM-REPAIRED '
/** What the log says of a path repairPrivate changed. */
export const PRIVATE_NOTICE = 'made private to this account: it was open to every user of this computer'
const PATHS = 'MM_REPAIR_PATHS'

const DRY = 'MM_REPAIR_DRY'
const MADE = 'MM_REPAIR_MADE'
/** What a data directory holds (or nothing yet): any other folder is someone else's to set. */
const DATA_FILES = ['mongo-manager.db', 'secret.key']
const REPAIR_MS = 30_000

/**
 * Security audit 2026-10-16 (minor), narrowed by the independent review (I5): an existing path that
 * grants Everyone, Users, Authenticated Users or Interactive anything loses those grants — and only
 * those: every other entry stays (made explicit where it was inherited), and this account is given
 * full control so the server keeps its own access. Compared by SID, and read by SID (review of the
 * module imports: the name of an app package's entry could not be turned back into its SID, so the
 * repair stopped). Only a path owned by this account — or, where the caller says the paths are its
 * own (MADE), by whom it makes things owned by (CI 2026-10-18: run elevated, or as LocalSystem, what
 * it makes is owned by Administrators, so its own data directory went unrepaired; never another's
 * file owned by Administrators, review of the CI fixes, minor 5) — never one inside Windows' own
 * folder (see insideWindows), not a link, and for a directory one that holds a data directory's
 * files or nothing. Each change prints the ACL it had (SDDL), for the log. A dry run only says what
 * it would change.
 */
const REPAIR_PRIVATE = `trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$mine = @($me.Value)
if ($env:${MADE} -eq '1') { $mine += [System.Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value }
$broad = @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4')
$dry = $env:${DRY} -eq '1'
# Read by SID: the name of ALL APPLICATION PACKAGES cannot be turned back into its SID.
$rulesOf = { param($acl) $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) }
foreach ($path in ($env:${PATHS} -split "\`n")) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { continue }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
  $owner = $item.GetAccessControl('Owner').GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($mine -notcontains $owner) { continue }
  # The access rules alone: reading or writing the audit rules (SACL) needs a privilege it lacks.
  $acl = $item.GetAccessControl('Access')
  $dir = $item.PSIsContainer
  if ($dir) {
    $names = @(Get-ChildItem -LiteralPath $path -Force | ForEach-Object { $_.Name })
    if ($names.Count -gt 0 -and @($names | Where-Object { @(${DATA_FILES.map((f) => `'${f}'`).join(', ')}) -contains $_ }).Count -eq 0) { continue }
  }
  $open = @(& $rulesOf $acl | Where-Object { $_.AccessControlType -eq 'Allow' -and ($broad -contains $_.IdentityReference.Value) })
  if ($open.Count -eq 0) { continue }
  $was = $acl.Sddl
  if (-not $dry) {
    if (-not $acl.AreAccessRulesProtected) {
      $acl.SetAccessRuleProtection($true, $true)
      $item.SetAccessControl($acl)
      $item = Get-Item -LiteralPath $path -Force
      $acl = $item.GetAccessControl('Access')
    }
    foreach ($rule in @(& $rulesOf $acl)) {
      if ($rule.AccessControlType -eq 'Allow' -and ($broad -contains $rule.IdentityReference.Value)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    }
    $inherit = if ($dir) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', $inherit, [System.Security.AccessControl.PropagationFlags]::None, 'Allow')))
    $item.SetAccessControl($acl)
  }
  '${REPAIRED}' + $path + "\`t" + $was
}
'${DONE}'`

/** A path changed by repairPrivate, with the ACL (Windows: SDDL) or mode (POSIX) it had. */
export interface Repaired {
  path: string
  was: string
}

/** The PowerShell run that repairs `paths` (see REPAIR_PRIVATE). */
function repairCommand(paths: string[], dryRun: boolean, made: boolean) {
  return {
    file: windowsTool('powershell'),
    args: powershellArgs(REPAIR_PRIVATE),
    options: {
      encoding: 'utf8' as const,
      windowsHide: true,
      timeout: REPAIR_MS,
      env: powershellEnv({
        [PATHS]: paths.join('\n'),
        [DRY]: dryRun ? '1' : '0',
        [MADE]: made ? '1' : '0',
      }),
    },
  }
}

/** What REPAIR_PRIVATE printed: the paths it changed, with the ACL each had. */
function repairedFrom(out: string): Repaired[] {
  const lines = out.split(/\r?\n/).map((l) => l.trim())
  if (lines.filter(Boolean).at(-1) !== DONE) throw new Error('no answer')
  return lines
    .filter((l) => l.startsWith(REPAIRED))
    .map((l) => {
      const [path, was] = l.slice(REPAIRED.length).split('\t')
      return { path: path!, was: was ?? '' }
    })
}

/**
 * Windows' own folder and what is in it, by its real place: never ours to narrow, though
 * Administrators own much of it (CI 2026-10-18: an elevated server counts their folders as its own).
 */
const insideWindows = (p: string) => {
  const root = systemRoot()
  const real = (q: string) => {
    try {
      return win32.normalize(realpathSync.native(q)).toLowerCase()
    } catch {
      return win32.normalize(q).toLowerCase()
    }
  }
  const r = real(root).replace(/\\+$/, '')
  const w = real(p)
  return w === r || w.startsWith(`${r}\\`)
}

/** A drive's root or a network share: never a data directory of ours to narrow. */
const isRootOrShare = (p: string) => {
  const w = win32.normalize(p)
  return w.startsWith('\\\\') || win32.parse(w).root === w || /^[A-Za-z]:\\?$/.test(w)
}

/**
 * Security audit 2026-10-16 (minor): what the server keeps — its data directory, its key, its log
 * file — made private when it already exists open to everyone (made by an older version, by hand,
 * or under a shared folder): on Windows the broad grants taken away (see REPAIR_PRIVATE), on POSIX
 * group and other access (0700 / 0600). Never a drive root, a network share or a folder that is not
 * a data directory (independent review I5). Returns what it changed and how it was, for the log.
 */
export function repairPrivate(
  paths: string[],
  opts: {
    dryRun?: boolean
    /**
     * The paths are this process's own: its data directory and what is in it, or a log file it has
     * just created. Only then is one owned by whom this process makes things owned by taken as its.
     */
    made?: boolean
  } = {},
): Repaired[] {
  const present = repairable(paths)
  if (!present.length) return []
  if (process.platform === 'win32') {
    const { file, args, options } = repairCommand(present, opts.dryRun === true, opts.made === true)
    return repairedFrom(execFileSync(file, args, options))
  }
  return repairPosix(present, opts.dryRun === true)
}

/**
 * Third and fourth reviews of the CI fixes: repairPrivate without holding the server while
 * PowerShell runs (a log file a rotation opened); never a dry run.
 */
export async function repairPrivateLater(
  paths: string[],
  opts: { made?: boolean } = {},
): Promise<Repaired[]> {
  const present = repairable(paths)
  if (!present.length) return []
  if (process.platform !== 'win32') return repairPosix(present, false)
  const { file, args, options } = repairCommand(present, false, opts.made === true)
  const out = await new Promise<string>((resolve, reject) =>
    execFile(file, args, options, (e, stdout) => (e ? reject(e) : resolve(String(stdout)))),
  )
  return repairedFrom(out)
}

/** The paths repairPrivate may look at: there, never a drive root, a share or inside Windows. */
const repairable = (paths: string[]) =>
  paths.filter(
    (p) => existsSync(p) && !isRootOrShare(p) && !(process.platform === 'win32' && insideWindows(p)),
  )

function repairPosix(present: string[], dryRun: boolean): Repaired[] {
  const repaired: Repaired[] = []
  for (const p of present) {
    const stat = lstatSync(p)
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) continue
    if ((stat.mode & 0o077) === 0) continue
    if (stat.isDirectory()) {
      const names = readdirSync(p)
      if (names.length > 0 && !names.some((n) => DATA_FILES.includes(n))) continue
    }
    if (!dryRun) chmodSync(p, stat.isDirectory() ? 0o700 : 0o600)
    repaired.push({ path: p, was: (stat.mode & 0o777).toString(8) })
  }
  return repaired
}

/**
 * Makes the data directory when it is missing: 0700 on POSIX; on Windows kept to SYSTEM,
 * Administrators and the account Mongo Manager runs as, whatever its parent allows (security review
 * 2026-10-13, ops: one made under a shared folder inherited an ACL every user could read). It is
 * never left open: a directory that cannot be made private stops the start. One that is already
 * there is repaired at start when it is open to everyone (repairPrivate, security audit 2026-10-16);
 * `mongo-manager doctor` says when it is open or someone else owns it.
 */
export function ensureDataDir(dir: string): void {
  if (existsSync(dir)) return
  if (process.platform === 'win32') makePrivateWindows(dir)
  else mkdirSync(dir, { recursive: true, mode: 0o700 })
}
