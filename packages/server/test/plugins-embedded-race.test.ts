// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEmbeddedPlugins } from '../src/plugins/embedded'

/** What lstat answers for a path, in place of the truth: the look before a swap. */
const looked = vi.hoisted(() => new Map<string, unknown>())
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const lstat = ((path: string, options?: never) =>
    looked.get(String(path)) ?? fs.lstatSync(path, options)) as typeof fs.lstatSync
  return { ...fs, lstatSync: lstat }
})

const dirs: string[] = []
afterEach(() => {
  looked.clear()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-embedded-race-'))
  dirs.push(d)
  return d
}
const bytes = (s: string) => new Uint8Array(Buffer.from(s))

// CodeQL 2026-11-02 (js/file-system-race, alert 12): a file looked at and then read by its name
// again could be another one by then — a link swapped in right after the look. What is read must be
// the very file looked at: opened once, checked, and read from that open file.
it('reads the very file it looked at, never another file put at its name after the look', () => {
  const data = temp()
  const files = new Map([['charts/index.html', bytes('<!doctype html>')]])
  const dir = writeEmbeddedPlugins(data, '1.0.0', files)
  const file = join(dir, 'charts', 'index.html')
  // The look saw another plain file than the one at the name now (the same bytes in both): the file
  // was swapped after the look. No file is touched for it (CodeQL alert 13 took a swap here for one).
  const elsewhere = join(temp(), 'index.html')
  writeFileSync(elsewhere, '<!doctype html>')
  const kept = lstatSync(file, { bigint: true }).ino
  looked.set(file, lstatSync(elsewhere, { bigint: true }))
  writeEmbeddedPlugins(data, '1.0.0', files)
  looked.clear()
  // Not taken for the file looked at: the folder is written again from the binary.
  expect(lstatSync(file, { bigint: true }).ino).not.toBe(kept)
})

it('reads the very file it looked at, never a link swapped in after the look', (ctx) => {
  const data = temp()
  const files = new Map([['charts/index.html', bytes('<!doctype html>')]])
  const dir = writeEmbeddedPlugins(data, '1.0.0', files)
  const file = join(dir, 'charts', 'index.html')
  // A link at the name, to the same bytes elsewhere; the look saw a plain file.
  const outside = join(temp(), 'index.html')
  writeFileSync(outside, '<!doctype html>')
  rmSync(file)
  try {
    symlinkSync(outside, file, 'file')
  } catch (e) {
    // Windows without the right to make links: nothing to swap in.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
    throw e
  }
  // The look saw the plain file there before the swap: another file than the link's target (CI on
  // Windows 2026-11-02, where a link is followed when opened: the target's own stats would match).
  const before = join(temp(), 'before.html')
  writeFileSync(before, '<!doctype html>')
  looked.set(file, lstatSync(before, { bigint: true }))
  writeEmbeddedPlugins(data, '1.0.0', files)
  looked.clear()
  // Not kept as the plugin's file: written again from the binary, a plain file.
  expect(lstatSync(file).isSymbolicLink()).toBe(false)
  expect(lstatSync(file).isFile()).toBe(true)
})
