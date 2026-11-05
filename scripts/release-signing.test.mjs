// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageStageHash, releaseInfo } from './release-info.mjs'

// The updater (2026-11-03): each release carries release.json, and SHA256SUMS signed with the
// project's Ed25519 key; the app installs nothing else.
const here = import.meta.dirname
const root = join(here, '..')
const node = (args, env = {}) =>
  spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } })
const temp = () => mkdtempSync(join(tmpdir(), 'mm-sign-'))

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

test('release.json names the version, the oldest Node and the oldest image', () => {
  const dir = temp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4.0', engines: { node: '>=24' } }))
  writeFileSync(
    join(dir, 'release-requirements.json'),
    JSON.stringify({ minImage: '1.1.0', imageStage: 'x' }),
  )
  assert.deepEqual(releaseInfo(dir), { schema: 1, version: '1.4.0', node: '24.0.0', minImage: '1.1.0' })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4.0', engines: { node: '^24' } }))
  assert.throws(() => releaseInfo(dir), /engines\.node/)
  const out = temp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4.0', engines: { node: '>=24.3' } }))
  const r = node([join(here, 'release-info.mjs'), out, '--package', dir])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')), {
    schema: 1,
    version: '1.4.0',
    node: '24.3.0',
    minImage: '1.1.0',
  })
  // Final review (I7): a release that needs a newer installed program says so.
  writeFileSync(
    join(dir, 'release-requirements.json'),
    JSON.stringify({ minImage: '1.1.0', minLauncher: '1.2.0', imageStage: 'x' }),
  )
  assert.equal(releaseInfo(dir).minLauncher, '1.2.0')
  writeFileSync(
    join(dir, 'release-requirements.json'),
    JSON.stringify({ minImage: '1.1.0', minLauncher: '1.2', imageStage: 'x' }),
  )
  assert.throws(() => releaseInfo(dir), /minLauncher/)
  rmSync(dir, { recursive: true })
  rmSync(out, { recursive: true })
})

test('the Docker image a release needs is pinned to the Dockerfile’s runtime stage', () => {
  const req = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'release-requirements.json'), 'utf8'))
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')
  assert.equal(
    imageStageHash(dockerfile),
    req.imageStage,
    "The Dockerfile's runtime stage changed: set minImage in packages/cli/release-requirements.json to the version that ships it and update imageStage",
  )
  // The version, the revision and the labels change with every release and are not the stage.
  const bumped = dockerfile
    .replace('ARG VERSION=dev', 'ARG VERSION=9.9.9')
    .replace('Mongo Manager: a secure', 'Changed')
  assert.equal(imageStageHash(bumped), req.imageStage)
  assert.notEqual(imageStageHash(dockerfile.replace('tini mongodb-tools', 'tini')), req.imageStage)
  // The build stage is not the runtime's.
  assert.equal(
    imageStageHash(dockerfile.replace('npm install --global pnpm', 'npm i -g pnpm')),
    req.imageStage,
  )
})

test('the image says its version and build time to the app', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG CREATED=unknown$/m)
  assert.match(dockerfile, /^ENV MM_IMAGE_VERSION=\$VERSION MM_IMAGE_CREATED=\$CREATED$/m)
})

test('sign-release signs SHA256SUMS with the key it is given, checked against the listed key', () => {
  const dir = temp()
  const k = pair()
  const sums = join(dir, 'SHA256SUMS')
  writeFileSync(sums, `${'a'.repeat(64)}  mongo-manager-1.4.0.tgz\n`)
  const sig = join(dir, 'SHA256SUMS.sig')
  const r = node([join(here, 'sign-release.mjs'), sums, sig, '--public', k.pub], {
    MM_RELEASE_SIGNING_KEY: k.priv,
  })
  assert.equal(r.status, 0, r.stderr)
  const text = readFileSync(sig, 'utf8')
  assert.match(text, /^[A-Za-z0-9+/]{86}==\n$/)
  const key = createPublicKey({ key: Buffer.from(k.pub, 'base64'), format: 'der', type: 'spki' })
  assert.ok(verify(null, readFileSync(sums), key, Buffer.from(text.trim(), 'base64')))
  rmSync(dir, { recursive: true })
})

test('sign-release refuses a key whose public half is not listed, and a missing key, leaving no signature', () => {
  const dir = temp()
  const sums = join(dir, 'SHA256SUMS')
  writeFileSync(sums, `${'a'.repeat(64)}  x\n`)
  const sig = join(dir, 'SHA256SUMS.sig')
  const wrong = node([join(here, 'sign-release.mjs'), sums, sig, '--public', pair().pub], {
    MM_RELEASE_SIGNING_KEY: pair().priv,
  })
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /source\.ts/)
  assert.match(wrong.stderr, /Forks: turning updates on/)
  assert.equal(existsSync(sig), false)
  const none = node([join(here, 'sign-release.mjs'), sums, sig], { MM_RELEASE_SIGNING_KEY: '' })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /MM_RELEASE_SIGNING_KEY/)
  assert.equal(existsSync(sig), false)
  // Without --public it checks against the keys the app ships.
  const shipped = node([join(here, 'sign-release.mjs'), sums, sig], { MM_RELEASE_SIGNING_KEY: pair().priv })
  assert.equal(shipped.status, 1)
  assert.equal(existsSync(sig), false)
  rmSync(dir, { recursive: true })
})

test('release-key writes the private key to a private file and prints only the public key', () => {
  const dir = temp()
  const file = join(dir, 'k', 'mm-release-signing.key')
  mkdirSync(join(dir, 'k'))
  const r = node([join(here, 'release-key.mjs'), file])
  assert.equal(r.status, 0, r.stderr)
  const priv = readFileSync(file, 'utf8').trim()
  assert.ok(!r.stdout.includes(priv), 'the private key is never printed')
  const pub = /[A-Za-z0-9+/]{40,}={0,2}/.exec(r.stdout)?.[0]
  const fromPriv = createPublicKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' })
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
  assert.equal(pub, fromPriv)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  // It never overwrites a key.
  assert.notEqual(node([join(here, 'release-key.mjs'), file]).status, 0)
  rmSync(dir, { recursive: true })
})
