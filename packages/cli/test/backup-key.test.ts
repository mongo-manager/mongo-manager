import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdCompress } from 'node:zlib'
import { backupKeyFingerprint, encryptMmbak, kitText } from '@mongo-manager/server'
import { backupCommand } from '../src/commands/backup'
import { main } from '../src/main'

const FIXTURES = join(__dirname, '../../server/test/fixtures/backup')
const ARCHIVE = readFileSync(join(FIXTURES, 'shop.archive'))
const PW = 'correct horse battery staple'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-cli-key-'))
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
/** A kit file as the server writes it, with the key line the CLI reads. */
const kitOf = async (key: Buffer): Promise<string> =>
  kitText({
    host: 'mm.example.com',
    username: 'alice',
    name: 'Key 1',
    fingerprint: backupKeyFingerprint(key),
    createdAt: 0,
    key,
  })
async function mmbak(opts: {
  password?: string
  serverKey?: { keyId: string; key: Buffer }
}): Promise<Buffer> {
  const parts: Buffer[] = []
  const z = Readable.from([ARCHIVE]).pipe(createZstdCompress())
  for await (const p of encryptMmbak(z as AsyncIterable<Buffer>, {
    ...opts,
    chunkBytes: 1024,
    tool: { name: 't', version: '1' },
    now: 1,
  }))
    parts.push(p)
  return Buffer.concat(parts)
}

describe('mongo-manager backup with a recovery kit (phase 3d-3c spec §2)', () => {
  it('decrypts a backup-key file with --key-file, and with --key - from stdin', async () => {
    const dir = tmp()
    const key = randomBytes(32)
    writeFileSync(join(dir, 'x.mmbak'), await mmbak({ serverKey: { keyId: randomUUID(), key } }))
    writeFileSync(join(dir, 'kit.txt'), await kitOf(key))
    const a = fakeIo('')
    expect(
      await backupCommand(
        ['decrypt', join(dir, 'x.mmbak')],
        { 'key-file': join(dir, 'kit.txt'), out: join(dir, 'a.archive') },
        a.io,
      ),
    ).toBe(0)
    expect(readFileSync(join(dir, 'a.archive'))).toEqual(ARCHIVE)
    const b = fakeIo(await kitOf(key))
    expect(
      await backupCommand(['decrypt', join(dir, 'x.mmbak')], { key: '-', out: join(dir, 'b.archive') }, b.io),
    ).toBe(0)
    expect(readFileSync(join(dir, 'b.archive'))).toEqual(ARCHIVE)
  })

  it('refuses another key’s kit and leaves nothing behind', async () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'x.mmbak'),
      await mmbak({ serverKey: { keyId: randomUUID(), key: randomBytes(32) } }),
    )
    writeFileSync(join(dir, 'kit.txt'), await kitOf(randomBytes(32)))
    await expect(
      backupCommand(
        ['decrypt', join(dir, 'x.mmbak')],
        { 'key-file': join(dir, 'kit.txt'), out: join(dir, 'o') },
        fakeIo('').io,
      ),
    ).rejects.toThrow(/does not open this backup/)
    expect(existsSync(join(dir, 'o'))).toBe(false)
  })

  it('names the slot types and fingerprints, and lists the contents with the kit', async () => {
    const dir = tmp()
    const key = randomBytes(32)
    writeFileSync(
      join(dir, 'x.mmbak'),
      await mmbak({ password: PW, serverKey: { keyId: randomUUID(), key } }),
    )
    writeFileSync(join(dir, 'kit.txt'), await kitOf(key))
    const withKit = fakeIo('')
    expect(
      await backupCommand(
        ['inspect', join(dir, 'x.mmbak')],
        { 'key-file': join(dir, 'kit.txt') },
        withKit.io,
      ),
    ).toBe(0)
    expect(withKit.out.join('')).toContain(`Key slots: password, backup key ${backupKeyFingerprint(key)}`)
    expect(withKit.out.join('')).toMatch(/shop\.orders/)
    writeFileSync(join(dir, 'k.mmbak'), await mmbak({ serverKey: { keyId: randomUUID(), key } }))
    const without = fakeIo('')
    expect(await backupCommand(['inspect', join(dir, 'k.mmbak')], {}, without.io)).toBe(0)
    expect(without.out.join('')).toContain('--key-file')
    expect(without.out.join('')).not.toMatch(/shop\.orders/)
  })

  // Final review minor 10: decrypt asked a key-only file for a password; a kit for a plain file, or
  // for a file without a backup-key slot, was ignored.
  it('says which opener a file takes before asking for anything', async () => {
    const dir = tmp()
    const key = randomBytes(32)
    writeFileSync(join(dir, 'k.mmbak'), await mmbak({ serverKey: { keyId: randomUUID(), key } }))
    writeFileSync(join(dir, 'p.mmbak'), await mmbak({ password: PW }))
    writeFileSync(join(dir, 'plain.archive'), ARCHIVE)
    writeFileSync(join(dir, 'kit.txt'), await kitOf(key))
    await expect(
      backupCommand(['decrypt', join(dir, 'k.mmbak')], { out: join(dir, 'o1') }, fakeIo('').io),
    ).rejects.toThrow(/opens with its backup key.*--key-file/)
    await expect(
      backupCommand(
        ['decrypt', join(dir, 'p.mmbak')],
        { 'key-file': join(dir, 'kit.txt'), out: join(dir, 'o2') },
        fakeIo('').io,
      ),
    ).rejects.toThrow(/no backup-key slot/)
    await expect(
      backupCommand(
        ['inspect', join(dir, 'plain.archive')],
        { 'key-file': join(dir, 'kit.txt') },
        fakeIo('').io,
      ),
    ).rejects.toThrow(/Only an encrypted backup/)
    expect(existsSync(join(dir, 'o1')) || existsSync(join(dir, 'o2'))).toBe(false)
  })

  it('never takes a key on the command line, and refuses mixed options', async () => {
    const { io, err } = fakeIo('')
    expect(await main(['backup', 'decrypt', 'x.mmbak', '--key', 'MMKEY1-AAAA', '-o', 'y'], io)).toBe(2)
    expect(err.join('')).toMatch(/never given on the command line/)
    expect(
      await main(['backup', 'decrypt', 'x.mmbak', '--key', '-', '--key-file', 'k', '-o', 'y'], fakeIo('').io),
    ).toBe(2)
    expect(
      await main(
        ['backup', 'decrypt', 'x.mmbak', '--key', '-', '--password-stdin', '-o', 'y'],
        fakeIo('').io,
      ),
    ).toBe(2)
    expect(await main(['user', 'list', '--key-file', 'k'], fakeIo('').io)).toBe(2)
  })
})
