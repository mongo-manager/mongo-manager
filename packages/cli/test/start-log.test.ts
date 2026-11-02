import { afterEach, describe, expect, it } from 'vitest'
import { linkSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/main'
import { cleanTempDirs, fakeIo, tempDir } from './support'

/**
 * CI fixes, seventh review (important 1): a start that fails before the server's logger exists says
 * so in its log file — opened as the server opens it, so a file the server would refuse (another
 * file's second name, here) is never written to.
 */
afterEach(() => cleanTempDirs())

describe('a start that fails before the server logs', () => {
  it('writes its failure into a log file of its own', async () => {
    const dir = tempDir()
    const log = join(dir, 'mm.log')
    const io = fakeIo()
    const code = await main(
      ['start', '--data-dir', join(dir, 'data'), '--log-file', log, '--web-port', 'x'],
      io,
    )
    expect(code).not.toBe(0)
    expect(readFileSync(log, 'utf8')).toMatch(/"msg":"Start failed: /)
  })

  it('never into another file that has the log path as a second name', async () => {
    const dir = tempDir()
    const other = join(dir, 'config.json')
    writeFileSync(other, '{"keep":true}\n')
    const log = join(dir, 'mm.log')
    linkSync(other, log)
    const io = fakeIo()
    const code = await main(
      ['start', '--data-dir', join(dir, 'data'), '--log-file', log, '--web-port', 'x'],
      io,
    )
    expect(code).not.toBe(0)
    expect(readFileSync(other, 'utf8')).toBe('{"keep":true}\n')
  })
})
