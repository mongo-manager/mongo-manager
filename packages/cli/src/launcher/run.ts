// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { spawn as nodeSpawn } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import {
  HEALTH_WINDOW_MS,
  RELEASE_IMAGE,
  RELEASE_NPM_PACKAGE,
  RELEASE_PUBLIC_KEYS,
  RESTART_EXIT_CODE,
  cleanIncoming,
  compareReleaseVersions,
  listVersions,
  originEnv,
  pruneVersions,
  readUpdateState,
  readUpdateStateChecked,
  verifyVersionDir,
  writeUpdateState,
  type UpdaterOrigin,
  type VerifiedVersion,
  type VerifyFailure,
} from '@mongo-manager/shared/updates'
import { giveUp, noteRefused, settle, watchFirstStart, type FirstStart } from './health'
import { acquireLauncherLock, type LauncherLock } from './lock'
import { repairVersion } from './repair'

/**
 * The updater's launcher (2026-11-03): the installed program starts the newest version it may run
 * — the bundled one, or one downloaded into `<data>/app` whose every file matches its signed
 * release — as a child, and starts it again when it exits with 75.
 */
export interface LaunchDeps {
  command: string
  env: NodeJS.ProcessEnv
  dataDir: string
  origin: UpdaterOrigin
  /** The release keys (tests give their own). */
  keys?: readonly string[]
  /** Updates turned on by the configuration (MM_UPDATES and the config file's updates.enabled). */
  updatesEnabled?: boolean
  spawn?: typeof nodeSpawn
  execPath?: string
  execArgv?: string[]
  now?: () => number
  log?: (message: string) => void
  /** Where stop signals arrive (the process). */
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>
  platform?: NodeJS.Platform
  /** The first-start window (tests shorten it). */
  healthMs?: number
  /**
   * Downloads a version again into `<data>/app` (a settled version that no longer verifies): true
   * when it is back.
   */
  download?: (version: string) => Promise<boolean>
  /**
   * Ends the account's other processes before a downloaded version is checked and runs, when the
   * origin asks it (design §7b-1): the previous program, on a restart.
   */
  isolate?: (previous?: PreviousChild) => Promise<IsolateResult>
  /** The start launcher's lock (tests give their own). */
  lock?: (appDir: string) => LauncherLock | null
}

export interface PreviousChild {
  pid: number
  startedAt: number
}
export interface IsolateResult {
  ended: number
  /** Processes the rule named that would not end. */
  survivors: number[]
}

/** At most this many restarts within the window, then the launcher stops. */
const RESTARTS = 3
const RESTART_WINDOW_MS = 10 * 60_000
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const DB_COPY = /^mongo-manager\.db\.before-\d{1,9}\.\d{1,9}\.\d{1,9}$/

export const appDirOf = (dataDir: string) => join(dataDir, 'app')
const logOf = (deps: LaunchDeps) => deps.log ?? ((m: string) => void process.stderr.write(`${m}\n`))

type Refusal = VerifyFailure | 'launcher'
const FAILURES: Record<Refusal, string> = {
  signature: 'its signature does not match a release key',
  sums: 'its list of checksums cannot be read',
  info: 'its release.json does not match',
  digest: 'its download does not match its checksum',
  files: 'its files do not match the release (changed, added or missing)',
  missing: 'files are missing',
  launcher: 'it needs a newer installed program (install Mongo Manager again to run it)',
}

interface Choice {
  /** null: the bundled program. */
  version: string | null
  /** The version being installed: it has the health window to say it is ready. */
  firstStart: boolean
  command: string
  args: string[]
}

function program(
  entry: string | null,
  argv: string[],
  deps: LaunchDeps,
): { command: string; args: string[] } {
  const execPath = deps.execPath ?? process.execPath
  const execArgv = deps.execArgv ?? process.execArgv
  if (deps.origin.distribution === 'standalone')
    return { command: entry ?? deps.origin.installDir, args: argv }
  return { command: execPath, args: [...execArgv, entry ?? join(deps.origin.installDir, 'cli.cjs'), ...argv] }
}

const newer = (v: string, than: string) => compareReleaseVersions(v, than) > 0

/**
 * Final review (minor): what a start leaves tidy, holding the launcher lock — downloads that never
 * finished, a pending version the installed program has caught up with, database copies no install
 * waits for (each a whole copy of the data), and versions no newer than the installed program.
 */
