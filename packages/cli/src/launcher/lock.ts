// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The start launcher's lock in `<data>/app`: an exclusive SQLite lock, as the server's instance lock. */
export const LAUNCHER_LOCK = 'launcher.lock'

export interface LauncherLock {
  release(): void
}

/**
 * Final review (I1, 2026-11-03): one start launcher per data folder. Only the one holding this
 * lock tidies `<data>/app`, starts a version for the first time, settles it or puts the database
 * copy back — a second `mongo-manager start` would otherwise roll the database back under a running
 * server. The operating system drops the lock when the process ends, however it ends, so a crash
 * or a reused pid never blocks a start. Null when another launcher holds it.
 */
export function acquireLauncherLock(appDir: string): LauncherLock | null {
  mkdirSync(appDir, { recursive: true, mode: 0o700 })
  const path = join(appDir, LAUNCHER_LOCK)
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA locking_mode = EXCLUSIVE')
      db.exec('BEGIN EXCLUSIVE')
      const held = db
      return {
        release: () => {
          try {
            held.close()
          } catch {
            // Closed already.
          }
        },
      }
    } catch (e) {
      db?.close()
      const message = (e as Error).message
      if (/locked|busy/i.test(message)) return null
      // Not a lock database: replaced once.
      if (attempt === 0 && /not a database|malformed/i.test(message)) {
        rmSync(path, { force: true })
        continue
      }
      throw e
    }
  }
  return null
}
