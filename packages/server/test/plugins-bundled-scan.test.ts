// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { scanPlugin } from '../src/plugins/scan'

// User report 2026-10-11: the plugins shipped with Mongo Manager scan clean — nothing high, medium
// or low (a note on minified code aside) — as built into packages/plugins/dist.
const DIST = join(__dirname, '..', '..', 'plugins', 'dist')
const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesIn(path) : [path]
  })
const built = existsSync(DIST) ? readdirSync(DIST).filter((id) => statSync(join(DIST, id)).isDirectory()) : []

// CI's e2e job builds first and sets MM_REQUIRE_BUILD: there a missing build fails, never skips.
// Every first-party plugin (a source folder with a manifest), not only some (review of the deferred
// fixes: a partial build passed).
it.runIf(process.env.MM_REQUIRE_BUILD === '1')('has every first-party plugin built to scan', () => {
  const SOURCES = join(__dirname, '..', '..', 'plugins')
  const plugins = readdirSync(SOURCES).filter((name) =>
    existsSync(join(SOURCES, name, 'public', 'mongo-manager-plugin.json')),
  )
  expect(plugins.length).toBeGreaterThan(0)
  expect(plugins.filter((name) => !built.includes(name))).toEqual([])
})

describe.skipIf(!built.length)('the plugins shipped with the app', () => {
  it.each(built)('%s scans clean', (id) => {
    const dir = join(DIST, id)
    const files = new Map(filesIn(dir).map((p) => [relative(dir, p).split(sep).join('/'), readFileSync(p)]))
    const manifest = JSON.parse(files.get('mongo-manager-plugin.json')!.toString('utf8'))
    const { counts, findings } = scanPlugin(files, manifest)
    expect(
      findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity}:${f.rule} ${f.file}:${f.line}`),
    ).toEqual([])
    expect({ ...counts, info: 0 }).toEqual({ high: 0, medium: 0, low: 0, info: 0 })
  })
})
