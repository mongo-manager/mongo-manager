import type { InspectResponse, OpenedWith } from '@mongo-manager/shared'
import type { BackupFileRow, BackupStore } from './store'
import { KeyNeeded, MoreNeeded, PasswordNeeded, openArchive, summarize } from './pipeline'
import type { SlotKeys } from './keys/slot-keys'

/**
 * U4: what a backup holds, read from its prelude only. A growing upload answers "waiting" until
 * enough of it has arrived; an encrypted one without a password answers "password"; a backup-key
 * file none of the caller's keys opens answers "key" (phase 3d-3c).
 */
export async function inspectBackup(
  store: BackupStore,
  row: BackupFileRow,
  opts: { password?: string; keys?: SlotKeys; signal: AbortSignal; onWrongPassword?: () => void },
): Promise<InspectResponse> {
  try {
    const now = store.byId(row.id) ?? row
    let openedWith: OpenedWith | undefined
    const { container, events } = await openArchive(store, now, {
      ...opts,
      follow: now.complete ? 'complete' : 'idle',
      onOpened: (how) => (openedWith = how),
    })
    const summary = await summarize(container, events)
    return { state: 'ready', summary, ...(openedWith ? { openedWith } : {}) }
  } catch (e) {
    if (e instanceof PasswordNeeded) return { state: 'password' }
    if (e instanceof KeyNeeded) return { state: 'key', fingerprint: e.fingerprint, password: e.password }
    if (e instanceof MoreNeeded) {
      const now = store.byId(row.id) ?? row
      return { state: 'waiting', received: now.size, size: now.declaredSize ?? now.size }
    }
    throw e
  }
}
