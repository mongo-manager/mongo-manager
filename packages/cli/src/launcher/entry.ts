// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import sea from 'node:sea'
import {
  STANDALONE_TARGETS,
  compareReleaseVersions,
  readUpdateState,
  verifyVersionDir,
  type UpdaterOrigin,
} from '@mongo-manager/shared/updates'
import { VERSION } from '../version'
import { isolateAccount } from './isolate'
import { launch } from './run'

/**
 * Commands that run as they are, in this process: `service install` copies this very program, and the
 * help is the installed program's.
 */
const IN_PROCESS = new Set(['service', 'help'])
/** The accounts `service install` makes for the service (service/layout.ts): the app's alone. */
const SERVICE_ACCOUNTS = new Set(['mongo-manager', '_mongomanager'])

/** The standalone build this binary is, as the release names it; null for one it does not make. */
export function standaloneTarget(platform: string, arch: string): string | null {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : platform
  const target = `${os}-${arch}`
  return (STANDALONE_TARGETS as readonly string[]).includes(target) ? target : null
}

export interface LaunchPlan {
  command: string
  dataDir: string
  /** MM_UPDATES and the config file's updates.enabled. */
  updatesEnabled: boolean
  proxy?: string
  isolateFlag: boolean
}

const OFF = /^(off|0|false|no)$/i

/** `--name value` or `--name=value`, wherever it stands. */
function option(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === `--${name}`) return argv[i + 1]
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return undefined
}

/**
 * Final review (I2, 2026-11-03): what the launcher needs — the command, the data directory, whether
 * updates are on — read without this version's own option and config schemas, so a later version's
 * new option, command or config key never stops the version that knows it from being started. The
 * precedence is the app's: command line, then environment, then config file, then the default. Null
 * for a command that runs in this process.
 */
export function launchPlan(
  argv: string[],
  io: { env: Record<string, string | undefined>; cwd: string; platform: NodeJS.Platform; home: string },
): LaunchPlan | null {
  const first = argv[0]
  // `--version` and `--help` alone are commands of their own: never a start (no lock, no tidying).
  const flag = (...names: string[]) => argv.some((a) => names.includes(a))
  const command =
    first && !first.startsWith('-')
      ? first
      : flag('--version', '-v')
        ? 'version'
        : flag('--help', '-h')
          ? 'help'
          : 'start'
  if (IN_PROCESS.has(command)) return null
  const configArg = option(argv, 'config') ?? io.env.MM_CONFIG
  let file: { dataDir?: unknown; updates?: { enabled?: unknown; proxy?: unknown } } = {}
  if (configArg) {
    try {
      const path = isAbsolute(configArg) ? configArg : resolve(io.cwd, configArg)
      file = JSON.parse(readFileSync(path, 'utf8')) as typeof file
    } catch {
      // The program itself says what is wrong with it.
    }
  }
  const named =
    option(argv, 'data-dir') ??
    (io.env.MM_DATA_DIR || undefined) ??
    (typeof file.dataDir === 'string' && file.dataDir ? file.dataDir : undefined)
  const dataDir = named ? resolve(io.cwd, named) : join(io.home, '.mongo-manager')
  const updatesEnabled =
    io.env.MM_UPDATES !== undefined && io.env.MM_UPDATES !== ''
      ? !OFF.test(io.env.MM_UPDATES)
      : file.updates?.enabled !== false
  const proxy =
    io.env.MM_UPDATE_PROXY || (typeof file.updates?.proxy === 'string' ? file.updates.proxy : undefined)
  return {
    command,
    dataDir,
    updatesEnabled,
    ...(proxy ? { proxy } : {}),
    isolateFlag: argv.includes('--isolate-account'),
  }
}

/**
 * Final review (minor): `mongo-manager --version` says the version that runs — the downloaded one,
 * when it is settled and verifies, besides the installed one — without starting either.
 */
export function versionLine(
  dataDir: string,
  origin: UpdaterOrigin,
  keys: readonly string[] | undefined,
  node: string,
): string {
  const bundled = origin.bundledVersion
  const state = readUpdateState(join(dataDir, 'app'))
  const settled = state.settled
  if (settled && compareReleaseVersions(settled, bundled) > 0 && !state.failed.includes(settled)) {
    const r = verifyVersionDir(join(dataDir, 'app', settled), {
      kind: origin.distribution === 'standalone' ? 'standalone' : 'package',
      target: origin.target,
      ...(keys ? { keys } : {}),
    })
    if (r.ok && !(r.info.minLauncher && compareReleaseVersions(r.info.minLauncher, bundled) > 0))
      return `mongo-manager ${settled} (node ${node}; installed ${bundled})`
  }
  return `mongo-manager ${bundled} (node ${node})`
}

/**
 * Updater (2026-11-03): whether this start goes through the launcher. Null when the program should
 * run here, as before — from source, or for `service`.
 */
export async function runLauncher(argv: string[]): Promise<number | null> {
  const isSea = sea.isSea()
  // The build maps import.meta.dirname to the bundle's own folder (dist).
  const bundled = /[\\/]dist$/.test(import.meta.dirname)
  if (!isSea && !bundled) return null
  const plan = launchPlan(argv, {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
  })
  if (!plan) return null
  const docker = !isSea && process.env.MM_DISTRIBUTION === 'docker'
  // Final review (I3): never root (in a container run as root with the host's processes, or a unit
  // written by hand, that would end the whole machine's), in Docker only under the image's tini as
  // pid 1 (not with --pid=host), and for a service only as the account `service install` made for
  // it. Windows has its own narrower rule (isolate.ts).
  const posix = process.platform !== 'win32'
  const uid = process.getuid?.()
  const notRoot = !posix || (uid !== undefined && uid !== 0)
  let ownAccount = !posix
  try {
    ownAccount ||= SERVICE_ACCOUNTS.has(userInfo().username)
  } catch {
    // No account name: not the service's own.
  }
  const isolate = notRoot && ((docker && process.ppid === 1) || (plan.isolateFlag && ownAccount))
  const installDir = isSea ? process.execPath : import.meta.dirname
  const origin: UpdaterOrigin = {
    distribution: isSea ? 'standalone' : docker ? 'docker' : 'bundle',
    bundledVersion: VERSION,
    installDir,
    target: isSea ? standaloneTarget(process.platform, process.arch) : null,
    isolate,
  }
  // A settled version that no longer verifies is downloaded again: the server's code, loaded only then.
  const download = async (version: string) => {
    const { createEgress, downloadVersion } = await import('@mongo-manager/server')
    await downloadVersion({
      egress: createEgress({
        networks: [],
        networksSetting: 'no setting (the update download reaches public addresses only)',
        ...(plan.proxy ? { proxy: plan.proxy } : {}),
      }),
      dataDir: plan.dataDir,
      version,
      kind: origin.distribution === 'standalone' ? 'standalone' : 'package',
      target: origin.target,
    })
    return true
  }
  // Windows: the programs ended are this install's and its data directory's (isolate.ts).
  const roots = [dirname(installDir), plan.dataDir]
  if (plan.command === 'version') {
    process.stdout.write(`${versionLine(plan.dataDir, origin, undefined, process.versions.node)}\n`)
    return 0
  }
  return launch(argv, {
    command: plan.command,
    env: process.env,
    dataDir: plan.dataDir,
    origin,
    updatesEnabled: plan.updatesEnabled,
    isolate: (previous) => isolateAccount(previous, roots),
    download,
  })
}
