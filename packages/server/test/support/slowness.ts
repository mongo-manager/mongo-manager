// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** How many times longer a test and a hook are given on a slow runner. */
export const SLOW_RUNNER = 3

/**
 * How long a test MongoDB server is given to start, three times the library's 10 s. CI 2026-10-22
 * (Windows): a runner starting several at once took more than 10 s (test-servers.ts).
 */
export const LAUNCH_MS = 30_000

/** How long a replica set waits for its primary: the library's own, which no option changes. */
export const PRIMARY_MS = 30_000

/** How many times a server that did not start in its time, or a set with no primary, is started. */
export const SLOW_STARTS = 2

/**
 * The time a test or a hook that starts a server gives it (review of the Windows hardening, second
 * round, Minor 1): two slow starts with time to spare — a lone server's, and a set's with its wait
 * for a primary (start-budget.test.ts checks every test file; servers awaited one after another add
 * up). A server's driver connection that times out (server selection) is not tried again. The
 * budgets are not scaled: they are what LAUNCH_MS and PRIMARY_MS allow at most (third round, nit 9);
 * a hook names one with slow(), its slow runner's default being 360 s (fifth review, nit 5).
 */
export const SERVER_START_MS = SLOW_STARTS * LAUNCH_MS + 30_000
export const SET_START_MS = SLOW_STARTS * (LAUNCH_MS + PRIMARY_MS) + 30_000

/**
 * Whether the tests run in CI: a CI variable that says no ("false", "0") is not CI. One reading for
 * every test helper (second round, nit 7).
 */
export function isCI(env: Record<string, string | undefined> = process.env): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0'
}

/**
 * CI 2026-10-22 (Windows): the runner took 24 s and 35 s over tests that take a few seconds
 * elsewhere, and failed them on the 20 s default. On Windows in CI a test's and a hook's default
 * times are SLOW_RUNNER times as long; anywhere else, as written. A test or a hook that names a
 * time shorter than a slow runner's default names it with slow() (second round, Minor 2; fourth,
 * Minors 1, 2), or with asIs() when it is a limit of its own (start-budget.test.ts checks it).
 */
export function slowness(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): number {
  return platform === 'win32' && isCI(env) ? SLOW_RUNNER : 1
}

/** A test's or a hook's time that holds on a fast runner, longer on a slow one (slowness). */
export const slow = (ms: number): number => ms * slowness()

/** A test's or a hook's time that is a limit of its own, the same on every runner (start-budget.test.ts). */
export const asIs = (ms: number): number => ms
