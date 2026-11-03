import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdCompress } from 'node:zlib'

/** Every key a kit opened, to see that the command wipes it when it is done. */
const opened: Buffer[] = []
vi.mock('@mongo-manager/server', async (original) => {
  const real = await original<typeof import('@mongo-manager/server')>()
  return {
    ...real,
    parseKit: (text: string) => {
      const key = real.parseKit(text)
      opened.push(key)
      return key
    },
  }
})
const { backupKeyFingerprint, encryptMmbak, kitText } = await import('@mongo-manager/server')
const { backupCommand } = await import('../src/commands/backup')

const ARCHIVE = readFileSync(join(__dirname, '../../server/test/fixtures/backup/shop.archive'))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  opened.splice(0)
})
const io = () =>
  ({
    stdin: Object.assign(Readable.from(['']), { isTTY: false }),
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: {},
    cwd: process.cwd(),
    platform: process.platform,
    openBrowser: () => undefined,
    waitForShutdown: () => Promise.resolve(),
  }) as never

describe('the recovery kit in memory (final review minor 10)', () => {
  it('wipes the kit’s key once inspect has listed the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-cli-wipe-'))
    dirs.push(dir)
    const key = randomBytes(32)
    const parts: Buffer[] = []
    const z = Readable.from([ARCHIVE]).pipe(createZstdCompress())
    for await (const p of encryptMmbak(z as AsyncIterable<Buffer>, {
      serverKey: { keyId: randomUUID(), key },
      chunkBytes: 1024,
      tool: { name: 't', version: '1' },
      now: 1,
    }))
      parts.push(p)
    writeFileSync(join(dir, 'x.mmbak'), Buffer.concat(parts))
    writeFileSync(
      join(dir, 'kit.txt'),
      kitText({
        host: 'h',
        username: 'u',
        name: 'Key 1',
        fingerprint: backupKeyFingerprint(key),
        createdAt: 0,
        key: Buffer.from(key),
      }),
    )
    expect(
      await backupCommand(['inspect', join(dir, 'x.mmbak')], { 'key-file': join(dir, 'kit.txt') }, io()),
    ).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.every((b) => b === 0)).toBe(true)
  })
})
