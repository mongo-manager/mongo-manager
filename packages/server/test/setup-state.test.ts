// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SetupState } from '../src/auth/setup'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-setup-'))
  dirs.push(d)
  return d
}

// Security review 2026-10-13 (low) and its review: the setup token's file.
describe('the setup token file', () => {
  it('is written anew, never through what was there', () => {
    const dir = temp()
    const file = join(dir, 'setup-token')
    const elsewhere = join(dir, 'elsewhere')
    writeFileSync(elsewhere, 'untouched')
    try {
      symlinkSync(elsewhere, file)
    } catch {
      return // No links here (Windows without the right): nothing to follow.
    }
    const state = new SetupState()
    const token = state.ensureToken()
    state.keepIn(file)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
  })

  // Review, minor 5: the user row was already made; a file that would not go failed the setup.
  it('is spent even when the file cannot be removed', () => {
    const dir = temp()
    const file = join(dir, 'setup-token')
    const state = new SetupState()
    state.ensureToken()
    state.keepIn(file)
    rmSync(file)
    mkdirSync(join(file, 'held'), { recursive: true })
    expect(() => state.clear()).not.toThrow()
    expect(state.active).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
})
