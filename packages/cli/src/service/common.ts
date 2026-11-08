// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { realpathSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { DB_FILE, KEY_FILE, assertSafeBind, parseConfigFile, resolveConfig } from '@mongo-manager/server'
import { UsageError, type Values } from '../args'
import { isStandalone } from '../sea'
import type { Io } from '../io'
import type { Layout } from './layout'
import type { ServiceOptions } from './render'
import type { Sys } from './sys'
import { checkLinked } from './linked'
import { checkTrusted } from './trust'
import { checkPathSafe, checkPort, checkUserName } from './validate'

/** The npm package: the bundle and web app, run by a copy of the Node that installs it. */
export interface NodeProgram {
  node: string
  cli: string
  publicDir: string
}

/** The standalone single-executable binary: one file, web app embedded, no Node needed. */
export interface StandaloneProgram {
  binary: string
}

export type ProgramSource = NodeProgram | StandaloneProgram

export const isStandaloneProgram = (p: ProgramSource): p is StandaloneProgram => 'binary' in p

export interface ServiceDeps {
  sys: Sys
  program?: ProgramSource
  probe?: (url: string) => Promise<boolean>
}

/** The package this CLI runs from: the service copies it, so it must be the built bundle or binary. */
export function runningProgram(): ProgramSource {
  if (isStandalone()) return { binary: process.execPath }
  const cli = realpathSync(process.argv[1] ?? '')
  if (!cli.endsWith('cli.cjs')) {
    throw new UsageError(
      'service install must run from the installed package (mongo-manager), not from source',
    )
  }
  return { node: process.execPath, cli, publicDir: join(dirname(cli), '..', 'public') }
}

/**
 * The Node.js binary to copy into the program folder (the running one, or --node): any install
 * works, nvm included, because the service only ever runs the administrators' own copy of it,
 * which is trust-checked after copying (Review Critical 2).
 */
export function sourceNode(node: string, sys: Sys): string {
  return sourceFile(node, sys, 'Node.js')
}

/** A file to copy into the program folder: a safe path, symlinks resolved, and present. */
export function sourceFile(path: string, sys: Sys, what: string): string {
  checkPathSafe(path, sys.platform)
  let real: string
  try {
    real = sys.realpath(path)
  } catch {
    throw new Error(`${what} at ${path} does not exist`)
  }
  checkPathSafe(real, sys.platform)
  if (sys.stat(real) === null) throw new Error(`${what} at ${path} does not exist`)
  return real
}

/** The source to install: the running program, with --node applied (npm package only). */
export function installSource(source: ProgramSource, node: string | undefined, sys: Sys): ProgramSource {
  if (isStandaloneProgram(source)) {
    if (node !== undefined) {
      throw new UsageError('--node is not used by the standalone binary: it carries its own runtime')
    }
    return { binary: sourceFile(source.binary, sys, 'The standalone binary') }
  }
  return { ...source, node: sourceNode(node ?? source.node, sys) }
}

/**
 * What the service runs, as installed in the program folder: the standalone binary, or the copied
 * Node with the bundle. The unit, plist or task appends `start --config …`.
 */
