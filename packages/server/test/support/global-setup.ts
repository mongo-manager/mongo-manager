import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoBinary } from 'mongodb-memory-server'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Downloads the MongoDB binary (MONGOMS_VERSION or the package default) once, before the test
 * workers start: parallel first downloads race on the binary's lock file (seen on Windows).
 *
 * Bundles the shell worker from the source under test: the shell tests run dist/shell-worker.cjs,
 * which a fresh checkout (CI) does not have, and which a working copy may hold from older source.
 */
export default async function setup(): Promise<void> {
  try {
    // Its warnings (mongosh's own eval, optional modules) are for whoever changes the bundle, not
    // for every test run: shown only when the build fails (review 2026-10-17, minor 5).
    execFileSync(process.execPath, [join(here, '..', '..', 'scripts', 'build-shell-worker.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: Buffer; stderr?: Buffer }
    throw new Error(`The shell worker did not build:\n${String(stdout ?? '')}${String(stderr ?? '')}`, {
      cause: e,
    })
  }
  await MongoBinary.getPath()
}
