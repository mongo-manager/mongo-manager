import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp, type AppDeps } from '../src/http/app'
import { resolveConfig, type PartialConfig } from '../src/config'
import { openStore } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'
import { hashPassword } from '../src/auth/passwords'
import { localCookieName } from '../src/auth/launch'
import type { ServerContext } from '../src/http/context'
import { EgressError, type Egress } from '../src/net/egress'

/** Security audit 2026-10-16: the password test accounts confirm account changes with. */
export const ADMIN_PASSWORD = 'yonetici-parolasi-2026-test'

/** Gives an account made with a placeholder hash a real password (ADMIN_PASSWORD). */
export async function givePassword(ctx: ServerContext, userId: string): Promise<void> {
  ctx.users.setPassword(userId, await hashPassword(ADMIN_PASSWORD))
}

export interface TestApp {
  app: FastifyInstance
  dir: string
  clock: { now: number }
  close(): Promise<void>
}

/**
 * Security audit 2026-10-16 and its review: test apps share one launch secret, and each has one
 * test browser in its store, so the default headers carry what a launch link and its page's claim
 * would have given a browser: its cookie and its page key (local-launch.test.ts covers how).
 */
export const TEST_LAUNCH_SECRET = Buffer.alloc(32, 7)
export const LOCAL_COOKIE_NAME = localCookieName(TEST_LAUNCH_SECRET)
export const LOCAL_COOKIE_VALUE = 'test-browser-cookie-0000000000000000000000'
export const LOCAL_KEY = 'test-browser-page-key-00000000000000000000'
const sha = (text: string) => createHash('sha256').update(text).digest('base64url')

/** Same-origin browser headers for requests to the default test host (local mode's cookie and key). */
export const H = {
  host: 'localhost:4321',
  origin: 'http://localhost:4321',
  cookie: `${LOCAL_COOKIE_NAME}=${LOCAL_COOKIE_VALUE}`,
  'x-mm-local': LOCAL_KEY,
} as const

/** An egress that reaches nothing: the updater of a test app never reaches GitHub (2026-11-03). */
export const offlineEgress: Egress = {
  buffer: () => Promise.reject(new EgressError('connect', 'Tests reach no network')),
  request: () => Promise.reject(new EgressError('connect', 'Tests reach no network')),
  probe: () => Promise.reject(new EgressError('connect', 'Tests reach no network')),
  listed: () => false,
}

export async function makeApp(
  overrides: PartialConfig = {},
  extra: Pick<
    AppDeps,
    | 'realtime'
    | 'jobs'
    | 'monitor'
    | 'logger'
    | 'aggregation'
    | 'documents'
    | 'scheduler'
    | 'watch'
    | 'liveSync'
    | 'http'
    | 'optionalModules'
    | 'encryptionTools'
  > = {},
  /** What the store holds before the app starts (a setting it reads at start). */
  seed?: (db: DatabaseSync) => void,
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-app-'))
  const config = resolveConfig({ cli: { dataDir: dir, logLevel: 'silent', ...overrides } })
  const store = await openStore(dir)
  seed?.(store.db)
  const clock = { now: Date.UTC(2026, 0, 1) }
  const app = await buildApp({
    config,
    store,
    secretBox: createSecretBox(randomBytes(32)),
    launchSecret: TEST_LAUNCH_SECRET,
    now: () => clock.now,
    scheduler: { autoStart: false },
    reports: { autoStart: false },
    ...extra,
  })
  app.ctx.updates.deps.egress = offlineEgress
  // The test browser of H: claimed, and never idle long enough to be forgotten whatever the clock.
  store.db
    .prepare('INSERT INTO local_browsers (id_hash, key_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(sha(LOCAL_COOKIE_VALUE), sha(LOCAL_KEY), clock.now, Number.MAX_SAFE_INTEGER)
  return {
    app,
    dir,
    clock,
    close: async () => {
      await app.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
