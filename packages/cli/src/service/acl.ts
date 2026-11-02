import { runPowerShell } from './powershell'
import type { Sys } from './sys'

/** Everyone, Users, Authenticated Users, Interactive: a data directory must not grant them anything. */
export const BROAD_SIDS = new Set(['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4'])

/**
 * The SIDs a path's ACL grants to, or null when they could not be read: those a directory passes
 * only to the files it holds too, as they are the reading of every file made there (review of the
 * ACL reads, minor 2; second review, nit: not those it passes to folders alone). `own`: the path's
 * own grants only, not those it has from its folder (second review, minor 1). Read by SID, since the
 * name of ALL APPLICATION PACKAGES cannot be turned back into its SID (review of the module imports).
 */
export function aclSids(sys: Sys, path: string, opts: { own?: boolean } = {}): string[] | null {
  const r = runPowerShell(
    sys,
    `'mm:acl-sids' | Out-Null
$io = [System.Security.AccessControl.PropagationFlags]::InheritOnly
$files = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
(Get-Acl -LiteralPath $in.path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
  Where-Object { $_.AccessControlType -eq 'Allow' -and -not (($_.PropagationFlags -band $io) -and -not ($_.InheritanceFlags -band $files)) } |${
    opts.own ? '\n  Where-Object { -not $_.IsInherited } |' : ''
  }
  ForEach-Object { $_.IdentityReference.Value }`,
    { path },
  )
  return r.ok ? r.lines : null
}

/**
 * Review of the ops fixes (I1): who owns a directory, and who this account is. An owner other than
 * SYSTEM, Administrators or this account can change its ACL whenever it likes. Null when unread.
 */
export function dirOwner(sys: Sys, dir: string): { owner: string; me: string } | null {
  const r = runPowerShell(
    sys,
    `'mm:acl-owner' | Out-Null
'owner ' + (Get-Acl -LiteralPath $in.path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
'me ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
    { path: dir },
  )
  if (!r.ok) return null
  const owner = r.lines.find((l) => l.startsWith('owner '))?.slice(6)
  const me = r.lines.find((l) => l.startsWith('me '))?.slice(3)
  return owner && me ? { owner, me } : null
}

const INSPECT = `'mm:inspect' | Out-Null
$i = 0
foreach ($p in @($in.paths)) {
  if (Test-Path -LiteralPath $p) {
    $item = Get-Item -LiteralPath $p -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { "reparse $p" }
    $owner = (Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $allowed = if ($i -eq 0) { @('S-1-5-18', 'S-1-5-32-544') } else { @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19') }
    if ($allowed -notcontains $owner) { "owner $owner $p" }
  }
  $i++
}`

/**
 * %ProgramData% lets every user create folders there, and the creator owns what it creates.
 * Before anything changes, the state folder must be missing or owned by SYSTEM/Administrators,
 * and neither it nor its known entries may be a junction or link (Review Critical 1). This is the
 * early, read-only check; prepareStateRoot repeats it where it cannot race.
 */
export function inspectStateRoot(sys: Sys, root: string, entries: string[]): string[] {
  const r = runPowerShell(sys, INSPECT, { paths: [root, ...entries] })
  if (!r.ok) return [`the owner of ${root} could not be read (${r.error || 'no result'})`]
  return r.lines.map((l) => {
    const [kind, a, ...rest] = l.split(' ')
    if (kind === 'reparse') return `${[a, ...rest].join(' ')} is a junction or link`
    return `${rest.join(' ')} is owned by ${a}, so it was not created by an administrator`
  })
}

const PREPARE = `'mm:prepare' | Out-Null
$root = $in.root
$sidOf = { param($s) New-Object System.Security.Principal.SecurityIdentifier($s) }
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
$sec = New-Object System.Security.AccessControl.DirectorySecurity
$sec.SetOwner((& $sidOf 'S-1-5-32-544'))
$sec.SetAccessRuleProtection($true, $false)
foreach ($rule in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', 'ReadAndExecute'))) {
  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((& $sidOf $rule[0]), $rule[1], $inherit, $none, 'Allow')))
}
# A new folder is created with its final security in one step, so nobody else can ever add to it.
$null = [System.IO.Directory]::CreateDirectory($root, $sec)
# An existing folder (or one created by someone else in between) must be the administrators' own.
$item = Get-Item -LiteralPath $root -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "$root is a junction or link" }
$owner = (Get-Acl -LiteralPath $root).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if (@('S-1-5-18', 'S-1-5-32-544') -notcontains $owner) { throw "$root is owned by $owner, so it was not created by an administrator" }
# No junction, link or hard link (whose ACL would be rewritten through it, and which could alias
# a file elsewhere), and nothing owned by anyone but SYSTEM, Administrators or the service account.
$scan = {
  $allowed = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    foreach ($e in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "$($e.FullName) is a junction or link" }
      if ($e.LinkType -eq 'HardLink') { throw "$($e.FullName) is a hard link" }
      $o = (Get-Acl -LiteralPath $e.FullName).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
      if ($allowed -notcontains $o) { throw "$($e.FullName) is owned by $o, so it was not created by an administrator or the service" }
      if ($e.PSIsContainer) { $stack.Push($e.FullName) }
    }
  }
}
# Before locking (so the new security never propagates through a link) and after (from then on
# only administrators can add entries, so the result holds).
& $scan
Set-Acl -LiteralPath $root -AclObject $sec
& $scan
# The service account may change only its data and its logs; the config stays read-only to it.
foreach ($dir in @($in.writable)) {
  $null = [System.IO.Directory]::CreateDirectory($dir)
  $acl = Get-Acl -LiteralPath $dir
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((& $sidOf 'S-1-5-19'), 'Modify', $inherit, $none, 'Allow')))
  Set-Acl -LiteralPath $dir -AclObject $acl
}`

/**
 * Creates (or takes over, if it is already the administrators') the state folder with a fresh,
 * protected security: owner Administrators; SYSTEM and Administrators full control; LocalService
 * read only, plus modify on `writable` (data, logs). Refuses a folder someone else created or
 * filled, and never deletes anything (Review Critical 1, Important 1; second review Y2).
 */
export function prepareStateRoot(sys: Sys, root: string, writable: string[]): void {
  const r = runPowerShell(sys, PREPARE, { root, writable })
  if (!r.ok) {
    throw new Error(
      `${root} cannot be used: ${r.error || 'the permission script did not finish'}\n` +
        'Another user may have created it to read the data or take over the service. It was not deleted; ' +
        'inspect it, move it aside if it is not yours, and run the installer again.',
    )
  }
}
