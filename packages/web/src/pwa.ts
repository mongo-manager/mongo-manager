/**
 * Registers the service worker that makes Mongo Manager installable as an app (PWA; user decision
 * 2026-09-27: no desktop wrapper). Its scope is the server's base path; only production builds
 * register it, and a refusal (private window, blocked) never affects the app.
 */
export async function registerServiceWorker(
  nav: Navigator,
  baseURI: string,
  production: boolean,
): Promise<void> {
  if (!production || !('serviceWorker' in nav)) return
  const base = new URL('./', baseURI)
  try {
    await nav.serviceWorker.register(new URL('sw.js', base).href, { type: 'module', scope: base.pathname })
  } catch {
    // Not installable here; everything else works the same.
  }
}