function tidy(deps: LaunchDeps): void {
  const log = logOf(deps)
  const appDir = appDirOf(deps.dataDir)
  const bundled = deps.origin.bundledVersion
  try {
    cleanIncoming(appDir)
    let state = readUpdateState(appDir)
    if (state.pending && !newer(state.pending.version, bundled)) {
      rmSync(join(deps.dataDir, state.pending.dbCopy), { force: true })
      state = { ...state, pending: null }
      writeUpdateState(appDir, state)
    }
    let names: string[] = []
    try {
      names = readdirSync(deps.dataDir)
    } catch {
      names = []
    }
    for (const name of names)
      if (DB_COPY.test(name) && name !== state.pending?.dbCopy)
        rmSync(join(deps.dataDir, name), { force: true })
    pruneVersions(
      appDir,
      listVersions(appDir).filter((v) => newer(v, bundled)),
    )
  } catch (e) {
    log(`Mongo Manager could not tidy ${appDir}: ${(e as Error).message}`)
  }
}

/**
 * Which program runs. A start runs the version being installed (pending) or the one that started
 * well (settled); another command (doctor, user …) only the settled one, and changes nothing in
 * `<data>/app`. A settled version that no longer verifies is never replaced by the older bundled
 * program (the database may be past it): it is downloaded again (a start, updates on), or the
 * previous version kept beside it runs, or nothing runs. A number is the exit code: nothing may run.
 */
async function choose(argv: string[], deps: LaunchDeps): Promise<Choice | number> {
  const log = logOf(deps)
  const now = deps.now ?? Date.now
  const appDir = appDirOf(deps.dataDir)
  const start = deps.command === 'start'
  const bundled = deps.origin.bundledVersion
  const kind = deps.origin.distribution === 'standalone' ? 'standalone' : 'package'
  const checked = readUpdateStateChecked(appDir)
  let state = checked.state
  const verify = (v: string): VerifiedVersion | { ok: false; reason: Refusal } => {
    const r = verifyVersionDir(join(appDir, v), { kind, target: deps.origin.target, keys: deps.keys })
    if (r.ok && r.info.minLauncher && newer(r.info.minLauncher, bundled))
      return { ok: false, reason: 'launcher' }
    return r
  }
  const run = (v: string | null, entry: string | null, firstStart = false): Choice => ({
    version: v,
    firstStart,
    ...program(entry, argv, deps),
  })
  const notRun = (v: string, reason: Refusal) =>
    log(`Mongo Manager ${v} in ${join(appDir, v)} was not run: ${FAILURES[reason]}.`)

  if (checked.damaged) {
    // Which version last ran is not known: the newest that verifies, never the older bundled one.
    log(`${join(appDir, 'state.json')} cannot be read: the newest verified version runs.`)
    for (const v of listVersions(appDir)) {
      if (!newer(v, bundled)) continue
      const r = verify(v)
      if (r.ok) return run(v, r.entry)
    }
    return run(null, null)
  }

  const usable = (v: string | null | undefined): v is string =>
    !!v && newer(v, bundled) && !state.failed.includes(v)
  const pending = state.pending?.version
  if (start && usable(pending)) {
    const r = verify(pending)
    if (r.ok) return run(pending, r.entry, true)
    notRun(pending, r.reason)
    // It never ran: the database is as the previous version left it.
    giveUp(appDir, deps.dataDir, `it was not run: ${FAILURES[r.reason]}`, 'files', now(), false, log)
    state = readUpdateState(appDir)
  }
  const settled = state.settled
  if (!usable(settled)) return run(null, null)
  const r = verify(settled)
  if (r.ok) return run(settled, r.entry)
  notRun(settled, r.reason)
  if (start) noteRefused(appDir, settled, FAILURES[r.reason], now(), log)
  // Downloaded again first: the version the database was last run with.
  const allowed = deps.updatesEnabled !== false && (deps.keys ?? RELEASE_PUBLIC_KEYS).length > 0
  if (start && allowed && r.reason !== 'launcher' && (await repairVersion(settled, deps))) {
    const again = verify(settled)
    if (again.ok) return run(settled, again.entry)
  }
  // Then the version it was installed from, kept beside it: older, never one waiting to be installed.
  for (const v of listVersions(appDir)) {
    if (!newer(settled, v) || v === state.pending?.version || !usable(v)) continue
    const older = verify(v)
    if (!older.ok) continue
    log(`Mongo Manager ${v}, the previous verified version, runs instead.`)
    return run(v, older.entry)
  }
  log(
    `Mongo Manager ${settled} is damaged and could not be repaired: ${FAILURES[r.reason]}. Reinstall it with ` +
      `npm i -g ${RELEASE_NPM_PACKAGE}, docker pull ${RELEASE_IMAGE} or the release file.`,
  )
  return 1
}

