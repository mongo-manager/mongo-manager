// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConfigError } from '../config'
import { ensureDataDir } from './datadir'

/** A tiny SQLite file whose exclusive lock is the instance lock. */
export const LOCK_FILE = 'server.lock'
/** Who holds the lock: informational only, the lock itself is the authority. */
export const LOCK_INFO_FILE = 'server.lock.json'

export type LockPurpose = 'server' | 'key rotation' | 'admin command'

export interface InstanceLock {
  release(): void
  /** Review of the audit fixes (minor 7): where the server listens, for `mongo-manager open`. */
  setAddress(address: InstanceAddress): void
}

export interface InstanceAddress {
  host: string
  port: number
  basePath: string
}

export interface LockHolder {
  pid: number
  what: string
  startedAt: number
  address?: InstanceAddress
}

/**
 * Takes the OS-level lock: an exclusive SQLite lock that the operating system drops when the
 * process ends, however it ends. A stale lock after a crash, or a reused PID (PID 1 in a
 * restarted container), can therefore never block a restart. Returns null when it is held.
 */
function tryLock(path: string): DatabaseSync | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA locking_mode = EXCLUSIVE')
      db.exec('BEGIN EXCLUSIVE')
      return db
    } catch (e) {
      db?.close()
      const message = (e as Error).message
      if (/locked|busy/i.test(message)) return null
      // Not a lock database (e.g. a file from an older version): replace it once.
      if (attempt === 0 && /not a database|malformed/i.test(message)) {
        rmSync(path, { force: true })
        continue
      }
      throw e
    }
  }
  return null
}

function readHolder(dataDir: string): LockHolder | null {
  try {
    const info = JSON.parse(readFileSync(join(dataDir, LOCK_INFO_FILE), 'utf8')) as Partial<LockHolder>
    const a = info.address
    const address =
      a && typeof a.host === 'string' && Number.isInteger(a.port) && typeof a.basePath === 'string'
        ? { host: a.host, port: a.port, basePath: a.basePath }
        : undefined
    return Number.isInteger(info.pid)
      ? {
          pid: info.pid as number,
          what: String(info.what ?? 'server'),
          startedAt: Number(info.startedAt) || 0,
          ...(address ? { address } : {}),
        }
      : null
  } catch {
    return null
  }
}

/** Who holds the data directory right now, or null when nobody does. */
export function runningInstance(dataDir: string): LockHolder | null {
  const path = join(dataDir, LOCK_FILE)
  if (!existsSync(path)) return null
  const db = tryLock(path)
  if (db) {
    db.close()
    return null
  }
  return readHolder(dataDir) ?? { pid: 0, what: 'unknown', startedAt: 0 }
}

/**
 * One process per data directory: a second server, a key rotation next to a running server, or an
 * admin command during a rotation would each use a different view of the store and the key.
 */
export function acquireInstanceLock(dataDir: string, what: LockPurpose = 'server'): InstanceLock {
  ensureDataDir(dataDir)
  const path = join(dataDir, LOCK_FILE)
  const db = tryLock(path)
  if (!db) {
    const holder = readHolder(dataDir)
    const who = holder ? `${holder.what}, pid ${holder.pid}` : 'another process'
    throw new ConfigError(
      `The data directory ${dataDir} is in use by Mongo Manager (${who}). Stop it first, then try again.`,
    )
  }
  const infoPath = join(dataDir, LOCK_INFO_FILE)
  const info = { pid: process.pid, what, startedAt: Date.now() }
  writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 })
  let released = false
  return {
    setAddress: (address) => {
      if (!released) writeFileSync(infoPath, JSON.stringify({ ...info, address }), { mode: 0o600 })
    },
    release: () => {
      if (released) return
      released = true
      try {
        unlinkSync(infoPath)
      } catch {
        // Already gone.
      }
      db.close()
    },
  }
}
