// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
// The configuration module alone (2026-11-03): the launcher reads the data directory without loading the server.
import { readConfigFile, resolveConfig, type Config, type PartialConfig } from '@mongo-manager/server/config'
import type { Io } from './io'

/** A MongoDB connection string that carries a password. */
export const URI_WITH_PASSWORD = /^mongodb(?:\+srv)?:\/\/[^/@]*:[^/@]*@/i

export class UsageError extends Error {
  override name = 'UsageError'
}

export const OPTIONS = {
  'web-port': { type: 'string', short: 'p' },
  host: { type: 'string' },
  auth: { type: 'boolean' },
  'data-dir': { type: 'string' },
  config: { type: 'string' },
  open: { type: 'boolean' },
  uri: { type: 'string' },
  'read-only': { type: 'boolean' },
  'trusted-proxies': { type: 'string' },
  'allowed-hosts': { type: 'string' },
  'base-path': { type: 'string' },
  'unsafe-no-auth': { type: 'boolean' },
  shell: { type: 'boolean' },
  'log-level': { type: 'string' },
  'web-root': { type: 'string' },
  'log-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  role: { type: 'string' },
  'require-2fa': { type: 'boolean' },
  'password-stdin': { type: 'boolean' },
  'new-key-file': { type: 'string' },
  user: { type: 'string' },
  node: { type: 'string' },
  follow: { type: 'boolean', short: 'f' },
  out: { type: 'string', short: 'o' },
  'key-file': { type: 'string' },
  key: { type: 'string' },
  all: { type: 'boolean' },
  // Hidden (updater, 2026-11-03): a service install asks its launcher to end the account's other
  // processes before a downloaded version runs.
  'isolate-account': { type: 'boolean' },
} as const

export type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string
}

export const COMMANDS = [
  'start',
  'open',
  'forget-browsers',
  'user',
  'bans',
  'access',
  'rotate-key',
  'doctor',
  'service',
  'version',
  'help',
  'backup',
] as const
export type Command = (typeof COMMANDS)[number]

/** Options that only one command understands; every command also takes the server options. */
const COMMAND_OPTIONS: Partial<Record<keyof typeof OPTIONS, Command | Command[]>> = {
  role: 'user',
  'require-2fa': 'user',
  'password-stdin': ['user', 'backup'],
  out: 'backup',
  'key-file': 'backup',
  key: 'backup',
  'new-key-file': 'rotate-key',
  user: 'service',
  node: 'service',
  follow: 'service',
  all: 'bans',
  'isolate-account': 'start',
}
/** How many positional arguments each command takes: [min, max]. */
const ARITY: Record<Command, [number, number]> = {
  start: [0, 0],
  open: [0, 0],
  'forget-browsers': [0, 0],
  user: [1, 2],
  bans: [1, 2],
  access: [1, 1],
  'rotate-key': [0, 0],
  doctor: [0, 0],
  service: [1, 1],
  version: [0, 0],
  help: [0, 1],
  backup: [2, 2],
}

export function parseCli(argv: string[]): { command: Command; positionals: string[]; values: Values } {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  const [first, ...positionals] = parsed.positionals
  const command = (first ?? 'start') as Command
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}"`)
  const values = parsed.values as Values
  for (const [option, owner] of Object.entries(COMMAND_OPTIONS)) {
    const owners = ([] as Command[]).concat(owner)
    if (values[option as keyof Values] !== undefined && !owners.includes(command)) {
      throw new UsageError(`--${option} is only valid for "${owners.join('" or "')}"`)
    }
  }
  const [min, max] = ARITY[command]
  if (positionals.length > max) throw new UsageError(`Unexpected argument "${positionals[max]}"`)
  if (positionals.length < min) throw new UsageError(`"${command}" needs more arguments`)
  return { command, positionals, values }
}

const list = (text: string | undefined) =>
  text === undefined
    ? undefined
    : text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

function cliConfig(values: Values, cwd: string): PartialConfig {
  let webPort: number | undefined
  if (values['web-port'] !== undefined) {
    const text = values['web-port']
    webPort = /^\d{1,5}$/.test(text) ? Number(text) : NaN
    if (!(webPort >= 0 && webPort <= 65535))
      throw new UsageError(`--web-port must be a port number (0-65535), got "${text}"`)
  }
  const path = (p: string | undefined) => (p === undefined ? undefined : resolve(cwd, p))
  const out: PartialConfig = {
    webPort,
    host: values.host,
    auth: values.auth,
    dataDir: path(values['data-dir']),
    open: values.open,
    uri: values.uri,
    readOnly: values['read-only'],
    trustedProxies: list(values['trusted-proxies']),
    allowedHosts: list(values['allowed-hosts']),
    basePath: values['base-path'],
    unsafeNoAuth: values['unsafe-no-auth'],
    logLevel: values['log-level'] as PartialConfig['logLevel'],
    webRoot: path(values['web-root']),
    logFile: path(values['log-file']),
    // Phase 3a-1: --no-shell disables the advanced shell; --shell forces it on (the parser reads
    // --no-shell as shell=false, and the last of the two wins). resolveConfig merges this over the
    // other layers' shell settings, so a partial is enough here.
    shell: (values.shell === undefined ? undefined : { enabled: values.shell }) as PartialConfig['shell'],
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as PartialConfig
}

/** CLI > env > config file > defaults. A config file holding a secret must be private. */
export function loadConfig(values: Values, io: Io): Config {
  const fileArg = values.config ?? io.env.MM_CONFIG
  let file: PartialConfig | undefined
  if (fileArg) {
    const path = isAbsolute(fileArg) ? fileArg : resolve(io.cwd, fileArg)
    file = readConfigFile(path, io.platform)
    // A secret key, the metrics token or a connection string with a password must not be readable
    // by other users.
    const secret = file.secretKey
      ? 'secretKey'
      : file.metricsToken
        ? 'metricsToken'
        : file.uri && URI_WITH_PASSWORD.test(file.uri)
          ? 'a password in uri'
          : null
    if (secret && io.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new UsageError(
        `Config file ${path} contains ${secret} but is readable by other users. Run: chmod 600 ${path}`,
      )
    }
  }
  return resolveConfig({
    cli: cliConfig(values, io.cwd),
    env: io.env,
    ...(file ? { file } : {}),
    platform: io.platform,
  })
}