interface Ended {
  code: number
  /** A stop signal reached the launcher while it ran. */
  stopped: boolean
  firstStart: FirstStart | null
  previous: PreviousChild | undefined
}

function runOnce(choice: Choice, deps: LaunchDeps, relaunch: boolean): Promise<Ended> {
  const spawn = deps.spawn ?? nodeSpawn
  const signals = deps.signals ?? process
  const platform = deps.platform ?? process.platform
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(choice.command, choice.args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      // A relaunch (a restart, a rollback) opens no second browser tab.
      env: { ...deps.env, ...originEnv(deps.origin), ...(relaunch ? { MM_UPDATER_RELAUNCH: '1' } : {}) },
      windowsHide: true,
    })
    const version = choice.version
    const health =
      choice.firstStart && version
        ? watchFirstStart(child, deps.healthMs ?? HEALTH_WINDOW_MS, () =>
            settle(appDirOf(deps.dataDir), deps.dataDir, version, (deps.now ?? Date.now)(), logOf(deps)),
          )
        : null
    let stops = 0
    // A stop is handed on (Windows has no signals to send: the channel closing says it); a second
    // one ends the program at once, as a second Ctrl+C would.
    const onSignal = (signal: NodeJS.Signals) => {
      stops++
      if (stops > 1) child.kill('SIGKILL')
      else if (platform === 'win32') {
        if (child.connected) child.disconnect()
      } else child.kill(signal)
    }
    for (const s of STOP_SIGNALS) signals.on(s, onSignal)
    let ended = false
    const done = (code: number) => {
      if (ended) return
      ended = true
      for (const s of STOP_SIGNALS) signals.off(s, onSignal)
      resolve({
        code,
        stopped: stops > 0,
        firstStart: health ? health() : null,
        previous: child.pid ? { pid: child.pid, startedAt } : undefined,
      })
    }
    child.once('error', (e) => {
      logOf(deps)(`Mongo Manager could not start: ${e.message}`)
      done(1)
    })
    child.once('exit', (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)))
  })
}

/** Runs the chosen program until it ends; its exit code is the launcher's. */
export async function launch(argv: string[], deps: LaunchDeps): Promise<number> {
  const now = deps.now ?? Date.now
  const log = logOf(deps)
  const appDir = appDirOf(deps.dataDir)
  const start = deps.command === 'start'
  let lock: LauncherLock | null = null
  if (start) {
    lock = (deps.lock ?? acquireLauncherLock)(appDir)
    if (!lock) {
      log('Mongo Manager is already starting or running on this data directory: that launcher keeps it.')
      return 1
    }
  }
  try {
    const restarts: number[] = []
    let previous: PreviousChild | undefined
    let spawned = false
    for (;;) {
      if (start) tidy(deps)
      // Final review (C1): the account's other processes end before any downloaded version is
      // checked, so nothing is left that could change its files between the check and the start.
      const downloaded = listVersions(appDir).some((v) => newer(v, deps.origin.bundledVersion))
      if (start && downloaded && deps.origin.isolate && deps.isolate) {
        try {
          const r = await deps.isolate(previous)
          if (r.ended)
            log(`Mongo Manager ended ${r.ended} other process(es) of its account before it started.`)
          if (r.survivors.length)
            log(`Mongo Manager could not end process(es) ${r.survivors.join(', ')} of its account.`)
        } catch (e) {
          log(`Mongo Manager could not list its account's processes: ${(e as Error).message}`)
        }
      }
      const choice = await choose(argv, deps)
      if (typeof choice === 'number') return choice
      const ended = await runOnce(choice, deps, spawned)
      spawned = true
      previous = ended.previous
      if (ended.firstStart && ended.firstStart !== 'ready' && !ended.stopped) {
        const timeout = ended.firstStart === 'timeout'
        const reason = timeout
          ? `it did not say it was ready within ${Math.round((deps.healthMs ?? HEALTH_WINDOW_MS) / 1000)} seconds`
          : `it stopped with code ${ended.code}`
        giveUp(appDir, deps.dataDir, reason, timeout ? 'timeout' : 'exited', now(), true, log)
        continue
      }
      if (ended.code !== RESTART_EXIT_CODE || ended.stopped) return ended.code
      const at = now()
      restarts.push(at)
      while (restarts[0]! < at - RESTART_WINDOW_MS) restarts.shift()
      if (restarts.length > RESTARTS) {
        log('Mongo Manager is restarting too often; it stops here. Its log says why.')
        return 1
      }
    }
  } finally {
    lock?.release()
  }
}
