import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'

type Env = Record<string, string | undefined>

/**
 * Windows' own folder (review of the CI fixes, minor 6; second review, minor 2). SystemRoot comes from
 * the environment, which an account's own settings can change for what it starts elevated, and a
 * user may make D:\\Windows on a second drive: the folder is asked of the kernel (its \\SystemRoot
 * link, which no environment changes); only where that cannot answer is a Windows folder at a
 * drive's root taken from SystemRoot, else C:\\Windows. Every tool and check uses this one.
 */
export function systemRoot(env: Env = process.env, kernel: () => string | null = kernelRoot): string {
  const asked = kernel()
  if (asked) return asked
  const named = env.SystemRoot
  return named && /^[A-Za-z]:\\Windows$/i.test(named) ? named : 'C:\\Windows'
}

let kernelAnswer: string | null | undefined
/** The kernel's own \\SystemRoot, as a drive path, or null (not Windows, or no answer). */
export function kernelRoot(): string | null {
  if (kernelAnswer !== undefined) return kernelAnswer
  kernelAnswer = null
  if (process.platform === 'win32')
    try {
      const real = realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot').replace(/^\\\\\?\\/, '')
      if (/^[A-Za-z]:\\[^\\]/.test(real)) kernelAnswer = real
    } catch {
      // Then SystemRoot, checked.
    }
  return kernelAnswer
}

/**
 * Windows' own tools, by their place (CI 2026-10-18): a bare name is looked up in the folder the
 * program runs in first (unless NoDefaultCurrentDirectoryInExePath is set), then on the PATH, so a
 * schtasks.exe or powershell.exe left in the folder an administrator runs `service install` from, or
 * in a folder before System32 on the PATH, would run as that administrator.
 */
export function windowsTool(name: string, root: string = systemRoot()): string {
  if (name === 'powershell')
    return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return win32.join(root, 'System32', `${name}.exe`)
}

/**
 * `base` with `extra` laid over it, names compared as Windows does (without case), so a
 * `Path` in `base` cannot stay beside a `PATH` in `extra` and win.
 */
export function windowsEnv(base: Env, extra: Env): Env {
  const names = new Set(Object.keys(extra).map((k) => k.toUpperCase()))
  const out: Env = {}
  for (const [k, v] of Object.entries(base)) if (!names.has(k.toUpperCase())) out[k] = v
  return { ...out, ...extra }
}

/**
 * The environment Windows PowerShell runs in: `extra` over this process's, and Windows
 * PowerShell's own modules only (CI 2026-10-18). PowerShell 7 leaves its own module folders first
 * on PSModulePath for what it starts, and Windows PowerShell found a Get-Acl there it could not
 * load: every ACL check failed. A folder of the user's on it could also stand in for a module of
 * Windows' own.
 */
export function powershellEnv(extra: Env = {}, env: Env = process.env): Env {
  return windowsEnv(env, {
    ...extra,
    PSModulePath: win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  })
}

/** Windows PowerShell's own modules every script of ours may use. */
const MODULES = [
  'Microsoft.PowerShell.Management',
  'Microsoft.PowerShell.Security',
  'Microsoft.PowerShell.Utility',
]

/**
 * The arguments that have Windows PowerShell run `script`: no profile, no prompt, and the script
 * encoded (powershell.exe parses any further argument as PowerShell). Any error stops it, and what
 * it prints is UTF-8 from the first line, an import's error too (review of the module imports,
 * minor 1). It looks for no module (CI 2026-10-21): autoloading is off, and the modules it uses
 * (MODULES, then `more`, each a plain name: minor 2) are imported from PowerShell's own folder
 * ($PSHOME, which the registry names, not the environment) by their place. Finding a cmdlet
 * otherwise reads what every module holds, which Windows PowerShell keeps in a cache; GitHub's
 * Windows runner names its cache in PSModuleAnalysisCachePath, and in an environment without it (as
 * the sea test gives the binary) each start took 25 to 30 s, where it takes 0.5 to 1 s with it.
 */
export function powershellArgs(script: string, more: string[] = []): string[] {
  for (const m of more)
    if (!/^[A-Za-z][\w-]*(\.[\w-]+)*$/.test(m))
      throw new Error(`Not a plain module name: ${JSON.stringify(m)}`)
  const modules = [...MODULES, ...more].map((m) => `"$PSHOME\\Modules\\${m}"`).join(', ')
  const full = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$PSModuleAutoLoadingPreference = 'None'",
    `Import-Module -Name ${modules}`,
    script,
  ].join('\n')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')]
}
