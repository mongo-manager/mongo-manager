// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ROLES, UsernameSchema, type AuditAction, type Role } from '@mongo-manager/shared'
import { hashPassword, passwordProblems, type Config } from '@mongo-manager/server'
import { UsageError, type Values } from '../args'
import { openData, type Data } from '../data'
import type { Io } from '../io'
import { readSecret, readStdinSecret } from '../prompt'

async function newPassword(io: Io, values: Values, username: string): Promise<string> {
  let password: string
  if (values['password-stdin']) {
    // On a terminal the typed password would be echoed; the hidden prompt is the way there.
    if (io.stdin.isTTY) {
      throw new UsageError(
        '--password-stdin reads from a pipe; on a terminal, leave it out to be asked without echo',
      )
    }
    password = await readStdinSecret(io)
  } else if (!io.stdin.isTTY)
    throw new UsageError('No terminal to read a password from: pipe it in with --password-stdin')
  else {
    password = await readSecret(io, `Password for ${username}: `)
    if ((await readSecret(io, 'Repeat password: ')) !== password)
      throw new Error('The passwords do not match')
  }
  const problems = passwordProblems(password, username)
  if (problems.length > 0) throw new Error(`Password ${problems.join('; ')}`)
  return password
}

function findUser(data: Data, username: string) {
  const user = data.users.findByUsername(username)
  if (!user) throw new Error(`No user named "${username}"`)
  return user
}

const audit = (data: Data, action: AuditAction, details: Record<string, unknown>) =>
  data.audit.append({
    action,
    outcome: 'success',
    userId: null,
    username: 'cli',
    ip: null,
    details: { ...details, via: 'cli' },
  })

export async function userCommand(
  positionals: string[],
  values: Values,
  config: Config,
  io: Io,
): Promise<number> {
  const [sub, username] = positionals
  if (sub === 'list') {
    if (username !== undefined) throw new UsageError(`Unexpected argument "${username}"`)
  } else if (sub === 'add' || sub === 'reset-password' || sub === 'reset-2fa') {
    if (!username) throw new UsageError(`"user ${sub}" needs a username`)
    const valid = UsernameSchema.safeParse(username)
    if (!valid.success) throw new UsageError(valid.error.issues[0]!.message)
  } else {
    throw new UsageError(`Unknown user command "${sub}" (use add, reset-password, reset-2fa or list)`)
  }
  if (sub === 'add') {
    if (!values.role) throw new UsageError('"user add" needs --role admin|editor|viewer')
    if (!(ROLES as readonly string[]).includes(values.role))
      throw new UsageError(`--role must be one of ${ROLES.join(', ')}`)
  } else if (values['require-2fa'] !== undefined) {
    throw new UsageError('--require-2fa is for "user add"')
  }
  // Read the password before opening the store, so a cancelled prompt changes nothing.
  const password = sub === 'add' || sub === 'reset-password' ? await newPassword(io, values, username!) : null

  const data = await openData(config, { create: sub === 'add', io })
  try {
    if (sub === 'list') {
      const rows = data.users.list()
      if (rows.length === 0) io.stdout.write('No users yet.\n')
      for (const u of rows) {
        io.stdout.write(
          `${u.username.padEnd(24)} ${u.role.padEnd(7)} ${u.totpEnabled ? 'on ' : 'off'} ${u.disabled ? 'disabled' : 'active'}${u.requireTwoFactor ? '  2fa required' : ''}\n`,
        )
      }
      return 0
    }
    if (sub === 'add') {
      const role = values.role as Role
      // Required 2FA (2026-10-28): the user must set it up before anything else.
      const requireTwoFactor = values['require-2fa'] === true
      data.users.create({
        username: username!,
        passwordHash: await hashPassword(password!),
        role,
        requireTwoFactor,
      })
      audit(data, 'users.create', { target: username, role, requireTwoFactor })
      io.stdout.write(`Created user "${username}" (${role}).\n`)
      if (requireTwoFactor)
        io.stdout.write('They must set up two-factor authentication when they first sign in.\n')
      if (!config.auth) io.stdout.write('Note: users sign in only in team mode (start with --auth).\n')
      return 0
    }
    const user = findUser(data, username!)
    if (sub === 'reset-password') {
      data.users.setPassword(user.id, await hashPassword(password!))
      data.sessions.revokeAllForUser(user.id)
      audit(data, 'users.password.reset', { target: user.username })
      io.stdout.write(`Password of "${user.username}" changed; all of their sessions were signed out.\n`)
      if (user.disabled)
        io.stdout.write('Note: this user is disabled; an admin can enable them in the Users screen.\n')
      return 0
    }
    data.users.setTotp(user.id, null, false)
    data.passkeys.deleteAllForUser(user.id)
    data.recoveryCodes.clear(user.id)
    data.sessions.revokeAllForUser(user.id)
    audit(data, 'users.2fa.reset', { target: user.username })
    // Required 2FA final review (minor 10): a reset takes no requirement away (the app's own policy
    // settings are not read here; the user's flag and the configuration are).
    const stillRequired =
      user.requireTwoFactor || config.requireAll2fa || (user.role === 'admin' && config.requireAdmin2fa)
    io.stdout.write(
      stillRequired
        ? `Two-factor authentication of "${user.username}" was removed; it is still required of them: they must set it up again when they next sign in.\n`
        : `Two-factor authentication of "${user.username}" was removed; they can sign in with their password.\n`,
    )
    return 0
  } finally {
    data.close()
  }
}
