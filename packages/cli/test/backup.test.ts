import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdCompress } from 'node:zlib'
import { encryptMmbak } from '@mongo-manager/server'
import { backupCommand } from '../src/commands/backup'
import { main } from '../src/main'

const FIXTURES = join(__dirname, '../../server/test/fixtures/backup')
const PW = 'correct horse battery staple'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-cli-backup-'))
  dirs.push(dir)
  return dir
}
function fakeIo(stdinText: string, tty = false) {
  const out: string[] = []
  const err: string[] = []
  const stdin = Object.assign(Readable.from([stdinText]), { isTTY: tty })
  const io = {
    stdin,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: {},
    cwd: process.cwd(),
    platform: process.platform,
    openBrowser: () => undefined,
    waitForShutdown: () => Promise.resolve(),
  }
  return { io: io as never, out, err }
}
async function mmbakOf(plain: Buffer): Promise<Buffer> {
  const z = Readable.from([plain]).pipe(createZstdCompress())
  const parts: Buffer[] = []
  for await (const p of encryptMmbak(z as AsyncIterable<Buffer>, {
    password: PW,
    chunkBytes: 1024,
    tool: { name: 't', version: '1' },
    now: 1,
  }))
    parts.push(p)
  return Buffer.concat(parts)
}

describe('mongo-manager backup (spec §10)', () => {
  it('decrypts an .mmbak with the password from stdin into a plain archive', async () => {
    const dir = tmp()
    const archive = readFileSync(join(FIXTURES, 'shop.archive'))
    writeFileSync(join(dir, 'x.mmbak'), await mmbakOf(archive))
    const { io, out } = fakeIo(`${PW}\n`)
    const code = await backupCommand(
      ['decrypt', join(dir, 'x.mmbak')],
      { 'password-stdin': true, out: join(dir, 'x.archive') },
      io,
    )
    expect(code).toBe(0)
    expect(readFileSync(join(dir, 'x.archive'))).toEqual(archive)
    expect(out.join('')).toMatch(/Wrote/)
  })

  it('leaves no partial file after a wrong password, and never overwrites a file', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'x.mmbak'), await mmbakOf(readFileSync(join(FIXTURES, 'shop.archive'))))
    const target = join(dir, 'x.archive')
    await expect(
      backupCommand(
        ['decrypt', join(dir, 'x.mmbak')],
        { 'password-stdin': true, out: target },
        fakeIo('wrong\n').io,
      ),
    ).rejects.toThrow(/password/)
    // No partial file: creating it anew succeeds (it throws EEXIST if one was left).
    expect(() => writeFileSync(target, 'keep', { flag: 'wx' })).not.toThrow()
    await expect(
      backupCommand(
        ['decrypt', join(dir, 'x.mmbak')],
        { 'password-stdin': true, out: target },
        fakeIo(`${PW}\n`).io,
      ),
    ).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('inspects an archive, a gzip archive, a directory zip and an .mmbak', async () => {
    for (const [file, format] of [
      ['shop.archive', 'archive'],
      ['shop.archive.gz', 'gzip'],
      ['shop-dir.zip', 'directory'],
    ] as const) {
      const { io, out } = fakeIo('')
      expect(await backupCommand(['inspect', join(FIXTURES, file)], {}, io)).toBe(0)
      expect(out.join(''), file).toMatch(/shop\.orders/)
      expect(out.join(''), file).toContain(format)
    }
    const dir = tmp()
    writeFileSync(join(dir, 'x.mmbak'), await mmbakOf(readFileSync(join(FIXTURES, 'shop.archive'))))
    const { io, out } = fakeIo(`${PW}\n`)
    expect(await backupCommand(['inspect', join(dir, 'x.mmbak')], { 'password-stdin': true }, io)).toBe(0)
    expect(out.join('')).toMatch(/shop\.orders/)
  })

  it('reports a wrong password on inspect as an error, not a crash (final review minor 1)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'x.mmbak'), await mmbakOf(readFileSync(join(FIXTURES, 'shop.archive'))))
    const unhandled: unknown[] = []
    const onError = (e: unknown) => unhandled.push(e)
    process.on('uncaughtException', onError)
    try {
      await expect(
        backupCommand(['inspect', join(dir, 'x.mmbak')], { 'password-stdin': true }, fakeIo('wrong\n').io),
      ).rejects.toThrow(/password/)
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      process.off('uncaughtException', onError)
    }
    expect(unhandled).toEqual([])
  })

  it('refuses a password on the command line, a missing output and files that are not backups', async () => {
    const dir = tmp()
    const { io, err } = fakeIo('')
    expect(await main(['backup', 'decrypt', 'x', '--password=x'], io)).toBe(2)
    expect(err.join('')).toMatch(/password/)
    writeFileSync(join(dir, 'junk'), 'not a backup at all')
    await expect(backupCommand(['inspect', join(dir, 'junk')], {}, fakeIo('').io)).rejects.toThrow(
      /not a backup/,
    )
    await expect(
      backupCommand(['decrypt', join(FIXTURES, 'shop.archive')], { out: join(dir, 'o') }, fakeIo('').io),
    ).rejects.toThrow(/encrypted/)
    writeFileSync(join(dir, 'x.mmbak'), await mmbakOf(Buffer.from('x')))
    await expect(backupCommand(['decrypt', join(dir, 'x.mmbak')], {}, fakeIo('').io)).rejects.toThrow(/-o/)
    await expect(backupCommand(['restore', 'x'], {}, fakeIo('').io)).rejects.toThrow(/backup inspect/)
    // No terminal and no --password-stdin; --password-stdin on a terminal.
    await expect(
      backupCommand(['decrypt', join(dir, 'x.mmbak')], { out: join(dir, 'o') }, fakeIo('', false).io),
    ).rejects.toThrow(/--password-stdin/)
    await expect(
      backupCommand(
        ['decrypt', join(dir, 'x.mmbak')],
        { out: join(dir, 'o'), 'password-stdin': true },
        fakeIo('', true).io,
      ),
    ).rejects.toThrow(/pipe/)
    expect(await main(['backup', 'inspect', join(FIXTURES, 'shop.archive')], fakeIo('').io)).toBe(0)
  })
})
