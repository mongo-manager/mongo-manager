// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  ROLES,
  SessionPolicyBodySchema,
  SignInBanBlockSchema,
  SignInBanLiftSchema,
  AccessPreviewSchema,
  AccessSaveSchema,
  type AccessEntry,
  type AccessPolicy,
  UsernameSchema,
  type SignInBans,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { transaction } from '../store/db'
import { hashPassword } from '../auth/passwords'
import { toPublicUser, type UserRecord } from '../auth/users'
import { requirePermission, requireTeamMode, userPrincipal } from '../http/guards'
import { WRONG_PASSWORD, assertPasswordOk, checkPassword, requireStepUp } from './auth'
import { cancelTransfers } from './destinations'
import { hasTwoFactor, pendingUserIds, setTwoFactorPolicy, twoFactorPolicy } from '../auth/policy'
import { sessionPolicy, setSessionIdle } from '../auth/sessionPolicy'
import type { Principal } from '../http/context'
import { accessRange, ownRange, rangesAllowing } from '../auth/accessList'
import { safeEqual } from '../http/security'
import { BAN_FAILURES, BAN_STEPS_MS, BAN_WINDOW_MS, banAddress, banTarget, plainIp } from '../auth/bans'

const IdParams = z.object({ id: z.uuid() })
/** The administrator's own password, confirming a change that outlives the session (audit 2026-10-16). */
const CurrentPassword = z.string().max(1024).optional()
const CreateBody = z.object({
  username: UsernameSchema,
  password: z.string().max(1024),
  role: z.enum(ROLES),
  /** Required 2FA (2026-10-28): this user must set two-factor authentication up. */
  requireTwoFactor: z.boolean().optional(),
  currentPassword: CurrentPassword,
})
const UpdateBody = z
  .object({
    role: z.enum(ROLES).optional(),
    disabled: z.boolean().optional(),
    requireTwoFactor: z.boolean().optional(),
    currentPassword: CurrentPassword,
  })
  .refine(
    (b) => b.role !== undefined || b.disabled !== undefined || b.requireTwoFactor !== undefined,
    'Nothing to update',
  )
const ResetBody = z.object({ password: z.string().max(1024), currentPassword: CurrentPassword })
const ConfirmBody = z.object({ currentPassword: CurrentPassword })
const PolicyBody = z
  .strictObject({
    adminTwoFactor: z.boolean().optional(),
    everyoneTwoFactor: z.boolean().optional(),
    password: z.string().max(1024).optional(),
  })
  .refine((b) => b.adminTwoFactor !== undefined || b.everyoneTwoFactor !== undefined, 'Nothing to change')
const ActivityQuery = z.strictObject({ days: z.enum(['7', '30', '90']) })
const DAY = 86_400_000
/**
 * 4c review I3: a sign-in that let the user in — not a 2FA account's password step, which only
 * asks for the second factor (its own entry says so).
 */
