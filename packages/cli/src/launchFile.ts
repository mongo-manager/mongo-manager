import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'mongo-manager-launch-'
/** Longer than any link lives. */
const KEEP_MS = 2 * 3600_000

/** Files of earlier runs that ended before removing theirs (`open` exits as the browser opens). */
function sweepOld(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(PREFIX)) continue
      const dir = join(tmpdir(), name)
      const stat = lstatSync(dir)
      if (stat.isDirectory() && Date.now() - stat.mtimeMs > KEEP_MS)
        rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // Tidying is a convenience.
  }
}

/**
 * Review of the audit fixes (important 2, minor 6): a launch link never goes on a command line (a
 * browser's, an opener's — other accounts read those) nor into a log (a service's, pm2's, nohup's,
 * docker's). It goes into a file only this account can read, which redirects the browser to it: in
 * a directory of its own under this account's temporary folder (0700; the profile's private ACL on
 * Windows), the file 0600. It is removed once its link has expired, or when Mongo Manager stops.
 */
export function writeLaunchFile(link: string, ttlMs: number): { path: string; remove(): void } {
  sweepOld()
  const dir = mkdtempSync(join(tmpdir(), PREFIX))
  const path = join(dir, 'open-mongo-manager.html')
  const href = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  writeFileSync(
    path,
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
      `<meta http-equiv="refresh" content="0;url=${href}"><title>Mongo Manager</title></head>` +
      `<body><p><a href="${href}">Open Mongo Manager</a></p></body></html>\n`,
    { mode: 0o600, flag: 'wx' },
  )
  const remove = () => rmSync(dir, { recursive: true, force: true })
  setTimeout(remove, ttlMs).unref()
  return { path, remove }
}
