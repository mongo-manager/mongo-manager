// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// Builds the standalone binary dist/sea/mongo-manager[.exe] for the running platform (Node SEA):
// the bundled CLI is the main script and every file of public/ is embedded as an asset, so the
// binary needs no Node installation and writes nothing to disk to serve the web app.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { inject } from 'postject'
import { stripAuthenticode } from './pe.mjs'

const pkg = join(import.meta.dirname, '..')
const cli = join(pkg, 'dist', 'cli.cjs')
const publicDir = join(pkg, 'public')
if (!existsSync(cli) || !existsSync(join(publicDir, 'index.html'))) {
  console.error('dist/cli.cjs or public/ is missing: run "pnpm build" first')
  process.exit(1)
}

const out = join(pkg, 'dist', 'sea')
const work = join(pkg, 'dist', 'sea-work')
rmSync(out, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })

const files = readdirSync(publicDir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => relative(publicDir, join(e.parentPath, e.name)).split(sep).join('/'))
  // A build's own list of its packages is never embedded (review of the ops fixes, M2).
  .filter((f) => f !== 'third-party.json')
  .sort()
const shellWorker = join(pkg, 'dist', 'shell-worker.cjs')
const assets = { 'web/manifest.json': join(work, 'manifest.json'), 'shell-worker.cjs': shellWorker }
for (const f of files) assets[`web/${f}`] = join(publicDir, ...f.split('/'))
writeFileSync(assets['web/manifest.json'], JSON.stringify(files))

// 2026-11-01: the bundled plugins travel inside the binary too (it had none); the server writes them
// into the data directory at start. The CLI build copies them into packages/cli/plugins.
const pluginsDir = join(pkg, 'plugins')
const pluginFiles = existsSync(pluginsDir)
  ? readdirSync(pluginsDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(pluginsDir, join(e.parentPath, e.name)).split(sep).join('/'))
      .sort()
  : []
if (!pluginFiles.some((f) => f.endsWith('/mongo-manager-plugin.json')))
  throw new Error(`no bundled plugins in ${pluginsDir}: build them first (pnpm build)`)
assets['plugins/manifest.json'] = join(work, 'plugins-manifest.json')
for (const f of pluginFiles) assets[`plugins/${f}`] = join(pluginsDir, ...f.split('/'))
writeFileSync(assets['plugins/manifest.json'], JSON.stringify(pluginFiles))

const blob = join(work, 'sea.blob')
const config = join(work, 'sea-config.json')
writeFileSync(
  config,
  JSON.stringify({
    main: cli,
    output: blob,
    disableExperimentalSEAWarning: true,
    // Deterministic output; and NODE_OPTIONS cannot inject code into the binary.
    useCodeCache: false,
    useSnapshot: false,
    // Phase 3a-1: 'cli' lets the shell worker subcommand receive --node-options (the sandbox flags);
    // NODE_OPTIONS injection stays disabled.
    execArgvExtension: 'cli',
    assets,
  }),
)
const prep = spawnSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
if (prep.status !== 0) process.exit(prep.status ?? 1)

const binary = join(out, process.platform === 'win32' ? 'mongo-manager.exe' : 'mongo-manager')
copyFileSync(process.execPath, binary)
chmodSync(binary, 0o755)
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}
if (process.platform === 'darwin') run('codesign', ['--remove-signature', binary])
// Injection breaks node.exe's signature; an unsigned file is better than a corrupted signature.
if (process.platform === 'win32') writeFileSync(binary, stripAuthenticode(readFileSync(binary)))
await inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
})
if (process.platform === 'darwin') run('codesign', ['--sign', '-', binary])
rmSync(work, { recursive: true, force: true })
console.log(`built ${relative(process.cwd(), binary)} (Node ${process.version}, ${files.length} web files)`)
