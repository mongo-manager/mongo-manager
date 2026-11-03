import { UsageError } from '../args'

/** Accounts shared with the system or other services: the service needs one of its own. */
const RESERVED = new Set([
  'root',
  'nobody',
  'daemon',
  'bin',
  'sys',
  'adm',
  'wheel',
  'nogroup',
  'www-data',
  '_www',
  'staff',
])

/** System account names: lower case, may start with "_" (macOS), no shell metacharacters. */
export function checkUserName(name: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(name))
    throw new UsageError(`--user must be a plain account name, got "${name}"`)
  if (RESERVED.has(name))
    throw new UsageError(`--user ${name} is a shared system account; use an account of its own`)
  return name
}

/**
 * Paths go into unit files, plists and command lines: refuse anything that quoting cannot carry
 * safely there (quotes, systemd % specifiers, $ expansion, line breaks; backslash on POSIX).
 */
export function checkPathSafe(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // Another machine's Administrators are not ours, and a stream is not a file (third review).
    if (path.startsWith('\\\\') || path.startsWith('//')) {
      throw new UsageError(`Network and device paths are not supported: "${path}"`)
    }
    if (path.indexOf(':', 2) !== -1) throw new UsageError(`NTFS stream paths are not supported: "${path}"`)
  }
  const bad = platform === 'win32' ? /["%\r\n]/ : /["'%$`\\\r\n]/
  if (bad.test(path)) throw new UsageError(`Unsupported characters in path "${path}"`)
  return path
}

/** Unprivileged ports only: the service holds no capability to bind below 1024. */
export function checkPort(text: string): number {
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN
  if (!(port >= 1024 && port <= 65535))
    throw new UsageError(`--web-port for a service must be 1024-65535, got "${text}"`)
  return port
}
