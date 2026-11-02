import type { Router } from 'vue-router'

/**
 * Where a 401 leaves the page (review of the launch fix, minor 1). A session that ended: the guard
 * runs again on this address, which sends it to sign-in with the way back (`next`). A page nobody
 * was signed in on (sign-in, set-up, local mode's gate saying a link was used) stays as it is:
 * pushing it to sign-in lost why it was shown.
 *
 * `wasIn`: whether the session was signed in before the 401 (read before it is cleared).
 */
export async function afterUnauthenticated(router: Router, wasIn: boolean): Promise<void> {
  if (!wasIn) return
  // force: the same address again still runs the guard (it would be a duplicate otherwise).
  await router.replace({ path: router.currentRoute.value.fullPath, force: true })
}

/**
 * Panel access (2026-10-30): where a refused address leaves the page. Review (I1): only a page that
 * was ready moves to the "not allowed" screen — the guard's own read of the session was refused too,
 * and moving again from there asked again and again, until the rate limit answered.
 *
 * `wasReady`: whether the session was read before the refusal (read before it is cleared).
 */
export async function afterIpNotAllowed(router: Router, wasReady: boolean): Promise<void> {
  if (!wasReady || router.currentRoute.value.name === 'unavailable') return
  await router.replace({ name: 'unavailable' })
}
