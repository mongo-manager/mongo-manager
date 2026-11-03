import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig, verifyPassword } from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

const PW = 'tarçın-kavanoz-42-mavi'

async function run(argv: string[], opts: { stdin?: string; tty?: boolean; typed?: string[] } = {}) {
  const io = fakeIo({ tty: opts.tty })
  const code = main(argv, io)
  if (opts.stdin !== undefined) io.input.end(opts.stdin)
  if (opts.typed) {
    for (const line of opts.typed) {
      await new Promise((r) => setTimeout(r, 20))
      io.input.write(line)
    }
  }
  return { code: await code, io }
}

describe('user commands', () => {
  it('adds a user from --password-stdin and audits it without the password', async () => {
    const dir = tempDir()
    const { code, io } = await run(
      ['user', 'add', 'ada', '--role', 'editor', '--password-stdin', '--data-dir', dir],
      { stdin: `${PW}\n` },
    )
    expect(code).toBe(0)
    expect(io.out()).toMatch(/Created user "ada" \(editor\)/)
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      const user = data.users.findByUsername('ada')!
      expect(user.role).toBe('editor')
      expect(await verifyPassword(PW, user.passwordHash)).toBe(true)
      const audit = data.store.db
        .prepare("SELECT username, details FROM audit_log WHERE action = 'users.create'")
        .get() as { username: string; details: string }
      expect(audit.username).toBe('cli')
      expect(audit.details).toContain('"via":"cli"')
      expect(audit.details).not.toContain(PW)
    } finally {
      data.close()
    }
  })

  it('reads the password twice from a terminal without echoing it', async () => {
    const dir = tempDir()
    const { code, io } = await run(['user', 'add', 'bob', '--role', 'viewer', '--data-dir', dir], {
      tty: true,
      typed: [`${PW}\r`, `${PW}\r`],
    })
    expect(code).toBe(0)
    expect(io.err()).toMatch(/Password for bob: /)
    expect(io.err()).toMatch(/Repeat password: /)
    expect(io.err() + io.out()).not.toContain(PW)
  })

  it('refuses weak, mismatched, missing and invalid input', async () => {
    const dir = tempDir()
    const weak = await run(['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', dir], {
      stdin: 'short\n',
    })
    expect(weak.code).toBe(1)
    expect(weak.io.err()).toMatch(/at least 12 characters/)
    // Password strength (2026-10-28): long, but easy to guess.
    const guessable = await run(
      ['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', dir],
      {
        stdin: 'Password1234!\n',
      },
    )
    expect(guessable.code).toBe(1)
    expect(guessable.io.err()).toMatch(/too easy to guess/)
    const mismatch = await run(['user', 'add', 'ada', '--role', 'admin', '--data-dir', dir], {
      tty: true,
      typed: [`${PW}\r`, 'other-password-1\r'],
    })
    expect(mismatch.code).toBe(1)
    expect(mismatch.io.err()).toMatch(/do not match/)
    const noTty = await run(['user', 'add', 'ada', '--role', 'admin', '--data-dir', dir])
    expect(noTty.code).toBe(2)
    expect(noTty.io.err()).toMatch(/--password-stdin/)
    expect((await run(['user', 'add', 'ada', '--data-dir', dir])).code).toBe(2)
    expect(
      (
        await run(['user', 'add', 'x y', '--role', 'admin', '--password-stdin', '--data-dir', dir], {
          stdin: PW,
        })
      ).code,
    ).toBe(2)
    expect(
      (
        await run(['user', 'add', 'ada', '--role', 'root', '--password-stdin', '--data-dir', dir], {
          stdin: PW,
        })
      ).code,
    ).toBe(2)
    expect((await run(['user', 'fly', '--data-dir', dir])).code).toBe(2)
  })

  it('resets a password and signs the user out everywhere', async () => {
    const dir = tempDir()
    await run(['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', dir], { stdin: PW })
    const before = await openData(resolveConfig({ cli: { dataDir: dir } }))
    const user = before.users.findByUsername('ada')!
    const { sessionId } = before.sessions.create(user.id, {})
    before.close()
    const next = 'yeni-parola-2026-mavi'
    const { code } = await run(['user', 'reset-password', 'ada', '--password-stdin', '--data-dir', dir], {
      stdin: next,
    })
    expect(code).toBe(0)
    const after = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(after.sessions.get(sessionId)).toBeUndefined()
      expect(await verifyPassword(next, after.users.findByUsername('ada')!.passwordHash)).toBe(true)
    } finally {
      after.close()
    }
    expect(
      (
        await run(['user', 'reset-password', 'nobody', '--password-stdin', '--data-dir', dir], {
          stdin: next,
        })
      ).code,
    ).toBe(1)
  })

  it('resets two-factor authentication and lists users', async () => {
    const dir = tempDir()
    await run(['user', 'add', 'ada', '--role', 'admin', '--password-stdin', '--data-dir', dir], { stdin: PW })
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }))
    const user = data.users.findByUsername('ada')!
    data.users.setTotp(user.id, data.box.seal('JBSWY3DPEHPK3PXP', `totp:${user.id}`), true)
    data.recoveryCodes.replace(user.id)
    data.close()
    expect((await run(['user', 'reset-2fa', 'ada', '--data-dir', dir])).code).toBe(0)
    const check = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(check.users.findByUsername('ada')!.totpEnabled).toBe(false)
      expect(check.recoveryCodes.remaining(user.id)).toBe(0)
    } finally {
      check.close()
    }
    const listed = await run(['user', 'list', '--data-dir', dir])
    expect(listed.io.out()).toMatch(/ada\s+admin\s+off\s+active/)
  })

  it('adds a user 2FA is required of (required 2FA), and lists it', async () => {
    const dir = tempDir()
    const { code, io } = await run(
      ['user', 'add', 'cem', '--role', 'viewer', '--require-2fa', '--password-stdin', '--data-dir', dir],
      { stdin: `${PW}\n` },
    )
    expect(code).toBe(0)
    expect(io.out()).toMatch(/must set up two-factor authentication/)
    await run(['user', 'add', 'deniz', '--role', 'viewer', '--password-stdin', '--data-dir', dir], {
      stdin: PW,
    })
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(data.users.findByUsername('cem')!.requireTwoFactor).toBe(true)
      expect(data.users.findByUsername('deniz')!.requireTwoFactor).toBe(false)
      const audit = data.store.db
        .prepare("SELECT details FROM audit_log WHERE action = 'users.create' ORDER BY id LIMIT 1")
        .get() as { details: string }
      expect(JSON.parse(audit.details)).toMatchObject({ target: 'cem', requireTwoFactor: true })
    } finally {
      data.close()
    }
    const listed = (await run(['user', 'list', '--data-dir', dir])).io.out()
    expect(listed).toMatch(/cem\s+viewer\s+off\s+active\s+2fa required/)
    expect(listed).not.toMatch(/deniz.*2fa required/)
    // Only "user add" takes it.
    expect((await run(['user', 'reset-2fa', 'cem', '--require-2fa', '--data-dir', dir])).code).toBe(2)
    // Required 2FA final review (minor 10): a reset does not take the requirement away, and says so.
    const reset = await run(['user', 'reset-2fa', 'cem', '--data-dir', dir])
    expect(reset.io.out()).toMatch(/still required of them: they must set it up again when they next sign in/)
    expect(reset.io.out()).not.toMatch(/can sign in with their password/)
    expect((await run(['user', 'reset-2fa', 'deniz', '--data-dir', dir])).io.out()).toMatch(
      /they can sign in with their password/,
    )
  })
})
