// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { ConnectionSettings, ToolsAvailability } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { localFullPath, rawSeries } from './series'
import { windowsTool } from '../windows-tools'
import type { Principal, ServerContext } from '../http/context'
import { clientSpec } from '../connections/client-spec'
import { AWS_KEYS_NEEDED } from '../connections/errors'
import { redactUris } from '../connections/errors'
import { pastedPem } from '../net/pem'
import { effectiveRole, isRestricted } from '../connections/access'

export interface FoundTools {
  dump: string
  restore: string
  version: string
}

const MIN = [100, 9, 0] as const
/**
 * CI 2026-10-18: for a server of 8.3 or later. Before 100.16, mongodump keeps its time series under
 * system.buckets, where mongorestore 100.16 and later no longer looks for them (series.ts).
 */
const MIN_RAW_SERIES = [100, 16, 0] as const
const cache = new Map<string, { at: number; value: FoundTools | null }>()
const run = promisify(execFile)

const parts = (v: string) => v.split('.').map(Number)

/** 100.9.0 or later (spec §5.3), or the floor given. */
export function versionOk(v: string, min: readonly number[] = MIN): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return false
  const n = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) if (n[i] !== min[i]) return n[i]! > min[i]!
  return true
}

/** Spec §5.3: mongodump and mongorestore side by side, on MM_MONGODB_TOOLS_PATH first, then PATH. */
export async function findTools(
  toolsPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<FoundTools | null> {
  const exe = platform === 'win32' ? '.exe' : ''
  const pathVar = env.PATH ?? env.Path ?? ''
  const key = `${platform}|${toolsPath ?? ''}|${pathVar}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value: FoundTools | null = null
  // Review of the CI fixes: a relative entry (".", or an empty one on Windows) names the folder the
  // server runs from, never a place of tools.
  const dirs = [toolsPath, ...pathVar.split(delimiter)].filter(
    (d): d is string => Boolean(d) && localFullPath(d!, platform),
  )
  /** The tool's own version, or null when it does not say. */
  const versionOf = async (file: string) => {
    const { stdout } = await run(file, ['--version'], { timeout: 5_000, windowsHide: true })
    return /version:\s*r?(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null
  }
  for (const dir of dirs) {
    const dump = join(dir, `mongodump${exe}`)
    const restore = join(dir, `mongorestore${exe}`)
    if (!existsSync(dump) || !existsSync(restore)) continue
    try {
      // Both are asked (review of the CI fixes, minor 7): the older of the two is their version.
      const versions = await Promise.all([versionOf(dump), versionOf(restore)])
      const known = versions.filter((v): v is string => v !== null)
      const oldest =
        known.length === 2 ? (versionOk(known[0]!, parts(known[1]!)) ? known[1]! : known[0]!) : null
      value = { dump, restore, version: oldest ?? 'unknown' }
    } catch {
      // Fourth review (minor 11): there, but they do not run: said so, never "not found".
      value = { dump, restore, version: 'unknown' }
    }
    break
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Spec §5.3, §6, B8: who may use the tools engine on a connection, and why not. */
export function toolsAvailability(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
  found: FoundTools | null,
  /** The server's version, when known: 8.3 and later need newer tools. */
  serverVersion: string | null = null,
): ToolsAvailability {
  const admin = effectiveRole(ctx, principal, connectionId) === 'admin'
  if (!found) return { available: false, reason: 'missing' }
  // Fifth review (minor 4): there, but they do not run or do not say their version.
  if (found.version === 'unknown') return { available: false, reason: 'broken' }
  if (!versionOk(found.version, rawSeries(serverVersion) ? MIN_RAW_SERIES : MIN))
    return { available: false, reason: 'old', ...(admin ? { version: found.version } : {}) }
  if (!admin) return { available: false, reason: 'not_admin' }
  // Admins are never restricted today; this stays as a second line if that ever changes.
  if (isRestricted(ctx, principal, connectionId)) return { available: false, reason: 'restricted' }
  const record = ctx.connections.get(connectionId)
  if (!record || record.settings.ssh?.enabled) return { available: false, reason: 'unsupported' }
  return { available: true, version: found.version }
}

/** B15: names the tools engine passes on; anything that could read as an option or be split is refused. */
export const toolSafeName = (s: string): boolean => /^[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith('-')

const yaml = (v: string) => JSON.stringify(v)

/** Adds query parameters to a connection string without parsing its hosts (a host list is not a URL). */
function withQuery(uri: string, params: Array<[string, string]>): string {
  if (!params.length) return uri
  const q = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const at = uri.indexOf('?')
  if (at >= 0) return `${uri}${at === uri.length - 1 ? '' : '&'}${q}`
  const slash = uri.indexOf('/', uri.indexOf('://') + 3)
  return slash >= 0 ? `${uri}?${q}` : `${uri}/?${q}`
}

/**
 * S11, B14: the URI (with the user name) and every password go into a 0600 config file in a private
 * temporary directory, with the TLS PEMs beside it; nothing secret is ever an argument. The
 * directory is removed whatever happens.
 */
const TOOL_DIR_PREFIX = 'mm-tools-'

/**
 * Final review minor 10: tool folders (with a connection's password) live in the server's own private
 * directory, and what a crash left there is removed at start (no tool runs then).
 */
export async function sweepToolDirs(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const name of await readdir(root))
    if (name.startsWith(TOOL_DIR_PREFIX)) await rm(join(root, name), { recursive: true, force: true })
}

export async function withToolConfig<T>(
  settings: ConnectionSettings,
  fn: (configArgs: string[]) => Promise<T>,
  root: string = tmpdir(),
): Promise<T> {
  // Without the connection's keys the tools' own AWS credential chain would read the host's
  // identity (an instance role): a user of this server must never sign in as the server.
  if (settings.auth.mechanism === 'MONGODB-AWS' && (!settings.auth.username || !settings.auth.password))
    throw Errors.validation(AWS_KEYS_NEEDED, { reason: 'aws_keys' })
  // W7, W8 (review minor 7 before them): the tools would sign in with the host's Kerberos ticket
  // cache or its cloud identity, and a person's OIDC token is never handed to another program.
  if (settings.auth.mechanism === 'GSSAPI')
    throw Errors.validation(
      'Backups and restores of a Kerberos connection are not run: the tools would sign in with the server’s own ticket',
      { reason: 'tools_kerberos' },
    )
  if (settings.auth.mechanism === 'MONGODB-OIDC')
    throw Errors.validation(
      'Backups and restores of an OIDC connection are not run: the tools cannot use your sign-in, and never the server’s own identity',
      { reason: 'tools_oidc' },
    )
  const dir = await mkdtemp(join(root, TOOL_DIR_PREFIX))
  try {
    const { auth, tls } = settings
    const params: Array<[string, string]> = []
    const lines: string[] = []
    const base = clientSpec(settings).uri
    if (tls.enabled) {
      // The connection's own URI may say tls already (final review): never twice.
      if (!/[?&](tls|ssl)=/i.test(base)) params.push(['tls', 'true'])
      const caPem = pastedPem(tls.caPem)
      if (caPem) {
        const ca = join(dir, 'ca.pem')
        await writeFile(ca, `${caPem}\n`, { mode: 0o600 })
        params.push(['tlsCAFile', ca])
      }
      const certificateKeyPem = pastedPem(tls.certificateKeyPem)
      if (certificateKeyPem) {
        const cert = join(dir, 'client.pem')
        await writeFile(cert, `${certificateKeyPem}\n`, { mode: 0o600 })
        params.push(['tlsCertificateKeyFile', cert])
        if (tls.certificateKeyPassword) lines.push(`sslPEMKeyPassword: ${yaml(tls.certificateKeyPassword)}`)
      }
    }
    // MONGODB-AWS session tokens, GSSAPI service names: in the private file's URI, never an argument.
    if (auth.mechanism !== 'none' && auth.mechanismProperties)
      params.push(['authMechanismProperties', auth.mechanismProperties])
    let uri = withQuery(base, params)
    if (auth.mechanism !== 'none' && auth.username) {
      uri = uri.replace(/^(mongodb(?:\+srv)?:\/\/)/, `$1${encodeURIComponent(auth.username)}@`)
      if (auth.password) lines.push(`password: ${yaml(auth.password)}`)
    }
    lines.unshift(`uri: ${yaml(uri)}`)
    const config = join(dir, 'config.yaml')
    await writeFile(config, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
    return await fn([`--config=${config}`])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** B14: what a tool says, without connection strings or passwords, at most 300 characters. */
export function scrubToolOutput(line: string): string {
  return redactUris(line)
    .replace(/(password|pwd|sslPEMKeyPassword)\s*[=:]\s*\S+/gi, '$1=[hidden]')
    .replace(/(authMechanismProperties)\s*[=:]\s*[^&\s]+/gi, '$1=[hidden]')
    .replace(/\/\/[^/\s@]+:[^/\s@]+@/g, '//[hidden]@')
    .slice(0, 300)
}

const ENV_KEEP = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot']
const minimalEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))

/**
 * B16: a tool process without a shell, with a reduced environment, stdin from `stdin` (or none),
 * killed with its whole tree on cancel or timeout.
 */
/**
 * MongoDB 9.0 (local run, 2026-10-20): why a tool failed. mongo-tools ends with its counts
 * ("0 document(s) restored successfully…"); the reason is its last "Failed:" line, given without
 * the timestamp before it. With none, the last line.
 */
export function toolFailure(log: readonly string[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const text = log[i]!.replace(/^\S+\t/, '')
    if (text.startsWith('Failed:')) return text
  }
  return log.at(-1) ?? ''
}

export function spawnTool(
  bin: string,
  args: string[],
  opts: {
    stdin?: AsyncIterable<Buffer> | null
    signal: AbortSignal
    timeoutMs: number
    onLine?: (line: string) => void
    spawnImpl?: typeof spawn
  },
): { stdout: Readable; exit: Promise<number> } {
  const child = (opts.spawnImpl ?? spawn)(bin, args, {
    shell: false,
    windowsHide: true,
    env: minimalEnv(),
    detached: process.platform !== 'win32',
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return
    if (process.platform === 'win32')
      spawn(windowsTool('taskkill'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => undefined,
      )
    else
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
  }
  const timer = setTimeout(kill, opts.timeoutMs)
  const onAbort = () => kill()
  opts.signal.addEventListener('abort', onAbort, { once: true })
  let input: Readable | null = null
  if (opts.stdin && child.stdin) {
    input = Readable.from(opts.stdin)
    input.on('error', () => kill())
    child.stdin.on('error', () => undefined)
    input.pipe(child.stdin)
  }
  createInterface({ input: child.stderr! }).on('line', (line) => opts.onLine?.(scrubToolOutput(line)))
  const exit = new Promise<number>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (e) => {
      done()
      input?.destroy()
      reject(e)
    })
    child.once('close', (code) => {
      done()
      // Final review minor 9: an input the process did not read to its end is let go (its file
      // handle closes; on Windows the file could not be deleted while it stayed open).
      input?.destroy()
      resolve(code ?? -1)
    })
  })
  return { stdout: child.stdout!, exit }
}

/** Spec §7.6: at most `max` tool processes per server. */
export class ToolSlots {
  private used = 0

  constructor(private readonly max: number) {}

  acquire(): () => void {
    if (this.used >= this.max)
      throw Errors.conflict('The backup tools are busy; try again shortly', { reason: 'tools_busy' })
    this.used++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.used--
      }
    }
  }
}
