import { Module } from 'node:module'
import sea from 'node:sea'

/**
 * Phase 3a-1 spec §3.1: in a single executable, the shell worker's code is an embedded asset, not a
 * file. When the binary is started as its own hidden `__mm-shell-worker` subcommand (by
 * spawnWorker), it loads that asset and runs it in this process. Compiling a module is not code
 * generation from strings, so it works under --disallow-code-generation-from-strings; the worker's
 * own sandbox self-check still refuses to run if the permission model is somehow off.
 */
export function runShellWorkerFromAsset(): void {
  // Review of the SEA fix 2026-10-20 (minor 6): elsewhere (an npm install) it has no asset.
  if (!sea.isSea()) {
    process.stderr.write('Error: __mm-shell-worker is run by the standalone binary only.\n')
    process.exitCode = 2
    return
  }
  const code = sea.getAsset('shell-worker.cjs', 'utf8')
  const module = new Module('mm-shell-worker.cjs')
  ;(module as unknown as { _compile(code: string, filename: string): void })._compile(
    code,
    'mm-shell-worker.cjs',
  )
}
