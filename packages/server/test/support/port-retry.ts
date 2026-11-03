import { LAUNCH_MS, SLOW_STARTS } from './slowness'

/** How many times a test MongoDB server is started before its failure stands. */
export const PORT_ATTEMPTS = 3

/**
 * Whether a server did not start in its time, or a set chose no primary in its: mongodb-memory-server
 * says so in these words (review of the Windows hardening, M5).
 */
export const slowStart = (e: unknown): boolean =>
  /Instance failed to start within \d+ms/i.test(textOf(e)) || noPrimary(e)

/** Whether a set's members started but chose no primary in the library's time (PRIMARY_MS). */
const noPrimary = (e: unknown): boolean =>
  /Timed out after \d+ms while waiting for a Primary/i.test(textOf(e))

const textOf = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''))

/**
 * Whether a server failed to start because another process held its port: mongodb-memory-server
 * says so where mongod says it in English ("address already in use"); on Windows mongod says it in
 * the system's own words, and only its exit code tells, 48, its network error: any network error
 * (a port Windows reserves, an address it cannot bind) is then tried again too, which is harmless
 * (review of the port retry, minor 4; nit 8; second review, nit 5).
 */
export const portTaken = (e: unknown): boolean =>
  /Port "\d+" already in use|closed unexpectedly with code "48"/i.test(
    e instanceof Error ? e.message : String(e ?? ''),
  )

interface Member {
  readonly state: string
  once(event: 'stateChange', listener: (state: string) => void): unknown
  /** The member's own options: its time to start. */
  readonly opts?: { instance?: { launchTimeout?: number } }
}

interface Startable {
  start(): Promise<void>
  stop(opts?: { doCleanup?: boolean }): Promise<unknown>
  /** A replica set's members. */
  readonly servers?: Member[]
}

/**
 * How long a member is waited for before the set is stopped: past its own time to start, so none is
 * left running (review of the Windows hardening, I1; second round, nit 4: a member's own time).
 */
export const settleMs = (m: Pick<Member, 'opts'>): number =>
  (m.opts?.instance?.launchTimeout ?? LAUNCH_MS) + 15_000

/**
 * How long the library's own cleanup of a member is waited for (its folders removed), on each
 * attempt that chose no primary: within a set's budget still (review of the Windows hardening,
 * third round, nit 5; fourth, Minor 4). One that fails (a folder Windows still holds) leaves the
 * member stopped, and the retry goes on after this; the library does not wait for that cleanup
 * either, so its failure is an unhandled rejection, which fails the run as well.
 */
export const CLEANUP_MS = 10_000

/** Waits, at most `ms`, until `m` is no longer in `state`; nothing of it keeps the process up. */
const leaves = (m: Member, state: string, ms: number) =>
  m.state !== state
    ? Promise.resolve()
    : new Promise<void>((done) => {
        const timer = setTimeout(done, ms)
        timer.unref()
        const left = (now: string) => {
          if (now !== state) {
            clearTimeout(timer)
            done()
          } else m.once('stateChange', left)
        }
        m.once('stateChange', left)
      })

/**
 * Waits until no member of a replica set is still starting, when one failed: the set stops only
 * members that are not (review of the port retry, important 1; second review, nit 2). After no
 * primary was chosen, the library stops and cleans every member itself, not waited for: it is let
 * finish (members back to "new"), so the two never remove the same folders at once (review of the
 * Windows hardening, second round, Minor 3). The retry's own cleanup then finds nothing to do (its
 * refusal, a member already "new", is let go); a set with auth would leave its keyfile's folder.
 */
async function settled(members: Member[], e: unknown): Promise<void> {
  await Promise.all(members.map((m) => leaves(m, 'starting', settleMs(m))))
  if (noPrimary(e)) await Promise.all(members.map((m) => leaves(m, 'stopped', CLEANUP_MS)))
}

/**
 * Starts the server `make` gives. CI 2026-10-21: mongodb-memory-server picks a free port and lets it
 * go, and mongod opens it a moment later; another test file's server took it in between, and the
 * file failed before its first test. A server whose port was taken is stopped (a replica set once
 * its other members are done starting, so none is left running), and a new one started on another
 * port, up to `attempts` times; one that did not start in its time, or a set that chose no primary
 * (CI 2026-10-22, Windows), SLOW_STARTS starts at most — never where `attempts` is 1, a server held to
 * its port, which the one being killed may still hold. Any other failure stands at once. A server
 * that did not start in its time is killed by the library itself, not waited for here: the next one
 * has a port and a folder of its own. The folder a failed start made, a lone server's or a set
 * member's, stays with what mongod wrote of it (the library keeps no record of it).
 */
export async function startRetrying<T extends Startable>(
  make: () => T,
  attempts = PORT_ATTEMPTS,
): Promise<T> {
  let slowTries = 0
  for (let attempt = 1; ; attempt++) {
    const server = make()
    try {
      await server.start()
      return server
    } catch (e) {
      await settled(server.servers ?? [], e)
      // Its own folders only, never a dbPath a test named (review of the port retry, minor 3).
      await server.stop({ doCleanup: true }).catch(() => undefined)
      // CI 2026-10-22 (Windows): one that did not start in its time, on a busy runner, too, SLOW_STARTS
      // starts at most.
      const slow = slowStart(e)
      if (slow) slowTries++
      const why = portTaken(e)
        ? 'its port was taken'
        : noPrimary(e)
          ? 'it chose no primary in time'
          : slow
            ? 'it did not start in time'
            : null
      if (why === null || attempt >= attempts || slowTries >= SLOW_STARTS) throw e
      // Counted as its own kind is (second round, nit 2).
      const count = slow ? `${slowTries + 1}/${SLOW_STARTS}` : `${attempt + 1}/${attempts}`
      console.warn(`test MongoDB server: ${why}; starting again (${count})`)
    }
  }
}
