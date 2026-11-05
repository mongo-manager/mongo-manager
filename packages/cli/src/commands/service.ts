// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { posix, win32 } from 'node:path'
import { LAUNCH_FILE, LAUNCH_TTL_START_MS, mintLaunchToken, parseLaunchSecret } from '@mongo-manager/server'
import { UsageError, type Values } from '../args'
import type { Io } from '../io'
import {
  installSource,
  defaultProbe,
  installOptions,
  runningProgram,
  serviceUrl,
  type ProgramSource,
  type ServiceDeps,
} from '../service/common'
import { installDarwin, logsDarwin, statusDarwin, uninstallDarwin } from '../service/darwin'
import { layoutFor, type Layout } from '../service/layout'
import { installLinux, logsLinux, statusLinux, uninstallLinux } from '../service/linux'
import type { ServiceOptions } from '../service/render'
import type { Sys } from '../service/sys'
import { installWindows, logsWindows, statusWindows, uninstallWindows } from '../service/windows'

interface PlatformOps {
  adminHint: string
  install(
    sys: Sys,
    io: Io,
    layout: Layout,
    opts: ServiceOptions & { user: string },
    program: ProgramSource,
    probe: (url: string) => Promise<boolean>,
  ): Promise<void>
  uninstall(sys: Sys, io: Io, layout: Layout): void
  status(sys: Sys, layout: Layout): number
  logs(sys: Sys, io: Io, layout: Layout, follow: boolean): number
}

const PLATFORMS: Partial<Record<NodeJS.Platform, PlatformOps>> = {
  linux: {
    adminHint: 'Installing a service needs root: run it with sudo',
    install: installLinux,
    uninstall: uninstallLinux,
    status: (sys) => statusLinux(sys),
    logs: (sys, _io, _layout, follow) => logsLinux(sys, follow),
  },
  darwin: {
    adminHint: 'Installing a service needs root: run it with sudo',
    install: installDarwin,
    uninstall: uninstallDarwin,
    status: (sys) => statusDarwin(sys),
    logs: (sys, _io, layout, follow) => logsDarwin(sys, layout, follow),
  },
  win32: {
    adminHint: 'Installing a service needs an elevated prompt: run it as Administrator',
    install: installWindows,
    uninstall: uninstallWindows,
    status: (sys, layout) => statusWindows(sys, layout),
    logs: logsWindows,
  },
}

/**
 * Security audit 2026-10-16: a one-time link to the installed service in local mode, made from the
 * secret the service keeps in its data directory (readable by administrators only). Printed, never
 * opened: an elevated browser is not one to use.
 */
export function serviceLaunch(
  sys: Sys,
  layout: Layout,
  now = Date.now(),
): { url: string } | { error: string; local: boolean } {
  if (!sys.exists(layout.configFile)) return { error: 'The service is not installed.', local: false }
  const configJson = sys.read(layout.configFile)
  const address = serviceUrl(configJson)
  if ((JSON.parse(configJson) as { auth?: unknown }).auth !== false)
    return { error: `The service runs in team mode: sign in at ${address}`, local: false }
  const keyFile = (layout.platform === 'win32' ? win32 : posix).join(layout.dataDir, LAUNCH_FILE)
  if (!sys.exists(keyFile))
    return { error: 'The service has not started yet; try again in a moment.', local: true }
  const secret = parseLaunchSecret(sys.read(keyFile), keyFile)
  return { url: `${address}launch/${mintLaunchToken(secret, now, LAUNCH_TTL_START_MS)}` }
}

export async function serviceCommand(
  positionals: string[],
  values: Values,
  io: Io,
  deps: ServiceDeps,
): Promise<number> {
  const { sys } = deps
  const action = positionals[0]
  if (!['install', 'uninstall', 'status', 'logs', 'open'].includes(action ?? '')) {
    throw new UsageError(`Unknown service command "${action}" (use install, uninstall, status, logs or open)`)
  }
  if (values.follow !== undefined && action !== 'logs')
    throw new UsageError('--follow is only valid for "service logs"')
  const ops = PLATFORMS[sys.platform]
  if (!ops) {
    io.stderr.write(`Error: running as a service is not supported on ${sys.platform}\n`)
    return 1
  }
  const layout = layoutFor(sys.platform, io.env)
  try {
    if (action === 'status') return ops.status(sys, layout)
    if (action === 'logs') return ops.logs(sys, io, layout, !!values.follow)
    if (!sys.isAdmin()) throw new Error(ops.adminHint)
    if (action === 'open') {
      const link = serviceLaunch(sys, layout)
      if ('error' in link) {
        io.stderr.write(`Error: ${link.error}\n`)
        return 1
      }
      io.stdout.write(`Open Mongo Manager with this link (it works once, within an hour): ${link.url}\n`)
      return 0
    }
    if (action === 'uninstall') {
      ops.uninstall(sys, io, layout)
      return 0
    }
    if (sys.platform === 'win32' && values.user !== undefined) {
      io.stderr.write('Note: on Windows the service always runs as LocalService; --user is ignored.\n')
    }
    const opts = installOptions(sys.platform === 'win32' ? { ...values, user: undefined } : values, layout)
    const source = deps.program ?? runningProgram()
    const program = installSource(source, values.node, sys)
    await ops.install(sys, io, layout, opts, program, deps.probe ?? defaultProbe)
    // Security audit 2026-10-16: a service in local mode opens only from a launch link.
    const link = serviceLaunch(sys, layout)
    if ('url' in link)
      io.stdout.write(`Open it with this link (it works once, within an hour): ${link.url}\n`)
    else if (link.local)
      io.stdout.write('Get a link that opens it with "mongo-manager service open" once it has started.\n')
    return 0
  } catch (e) {
    if (e instanceof UsageError) throw e
    io.stderr.write(`Error: ${(e as Error).message}\n`)
    return 1
  }
}
