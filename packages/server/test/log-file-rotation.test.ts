// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fourth review of the CI fixes (important 3): a log file another program holds open (a reader
 * following it, on Windows) cannot be renamed; the log goes on in the same file and is rotated once
 * it has grown by another limit — the server never stops for it. And a log that cannot be written
 * any more is said on stderr, never taking the server down.
 */
const state = vi.hoisted(() => ({
  refuseRename: 0,
  renames: 0,
  failWrite: false,
  closed: new Set<number>(),
  afterClose: [] as string[],
  notRegular: false,
  failOpen: 0,
  shortWrite: false,
  later: 0,
}))
// The repair after a rotation answers later, as PowerShell does (fourth review, important 2).
vi.mock('../src/store/datadir', async (original) => ({
  ...(await original<typeof import('../src/store/datadir')>()),
  repairPrivate: () => [],
  repairPrivateLater: () => {
    state.later++
    return new Promise((resolve) =>
      setTimeout(() => resolve([{ path: 'mm.log', was: 'D:(A;;FA;;;BU)' }]), 30),
    )
  },
}))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      state.renames++
      if (state.refuseRename > 0) {
        state.refuseRename--
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
      }
      return real.renameSync(from, to)
    },
    closeSync: (fd: number) => {
      state.closed.add(fd)
      return real.closeSync(fd)
    },
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (state.failOpen > 0) {
        state.failOpen--
        throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' })
      }
      const fd = real.openSync(...args)
      state.closed.delete(fd)
      return fd
    },
    writeSync: (...args: Parameters<typeof real.writeSync>) => {
      if (state.closed.has(args[0] as number)) state.afterClose.push(String(args[1]))
      if (state.failWrite)
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      // A short write: at most three bytes at a time.
      if (state.shortWrite && Buffer.isBuffer(args[1])) {
        const [fd, buf, offset = 0, length = buf.length] = args as unknown as [
          number,
          Buffer,
          number?,
          number?,
        ]
        return real.writeSync(fd, buf, offset, Math.min(3, length))
      }
      return real.writeSync(...args)
    },
    fstatSync: (...args: Parameters<typeof real.fstatSync>) => {
      const st = real.fstatSync(...args)
      return state.notRegular ? Object.assign(st, { isFile: () => false }) : st
    },
  }
})
const { openLogFile } = await import('../src/http/log-file')

const dirs: string[] = []
afterEach(() => {
  Object.assign(state, {
    refuseRename: 0,
    renames: 0,
    failWrite: false,
    closed: new Set(),
    afterClose: [],
    notRegular: false,
    failOpen: 0,
    shortWrite: false,
    later: 0,
  })
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const ended = (s: NodeJS.WritableStream) => new Promise<void>((r) => s.end(r))

describe('a log file that cannot be rotated or written', () => {
  it('goes on in the same file when it cannot be renamed, and rotates once it has grown by another limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
    dirs.push(dir)
    const path = join(dir, 'mm.log')
    const stream = openLogFile(path, 100)
    state.refuseRename = 1
    const line = `${'a'.repeat(59)}\n`
    for (let i = 0; i < 2; i++) stream.write(line)
    await new Promise((r) => setImmediate(r))
    // The rename was refused: still one file, nothing lost.
    expect(state.renames).toBe(1)
    expect(fs.existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(line.repeat(2))
    // Not tried at every line, only once it has grown by another limit.
    stream.write(line)
    await new Promise((r) => setImmediate(r))
    expect(state.renames).toBe(1)
    stream.write(line)
    await new Promise((r) => setImmediate(r))
    expect(state.renames).toBe(2)
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(line.repeat(3))
    expect(readFileSync(path, 'utf8')).toBe(line)
    // Rotated again, it goes back to rotating at every limit.
    stream.write(line)
    await ended(stream)
    expect(state.renames).toBe(3)
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(line)
  })

  it('drops a line it cannot write, says so once on stderr, and goes on writing when it can', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
    dirs.push(dir)
    const path = join(dir, 'mm.log')
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stream = openLogFile(path, 1_000_000)
    state.failWrite = true
    stream.write('one\n')
    stream.write('two\n')
    await new Promise((r) => setImmediate(r))
    const lines = said.mock.calls
      .map((c) => String(c[0]))
      .filter((t) => t.includes('could not write to the log file'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/ENOSPC/)
    // Fifth review (minor 3): the disk has room again, and the log goes on.
    state.failWrite = false
    stream.write('three\n')
    await ended(stream)
    expect(readFileSync(path, 'utf8')).toBe('three\n')
  })

  // Fourth review (important 2): a notice of the repair after a rotation, answered once the log is
  // closed, is never written — the system may have given its descriptor to another file since.
  it.runIf(process.platform === 'win32')('writes no notice once the log is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
    dirs.push(dir)
    const stream = openLogFile(join(dir, 'mm.log'), 100)
    stream.write(`${'a'.repeat(80)}
`)
    stream.write(`${'b'.repeat(80)}
`)
    await ended(stream)
    await new Promise((r) => setTimeout(r, 100))
    expect(state.afterClose).toEqual([])
  })

  // Sixth review (important 1): a file that is not what the log must be (planted at the path at a
  // rotation: not a regular file) is closed again, and not a line goes into it.
  it('writes no line into a file at its path that is not a regular file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
    dirs.push(dir)
    const path = join(dir, 'mm.log')
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stream = openLogFile(path, 100)
    stream.write(`${'a'.repeat(80)}\n`)
    state.notRegular = true
    stream.write(`${'b'.repeat(80)}\n`)
    stream.write(`${'c'.repeat(80)}\n`)
    await new Promise((r) => setImmediate(r))
    state.notRegular = false
    await ended(stream)
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(`${'a'.repeat(80)}\n`)
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(said.mock.calls.map((c) => String(c[0])).join('')).toMatch(/is not a regular file/)
  })

  // Sixth review (minor 3): a file made again after an open that failed is made private too.
  it.runIf(process.platform === 'win32')(
    'makes private the file it makes again after a failed open',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
      dirs.push(dir)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stream = openLogFile(join(dir, 'mm.log'), 100)
      stream.write(`${'a'.repeat(80)}\n`)
      state.failOpen = 1
      stream.write(`${'b'.repeat(80)}\n`)
      expect(state.later).toBe(0)
      stream.write(`${'c'.repeat(80)}\n`)
      await ended(stream)
      expect(state.later).toBe(1)
    },
  )

  // Sixth review (minor 5): a short write is carried on to the end of the line.
  it('writes the whole line when the system writes only part of it at a time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rot-'))
    dirs.push(dir)
    const path = join(dir, 'mm.log')
    const stream = openLogFile(path, 1_000_000)
    state.shortWrite = true
    stream.write('{"msg":"one"}\n')
    stream.write('{"msg":"two"}\n')
    await ended(stream)
    expect(readFileSync(path, 'utf8')).toBe('{"msg":"one"}\n{"msg":"two"}\n')
  })
})
