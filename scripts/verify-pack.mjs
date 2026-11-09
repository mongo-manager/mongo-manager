// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^NOTICE$/,
  /^dist\/cli\.cjs$/,
  /^dist\/shell-worker\.cjs$/,
  /^dist\/THIRD-PARTY-NOTICES\.txt$/,
  /^public\//,
  // Phase 4b §4: the plugins shipped with it, each in a folder of its own.
  /^plugins\/[a-z0-9-]+\//,
]
const INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'preprepare',
  'postprepare',
]

export function checkPackFiles(files) {
  const problems = files
    // A build's own list of its packages never ships: the notices do (review of the ops fixes, M2).
    .filter((f) => /(^|\/)third-party\.json$/.test(f) || !ALLOWED.some((r) => r.test(f)))
    .map((f) => `unexpected file in package: ${f}`)
  // User request 2026-11-03: the license and its additional terms go with every copy.
  for (const name of ['LICENSE', 'NOTICE']) if (!files.includes(name)) problems.push(`missing ${name}`)
  if (!files.includes('dist/cli.cjs')) problems.push('missing dist/cli.cjs')
  if (!files.includes('dist/shell-worker.cjs')) problems.push('missing dist/shell-worker.cjs')
  if (!files.includes('dist/THIRD-PARTY-NOTICES.txt')) problems.push('missing dist/THIRD-PARTY-NOTICES.txt')
  if (!files.includes('public/index.html')) problems.push('missing public/index.html')
  if (!files.includes('plugins/geojson-map/mongo-manager-plugin.json'))
    problems.push('missing plugins/geojson-map/mongo-manager-plugin.json')
  return problems
}

export function checkManifest(pkg) {
  const problems = []
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    if (pkg[field] && Object.keys(pkg[field]).length > 0) problems.push(`${field} must be empty`)
  }
  for (const name of INSTALL_SCRIPTS)
    if (pkg.scripts?.[name]) problems.push(`install script not allowed: ${name}`)
  return problems
}

const npm = (args, opts = {}) => {
  // npm is a .cmd on Windows; run its JS entry with node instead of going through a shell.
  const cli = join(
    process.execPath,
    '..',
    process.platform === 'win32' ? '' : '..',
    process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js',
  )
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout
}

async function main() {
  const root = join(import.meta.dirname, '..')
  const pkgDir = join(root, 'packages', 'cli')
  if (!process.argv.includes('--no-build')) {
    const build = spawnSync(process.execPath, [join(pkgDir, 'scripts', 'build.mjs')], { stdio: 'inherit' })
    if (build.status !== 0) throw new Error('build failed')
  }
  const work = mkdtempSync(join(tmpdir(), 'mm-pack-'))
  try {
    const [info] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], { cwd: pkgDir }))
    const problems = [
      ...checkPackFiles(info.files.map((f) => f.path)),
      ...checkManifest(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))),
    ]
    // Phase 3a-1: the shell worker bundle (~13 MB) ships too, so the tarball is larger.
    if (info.size > 45 * 1024 * 1024) problems.push(`package is too large: ${info.size} bytes`)
    if (problems.length > 0) throw new Error(problems.join('\n'))

    const prefix = join(work, 'prefix')
    npm([
      'install',
      '--global',
      '--prefix',
      prefix,
      '--offline',
      '--no-audit',
      '--no-fund',
      join(work, info.filename),
    ])
    const installed =
      process.platform === 'win32'
        ? join(prefix, 'node_modules', '@mongo-manager', 'app', 'dist', 'cli.cjs')
        : join(prefix, 'lib', 'node_modules', '@mongo-manager', 'app', 'dist', 'cli.cjs')
    const version = spawnSync(process.execPath, [installed, 'version'], { encoding: 'utf8', cwd: work })
    if (!/^mongo-manager \d/.test(version.stdout)) throw new Error(`version failed: ${version.stderr}`)

    const child = spawn(
      process.execPath,
      [
        installed,
        'start',
        '--web-port',
        '0',
        '--data-dir',
        join(work, 'data'),
        '--no-open',
        '--log-level',
        'warn',
      ],
      { cwd: work },
    )
    try {
      const url = await new Promise((resolve, reject) => {
        let err = ''
        const timer = setTimeout(() => reject(new Error(`start printed no URL:\n${err}`)), 60_000)
        child.stderr.on('data', (d) => {
          err += d
          const m = /running at (\S+)/.exec(err)
          if (m) {
            clearTimeout(timer)
            resolve(m[1])
          }
        })
      })
      const health = await fetch(new URL('healthz', url))
      const index = await fetch(url)
      if (health.status !== 200 || !(await index.text()).includes('<base href='))
        throw new Error('installed package does not serve the app')
    } finally {
      // Wait for the server to exit: on Windows its open files block removing the folder.
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
    console.log(
      `verify-pack: ${info.filename} (${Math.round(info.size / 1024)} KiB, ${info.files.length} files) installs offline and serves the app`,
    )
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
