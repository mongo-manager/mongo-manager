// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLogLine, openLogFile } from '../src/http/log-file'

/**
 * CI fixes, sixth and seventh reviews: the log file is taken only when it is what it must be — a
 * regular file with one name, the very file at its path — checked before anything is changed, so a
 * file it refuses is left exactly as it was, and the refusal says what to do.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-logc-'))
  dirs.push(d)
  return d
}

describe('a log path that is not a log file of its own', () => {
  it('refuses a file with other names, leaving it as it was', () => {
    const dir = temp()
    const other = join(dir, 'config.json')
    writeFileSync(other, '{"keep":true}\n')
    if (process.platform !== 'win32') chmodSync(other, 0o644)
    const path = join(dir, 'mm.log')
    linkSync(other, path)
    expect(() => openLogFile(path)).toThrow(/has other names \(hard links\): remove or rename it/)
    expect(() => appendLogLine(path, '{"msg":"x"}')).toThrow(/has other names/)
    expect(readFileSync(other, 'utf8')).toBe('{"keep":true}\n')
    if (process.platform !== 'win32') expect(statSync(other).mode & 0o777).toBe(0o644)
  })

  it.skipIf(process.platform === 'win32')('refuses a link, and a pipe without waiting on it', () => {
    const dir = temp()
    const target = join(dir, 'target')
    writeFileSync(target, 'theirs\n')
    const link = join(dir, 'link.log')
    symlinkSync(target, link)
    expect(() => openLogFile(link)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('theirs\n')
    const fifo = join(dir, 'fifo.log')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    expect(() => appendLogLine(fifo, '{"msg":"x"}')).toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  // Eighth review (important 1): Windows follows a junction even on an exclusive create, and making
  // one needs no privilege; a junction at the log path is refused before anything is created.
  it.runIf(process.platform === 'win32')('creates nothing where a junction at its path points', () => {
    const dir = temp()
    // A folder the junction's target is in: what an exclusive create would make the file in.
    mkdirSync(join(dir, 'elsewhere'))
    const target = join(dir, 'elsewhere', 'planted.txt')
    const path = join(dir, 'mm.log')
    symlinkSync(target, path, 'junction')
    expect(() => openLogFile(path)).toThrow(/is a link: remove or rename it/)
    expect(() => appendLogLine(path, '{"msg":"x"}')).toThrow(/is a link/)
    expect(existsSync(target)).toBe(false)
  })

  it('appends a line to a log file of its own, made private', () => {
    const dir = temp()
    const path = join(dir, 'logs', 'mm.log')
    appendLogLine(path, '{"msg":"one"}')
    appendLogLine(path, '{"msg":"two"}\n')
    expect(readFileSync(path, 'utf8')).toBe('{"msg":"one"}\n{"msg":"two"}\n')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
