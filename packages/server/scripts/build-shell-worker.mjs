// Phase 3a-1 spec §3.1: bundle the shell worker into dist/shell-worker.cjs.
// - It regenerates the contextless-eval stub and substitutes it for mongosh's, so the bundle has no
//   host `eval` (spec §3.2).
// - Optional native add-ons the driver loads inside try/catch become stubs that report themselves
//   missing, exactly as the CLI bundle does; the worker cannot load addons anyway.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..')
const req = createRequire(join(pkg, 'package.json'))
const { rolldown } = await import(pathToFileURL(req.resolve('rolldown')).href)

// 1. Regenerate the contextless-eval stub (fails if a mongosh upgrade changed it).
execFileSync(process.execPath, [join(here, 'gen-contextless-eval.mjs')], { stdio: 'inherit' })
const generatedStub = join(pkg, 'src', 'shell', 'worker', 'contextless-eval.generated.cjs')
const shellReq = createRequire(req.resolve('@mongosh/browser-runtime-core'))
const contextlessEvalPath = shellReq.resolve('@mongosh/shell-evaluator/lib/contextless-eval.js')

// 2. Optional add-ons the mongosh driver loads with try/catch — bundled as self-reporting stubs.
const NATIVE = /\.node$|^cpu-features$/
// Only add-ons the driver loads inside try/catch. Modules read eagerly at import
// (@mongodb-js/oidc-plugin, system-ca, os-dns-native, the cert helpers) are bundled instead, so the
// worker loads; they do no I/O unless a TLS/OIDC path runs, which never happens (the proxy does TLS).
const OPTIONAL = new Set([
  'kerberos',
  'snappy',
  '@mongodb-js/zstd',
  'mongodb-client-encryption',
  '@aws-sdk/credential-providers',
  'gcp-metadata',
  'socks',
  'aws4',
  '@napi-rs/snappy-wasm',
])
const missingSource = (name) =>
  [
    `const e = new Error('Optional module not bundled in the shell worker: ' + ${JSON.stringify(name)})`,
    "e.code = 'MODULE_NOT_FOUND'",
    'module.exports = new Proxy({}, {',
    "  has: (_, key) => key === 'kModuleError',",
    "  get: (_, key) => { if (key === 'kModuleError') return e; if (key === '__esModule' || typeof key === 'symbol') return undefined; throw e },",
    '})',
    'throw e',
  ].join('\n')

const norm = (id) => id.split('\\').join('/')

const plugin = {
  name: 'mongo-manager:shell-worker',
  resolveId(id) {
    if (NATIVE.test(id) || OPTIONAL.has(id)) return `\0missing:${id}`
    return null
  },
  load(id) {
    if (id.startsWith('\0missing:')) return missingSource(id.slice('\0missing:'.length))
    // Replace mongosh's host eval with the pre-compiled stub.
    if (norm(id) === norm(contextlessEvalPath)) return readFileSync(generatedStub, 'utf8')
    return null
  },
}

mkdirSync(join(pkg, 'dist'), { recursive: true })
const bundle = await rolldown({
  input: join(pkg, 'src', 'shell', 'worker', 'entry.ts'),
  platform: 'node',
  logLevel: 'warn',
  plugins: [plugin],
})
// Written beside it, then renamed into place: a server running from source (or a test run) that
// starts a worker meanwhile loads the old bundle or the new one, never half of one (review
// 2026-10-17, minor 6: every server test run now builds it).
const target = join(pkg, 'dist', 'shell-worker.cjs')
// On Windows a virus scanner or the indexer may hold a file just written for a moment: the rename
// is tried again, briefly, before the build fails (second review 2026-10-17, minor 5).
async function renameIntoPlace(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (e) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}
const partial = `${target}.${process.pid}.partial`
let output
try {
  // Security review 2026-10-20 (critical): like the CLI bundle, it loads no package from a
  // node_modules above it, even outside its sandbox.
  const { ownModulesGuard } = await import(
    pathToFileURL(join(pkg, '..', '..', 'scripts', 'own-modules.mjs')).href
  )
  ;({ output } = await bundle.write({
    file: partial,
    format: 'cjs',
    codeSplitting: false,
    minify: true,
    banner: ownModulesGuard(),
  }))
  await renameIntoPlace(partial, target)
} finally {
  rmSync(partial, { force: true })
}
await bundle.close()
// The packages the worker is made of, for the release's notices (review 2026-10-13).
const { packagesOf } = await import(pathToFileURL(join(pkg, '..', '..', 'scripts', 'third-party.mjs')).href)
writeFileSync(
  join(pkg, 'dist', 'shell-worker.third-party.json'),
  JSON.stringify(packagesOf(output.flatMap((o) => (o.type === 'chunk' ? o.moduleIds : [])))),
)
console.log('built packages/server/dist/shell-worker.cjs')
