import { existsSync } from 'node:fs'
import {
  LAUNCH_TTL_OPEN_MS,
  LAUNCH_TTL_START_MS,
  isLoopbackHost,
  startServer,
  type Config,
} from '@mongo-manager/server'
import { writeLaunchFile } from '../launchFile'
import { URI_WITH_PASSWORD, type Values } from '../args'
import type { Io } from '../io'
import { packagedBundledPlugins, packagedWebRoot } from '../paths'
import { embeddedPlugins, embeddedWebAssets } from '../sea'
import { VERSION } from '../version'

/**
 * A container's terminal is kept by its runtime (`docker logs`) — a log like any other (review of
 * the setup token, minor 6).
 */
const runsInContainer = () => existsSync('/.dockerenv') || existsSync('/run/.containerenv')

export async function start(
  config: Config,
  values: Values,
  io: Io,
  deps: { startServer: typeof startServer; inContainer?: () => boolean } = { startServer },
): Promise<number> {
  const inContainer = deps.inContainer ?? runsInContainer
  if (values.uri && URI_WITH_PASSWORD.test(values.uri)) {
    io.stderr.write(
      'Warning: the connection string given with --uri contains a password, which is visible to other users of ' +
        'this machine (process list, shell history). Prefer the MM_URI environment variable, or add the connection in the UI.\n',
    )
  }
  if (config.unsafeNoAuth && !isLoopbackHost(config.host)) {
    io.stderr.write(
      `WARNING: listening on ${config.host} without authentication (--unsafe-no-auth). Anyone who can reach this ` +
        'port has full access to every saved connection.\n',
    )
  }
  // An explicit --web-root wins; the standalone binary serves its embedded copy from memory.
  const webAssets = config.webRoot ? undefined : embeddedWebAssets()
  const webRoot = config.webRoot ?? (webAssets ? undefined : packagedWebRoot())
  // Phase 4b §4: the plugins shipped beside the bundle. The standalone binary carries its own inside
  // (2026-11-01: it had none), which the server writes into the data directory — never a folder
  // beside the program.
  const bundledPluginsDir = config.bundledPluginsDir ?? (webAssets ? undefined : packagedBundledPlugins())
  const plugins = !bundledPluginsDir && webAssets ? embeddedPlugins() : undefined
  const server = await deps.startServer(
    { ...config, ...(webRoot ? { webRoot } : {}), ...(bundledPluginsDir ? { bundledPluginsDir } : {}) },
    {
      logger: config.logLevel !== 'silent',
      ...(webAssets ? { webAssets } : {}),
      ...(plugins ? { embeddedPlugins: plugins } : {}),
    },
  )
  io.stderr.write(
    `Mongo Manager ${VERSION} (${config.auth ? 'team mode' : 'local mode'}) is running at ${server.url}\n`,
  )
  // Security audit 2026-10-16: in local mode the app opens only from a one-time launch link, said on
  // the next line (the line above keeps its address, which scripts read). Review of the audit fixes
  // (minor 6): the link itself only to a terminal outside a container; anywhere else the output is
  // usually a log (a service, pm2, nohup, docker logs), which gets the path of a file only this
  // account can read that opens it — never a bearer link.
  const launchUrl = server.launchUrl ?? null
  const files: Array<{ remove(): void }> = []
  if (launchUrl) {
    // Second review (minor 6): a file inside a container is no use on the host; the command is.
    if (inContainer())
      io.stderr.write(
        'Get a link that opens it with: docker exec <container> node /app/dist/cli.cjs open --no-open\n',
      )
    else if (io.stderr.isTTY)
      io.stderr.write(`Open it with this link (it works once, within an hour): ${launchUrl()}\n`)
    else {
      const file = writeLaunchFile(launchUrl(LAUNCH_TTL_START_MS), LAUNCH_TTL_START_MS)
      files.push(file)
      io.stderr.write(`Open it from this file (it works once, within an hour): ${file.path}\n`)
    }
  }
  // Security review 2026-10-13: how this start may leak sign-ins, said where the person looks.
  for (const w of server.warnings ?? []) io.stderr.write(`Warning: ${w}\n`)
  if (server.setupToken) {
    // Output that is not a terminal is usually a log (a service, a container): it names the file
    // that holds the token, never the token (security review 2026-10-13).
    io.stderr.write(
      (io.stderr.isTTY && !inContainer()) || !server.setupTokenFile
        ? `\nFirst-run setup: open ${server.url} and enter this one-time setup token:\n\n    ${server.setupToken}\n\n`
        : `\nFirst-run setup: open ${server.url} and enter the one-time setup token from ${server.setupTokenFile}\n\n`,
    )
  }
  // A link of its own (the printed one stays unused for the person to open elsewhere), for two
  // minutes, through a private file: never on the opener's command line (review of the audit fixes,
  // important 2).
  if (config.open && !config.auth && isLoopbackHost(config.host) && io.stdout.isTTY) {
    if (launchUrl) {
      const file = writeLaunchFile(launchUrl(LAUNCH_TTL_OPEN_MS), LAUNCH_TTL_OPEN_MS)
      files.push(file)
      void io.openBrowser(file.path)
    } else void io.openBrowser(server.url)
  }
  await io.waitForShutdown()
  for (const file of files) file.remove()
  await server.close()
  return 0
}
