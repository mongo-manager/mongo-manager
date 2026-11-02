import { TestRunner } from 'vitest'

/**
 * CI 2026-10-21 (Windows): a test that waits up to 60 s for its job, under the 20 s test limit, ran
 * out of time at 20 s, and its own wait, which says what the job was doing, never could. A test adds
 * up the bounds of the job waits it runs, in helpers and loops too, and after it their sum with this
 * much to spare must fit in its limit (wait-limits.ts; review of the limits, important 1, 2; minor 4,
 * 5). Waits run side by side are added up all the same. It counts against the one test running, so
 * tests run at the same time (test.concurrent), or a wait a finished test left running, would be
 * counted against another; none does.
 */
export const SPARE_MS = 5_000

const waited = new WeakMap<object, number>()

/** Counts a job wait's bound against the running test. */
export function countWait(ms: number): void {
  const test = TestRunner.getCurrentTest()
  if (test) waited.set(test, (waited.get(test) ?? 0) + ms)
}

/** Starts `test`'s count again, as each try of it does. */
export function resetWaits(test: object): void {
  waited.delete(test)
}

/** The bounds of the job waits `test` ran, added up. */
export function waitsOf(test: object): number {
  return waited.get(test) ?? 0
}

/** Why waits of `waits` ms do not fit in a test limit of `limit` ms (0: none), or null where they do. */
export function overLimit(waits: number, limit: number): string | null {
  if (limit <= 0 || waits + SPARE_MS <= limit) return null
  return (
    `waits up to ${waits} ms for its jobs; with ${SPARE_MS} ms to spare that needs a limit of ` +
    `${waits + SPARE_MS} ms, and its limit is ${limit} ms`
  )
}
