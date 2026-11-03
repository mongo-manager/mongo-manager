import type { ChildProcess } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  DB_FILE_NAME,
  pruneVersions,
  readUpdateState,
  writeLastUpdate,
  writeUpdateState,
} from '@mongo-manager/shared/updates'

/**
 * A new version's first start (updater, 2026-11-03): it has the health window to say it is ready.
 * Ready → it is the version from now on; stopped or silent → the database copy taken before the
 * switch is put back and the previous version runs again. User data is never rolled back later.
 * Release rule: only the database is put back, so a version must not change other data-folder state
 * before it says it is ready.
 */
export type FirstStart = 'ready' | 'exited' | 'timeout'
export type FailureCode = 'exited' | 'timeout' | 'files'

/** However often a slow first start says it is alive, it is given up after this. */
export const FIRST_START_CAP_MS = 15 * 60_000

/**
 * Watches a child for its ready message; a silent one is ended when the window closes. Final review
 * (minor): each "alive" (a migration on a large database takes time) opens the window again, up to
 * FIRST_START_CAP_MS in all.
 */
export function watchFirstStart(
  child: ChildProcess,
  ms: number,
  onReady: () => void,
  capMs = FIRST_START_CAP_MS,
): () => FirstStart {
  let result: FirstStart = 'exited'
  const startedAt = Date.now()
  const expire = () => {
    result = 'timeout'
    child.kill('SIGKILL')
  }
  let timer = setTimeout(expire, ms)
  child.on('message', (m: unknown) => {
    const word = (m as { mm?: unknown } | null)?.mm
    if (result !== 'exited') return
    if (word === 'alive') {
      clearTimeout(timer)
      timer = setTimeout(expire, Math.max(0, Math.min(ms, startedAt + capMs - Date.now())))
    } else if (word === 'ready') {
      result = 'ready'
      clearTimeout(timer)
      onReady()
    }
  })
  child.once('exit', () => clearTimeout(timer))
  return () => result
}

/** The copy in place of the database, its journal files removed first (a journal left would be applied to it). */
export function restoreDbCopy(dataDir: string, copy: string): boolean {
  const from = join(dataDir, copy)
  if (!existsSync(from)) return false
  const db = join(dataDir, DB_FILE_NAME)
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${db}${suffix}`, { force: true })
  renameSync(from, db)
  return true
}

/** The version said it is ready: it is the settled one. An error here never ends a working server. */
export function settle(
  appDir: string,
  dataDir: string,
  version: string,
  now: number,
  log: (m: string) => void,
): void {
  try {
    const s = readUpdateState(appDir)
    if (s.pending?.version !== version) return
    writeUpdateState(appDir, { ...s, settled: version, pending: null })
    rmSync(join(dataDir, s.pending.dbCopy), { force: true })
    writeLastUpdate(appDir, { version, outcome: 'updated', at: now })
    pruneVersions(appDir, [version, ...(s.pending.from ? [s.pending.from] : [])])
  } catch (e) {
    log(
      `Mongo Manager ${version} runs, but its update could not be recorded in full: ${(e as Error).message}`,
    )
  }
}

/**
 * The version being installed is given up: marked failed, so it never runs again unless installed
 * again. `restore` puts the database copy back (it ran); otherwise the copy is only removed. An error
 * is said, never thrown: the previous version must still start.
 */
export function giveUp(
  appDir: string,
  dataDir: string,
  reason: string,
  code: FailureCode,
  now: number,
  restore: boolean,
  log: (m: string) => void,
): void {
  const s = readUpdateState(appDir)
  if (!s.pending) return
  const { version, dbCopy } = s.pending
  try {
    if (restore) {
      if (!restoreDbCopy(dataDir, dbCopy))
        log(
          `The database copy ${join(dataDir, dbCopy)} is missing: the database stays as ${version} left it.`,
        )
    } else rmSync(join(dataDir, dbCopy), { force: true })
  } catch (e) {
    log(
      `The database copy ${join(dataDir, dbCopy)} could not be put back (${(e as Error).message}): put it in ` +
        `place of ${DB_FILE_NAME} by hand while Mongo Manager is stopped.`,
    )
  }
  try {
    const failed = [...s.failed.filter((v) => v !== version), version].slice(-100)
    writeUpdateState(appDir, { ...s, pending: null, failed })
    writeLastUpdate(appDir, { version, outcome: 'rolled_back', code, reason: reason.slice(0, 500), at: now })
  } catch (e) {
    log(`The update's failure could not be recorded: ${(e as Error).message}`)
  }
  log(
    `Mongo Manager: update to ${version} failed at first start: ${reason}. The previous version runs again.`,
  )
}

/** Final review (I6): a version that had run well was refused at a start; the About page says so. */
export function noteRefused(
  appDir: string,
  version: string,
  reason: string,
  now: number,
  log: (m: string) => void,
): void {
  try {
    writeLastUpdate(appDir, {
      version,
      outcome: 'refused',
      code: 'files',
      reason: reason.slice(0, 500),
      at: now,
    })
  } catch (e) {
    log(`The refusal could not be recorded: ${(e as Error).message}`)
  }
}
