import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  AuditRepo,
  ConfigError,
  ConnectionRepo,
  KEY_FILE,
  PasskeyRepo,
  RecoveryCodeRepo,
  SessionRepo,
  UserRepo,
  acquireInstanceLock,
  appKey,
  auditChainKey,
  assertKeyMayBeCreated,
  createSecretBox,
  finishPendingRotation,
  loadOrCreateKey,
  openStore,
  runningInstance,
  setAsideEmpty,
  sweepPartials,
  verifyKeyCheck,
  type Config,
  type InstanceLock,
  type SecretBox,
  type Store,
} from '@mongo-manager/server'
import type { Io } from './io'

export interface Data {
  store: Store
  box: SecretBox
  users: UserRepo
  sessions: SessionRepo
  passkeys: PasskeyRepo
  recoveryCodes: RecoveryCodeRepo
  audit: AuditRepo
  connections: ConnectionRepo
  close(): void
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Access to the data directory for an admin command, never at odds with the key:
 * - nothing else runs: the command holds the instance lock itself, so it can finish an interrupted
 *   rotation safely and no server or rotation can start underneath it;
 * - a server runs: no rotation can run (it needs the lock), so the command uses the server's key
 *   and leaves any pending rotation to the server;
 * - a key rotation (or another admin command) runs: refused.
 */
function lockFor(dataDir: string): InstanceLock | null {
  try {
    return acquireInstanceLock(dataDir, 'admin command')
  } catch (e) {
    const holder = runningInstance(dataDir)
    if (holder && holder.what === 'server' && alive(holder.pid)) return null
    if (holder && holder.what === 'key rotation') {
      throw new ConfigError(
        'A key rotation is in progress on this data directory; try again when it has finished.',
      )
    }
    throw e
  }
}

/**
 * The data directory as the server sees it (pending rotation, key check). Commands that only read
 * or change existing data refuse a directory that does not exist, so a mistyped --data-dir cannot
 * silently create an empty one; commands that add data (`create`) say they are creating it.
 */
export async function openData(config: Config, opts: { create?: boolean; io?: Io } = {}): Promise<Data> {
  const dir = config.dataDir
  if (!existsSync(dir)) {
    if (!opts.create)
      throw new ConfigError(`Data directory ${dir} does not exist (check --data-dir or MM_DATA_DIR)`)
    opts.io?.stderr.write(`Creating a new data directory: ${dir}\n`)
  }
  const lock = lockFor(dir)
  let store: Store | undefined
  try {
    store = await openStore(dir)
    if (lock) {
      // As a starting server does (fourth review of the CI fix 2026-10-20, minor 2): an empty key an
      // earlier start left is as none, and what such a start left beside a key goes.
      setAsideEmpty(join(dir, KEY_FILE))
      sweepPartials(dir)
      finishPendingRotation(dir, store.db)
      assertKeyMayBeCreated(store.db, dir, config.secretKey)
    }
    // Beside a running or starting server it holds no lock, and so never makes a key (minor 1).
    const box = createSecretBox(
      loadOrCreateKey({
        dataDir: dir,
        ...(config.secretKey ? { envKey: config.secretKey } : {}),
        ...(lock ? {} : { create: false }),
      }),
    )
    verifyKeyCheck(store.db, box, dir)
    const now = Date.now
    const opened = store
    return {
      store: opened,
      box,
      users: new UserRepo(opened.db, now),
      sessions: new SessionRepo(opened.db, now),
      passkeys: new PasskeyRepo(opened.db, now),
      recoveryCodes: new RecoveryCodeRepo(opened.db, now, appKey(opened.db, box, 'recovery-codes')),
      audit: (() => {
        const { key, keyCreated } = auditChainKey(opened.db, box)
        return new AuditRepo(opened.db, now, key, { keyCreated })
      })(),
      connections: new ConnectionRepo(opened.db, box, now),
      close: () => {
        opened.close()
        lock?.release()
      },
    }
  } catch (e) {
    store?.close()
    lock?.release()
    throw e
  }
}
