import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { ConnectionSettingsSchema, parseConnectionUri } from '@mongo-manager/shared'
import { ConfigError, assertSafeBind, startupWarnings, type Config } from './config'
import { openStore, type Store } from './store/db'
import { acquireInstanceLock } from './store/lock'
import { PRIVATE_NOTICE, repairPrivate, type Repaired } from './store/datadir'
import { redactUriSecrets } from './connections/errors'
import { KEY_FILE, createSecretBox, loadOrCreateKey } from './crypto/secret-box'
import { setAsideEmpty, sweepPartials } from './store/key-file'
import {
  ROTATION_KEPT_MS,
  assertKeyMayBeCreated,
  finishPendingRotation,
  sweepRotationLeftovers,
  verifyKeyCheck,
} from './crypto/rotate'
import { buildApp } from './http/app'
import { folderRootWarnings } from './backup/roots-check'
import { defaultWebRoot, type WebAssets } from './http/web'
import { writeEmbeddedPlugins } from './plugins/embedded'
import { VERSION } from './version'
import { LAUNCH_FILE, LAUNCH_TTL_START_MS, loadOrCreateLaunchSecret } from './auth/launch'

export interface StartedServer {
  app: FastifyInstance
  url: string
  setupToken: string | null
  /** Where the token is kept for whoever cannot see the console (a service, a container). */
  setupTokenFile: string | null
  /** What this start should say about how it is reached (security review 2026-10-13). */
  warnings: string[]
  /**
   * Security audit 2026-10-16: local mode — a new one-time link that opens the app in a browser
   * (each works once, within an hour); null in team mode.
   */
  launchUrl: ((ttlMs?: number) => string) | null
  /** Settles when the app asks to be started again (an update installed); the CLI then exits with 75. */
  restartRequested: Promise<void>
  requestRestart(): void
  close(): Promise<void>
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export async function startServer(
  config: Config,
  opts: {
    logger?: boolean
    installSignalHandlers?: boolean
    webAssets?: WebAssets
    /** The standalone binary's bundled plugins, written into the data directory (2026-11-01). */
    embeddedPlugins?: ReadonlyMap<string, Uint8Array>
  } = {},
): Promise<StartedServer> {
  assertSafeBind(config)
  // Updater (2026-11-03): the app asks for a restart through this; the launcher starts it again.
  let requestRestart = () => {}
  const restartRequested = new Promise<void>((resolve) => (requestRestart = resolve))
  // An explicit web root that holds no build is a mistake, not a request for API-only mode.
  if (config.webRoot && !existsSync(join(config.webRoot, 'index.html'))) {
    throw new ConfigError(`webRoot ${config.webRoot} does not contain a built web app (index.html)`)
  }
  // Security audit 2026-10-16 (minor): a data directory or key already there and open to every user of
  // the computer is made private now; the log says so once it is open. A failure does not stop the
  // start (doctor still reports an open directory). Second review: looked at before this start writes
  // anything there (its lock first), so only a folder as it was — a data directory's or an empty
  // one — is ever changed.
  let repaired: Repaired[] = []
  let repairFailed: unknown = null
  try {
    repaired = repairPrivate([config.dataDir, join(config.dataDir, 'secret.key')], { made: true })
  } catch (e) {
    repairFailed = e
  }
  const lock = acquireInstanceLock(config.dataDir)
  // Review of the CI fix 2026-10-20 (minor 3, 4): what a start stopped while writing a key left,
  // taken away by this one, which holds the lock: an empty key (then as none at all), and a key's
  // second name or one never named.
  try {
    setAsideEmpty(join(config.dataDir, KEY_FILE))
    setAsideEmpty(join(config.dataDir, LAUNCH_FILE))
    sweepPartials(config.dataDir)
  } catch (e) {
    lock.release()
    throw e
  }
  let store: Store
  try {
    store = await openStore(config.dataDir)
  } catch (e) {
    lock.release()
    throw e
  }
  let app: FastifyInstance
  let swept: { removed: string[]; kept: string[] }
  try {
    finishPendingRotation(config.dataDir, store.db)
    assertKeyMayBeCreated(store.db, config.dataDir, config.secretKey)
    const secretBox = createSecretBox(
      loadOrCreateKey({ dataDir: config.dataDir, ...(config.secretKey ? { envKey: config.secretKey } : {}) }),
    )
    // A wrong key is refused here, not discovered at the first decrypt (spec §3.4).
    verifyKeyCheck(store.db, secretBox, config.dataDir)
    // Security audit 2026-10-16 (minor): the key opened the data, so a rotation's leftovers past their
    // recovery window go (the previous key and the backup sealed with it open the old secrets).
    swept = sweepRotationLeftovers(config.dataDir, Date.now())
    const webRoot = config.webRoot ?? defaultWebRoot()
    // The data directory is private and locked by now: the binary's plugins are written there.
    const bundledPluginsDir =
      config.bundledPluginsDir ??
      (opts.embeddedPlugins ? writeEmbeddedPlugins(config.dataDir, VERSION, opts.embeddedPlugins) : undefined)
    app = await buildApp({
      config: bundledPluginsDir ? { ...config, bundledPluginsDir } : config,
      store,
      secretBox,
      // Security audit 2026-10-16: local mode's per-install secret, owner-only in the data directory.
      ...(config.auth ? {} : { launchSecret: loadOrCreateLaunchSecret(config.dataDir) }),
      logger: opts.logger ?? false,
      requestRestart,
      ...(webRoot ? { webRoot } : {}),
      ...(opts.webAssets ? { webAssets: opts.webAssets } : {}),
    })
  } catch (e) {
    store.close()
    lock.release()
    throw e
  }
  for (const { path, was } of repaired) app.log.warn({ path, was }, PRIVATE_NOTICE)
  if (repairFailed)
    app.log.warn({ err: repairFailed }, 'could not check that the data directory is private to this account')
  if (swept.removed.length)
    app.log.info({ files: swept.removed }, 'key rotation: the previous key and backup were removed')
  if (swept.kept.length)
    app.log.warn(
      { files: swept.kept, days: ROTATION_KEPT_MS / 86_400_000 },
      'key rotation: the previous key and backup are kept until the recovery window ends; together they ' +
        'open the secrets as they were, so move them somewhere safe or delete them once the new key works',
    )

  let setupToken: string | null = null
  let setupTokenFile: string | null = null
  const tokenFile = join(config.dataDir, 'setup-token')
  if (config.auth && app.ctx.users.count() === 0) {
    setupToken = app.ctx.setup.ensureToken()
    try {
      app.ctx.setup.keepIn(tokenFile)
      setupTokenFile = tokenFile
      app.log.warn(`First-run setup: open Mongo Manager and enter the one-time setup token from ${tokenFile}`)
    } catch (e) {
      // Without the file the log is the only way to the token: one that cannot be set up is worse.
      app.log.warn({ err: e }, `could not write ${tokenFile}`)
      app.log.warn(`First-run setup: open Mongo Manager and enter this one-time setup token: ${setupToken}`)
    }
  } else {
    // A token left from a start before the first user: it is no use, and nobody should read it.
    rmSync(tokenFile, { force: true })
  }

  const db = store.db
  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'uri_seeded'").get() !== undefined
  if (config.uri && !seeded) {
    let settings
    try {
      settings = ConnectionSettingsSchema.parse(parseConnectionUri(config.uri))
    } catch (e) {
      await app.close()
      store.close()
      lock.release()
      throw new ConfigError(`--uri cannot be used: ${redactUriSecrets((e as Error).message, config.uri)}`)
    }
    // Seed only once: a user who later deletes it (or already has connections) keeps that choice.
    if (app.ctx.connections.count() === 0) {
      app.ctx.connections.create(
        { name: 'Default', favorite: true, readOnly: config.readOnly, settings },
        null,
      )
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('uri_seeded', '1')").run()
  }

  try {
    await app.listen({ port: config.webPort, host: config.host })
  } catch (e) {
    // e.g. the port is in use: leave the data directory free for the next attempt.
    await app.close()
    store.close()
    lock.release()
    throw e
  }
  const warnings = [...startupWarnings(config), ...folderRootWarnings(config.backup.folderRoots)]
  for (const w of warnings) app.log.warn(w)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : config.webPort
  const url = `http://${formatHost(config.host)}:${port}${config.basePath}`
  // Review of the audit fixes (minor 7): `mongo-manager open` reads where this server listens.
  lock.setAddress({ host: config.host, port, basePath: config.basePath })

  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      await app.close()
      store.close()
      lock.release()
    })())

  if (opts.installSignalHandlers) {
    const onSignal = () => {
      void close().then(() => process.exit(0))
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }

  const { launch } = app.ctx
  // A browser on this computer opens a wildcard bind at the loopback address.
  const wildcard = config.host === '0.0.0.0' || config.host === '::'
  const linkBase = wildcard ? `http://127.0.0.1:${port}${config.basePath}` : url
  const launchUrl = launch ? (ttlMs = LAUNCH_TTL_START_MS) => `${linkBase}launch/${launch.mint(ttlMs)}` : null
  return {
    app,
    url,
    setupToken,
    setupTokenFile,
    warnings,
    launchUrl,
    restartRequested,
    requestRestart,
    close,
  }
}
