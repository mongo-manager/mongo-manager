// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstPluginFolder } from '../src/plugins/bundled'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-bundled-'))
  dirs.push(d)
  return d
}

describe('bundled plugins are found next to the build (phase 4b §4)', () => {
  it('takes the first folder holding a plugin, never one that only exists', () => {
    const code = temp()
    mkdirSync(join(code, 'plugins-source'))
    writeFileSync(join(code, 'service.ts'), '')
    const built = temp()
    mkdirSync(join(built, 'geojson-map'))
    writeFileSync(join(built, 'geojson-map', 'mongo-manager-plugin.json'), '{}')
    expect(firstPluginFolder([join(temp(), 'missing'), code, built])).toBe(built)
    expect(firstPluginFolder([code])).toBeUndefined()
  })
})