const SIGNED_IN = `action LIKE 'auth.login%' AND outcome = 'success'
  AND (details IS NULL OR json_extract(details, '$.mfaRequired') IS NOT 1)`

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const guard = [requireTeamMode, requirePermission('users:manage')]

  const load = (id: string): UserRecord => {
    const record = ctx.users.findById(id)
    if (!record) throw Errors.notFound('User not found')
    return record
  }
  /**
   * Security audit 2026-10-16 (important 1): a stolen session alone must not hand out a lasting way
   * in — a new administrator, a promotion, another account's password or second factors. The caller
   * confirms with their own password (throttled per account), and with a second factor proved lately
   * when they have one.
   */
  const confirmCaller = async (request: FastifyRequest, currentPassword: string | undefined) => {
    const record = ctx.users.findById(userPrincipal(request).userId)
    if (!record) throw Errors.unauthenticated()
    // Review of the audit fixes (minor 3): the second factor first — without it the password is not
    // checked at all, so these routes are no way to guess it.
    requireStepUp(request, record)
    if (!currentPassword || !(await checkPassword(ctx, record, currentPassword)))
      throw Errors.validation('Enter your own password to confirm this change', WRONG_PASSWORD)
  }
  const losesAdmin = (target: UserRecord, change: { role?: string; disabled?: boolean }) =>
    target.role === 'admin' &&
    !target.disabled &&
    ((change.role !== undefined && change.role !== 'admin') || change.disabled === true)

  // Phase 4c §5: 2FA is an authenticator app or a passkey.
  app.get('/users', { preHandler: guard }, async () =>
    ctx.users.list().map((u) => ({ ...u, twoFactor: hasTwoFactor(ctx, u.id) })),
  )

  // Phase 4c §4: administrators must have 2FA — turned on only by one who has it (no lock-out).
  // Required 2FA (2026-10-28): everyone must, likewise; a field left out stays as it is.
  app.get('/users/policy', { preHandler: guard }, async () => twoFactorPolicy(ctx))
  app.put('/users/policy', { preHandler: guard, config: { audit: 'users.policy' } }, async (request) => {
    const body = parseInput(PolicyBody, request.body)
    request.auditInfo = {
      details: { adminTwoFactor: body.adminTwoFactor, everyoneTwoFactor: body.everyoneTwoFactor },
    }
    const now = twoFactorPolicy(ctx)
    if (
      (now.forced && body.adminTwoFactor === false) ||
      (now.everyoneForced && body.everyoneTwoFactor === false)
    )
      throw Errors.conflict('Required by the server configuration', { reason: 'forced_by_config' })
    const principal = request.principal!
    const weakens =
      (now.adminTwoFactor && body.adminTwoFactor === false) ||
      (now.everyoneTwoFactor && body.everyoneTwoFactor === false)
    // 4c review I4: turning a requirement off asks the administrator's password.
    if (weakens && principal.kind === 'user') {
      const record = ctx.users.findById(principal.userId)
      if (!record) throw Errors.unauthenticated()
      // Security audit 2026-10-16: and a second factor proved lately, as for any weakening of 2FA —
      // asked first (required 2FA final review, minor 1), so a session alone cannot test passwords.
      requireStepUp(request, record)
      if (!body.password || !(await checkPassword(ctx, record, body.password)))
        throw Errors.validation('Enter your password to turn this off', { reason: 'wrong_password' })
    }
    if (
      (body.adminTwoFactor || body.everyoneTwoFactor) &&
      principal.kind === 'user' &&
      !hasTwoFactor(ctx, principal.userId)
    )
      throw Errors.conflict('Set up two-factor authentication for yourself first', {
        reason: 'two_factor_needed_first',
      })
    const before = new Set(pendingUserIds(ctx))
    setTwoFactorPolicy(ctx, body)
    ctx.access.changed()
    // Required 2FA final review (minor 2): who must now set 2FA up keeps no shell running either.
    for (const id of pendingUserIds(ctx))
      if (!before.has(id)) await ctx.shell.closeFor({ userId: id }, 'access')
    return twoFactorPolicy(ctx)
  })

  // Session lifetime (2026-10-29): how long a session lasts without a request. A longer time keeps a
  // forgotten or stolen session alive longer: it asks, as turning a 2FA rule off does, for a second
  // factor used lately (first, so the route is no way to test passwords) and the password.
  app.get('/users/session-policy', { preHandler: guard }, async () => sessionPolicy(ctx))
  app.put(
    '/users/session-policy',
    { preHandler: guard, config: { audit: 'users.sessionPolicy' } },
    async (request) => {
      const body = parseInput(SessionPolicyBodySchema, request.body)
      const audit = (from: number) =>
        (request.auditInfo = { details: { idleMinutes: body.idleMinutes, from } })
      audit(sessionPolicy(ctx).idleMinutes)
      const principal = request.principal!
      let confirmed = false
      const confirm = async () => {
        if (confirmed || principal.kind !== 'user') return
        const record = ctx.users.findById(principal.userId)
        if (!record) throw Errors.unauthenticated()
        requireStepUp(request, record)
        if (!body.password || !(await checkPassword(ctx, record, body.password)))
          throw Errors.validation('Enter your password to keep sessions longer', { reason: 'wrong_password' })
        confirmed = true
      }
      if (body.idleMinutes > sessionPolicy(ctx).idleMinutes) await confirm()
      // Review (minor 5): another administrator may have changed it during the password check — what
      // is in force now decides, and is the one recorded.
      const from = sessionPolicy(ctx).idleMinutes
      if (body.idleMinutes > from) await confirm()
      audit(from)
      setSessionIdle(ctx, body.idleMinutes)
      return sessionPolicy(ctx)
    },
  )

  // Sign-in bans (2026-10-30): the addresses refused at the sign-in. Blocking one tightens the
  // sign-in and asks nothing more; lifting a ban lets the address guess again, so it asks for the
  // administrator's password and a second factor used lately, as a longer session does.
  const bans = (): SignInBans => ({
    ...ctx.bans.list(),
    rule: {
      failures: BAN_FAILURES,
      windowMinutes: BAN_WINDOW_MS / 60_000,
      stepsMinutes: BAN_STEPS_MS.map((ms) => ms / 60_000),
    },
  })
  app.get('/users/bans', { preHandler: guard }, async () => bans())
  app.post('/users/bans', { preHandler: guard, config: { audit: 'users.bans.block' } }, async (request) => {
    const body = parseInput(SignInBanBlockSchema, request.body)
    const ip = plainIp(body.address)
    if (!ip) throw Errors.validation('Enter an IPv4 or IPv6 address', { reason: 'ban_not_an_address' })
    const exempt = ctx.bans.exemption(ip)
    if (exempt === 'loopback')
      throw Errors.validation('This machine’s own address is never banned', { reason: 'ban_loopback' })
    // Review of the bans (I2): with no proxy trusted, a private address may be everyone's.
    if (exempt === 'private')
      throw Errors.validation('A private address is never banned while no proxy is trusted', {
        reason: 'ban_private',
      })
    if (banAddress(ip) === banAddress(request.ip))
      throw Errors.validation('This is the address you are signed in from', { reason: 'ban_own_address' })
    const ban = ctx.bans.block(ip, body.hours * 3_600_000, userPrincipal(request).username)
    request.auditInfo = { details: { address: ban.address, hours: body.hours } }
    return bans()
  })
  app.post(
    '/users/bans/lift',
    { preHandler: guard, config: { audit: 'users.bans.lift' } },
    async (request) => {
      const body = parseInput(SignInBanLiftSchema, request.body)
      const address = banTarget(body.address)
      if (!address) throw Errors.validation('Enter an IPv4 or IPv6 address', { reason: 'ban_not_an_address' })
      request.auditInfo = { details: { address } }
      await confirmCaller(request, body.password)
      const outcome = ctx.bans.lift(address)
      // The address starts afresh: the throttle forgets its guesses too.
      ctx.throttle.reset(`ip:${address}`)
      request.auditInfo = { details: { address, lifted: outcome === 'lifted', outcome } }
      return bans()
    },
  )

  // Panel access (2026-10-30): the addresses the panel answers, and who is signed in from where. A
  // change asks for the administrator's password and a recent second factor (it can shut the team
  // out, or let the world back in); a list without their own address, also their word that they
  // mean it. Saving ends every session from an address outside the list.
  const readEntries = (entries: AccessEntry[]) => {
    const kept: AccessEntry[] = []
    const invalid: number[] = []
    entries.forEach((e, i) => {
      const range = accessRange(e.range)
      if (!range) invalid.push(i)
      else if (!kept.some((k) => k.range === range)) kept.push({ range, label: e.label })
    })
    return { kept, invalid }
  }
  const accessView = (request: FastifyRequest, entries: AccessEntry[]): AccessPolicy => {
    const allow = rangesAllowing(entries.map((e) => e.range))
    const own = userPrincipal(request).sessionIdHash
    const forwarded =
      request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined
    return {
      entries,
      yourAddress: request.ip,
      yourRange: ownRange(request.ip) ?? request.ip,
      youAllowed: allow(request.ip),
      untrustedProxy: ctx.config.trustedProxies.length === 0 && forwarded,
      sessions: ctx.sessions.listActive().map((s) => ({
        username: s.username,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: safeEqual(s.idHash, own),
        allowed: allow(s.ip),
      })),
    }
  }
  app.get('/users/access', { preHandler: guard }, async (request) =>
    accessView(request, ctx.accessList.current()),
  )
  app.post('/users/access/preview', { preHandler: guard }, async (request) => {
    const body = parseInput(AccessPreviewSchema, request.body)
    const { kept, invalid } = readEntries(body.entries)
    return { ...accessView(request, kept), invalid }
  })
  app.put('/users/access', { preHandler: guard, config: { audit: 'users.access' } }, async (request) => {
    const body = parseInput(AccessSaveSchema, request.body)
    const { kept, invalid } = readEntries(body.entries)
    if (invalid.length > 0)
      throw Errors.validation('Enter IPv4 or IPv6 addresses or ranges such as 203.0.113.0/24', {
        reason: 'access_invalid',
        invalid,
      })
    request.auditInfo = { details: { ranges: kept.map((e) => e.range) } }
    await confirmCaller(request, body.password)
    const allow = rangesAllowing(kept.map((e) => e.range))
    const lockedOut = !allow(request.ip)
    if (lockedOut && body.lockMeOut !== true)
      throw Errors.validation('The list leaves out the address you are on', {
        reason: 'access_excludes_you',
        address: request.ip,
      })
    ctx.accessList.set(kept)
    // Review of panel access (minor 3): open sockets are judged by their own address too.
    ctx.access.changed()
    let signedOut = 0
    for (const s of ctx.sessions.listActive()) {
      if (allow(s.ip)) continue
      ctx.sessions.revokeHash(s.idHash)
      signedOut += 1
    }
    request.auditInfo = { details: { ranges: kept.map((e) => e.range), signedOut, lockedOut } }
    return accessView(request, ctx.accessList.current())
  })

  // Phase 4c §3: each user's sign-ins, failures, actions and last activity, from the audit log.
  app.get('/users/activity', { preHandler: guard }, async (request) => {
    const { days } = parseInput(ActivityQuery, request.query)
    const since = ctx.now() - Number(days) * DAY
    const rows = ctx.store.db
      .prepare(
        `SELECT user_id,
           MAX(CASE WHEN ${SIGNED_IN} THEN at END) AS last_sign_in,
           SUM(CASE WHEN ${SIGNED_IN} THEN 1 ELSE 0 END) AS sign_ins,
           SUM(CASE WHEN action LIKE 'auth.login%' AND outcome <> 'success' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN action NOT LIKE 'auth.%' THEN 1 ELSE 0 END) AS actions,
           SUM(CASE WHEN action NOT LIKE 'auth.%' AND outcome = 'denied' THEN 1 ELSE 0 END) AS denied,
           MAX(at) AS last_at
         FROM audit_log WHERE at >= ? AND user_id IS NOT NULL GROUP BY user_id`,
      )
      .all(since) as Array<{
      user_id: string
      last_sign_in: number | null
      sign_ins: number
      failed: number
      actions: number
      denied: number
      last_at: number
    }>
    const groups = ctx.store.db
      .prepare(
        `SELECT user_id, substr(action, 1, instr(action || '.', '.') - 1) AS grp, COUNT(*) AS n
         FROM audit_log WHERE at >= ? AND user_id IS NOT NULL AND action NOT LIKE 'auth.%'
         GROUP BY user_id, grp ORDER BY n DESC, grp`,
      )
      .all(since) as Array<{ user_id: string; grp: string; n: number }>
    // 4c review I3: a failed password has no actor (the audit's user is who acted, and no one signed
    // in): it is the account's by the name tried, which is unique whatever its case.
    const guessed = new Map(
      (
        ctx.store.db
          .prepare(
            `SELECT lower(username) AS name, COUNT(*) AS n FROM audit_log
             WHERE at >= ? AND user_id IS NULL AND username IS NOT NULL
               AND action LIKE 'auth.login%' AND outcome <> 'success'
             GROUP BY lower(username)`,
          )
          .all(since) as Array<{ name: string; n: number }>
      ).map((g) => [g.name, g.n]),
    )
    const byUser = new Map(rows.map((r) => [r.user_id, r]))
    return ctx.users.list().map((u) => {
      const r = byUser.get(u.id)
      return {
        userId: u.id,
        username: u.username,
        role: u.role,
        disabled: u.disabled,
        lastSignInAt: r?.last_sign_in ?? null,
        signIns: r?.sign_ins ?? 0,
        failedSignIns: (r?.failed ?? 0) + (guessed.get(u.username.toLowerCase()) ?? 0),
        actions: r?.actions ?? 0,
        denied: r?.denied ?? 0,
        lastActivityAt: r?.last_at ?? null,
        groups: groups
          .filter((g) => g.user_id === u.id)
          .slice(0, 5)
          .map((g) => ({ group: g.grp, count: g.n })),
      }
    })
  })

  app.post('/users', { preHandler: guard, config: { audit: 'users.create' } }, async (request) => {
    const body = parseInput(CreateBody, request.body)
    const requireTwoFactor = body.requireTwoFactor ?? false
    request.auditInfo = { details: { target: body.username, role: body.role, requireTwoFactor } }
    await confirmCaller(request, body.currentPassword)
    assertPasswordOk(body.password, body.username)
    return ctx.users.create({
      username: body.username,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      requireTwoFactor,
    })
  })

  app.patch('/users/:id', { preHandler: guard, config: { audit: 'users.update' } }, async (request) => {
    const { id } = parseInput(IdParams, request.params)
    const body = parseInput(UpdateBody, request.body)
    request.auditInfo = {
      details: {
        change: { role: body.role, disabled: body.disabled, requireTwoFactor: body.requireTwoFactor },
      },
    }
    const self = userPrincipal(request)
    // A role change can make an administrator, and enabling an account is a way in again (review of
    // the audit fixes, important 3); disabling one takes a way in away. Required 2FA: no longer
    // requiring it weakens the account's sign-in, requiring it does not.
    if (body.role !== undefined || body.disabled === false || body.requireTwoFactor === false)
      await confirmCaller(request, body.currentPassword)
    // As for the policy: no one requires 2FA of themselves without having it (no lock-out).
    if (body.requireTwoFactor && id === self.userId && !hasTwoFactor(ctx, id))
      throw Errors.conflict('Set up two-factor authentication for yourself first', {
        reason: 'two_factor_needed_first',
      })
    let roleChanged = false
    let accessChanged = false
    const pendingBefore = new Set(pendingUserIds(ctx))
    const updated = transaction(ctx.store.db, () => {
      const target = load(id)
      roleChanged = body.role !== undefined && body.role !== target.role
      if (target.id === self.userId && losesAdmin(target, body))
        throw Errors.conflict('You cannot demote or disable yourself', { reason: 'self_demote' })
      if (losesAdmin(target, body) && ctx.users.countActiveAdmins() <= 1) {
        throw Errors.conflict('At least one active admin is required', { reason: 'last_admin' })
      }
      if (body.role !== undefined) {
        ctx.users.setRole(id, body.role)
        // 4c review I1: made an administrator who must set 2FA up — their open sockets go now.
        accessChanged = true
      }
      if (body.requireTwoFactor !== undefined) {
        ctx.users.setRequireTwoFactor(id, body.requireTwoFactor)
        // Required of a user who has the app open without 2FA: their sockets go now.
        accessChanged = true
      }
      if (body.disabled !== undefined) {
        ctx.users.setDisabled(id, body.disabled)
        if (body.disabled) {
          ctx.sessions.revokeAllForUser(id)
          // Phase 3d-1 §8.3: a disabled user's transfer files and reports go at once.
          ctx.transfer.files.deleteAllFor(id)
          ctx.transfer.reports.deleteAllFor(id)
          ctx.backup.store.deleteAllFor(id)
          // Phase 3d-3c D5: a disabled owner's schedules pause at once (their runs would anyway).
          ctx.backup.schedules.pauseAllFor(id, 'owner_disabled')
        }
      }
      return toPublicUser(load(id))
    })
    // Required 2FA final review (minor 6): told once, and only once the change is stored.
    if (accessChanged) ctx.access.changed()
    // Minor 2: a user who must now set 2FA up keeps no shell running either.
    const nowPending =
      !body.disabled && !roleChanged && !pendingBefore.has(id) && pendingUserIds(ctx).includes(id)
    if (nowPending) await ctx.shell.closeFor({ userId: id }, 'access')
    // A shell keeps the rules it opened with and may be held open for good, so it goes now (review
    // 2026-10-12, M8: it lived on, unbounded once the idle limit was off by default).
    if (body.disabled || roleChanged) await ctx.shell.closeFor({ userId: id }, 'access')
    // Phase 3d-3b final review B21 (the D10 analogue): a disabled account's sends and fetches stop,
    // and a changed role stops those to destinations the account may no longer use.
    if (body.disabled) await cancelTransfers(ctx, (t) => t.userId === id)
    else if (body.role !== undefined) {
      const now = { kind: 'user', userId: id, role: updated.role } as Principal
      await cancelTransfers(
        ctx,
        (t) => t.userId === id && t.destinationIds.some((d) => !ctx.backup.destinations.levelOf(d, now)),
      )
    }
    return updated
  })

  app.post(
    '/users/:id/password',
    { preHandler: guard, config: { audit: 'users.password.reset' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(ResetBody, request.body)
      if (id === userPrincipal(request).userId) {
        throw Errors.conflict(
          'Use "change password" for your own account; it asks for your current password',
          {
            reason: 'self_password',
          },
        )
      }
      const target = load(id)
      await confirmCaller(request, body.currentPassword)
      assertPasswordOk(body.password, target.username)
      ctx.users.setPassword(id, await hashPassword(body.password))
      ctx.sessions.revokeAllForUser(id)
      // Security audit 2026-10-16: and a command still running in one of their shells ends now.
      await ctx.shell.closeFor({ userId: id }, 'access')
      return reply.status(204).send()
    },
  )

  app.post(
    '/users/:id/reset-2fa',
    { preHandler: guard, config: { audit: 'users.2fa.reset' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      // Review of L2: an administrator's own second factors are managed in Account settings, which
      // asks for one of them — a session and a password never take them away here.
      if (id === userPrincipal(request).userId)
        throw Errors.conflict('Manage your own two-factor settings in Account settings', {
          reason: 'self_2fa_reset',
        })
      load(id)
      await confirmCaller(request, parseInput(ConfirmBody, request.body ?? {}).currentPassword)
      transaction(ctx.store.db, () => {
        ctx.users.setTotp(id, null, false)
        ctx.passkeys.deleteAllForUser(id)
        ctx.recoveryCodes.clear(id)
        ctx.sessions.revokeAllForUser(id)
      })
      // Security audit 2026-10-16: their shells end with their sessions.
      await ctx.shell.closeFor({ userId: id }, 'access')
      return reply.status(204).send()
    },
  )

  app.delete(
    '/users/:id',
    { preHandler: guard, config: { audit: 'users.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const self = userPrincipal(request)
      transaction(ctx.store.db, () => {
        const target = load(id)
        if (target.id === self.userId)
          throw Errors.conflict('You cannot delete yourself', { reason: 'self_delete' })
        if (losesAdmin(target, { disabled: true }) && ctx.users.countActiveAdmins() <= 1) {
          throw Errors.conflict('At least one active admin is required', { reason: 'last_admin' })
        }
        // Security audit 2026-10-16: the cascade below ends the sessions without a word; revoked
        // first, their sockets close at once.
        ctx.sessions.revokeAllForUser(id)
        ctx.users.delete(id)
        // Phase 4a-2: chats kept in memory go with the user too (stored ones by cascade).
        ctx.ai.chats.removeAll(id)
        // User review 2026-10-09: and what they arranged for themselves (no cascade: see the table).
        ctx.preferences.removeAll(id)
      })
      // W7: their OIDC sign-ins on every connection (the tokens are theirs alone), revoked at the
      // provider (security review Minor 3) — once the deletion committed (re-review item 5).
      await ctx.oidc.forgetUser(id)
      for (const c of ctx.connections.list()) await ctx.manager.invalidateUser(c.id, id)
      // The user is gone; close any shell session they still hold (spec §6).
      await ctx.shell.closeFor({ userId: id }, 'access')
      // Phase 3d-3b final review B21: and stop their sends and fetches.
      await cancelTransfers(ctx, (t) => t.userId === id)
      // Phase 3d-1 §8.3: and their transfer files, reports and saved settings.
      ctx.transfer.files.deleteAllFor(id)
      ctx.transfer.reports.deleteAllFor(id)
      ctx.transfer.presets.deleteAllFor(id)
      ctx.backup.store.deleteAllFor(id)
      // Phase 3d-3c spec §3.1: the user's schedules (their runs go with them), then their keys.
      ctx.backup.schedules.deleteAllFor(id)
      ctx.backup.keys.deleteAllFor(id)
      // Phase 3e-2 final review m15: their live syncs stop and go (the targets keep their data).
      await ctx.liveSync.ownerDeleted(id)
      return reply.status(204).send()
    },
  )
}
