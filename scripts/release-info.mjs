// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// The updater (2026-11-03): release.json, listed in SHA256SUMS like every file of a release — the
// version, the oldest Node it runs on, and the oldest Docker image that can run it (an older image
// is pulled, not updated in place). Usage: node scripts/release-info.mjs <outDir> [--package <dir>]
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const VERSION = /^\d+\.\d+\.\d+$/

/** release.json for the package in `pkgDir` (its package.json and release-requirements.json). */
export function releaseInfo(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const req = JSON.parse(readFileSync(join(pkgDir, 'release-requirements.json'), 'utf8'))
  const engines = /^>=(\d+(?:\.\d+){0,2})$/.exec(pkg.engines?.node ?? '')
  if (!engines)
    throw new Error(`engines.node must read ">=x[.y[.z]]", got ${JSON.stringify(pkg.engines?.node)}`)
  const parts = engines[1].split('.')
  while (parts.length < 3) parts.push('0')
  const info = { schema: 1, version: pkg.version, node: parts.join('.'), minImage: req.minImage }
  // Final review (I7): the oldest installed program (launcher) that may run this release, when a
  // release needs one newer than any before; installs older than it are offered a reinstall.
  if (req.minLauncher !== undefined) info.minLauncher = req.minLauncher
  for (const k of Object.keys(info).filter((k) => k !== 'schema'))
    if (!VERSION.test(info[k])) throw new Error(`${k} is not x.y.z: ${JSON.stringify(info[k])}`)
  return info
}

/**
 * The Dockerfile's runtime stage (from its second FROM), without what changes with every release —
 * the version and revision arguments, the labels, the image's own version variables — or comments.
 */
export function imageStageHash(dockerfile) {
  const lines = dockerfile.replace(/\r\n/g, '\n').split('\n')
  const froms = lines.flatMap((l, i) => (/^FROM\s/i.test(l) ? [i] : []))
  if (froms.length < 2) throw new Error('The Dockerfile has no runtime stage')
  const kept = []
  let inLabel = false
  for (const line of lines.slice(froms[1])) {
    if (inLabel) {
      inLabel = line.trimEnd().endsWith('\\')
      continue
    }
    if (/^LABEL\s/.test(line)) {
      inLabel = line.trimEnd().endsWith('\\')
      continue
    }
    if (/^\s*#/.test(line) || line.trim() === '') continue
    if (/^ARG (VERSION|REVISION|CREATED)\b/.test(line) || /^ENV MM_IMAGE_/.test(line)) continue
    kept.push(line.trimEnd())
  }
  return createHash('sha256').update(kept.join('\n')).digest('hex')
}

if (import.meta.main) {
  const [out, flag, dir] = process.argv.slice(2)
  if (!out) {
    process.stderr.write('Usage: node scripts/release-info.mjs <outDir> [--package <dir>]\n')
    process.exit(2)
  }
  const pkgDir =
    flag === '--package' && dir ? resolve(dir) : join(import.meta.dirname, '..', 'packages', 'cli')
  try {
    const info = releaseInfo(pkgDir)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'release.json'), `${JSON.stringify(info, null, 2)}\n`)
    process.stdout.write(`release.json: ${JSON.stringify(info)}\n`)
  } catch (e) {
    process.stderr.write(`release-info: ${e.message}\n`)
    process.exit(1)
  }
}