export function programCommand(layout: Layout, source: ProgramSource): string[] {
  const join2 = layout.platform === 'win32' ? win32.join : posix.join
  if (isStandaloneProgram(source)) {
    return [
      join2(layout.programDir, 'bin', layout.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager'),
    ]
  }
  return [programNode(layout), join2(layout.programDir, 'dist', 'cli.cjs')]
}

/** The Node the service runs: the copy inside the program folder. */
export function programNode(layout: Layout): string {
  return layout.platform === 'win32'
    ? win32.join(layout.programDir, 'bin', 'node.exe')
    : posix.join(layout.programDir, 'bin', 'node')
}

/** Options that make no sense for a service, or that the service layout decides. */
const UNSUPPORTED = ['data-dir', 'uri', 'config', 'unsafe-no-auth', 'web-root', 'log-file'] as const
const list = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function installOptions(values: Values, layout: Layout): ServiceOptions & { user: string } {
  for (const option of UNSUPPORTED) {
    if (values[option] !== undefined) {
      throw new UsageError(
        `--${option} is not supported by service install (the service keeps its data in ${layout.dataDir}; ` +
          `other settings go into ${layout.configFile})`,
      )
    }
  }
  return {
    // Windows: the task always runs as LocalService (a SID, not an account name).
    user: layout.platform === 'win32' ? layout.defaultUser : checkUserName(values.user ?? layout.defaultUser),
    ...(values['web-port'] !== undefined ? { webPort: checkPort(values['web-port']) } : {}),
    ...(values.host !== undefined ? { host: values.host } : {}),
    ...(values.auth !== undefined ? { auth: values.auth } : {}),
    ...(values['base-path'] !== undefined ? { basePath: values['base-path'] } : {}),
    ...(values['allowed-hosts'] !== undefined ? { allowedHosts: list(values['allowed-hosts']) } : {}),
    ...(values['trusted-proxies'] !== undefined ? { trustedProxies: list(values['trusted-proxies']) } : {}),
    ...(values['read-only'] !== undefined ? { readOnly: values['read-only'] } : {}),
    ...(values['log-level'] !== undefined ? { logLevel: values['log-level'] } : {}),
    ...(values.shell !== undefined ? { shell: values.shell } : {}),
  }
}

/**
 * The config the service will actually start with (existing file merged with the new options)
 * must be one the server accepts: valid, safe to bind (S1), and using the service's data directory.
 */
export function checkServiceConfig(configJson: string, layout: Layout): void {
  const file = JSON.parse(configJson) as Record<string, unknown>
  if (file.dataDir !== undefined && file.dataDir !== layout.dataDir) {
    throw new Error(
      `${layout.configFile} sets dataDir to ${String(file.dataDir)}, but the service keeps its data in ` +
        `${layout.dataDir} (its sandbox allows only that). Remove dataDir from the config or set it to ${layout.dataDir}.`,
    )
  }
  const config = resolveConfig({
    file: parseConfigFile(file, layout.configFile, layout.platform),
    platform: layout.platform,
  })
  assertSafeBind(config)
}

export function must(sys: Sys, cmd: string, args: string[]): void {
  const r = sys.run(cmd, args)
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`)
  }
}

/**
 * Existing data without its key is refused, never given a new key (Review Focus 1). Returns
 * whether the key file is present. `configuredKey`: Linux keeps the key in its environment file.
 */
export function assertKeyNotLost(sys: Sys, layout: Layout, configuredKey: boolean): boolean {
  const join2 = layout.platform === 'win32' ? win32.join : posix.join
  const hasData = sys.exists(join2(layout.dataDir, DB_FILE))
  const hasKeyFile = sys.exists(join2(layout.dataDir, KEY_FILE))
  if (hasData && !hasKeyFile && !configuredKey) {
    throw new Error(
      `${layout.dataDir} holds existing data but no key (no ${KEY_FILE}${layout.envFile ? `, no ${layout.envFile}` : ''}). ` +
        'Restore the key first; a new key would make saved passwords unreadable.',
    )
  }
  return hasKeyFile
}

/** The service account's primary group; refuses an account with uid 0 (Review Minor 3, 4). */
export function accountGroup(sys: Sys, user: string): string {
  const uid = sys.run('id', ['-u', user])
  if (uid.status === 0 && uid.stdout.trim() === '0') {
    throw new Error(
      `The account ${user} has uid 0 (root); the service needs an unprivileged account of its own`,
    )
  }
  const group = sys.run('id', ['-gn', user])
  return group.status === 0 && group.stdout.trim() ? group.stdout.trim() : user
}

/**
 * Gives a service directory to its account. Entries inside change owner only when the account's
 * uid changed (it was re-created), and then never through a symlink or a hard link: a compromised
 * service account could otherwise plant a link to a root-owned file and have the next install
 * hand it over (second review Y4).
 */
export function chownTree(sys: Sys, dir: string, user: string, group: string): void {
  const before = sys.stat(dir)?.uid
  const uid = Number(sys.run('id', ['-u', user]).stdout.trim())
  must(sys, 'chown', [`${user}:${group}`, dir])
  if (before === undefined || !Number.isInteger(uid) || before === uid) return
  must(sys, 'find', [
    dir,
    '-xdev',
    '(',
    '-type',
    'd',
    '-o',
    '(',
    '-type',
    'f',
    '-links',
    '1',
    ')',
    ')',
    '!',
    '-user',
    user,
    '-exec',
    'chown',
    `${user}:${group}`,
    '{}',
    '+',
  ])
}

export const STOPPED =
  'The service is stopped and disabled until its program passes this check. Fix the problem above, then run service install again.\n'

/**
 * What to do about a folder others can change. The program's place is fixed, so never "choose
 * another location" (CI 2026-10-18: GitHub's Ubuntu runner has a /opt every user may write to).
 */
function trustHint(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Only administrators may be able to change it and the folders above it: take away the rights ' +
        'other users have on the file or folder named above (its Properties > Security, or icacls), then run ' +
        'service install again.'
    : 'Only root may be able to change it and the folders above it: give the file or folder named ' +
        "above to root and take away others' write access (sudo chown root <path>; sudo chmod go-w <path>), " +
        'then run service install again.'
}

/**
 * Before copying: the folder the program goes into must already be the administrators' own, so
 * nothing is copied into a place others control (final review Minor 2).
 */
export function checkProgramLocation(sys: Sys, layout: Layout): void {
  const path = layout.platform === 'win32' ? win32 : posix
  let p = path.dirname(layout.programDir)
  while (!sys.exists(p) && sys.stat(p) === null && path.dirname(p) !== p) p = path.dirname(p)
  // Security review 2026-10-20 (minor 3): and what it passes on to the folders the install makes.
  checkTrusted(sys, p, 'The program folder', trustHint(layout.platform), { below: true })
}

/**
 * True when the source is the installed program itself (service install run from the installed
 * copy): it is kept in place, since replacing the files it runs from fails on Windows.
 */
export function installedInPlace(layout: Layout, source: ProgramSource): boolean {
  const win = layout.platform === 'win32'
  const norm = (p: string) => (win ? p.toLowerCase() : p)
  const root = norm(layout.programDir) + (win ? '\\' : '/')
  const files = isStandaloneProgram(source) ? [source.binary] : [source.node, source.cli, source.publicDir]
  const inside = files.map((f) => norm(f).startsWith(root))
  if (inside.every(Boolean)) return true
  if (inside.some(Boolean)) {
    throw new Error(
      `The program to install comes partly from the installed program in ${layout.programDir} and partly from elsewhere; run service install from one package.`,
    )
  }
  return false
}

/**
 * An installed copy reinstalled in place must still hold the shell worker the server starts beside
 * its bundle; asked before anything changes, so a server that works but for shells is not stopped
 * (fourth review of the CI fixes, minor 7; fifth, minor 1).
 */
export function checkInPlace(sys: Sys, layout: Layout, source: ProgramSource, inPlace: boolean): void {
  if (!inPlace || isStandaloneProgram(source)) return
  const worker = (layout.platform === 'win32' ? win32 : posix).join(
    layout.programDir,
    'dist',
    'shell-worker.cjs',
  )
  if (!sys.exists(worker))
    throw new Error(
      `The installed copy has no shell worker (${worker}): it was removed since the install. Run service ` +
        'install from the mongo-manager package, not from the installed copy.',
    )
}

/** Everything the service runs must be replaceable only by administrators (Review Critical 2, Minor 5). */
export function checkProgram(sys: Sys, layout: Layout, source: ProgramSource): void {
  const command = programCommand(layout, source)
  // Third review of the CI fixes (I-1): and the shell worker the server runs beside its bundle.
  const worker = isStandaloneProgram(source)
    ? []
    : [(layout.platform === 'win32' ? win32 : posix).join(layout.programDir, 'dist', 'shell-worker.cjs')]
  for (const path of [...command, ...worker])
    checkTrusted(sys, path, 'The installed program at', trustHint(layout.platform))
  // The copy must not load libraries from where it came from (Homebrew, Linuxbrew).
  checkLinked(
    sys,
    command[0]!,
    'The installed program at',
    'Install with an official Node.js build (nodejs.org or nvm), pass one with --node, or use the standalone binary.',
  )
}

export function serviceUrl(configJson: string): string {
  const c = JSON.parse(configJson) as { host?: string; webPort?: number; basePath?: string }
  const host = !c.host || c.host === '0.0.0.0' || c.host === '::' ? '127.0.0.1' : c.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${c.webPort ?? 4321}${c.basePath ?? '/'}`
}

export async function waitHealthy(
  url: string,
  probe: (url: string) => Promise<boolean>,
  io: Io,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (await probe(new URL('healthz', url).href)) {
      io.stdout.write(`Mongo Manager is running at ${url}\n`)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  io.stderr.write(
    `The service did not answer at ${url} within 30 seconds; check its logs (mongo-manager service logs).\n`,
  )
}

export const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}
