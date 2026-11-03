import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkManifest, checkPackFiles } from './verify-pack.mjs'

test('only the bundle, the shell worker, the web app and the docs are packed', () => {
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'README.md',
      'LICENSE',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'public/index.html',
      'public/assets/a.js',
      'plugins/geojson-map/mongo-manager-plugin.json',
      'plugins/geojson-map/index.html',
    ]),
    [],
  )
  // Phase 4b §4: the map plugin ships, in a folder of its own; nothing else under plugins/.
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'public/index.html',
    ]),
    ['missing plugins/geojson-map/mongo-manager-plugin.json'],
  )
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'public/index.html',
      'plugins/geojson-map/mongo-manager-plugin.json',
      'plugins/stray.js',
    ]),
    ['unexpected file in package: plugins/stray.js'],
  )
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'src/main.ts',
      'public/index.html',
      'plugins/geojson-map/mongo-manager-plugin.json',
    ]),
    ['unexpected file in package: src/main.ts'],
  )
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'public/index.html',
      'plugins/geojson-map/mongo-manager-plugin.json',
    ]),
    ['missing dist/cli.cjs'],
  )
  // The shell worker (phase 3a-1) must ship, or the sandboxed shell cannot start.
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'public/index.html',
      'plugins/geojson-map/mongo-manager-plugin.json',
    ]),
    ['missing dist/shell-worker.cjs'],
  )
  // Security review 2026-10-13 (ops): the licences of what it bundles ship with it.
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'public/index.html',
      'plugins/geojson-map/mongo-manager-plugin.json',
    ]),
    ['missing dist/THIRD-PARTY-NOTICES.txt'],
  )
  assert.deepEqual(
    checkPackFiles([
      'package.json',
      'dist/cli.cjs',
      'dist/shell-worker.cjs',
      'dist/THIRD-PARTY-NOTICES.txt',
      'plugins/geojson-map/mongo-manager-plugin.json',
    ]),
    ['missing public/index.html'],
  )
})

test('the manifest has no dependencies and no install scripts (Review Focus 4)', () => {
  const ok = { name: 'mongo-manager', bin: { 'mongo-manager': 'dist/cli.cjs' }, scripts: { build: 'x' } }
  assert.deepEqual(checkManifest(ok), [])
  assert.deepEqual(checkManifest({ ...ok, dependencies: { fastify: '5' } }), ['dependencies must be empty'])
  assert.deepEqual(checkManifest({ ...ok, scripts: { postinstall: 'node x' } }), [
    'install script not allowed: postinstall',
  ])
  assert.deepEqual(checkManifest({ ...ok, optionalDependencies: { a: '1' } }), [
    'optionalDependencies must be empty',
  ])
})

// Review of the ops fixes (M2): a build's own list of its packages never ships (the notices do).
test('refuses a third-party list left in the package', () => {
  const base = [
    'package.json',
    'dist/cli.cjs',
    'dist/shell-worker.cjs',
    'dist/THIRD-PARTY-NOTICES.txt',
    'public/index.html',
    'plugins/geojson-map/mongo-manager-plugin.json',
  ]
  assert.deepEqual(checkPackFiles([...base, 'public/third-party.json']), [
    'unexpected file in package: public/third-party.json',
  ])
  assert.deepEqual(checkPackFiles([...base, 'plugins/geojson-map/third-party.json']), [
    'unexpected file in package: plugins/geojson-map/third-party.json',
  ])
})
