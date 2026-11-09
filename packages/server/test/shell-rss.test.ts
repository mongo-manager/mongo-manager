// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { parseProcStatus, parsePs, parseTasklist, rssSource } from '../src/shell/rss'
import { slow } from './support/slowness'

/**
 * Security audit 2026-10-16 (Important 2): the worker's memory was known only from its own answer to
 * a ping, which a worker busy in synchronous code never sends — and --max-old-space-size does not
 * count ArrayBuffers (648 MB seen). The server now measures the worker's resident memory itself, from
 * the operating system.
 */
describe('reading a process’s resident memory', () => {
  it('reads VmRSS from /proc/<pid>/status (Linux)', () => {
    const status = 'Name:\tnode\nVmPeak:\t 900000 kB\nVmRSS:\t  412345 kB\nRssAnon:\t 400000 kB\n'
    expect(parseProcStatus(status)).toBe(412345 * 1024)
    expect(parseProcStatus('Name:\tzombie\n')).toBeNull()
  })

  // Review 2026-10-16 (minor): memory pushed out to swap is still the worker's.
  it('counts what is swapped out on Linux too', () => {
    const status = 'Name:\tnode\nVmRSS:\t  400000 kB\nVmSwap:\t  300000 kB\n'
    expect(parseProcStatus(status)).toBe(700000 * 1024)
  })

  // Review 2026-10-16 (minor): one tasklist for every worker measured at once, not one each.
  it('measures every worker asked for at once with one tasklist on Windows', async () => {
    const calls: string[][] = []
    const files: string[] = []
    const source = rssSource('win32', {
      run: async (file, args) => {
        files.push(file)
        calls.push(args)
        return '"node.exe","11","Console","1","1.000 K"\r\n"node.exe","22","Console","1","2.000 K"\r\n'
      },
      imageName: 'node.exe',
      systemRoot: 'X:\\Win',
    })!
    const [a, b, c] = await Promise.all([source.read(11), source.read(22), source.read(33)])
    expect([a, b, c]).toEqual([1000 * 1024, 2000 * 1024, null])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq node.exe'])
    // By its full path under the system root, a Windows path wherever the test runs (CI is Linux).
    expect(files).toEqual(['X:\\Win\\System32\\tasklist.exe'])
  })

  // Second review 2026-10-16 (minor): each worker's watch has its own timer, so their reads rarely
  // met in the same instant; a listing serves every read for half a second.
  it('reuses a tasklist listing for half a second', async () => {
    let calls = 0
    const source = rssSource('win32', {
      run: async () => {
        calls++
        return '"node.exe","11","Console","1","1.000 K"\r\n'
      },
      imageName: 'node.exe',
      systemRoot: 'X:\\Win',
    })!
    await source.read(11)
    await new Promise((r) => setTimeout(r, 100))
    await source.read(22)
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 600))
    await source.read(11)
    expect(calls).toBe(2)
  })

  it('reads the rss column of ps (macOS and other POSIX systems)', () => {
    expect(parsePs('  512000\n')).toBe(512000 * 1024)
    expect(parsePs('')).toBeNull()
    expect(parsePs('RSS\n')).toBeNull()
  })

  it('reads the memory column of tasklist, whatever the locale’s digit grouping (Windows)', () => {
    expect(parseTasklist('"node.exe","4321","Console","1","412.345 K"\r\n', 4321)).toBe(412345 * 1024)
    expect(parseTasklist('"node.exe","4321","Console","1","412,345 K"\r\n', 4321)).toBe(412345 * 1024)
    expect(parseTasklist('"node.exe","4321","Services","0","1 234 567 Ko"\r\n', 4321)).toBe(1234567 * 1024)
    // Another process's line, or none at all.
    expect(parseTasklist('"node.exe","999","Console","1","5 K"\r\n', 4321)).toBeNull()
    expect(
      parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 4321),
    ).toBeNull()
  })

  // A process start (tasklist, ps) costs a tenth of a second or so: often only while the worker does
  // not answer, rarely otherwise, so twenty idle shells cost next to nothing. A /proc read is free.
  it('measures often where it is cheap, and rarely where each measure starts a process', () => {
    const linux = rssSource('linux')!
    expect(linux.busyMs).toBeLessThanOrEqual(250)
    for (const platform of ['win32', 'darwin'] as const) {
      const source = rssSource(platform, { systemRoot: 'X:\\Win' })!
      expect(source.busyMs, platform).toBeLessThanOrEqual(1000)
      expect(source.idleMs, platform).toBeGreaterThanOrEqual(30_000)
    }
  })

  it(
    'measures a live child holding memory outside the V8 heap',
    async () => {
      const source = rssSource()
      expect(source, 'every platform the server supports can be measured').not.toBeNull()
      const child = spawn(
        process.execPath,
        [
          '-e',
          'const b = new ArrayBuffer(200 * 1024 * 1024); new Uint8Array(b).fill(1); globalThis.keep = b; process.stdout.write("ready"); setInterval(() => {}, 1000)',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const exited = new Promise((r) => child.once('exit', r))
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once('data', () => resolve())
          child.once('exit', () => reject(new Error('the child ended early')))
        })
        // A tasklist slower than its 5 s under a full suite's load reads nothing; the manager then
        // measures again at its next sample, and so does this test.
        const bytes = await vi.waitFor(
          async () => {
            const read = await source!.read(child.pid!)
            expect(read).not.toBeNull()
            return read!
          },
          { timeout: slow(15_000), interval: 600 },
        )
        expect(bytes).toBeGreaterThan(180 * 1024 * 1024)
      } finally {
        child.kill('SIGKILL')
      }
      // A process that is gone has no memory to report.
      await exited
      // Past the half second a Windows listing is reused.
      await new Promise((r) => setTimeout(r, 600))
      expect(await source!.read(child.pid!)).toBeNull()
    },
    slow(30_000),
  )
})
