// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  LAUNCH_TTL_OPEN_MS,
  LAUNCH_TTL_START_MS,
  mintForgetToken,
  mintLaunchToken,
  readLaunchSecret,
  runningInstance,
  type Config,
} from '@mongo-manager/server'
import type { Io } from '../io'
import { writeLaunchFile } from '../launchFile'
import { openData } from '../data'

/**
 * Review of the audit fixes (important 1): `mongo-manager forget-browsers` signs every browser out
 * of local mode — beside a running server too (it asks the store on every request).
 */
export async function forgetBrowsersCommand(config: Config, io: Io): Promise<number> {
  const plural = (n: number) => `${n} browser${n === 1 ? '' : 's'}`
  // Second review (minor 3): a running server is asked, with a one-time token of its own kind, so
  // its sockets and the local shells (a command running in them too) end at once.
  const holder = runningInstance(config.dataDir)
  const secret = holder?.what === 'server' ? readLaunchSecret(config.dataDir) : null
  if (holder?.address && secret) {
    const address = localAddress({ ...config, ...holder.address, webPort: holder.address.port })
    try {
      const res = await fetch(`${address}launch/forget/${mintForgetToken(secret, Date.now())}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        const { removed } = (await res.json()) as { removed: number }
        io.stdout.write(
          `${plural(removed)} signed out by the running server; each opens it again only from a new link.\n`,
        )
        return 0
      }
    } catch {
      // Not answering: the store is changed directly below.
    }
  }
  const data = await openData(config)
  try {
    const n = Number(data.store.db.prepare('DELETE FROM local_browsers').run().changes)
    io.stdout.write(
      `${plural(n)} signed out of local mode; each opens it again only from a new link.` +
        (holder ? ' Open sockets end within a minute; restart Mongo Manager to end its shells now.\n' : '\n'),
    )
    return 0
  } finally {
    data.close()
  }
}

/** The address a browser on this computer reaches the server at (a wildcard bind: loopback). */
export function localAddress(config: Pick<Config, 'host' | 'webPort' | 'basePath'>): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.webPort}${config.basePath}`
}

/**
 * Security audit 2026-10-16: `mongo-manager open` — a one-time link that opens a running local-mode
 * Mongo Manager in the browser (the one it printed at start is used up, or the browser forgot it).
 * Made from the secret in the data directory, so only who can read that directory can.
 *
 * Review of the audit fixes: at the running server's own address, which it keeps in its lock
 * (minor 7); opened through a private redirect file with a two-minute link, never a token on a
 * command line (important 2); printed, for an hour, when there is no terminal or no browser opened.
 */
export async function openCommand(config: Config, io: Io, now = Date.now()): Promise<number> {
  if (config.auth) {
    io.stderr.write(`Error: team mode has no launch link; sign in at ${localAddress(config)}\n`)
    return 1
  }
  const holder = runningInstance(config.dataDir)
  const secret = holder?.what === 'server' ? readLaunchSecret(config.dataDir) : null
  if (!holder || !secret) {
    io.stderr.write(
      `Error: Mongo Manager is not running on ${config.dataDir}. Start it with "mongo-manager" (it opens the browser itself).\n`,
    )
    return 1
  }
  const address = localAddress({
    ...config,
    ...(holder.address ? { ...holder.address, webPort: holder.address.port } : {}),
  })
  const link = (ttlMs: number) => `${address}launch/${mintLaunchToken(secret, now, ttlMs)}`
  if (config.open && io.stdout.isTTY === true) {
    const file = writeLaunchFile(link(LAUNCH_TTL_OPEN_MS), LAUNCH_TTL_OPEN_MS)
    if (await io.openBrowser(file.path)) {
      // Second review (N3): a browser that cannot read the file (a snap or Flatpak one) or an opener
      // that shows it in an editor still exits well: the terminal gets a link of its own as well.
      io.stdout.write(`Opening Mongo Manager at ${address}\n`)
      io.stdout.write(`If no browser opened it: ${link(LAUNCH_TTL_START_MS)}\n`)
      return 0
    }
    file.remove()
    io.stdout.write('No browser opened.\n')
  }
  io.stdout.write(
    `Open Mongo Manager with this link (it works once, within an hour): ${link(LAUNCH_TTL_START_MS)}\n`,
  )
  return 0
}
