import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import sea from 'node:sea'
import { PipeWorker } from './channel'

/**
 * Phase 3a-1 spec §3.1: how a shell worker is started. The flags are the sandbox: the permission
 * model with read access to the worker bundle only, no code generation from strings, and a heap cap.
 */
export const WORKER_HEAP_MB = 256
/** Below-normal priority so a shell cannot starve the server. */
const WORKER_PRIORITY = 10
/** Default unprivileged ids when the server runs as root (spec §3.1). */
export const DEFAULT_WORKER_UID = 65534
export const DEFAULT_WORKER_GID = 65534

/** Whether this Node knows the network permission (Node 25+): then the worker gets no network. */
export function supportsNetPermission(
  allowedNodeFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): boolean {
  return allowedNodeFlags.has('--allow-net')
}

export function workerArgs(bundlePath: string | null, options: { netPermission: boolean }): string[] {
  const args = ['--permission']
  // A SEA worker reads nothing from disk: its code is an embedded asset.
  if (bundlePath) args.push(`--allow-fs-read=${bundlePath}`)
  args.push(
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${WORKER_HEAP_MB}`,
    '--max-semi-space-size=16',
  )
  // On a Node that enforces the network permission (25+), --permission would otherwise block the
  // worker's only outbound socket — the one to the loopback proxy — and the shell could never
  // connect. The worker's egress is controlled by the in-process network lock (network.ts), which
  // rewrites every connection to the proxy with a token and deletes fetch/WebSocket, on every Node
  // version; --allow-net keeps parity with Node 24 (which has no network permission at all) rather
  // than silently breaking the shell.
  //
  // Security audit 2026-10-16 (Important 4) weighed handing the worker already-connected sockets
  // instead (spec §3.1/§5.1, "Node ≥ 25") and kept --allow-net. Its cost: where Node has a network
  // permission (25+: the Docker image and the release binaries, both Node 26, and npm installs on 25+)
  // the worker is given the network, and Node's permission model refuses it nothing; on Node 24 there
  // is nothing for that model to refuse (reviews of the SEA fix 2026-10-20, minor 4 and 1). It was
  // kept for these reasons:
  // - The driver opens connections on demand (a monitor and an RTT socket per member, a pool of up
  //   to 16 through the proxy), synchronously expecting a Socket back from net.connect; each would
  //   need an asynchronous request to the parent, a handle passed back over an IPC channel, and a
  //   Duplex shim standing in for the socket until it arrives.
  // - Handles travel only over Node's IPC channel, which parses whatever the worker writes before
  //   anyone can bound its size; the worker now talks over plain pipes for exactly that reason
  //   (channel.ts), so this would bring an unbounded parser back.
  // The in-process lock (network.ts) remains the egress control on every version: every connect is
  // rewritten to the token-checked proxy, which allows only the connection's own hosts; UDP, DNS,
  // TLS, HTTP and listening are refused.
  if (options.netPermission) args.push('--allow-net')
  return args
}

/**
 * The worker's environment: Winsock needs SystemRoot on Windows. Windows' process start adds a few
 * of the parent's own (PATH, TEMP, USERPROFILE and the like) when they are missing; the worker
 * removes every one it does not keep before it runs anything (scrubEnv).
 */
export function workerEnv(
  parent: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Record<string, string> {
  if (platform === 'win32' && parent.SystemRoot) return { SystemRoot: parent.SystemRoot }
  return {}
}

/** True when running as a single executable (SEA); the worker is then an embedded asset, not a file. */
export function isSea(): boolean {
  try {
    return sea.isSea()
  } catch {
    return false
  }
}

/**
 * The worker bundle path on disk, or null under a SEA (where the worker is an embedded asset). The
 * bundle sits next to the running script in an npm install (dist/shell-worker.cjs) and in the
 * server package's dist during development; the first that exists wins.
 */
export function workerBundlePath(candidates?: string[]): string | null {
  if (isSea()) return null
  const list = candidates ?? [
    // npm: cli.cjs and shell-worker.cjs are both in dist/.
    process.argv[1] ? join(dirname(process.argv[1]), 'shell-worker.cjs') : '',
    // development: this file is server/src/shell/spawn.ts → server/dist/shell-worker.cjs.
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'shell-worker.cjs'),
  ]
  return list.find((p) => p && existsSync(p)) ?? list.at(-1) ?? null
}

export interface SpawnOptions {
  bundlePath: string | null
  uid?: number
  gid?: number
  /** Injected in tests. */
  spawnFn?: typeof spawn
  platform?: NodeJS.Platform
  /** True to run the SEA's hidden worker subcommand instead of a bundle file. */
  seaSubcommand?: boolean
}

/**
 * The spawn options for a worker: the sandbox flags in execArgv, a minimal environment, plain pipes
 * and no IPC channel (security audit 2026-10-16: messages are bounded lines, channel.ts), and, on a
 * root POSIX server, dropped privileges (spec §3.1). Pure, for testing the privilege drop.
 */
export function workerForkOptions(input: {
  bundlePath: string | null
  platform: NodeJS.Platform
  isRoot: boolean
  uid?: number
  gid?: number
}): {
  execArgv: string[]
  env: Record<string, string>
  uid?: number
  gid?: number
  stdio: ['pipe', 'pipe', 'pipe']
} {
  const options = {
    execArgv: workerArgs(input.bundlePath, { netPermission: supportsNetPermission() }),
    env: workerEnv(process.env, input.platform),
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  }
  if (input.platform !== 'win32' && input.isRoot) {
    return { ...options, uid: input.uid ?? DEFAULT_WORKER_UID, gid: input.gid ?? DEFAULT_WORKER_GID }
  }
  return options
}

/**
 * The command line fork() would build: Node's flags, the bundle, then its arguments. A standalone
 * binary takes Node's flags only through --node-options (execArgvExtension 'cli'), then its own
 * arguments (review of the CI fix 2026-10-20: given as they are, they were its arguments and the
 * shell never started). Node reads that value as it reads NODE_OPTIONS: a space splits it, a double
 * quote opens or closes a quoted part and a backslash escapes inside one, so a flag holding any of
 * these (or other whitespace) is refused. It must be the only --node-options (the last one wins),
 * and nothing untrusted follows it (reviews of the SEA fix 2026-10-20, minor 1 and 2).
 */
export function workerCommandArgs(
  execArgv: string[],
  modulePath: string,
  args: string[],
  options: { sea?: boolean } = {},
): string[] {
  if (!options.sea) return [...execArgv, modulePath, ...args]
  const odd = execArgv.find((a) => /[\s"\\]/.test(a))
  if (odd !== undefined) throw new Error(`A shell worker flag Node would read differently: ${odd}`)
  return [`--node-options=${execArgv.join(' ')}`, ...args]
}

/**
 * Spawn a shell worker with the sandbox flags, a minimal environment, below-normal priority, and,
 * on a root POSIX server, dropped privileges. Returns it wrapped in its message channel.
 */
export function spawnWorker(options: SpawnOptions): PipeWorker {
  const platform = options.platform ?? process.platform
  const spawnFn = options.spawnFn ?? spawn
  const isRoot = platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0
  const modulePath = options.bundlePath ?? process.execPath
  const forkArgs = options.seaSubcommand ? ['__mm-shell-worker'] : []
  const forkOptions = workerForkOptions({
    bundlePath: options.bundlePath,
    platform,
    isRoot,
    uid: options.uid,
    gid: options.gid,
  })
  const { execArgv, ...spawnOptions } = forkOptions
  const child = spawnFn(
    process.execPath,
    workerCommandArgs(execArgv, modulePath, forkArgs, { sea: options.seaSubcommand }),
    {
      ...spawnOptions,
      windowsHide: true,
    },
  )
  try {
    if (child.pid) os.setPriority(child.pid, WORKER_PRIORITY)
  } catch {
    // Priority is best effort.
  }
  return new PipeWorker(child)
}
