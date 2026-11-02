import { runShellWorkerFromAsset } from './shellWorkerSea'

// Phase 3a-1: in a SEA, the binary re-runs itself as the shell worker (see spawnWorker). Handle
// that before anything else so it never touches the normal CLI startup.
if (process.argv[2] === '__mm-shell-worker') {
  runShellWorkerFromAsset()
} else {
  // Node flags a few Web Crypto features used by the passkey library as experimental; that
  // warning is noise for users. Node's own printer writes every other one, as its flags say
  // (--no-warnings, --redirect-warnings; reviews of the SEA fix 2026-10-20: ours dropped a
  // warning's code and detail, and threw on an odd one). Only that printer is wrapped, any other
  // listener staying as it was added (fifth review, minor 1).
  const node = process.rawListeners('warning').find((l) => l.name === 'onWarning')
  if (node) {
    process.removeListener('warning', node)
    // In its place, first, as Node added it.
    process.prependListener('warning', (warning) => {
      const experimental = warning instanceof Error && warning.name === 'ExperimentalWarning'
      if (experimental && /Web Crypto/i.test(warning.message)) return
      node.call(process, warning)
    })
  }

  // Loaded only here: the shell worker runs nothing of the CLI (review of the CI fix 2026-10-20:
  // in its sandbox the CLI's modules wrote warnings and took a third more memory).
  Promise.all([import('./main'), import('./io')]).then(
    ([{ main }, { processIo }]) =>
      main(process.argv.slice(2), processIo()).then(
        (code) => {
          process.exitCode = code
          // Do not hang on a stray handle after the server has closed.
          setTimeout(() => process.exit(code), 5_000).unref()
        },
        (e: unknown) => {
          process.stderr.write(`Error: ${(e as Error).message}\n`)
          process.exitCode = 1
        },
      ),
    // A module that fails as it loads ends the process as it did when loaded before this ran: an
    // uncaught error, its stack printed (reviews of the SEA fix 2026-10-20, minor 4 and 3).
    (e: unknown) =>
      queueMicrotask(() => {
        throw e
      }),
  )
}
