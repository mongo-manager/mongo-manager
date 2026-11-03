import { posix } from 'node:path'
import { runPowerShell } from './powershell'
import type { Sys } from './sys'

/**
 * Code the service runs must not be replaceable by anyone but administrators: otherwise any
 * local user could swap it and run as the service account (which reads every saved credential).
 *
 * POSIX: the path and every directory above it are owned by root and not writable by group or
 * others. Windows: each is owned by SYSTEM, Administrators or TrustedInstaller, and only they may:
 * - write to, delete, re-permission or take the item itself, and a file's folder (DLLs load from
 *   there);
 * - delete, empty, re-permission or take any folder above. Making files or folders there counts for
 *   nothing (every signed-in user may make a folder in C:\: CI 2026-10-20, a first install refused
 *   Program Files for it), since the program looks nothing up in them: the bundles load no package
 *   from a node_modules above them (scripts/own-modules.mjs). Node's OpenSSL would read its module
 *   folder, compiled in as one under C:\, only for a provider it does not build in (FIPS), which the
 *   service never loads; this was so before, for files two or more folders down (second review,
 *   minor 5).
 *
 * `below`: things are about to be made in this folder, so what it passes on to them counts too.
 */
export function trustProblems(sys: Sys, path: string, opts: { below?: boolean } = {}): string[] {
  return sys.platform === 'win32' ? windowsProblems(sys, path, opts.below === true) : posixProblems(sys, path)
}

function posixProblems(sys: Sys, path: string): string[] {
  const problems: string[] = []
  let p = path
  for (;;) {
    const s = sys.stat(p)
    if (!s) {
      problems.push(`${p} does not exist`)
      break
    }
    if (s.uid !== 0) problems.push(`${p} is not owned by root`)
    if ((s.mode & 0o022) !== 0)
      problems.push(`${p} is writable by others (mode ${(s.mode & 0o777).toString(8)})`)
    const parent = posix.dirname(p)
    if (parent === p) break
    p = parent
  }
  return problems
}

// The path arrives as JSON data ($in.path); it is never part of the script text.
const WINDOWS_TRUST_SCRIPT = `'mm:trust' | Out-Null
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$R = [System.Security.AccessControl.FileSystemRights]
# GENERIC_ALL and GENERIC_WRITE, as an entry may hold them unmapped (an inherit-only one does).
$generic = 0x50000000
$file = [int]($R::WriteData -bor $R::AppendData -bor $R::Delete -bor $R::ChangePermissions -bor $R::TakeOwnership) -bor $generic
$dir = [int]($R::WriteData -bor $R::AppendData -bor $R::DeleteSubdirectoriesAndFiles -bor $R::Delete -bor $R::ChangePermissions -bor $R::TakeOwnership) -bor $generic
$up = [int]($R::DeleteSubdirectoriesAndFiles -bor $R::Delete -bor $R::ChangePermissions -bor $R::TakeOwnership) -bor $generic
$item = Get-Item -LiteralPath $in.path -Force
# A stream (file::$DATA) or anything else that is not a file or folder has no path to walk: refuse.
if (-not ($item -is [System.IO.FileSystemInfo]) -or -not $item.FullName) { throw "not a file or folder: $($in.path)" }
# The rights that count from the item up; every folder above these, $up.
$masks = @(if ($item -is [System.IO.DirectoryInfo]) { $dir } else { $file; $dir })
$p = $item.FullName
$level = 0
while ($p) {
  $acl = Get-Acl -LiteralPath $p
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { "owner $owner $p" }
  $mask = if ($level -lt $masks.Count) { $masks[$level] } else { $up }
  foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    $passed = ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
    # An entry only for what is made in it counts where things are about to be made; CREATOR OWNER
    # becomes whoever makes them, the administrator installing.
    if ($passed -and -not ($in.below -and $level -eq 0)) { continue }
    if ($passed -and $r.IdentityReference.Value -eq 'S-1-3-0') { continue }
    if (([int]$r.FileSystemRights -band $mask) -eq 0) { continue }
    if ($trusted -notcontains $r.IdentityReference.Value) { "$(if ($passed) { 'pass' } else { 'write' }) $($r.IdentityReference.Value) $p" }
  }
  $p = [System.IO.Path]::GetDirectoryName($p)
  $level++
}`

function windowsProblems(sys: Sys, path: string, below: boolean): string[] {
  const r = runPowerShell(sys, WINDOWS_TRUST_SCRIPT, { path, below })
  // Fail closed: permissions that cannot be read are not trusted.
  if (!r.ok) return [`the permissions of ${path} could not be read (${r.error || 'no result'})`]
  return r.lines.map((l) => {
    const [kind, sid, ...rest] = l.split(' ')
    const where = rest.join(' ')
    if (kind === 'owner') return `${where} is owned by ${sid}`
    return kind === 'pass' ? `${sid} can change what is made in ${where}` : `${sid} can change ${where}`
  })
}

/** Throws when `path` could be replaced by a non-administrator (see trustProblems). */
export function checkTrusted(
  sys: Sys,
  path: string,
  what: string,
  hint: string,
  opts: { below?: boolean } = {},
): void {
  // The real location: a symlinked folder would otherwise hide the parents that matter (second review Y5).
  let real: string
  try {
    real = sys.realpath(path)
  } catch {
    throw new Error(`${what} ${path} does not exist`)
  }
  const problems = trustProblems(sys, real, opts)
  if (problems.length > 0) {
    throw new Error(
      `${what} ${path} can be changed by users other than administrators, so it must not run as a service:\n  ` +
        `${problems.slice(0, 6).join('\n  ')}\n${hint}`,
    )
  }
}
