import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { UsernameSchema, permissionsFor, type AuditAction } from '@mongo-manager/shared'
import { Errors, type AppError } from '../errors'
import { keepsLastFactor, lastFactorRefusal, twoFactorPendingReason } from '../auth/policy'
import { parseInput } from '../validate'
import { transaction } from '../store/db'
import {
  dummyHash,
  hashPassword,
  passwordProblemCodes,
  passwordProblemTexts,
  verifyPassword,
} from '../auth/passwords'
import { ticketMatches } from '../auth/mfa'
import { safeEqual } from '../http/security'
import { generateTotpSecret, totpUri, verifyTotp } from '../auth/totp'
import { toPublicUser, type User, type UserRecord } from '../auth/users'
import {
  clearLocalCookie,
  clearSessionCookie,
  readLocalCookie,
  readSessionId,
  setLocalCookie,
  setSessionCookie,
} from '../http/principal'
import { requireAuth, requireTeamMode, userPrincipal } from '../http/guards'
import type { Principal, ServerContext } from '../http/context'
import { ipThrottleKey } from '../auth/throttle'
import { hashSessionId } from '../auth/sessions'

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) })
const SetupBody = z.object({
  token: z.string().min(1).max(200),
  username: UsernameSchema,
  password: z.string().max(1024),
})
const TicketCodeBody = z.object({ ticket: z.string().min(1).max(100), code: z.string().min(1).max(32) })
const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().max(1024),
})
const CodeBody = z.object({ code: z.string().max(16) })
const PasswordOnlyBody = z.object({ password: z.string().min(1).max(1024) })
const DisableTotpBody = z.object({ password: z.string().min(1).max(1024), code: z.string().max(16) })
/** A download link's path, as the browser will ask for it (review of the audit fixes, important 1). */
const LinkBody = z.strictObject({ path: z.string().min(2).max(2048).startsWith('/') })

export type SecondFactor = 'totp' | 'passkey'

export const totpContext = (userId: string) => `totp:${userId}`

export function secondFactors(ctx: ServerContext, record: UserRecord): SecondFactor[] {
  const factors: SecondFactor[] = []
  if (record.totpEnabled) factors.push('totp')
  if (ctx.passkeys.countForUser(record.id) > 0) factors.push('passkey')
  return factors
}

/** Called after a factor is removed: without any factor, recovery codes are meaningless. */
export function dropRecoveryCodesIfNoFactor(ctx: ServerContext, userId: string): void {
  const record = ctx.users.findById(userId)
  if (record && secondFactors(ctx, record).length === 0) ctx.recoveryCodes.clear(userId)
}

/** Refusal details for a wrong password (the client explains it in the user's language). */
export const WRONG_PASSWORD = { reason: 'wrong_password' } as const

export function assertPasswordOk(password: string, username: string): void {
  const codes = passwordProblemCodes(password, username)
  if (codes.length > 0) {
    throw Errors.validation(`Password ${passwordProblemTexts(codes).join('; ')}`, {
      reason: 'weak_password',
      problems: codes,
    })
  }
}

export function throttleCheck(ctx: ServerContext, keys: string[]): void {
  const wait = Math.max(...keys.map((k) => ctx.throttle.retryAfterMs(k)))
  if (wait > 0) throw Errors.rateLimited(wait)
}

/** Counts a failure on every key; returns each key's lock before it, for forgiving. */
export function recordFailure(ctx: ServerContext, keys: string[]): number[] {
  return keys.map((k) => ctx.throttle.recordFailure(k))
}

/**
 * Counts the attempt before any await, so parallel requests cannot all pass the lockout check;
 * a correct answer is forgiven afterwards.
 */
async function guardedAttempt(
  ctx: ServerContext,
  keys: string[],
  attempt: () => boolean | Promise<boolean>,
  /** A sign-in step: its refusals and failures count toward banning its address. */
  signIn?: FastifyRequest,
): Promise<boolean> {
  try {
    throttleCheck(ctx, keys)
  } catch (e) {
    // Review of the bans (minor 2): an account held back by guesses from elsewhere is no fault of
    // this address — only a hold on the address itself counts toward banning it.
    if (signIn && keys.some((k) => !k.startsWith('account:') && ctx.throttle.retryAfterMs(k) > 0))
      noteSignInFailure(signIn)
    throw e
  }
  const before = recordFailure(ctx, keys)
  const ok = await attempt()
  if (ok) keys.forEach((k, i) => ctx.throttle.forgive(k, before[i]))
  else if (signIn) noteSignInFailure(signIn)
  return ok
}

/** Sign-in bans (2026-10-30): sign-in steps share one budget per address and minute. */
export const SIGN_IN_RATE_LIMIT = 30

/**
 * Counts a failed or refused sign-in toward banning its address; a ban it starts is written to the
 * audit log, once.
 */
export function noteSignInFailure(request: FastifyRequest): void {
  const { ctx } = request.server
  const ban = ctx.bans.note(request.ip)
  if (!ban) return
  request.log.warn({ address: ban.address, strikes: ban.strikes, until: ban.until }, 'sign-in ban')
  ctx.audit.append({
    action: 'auth.ban',
    outcome: 'denied',
    userId: null,
    username: null,
    ip: request.ip,
    details: {
      address: ban.address,
      strikes: ban.strikes,
      minutes: Math.round((ban.until - ban.bannedAt) / 60_000),
    },
  })
}

/**
 * A banned address is refused at the sign-in at once, before any password is checked — except for
 * an account that signed in from it lately, which its own throttle still holds back (one person's
 * guesses never lock their colleagues behind the same address out).
 */
function assertNotBanned(ctx: ServerContext, request: FastifyRequest, account?: string): void {
  const ban = ctx.bans.current(request.ip)
  if (!ban) return
  // Review of the bans (I1): an administrator's block holds for everyone — an account signed in
  // from there lately may be the very one it was blocked for.
  if (ban.reason === 'sign_in' && account !== undefined && knownHere(ctx, request, account)) return
  throw banned(ctx, ban.until)
}

const knownHere = (ctx: ServerContext, request: FastifyRequest, account: string) =>
  ctx.knownSignIns.has(account.toLowerCase(), ipThrottleKey(request.ip))

const banned = (ctx: ServerContext, until: number) =>
  Errors.rateLimited(Math.max(1, until - ctx.now()), 'address_banned')

/**
 * Review of the bans (I4): a sign-in refused as busy counts toward banning its address, and the
 * refusals are written to the audit log as one row a minute while they go on.
 */
function busyRefused(request: FastifyRequest): void {
  const { ctx } = request.server
  noteSignInFailure(request)
  const refused = ctx.passwordWork.refused(ctx.now())
  if (refused === null) return
  request.log.warn({ refused }, 'sign-ins refused as busy')
  ctx.audit.append({
    action: 'auth.busy',
    outcome: 'denied',
    userId: null,
    username: null,
    ip: request.ip,
    details: { refused },
  })
}

/** The route options of a sign-in step: its attempts share the address's budget (http/app.ts). */
export const signInRoute = (audit?: AuditAction) => ({
  csrf: false as const,
  ...(audit ? { audit } : {}),
  signIn: true as const,
})

/**
 * The sign-in steps share one budget per address and minute; past it a step is refused at once, and
 * the refusal counts toward a ban. A banned address spends none: its step is told its ban.
 */
export function signInBudget(request: FastifyRequest): void {
  const { ctx } = request.server
  // Never banned, never budgeted: this machine, or a proxy nobody named (the password checks' queue
  // still bounds what they cost).
  if (ctx.bans.exemption(request.ip)) return
  const ban = ctx.bans.current(request.ip)
  // Review of the bans (I3): an administrator's block is refused before the body is even read; a ban
  // by failures waits for the account (one signed in from there lately still may) — within budget.
  if (ban?.reason === 'manual') throw banned(ctx, ban.until)
  const wait = ctx.signInBudget.spend(request.ip)
  if (wait === 0) return
  if (ban) throw banned(ctx, ban.until)
  noteSignInFailure(request)
  throw Errors.rateLimited(wait)
}

/**
 * Password re-check for an already signed-in user (sensitive actions); throttled per account, apart
 * from sign-in, so guesses at the sign-in never lock a signed-in user's re-checks (review L1).
 */
export function checkPassword(ctx: ServerContext, record: UserRecord, password: string): Promise<boolean> {
  return guardedAttempt(ctx, [`recheck:${record.id}`], () =>
    ctx.passwordWork.run(() => verifyPassword(password, record.passwordHash)),
  )
}

/**
 * Security review 2026-10-13 (L1): what a sign-in guess counts against — the account at this
 * address, the address, and the account across addresses unless it signed in from here lately.
 */
function signInKeys(
  ctx: ServerContext,
  username: string,
  ip: string,
): { keys: string[]; factorKeys: string[]; done: () => void } {
  const account = username.toLowerCase()
  const at = ipThrottleKey(ip)
  const here = `user:${account}|${at}`
  const across = `account:${account}`
  return {
    keys: [here, at, ...(ctx.knownSignIns.has(account, at) ? [] : [across])],
    // The second step is bounded by its ticket (a few tries); guesses at the password elsewhere never
    // hold it back (review of L1).
    factorKeys: [here, at],
    done: () => {
      ctx.throttle.reset(here)
      ctx.throttle.reset(across)
      ctx.knownSignIns.add(account, at)
    },
  }
}

/** Always issues a brand-new session id (session fixation defence) and returns its CSRF token. */
export function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  /** The sign-in proved a second factor (security review L2). */
  steppedUp = false,
): string {
  const { ctx } = request.server
  const existing = readSessionId(request)
  if (existing) ctx.sessions.revoke(existing)
  const { sessionId, session } = ctx.sessions.create(userId, {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 256),
  })
  // Review of the security pass 2026-10-16 (I5): the same user's session renewed in this browser —
  // its plugin frames' tickets follow it (another user's sign-in takes nothing over).
  const previous = request.principal
  if (previous?.kind === 'user' && previous.userId === userId)
    ctx.sessions.renewed(previous.sessionIdHash, session.idHash)
  if (steppedUp) ctx.stepUps.mark(hashSessionId(sessionId))
  setSessionCookie(request, reply, sessionId)
  return session.csrfToken
}

/**
 * Security review 2026-10-13 (L2): managing second factors takes one proved in this session within
 * the last ten minutes, when the account has any — someone holding a session and the password must
 * not give themselves a lasting way past two-factor sign-in.
 */
export function requireStepUp(request: FastifyRequest, record: UserRecord): void {
  const { ctx } = request.server
  const factors = secondFactors(ctx, record)
  if (!factors.length) return
  if (ctx.stepUps.fresh(userPrincipal(request).sessionIdHash)) return
  throw Errors.forbidden('Confirm one of your second factors first', {
    reason: 'step_up_required',
    methods: [...factors, 'recovery'],
  })
}

/** A second-factor check for a signed-in user, throttled per account (L2). */
export function factorAttempt(
  ctx: ServerContext,
  userId: string,
  attempt: () => boolean | Promise<boolean>,
): Promise<boolean> {
  return guardedAttempt(ctx, [`factor:${userId}`], attempt)
}

/** The session proved a second factor now (L2). */
export function markStepUp(request: FastifyRequest): void {
  request.server.ctx.stepUps.mark(userPrincipal(request).sessionIdHash)
}

/**
 * Second login step shared by TOTP, recovery codes and passkeys (Task 9): validates the ticket,
 * throttles, runs the factor check and issues the session only on success.
 */
/**
 * The user a sign-in ticket still stands for: the ticket is live, the user is not disabled, and the
 * password is the one the first step checked (a reset, or the user's own change, ends it). Null
 * otherwise.
 */
export function ticketUser(ctx: ServerContext, ticketId: string): UserRecord | null {
  const ticket = ctx.tickets.peek(ticketId)
  const record = ticket && ctx.users.findById(ticket.userId)
  return ticket && record && !record.disabled && ticketMatches(ticket, record.passwordHash) ? record : null
}

/** Ends a ticket that no longer stands, with the error the client tells expiry by. */
export function ticketExpired(ctx: ServerContext, ticketId: string): AppError {
  ctx.tickets.consume(ticketId)
  return Errors.unauthenticated('Sign-in session expired; enter your password again', {
    reason: 'mfa_ticket_expired',
  })
}

export async function completeSecondFactor(
  request: FastifyRequest,
  reply: FastifyReply,
  ticketId: string,
  verify: (record: UserRecord) => boolean | Promise<boolean>,
): Promise<{ user: User; csrfToken: string }> {
  const { ctx } = request.server
  const record = ticketUser(ctx, ticketId)
  if (!record) throw ticketExpired(ctx, ticketId)
  request.auditInfo = { userId: record.id, username: record.username }
  // Review of the bans (minor 3): a ticket from before a ban does not outlive it there.
  assertNotBanned(ctx, request, record.username)
  const { factorKeys, done } = signInKeys(ctx, record.username, request.ip)
  if (!(await guardedAttempt(ctx, factorKeys, () => verify(record), request))) {
    ctx.tickets.fail(ticketId)
    throw Errors.unauthenticated('Invalid two-factor code')
  }
  // Checked again: a factor's check may wait (a passkey), and the password may change meanwhile
  // (review of the deferred fixes, M7).
  if (!ticketUser(ctx, ticketId)) throw ticketExpired(ctx, ticketId)
  ctx.tickets.consume(ticketId)
  done()
  return { user: toPublicUser(record), csrfToken: startSession(request, reply, record.id, true) }
}

function openTotpSecret(ctx: ServerContext, record: UserRecord): string {
  if (!record.totpSecretSealed) throw new Error(`User ${record.id} has no TOTP secret`)
  return ctx.secretBox.open(record.totpSecretSealed, totpContext(record.id))
}

function currentUser(request: FastifyRequest): UserRecord {
  const record = request.server.ctx.users.findById(userPrincipal(request).userId)
  if (!record) throw Errors.unauthenticated()
  return record
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const team = [requireTeamMode, requireAuth]

  app.get('/auth/status', async (request, reply) => {
    // Security audit 2026-10-16: local mode's cookie is renewed whenever the app starts in a browser.
    const cookie = readLocalCookie(request)
    if (request.principal?.kind === 'local' && cookie) setLocalCookie(request, reply, cookie)
    return {
      mode: ctx.config.auth ? 'team' : 'local',
      setupRequired: ctx.config.auth && ctx.users.count() === 0,
      authenticated: request.principal !== null,
    }
  })

  // Review of the audit fixes (important 1): local mode's browsers (auth/launch). The gate (http/app)
  // lets the claim through on the cookie alone and everything else only with the page key.
  const localOnly = async (request: FastifyRequest) => {
    if (ctx.config.auth || !ctx.launch) throw Errors.notFound('Route not found')
    if (request.principal?.kind !== 'local' || !request.principal.browser) throw Errors.unauthenticated()
  }
  const browserOf = (request: FastifyRequest) =>
    (request.principal as Extract<Principal, { kind: 'local' }>).browser!

  /** The page claims its key once, right after its link; it keeps it in its own origin's storage. */
  app.post(
    '/auth/local/claim',
    { config: { csrf: false }, preHandler: localOnly },
    async (request, reply) => {
      const key = ctx.launch!.claim(browserOf(request))
      if (!key)
        throw Errors.unauthenticated('Open Mongo Manager from a new link', { reason: 'launch_required' })
      const cookie = readLocalCookie(request)
      if (cookie) setLocalCookie(request, reply, cookie)
      return { key }
    },
  )

  /** A one-time ticket for a download link (a navigation sends no header). */
  app.post('/auth/local/link', { preHandler: localOnly }, async (request) => {
    const { path } = parseInput(LinkBody, request.body)
    return { ticket: ctx.launch!.ticket(browserOf(request), path) }
  })

  /** Signs every browser out of local mode, this one too. */
  app.post(
    '/auth/local/sign-out-all',
    { config: { audit: 'auth.local.signOutAll' }, preHandler: localOnly },
    async (request, reply) => {
      const removed = ctx.launch!.forgetAll()
      request.auditInfo = { details: { removed } }
      clearLocalCookie(request, reply)
      return reply.status(204).send()
    },
  )

  app.post(
    '/auth/setup',
    { config: signInRoute('auth.setup'), preHandler: requireTeamMode },
    async (request, reply) => {
      const body = parseInput(SetupBody, request.body)
      request.auditInfo = { userId: null, username: body.username }
      assertNotBanned(ctx, request)
      const ipKey = ipThrottleKey(request.ip)
      try {
        throttleCheck(ctx, [ipKey])
      } catch (e) {
        noteSignInFailure(request)
        throw e
      }
      if (ctx.users.count() > 0) throw Errors.conflict('Setup has already been completed')
      if (!ctx.setup.matches(body.token)) {
        recordFailure(ctx, [ipKey])
        noteSignInFailure(request)
        throw Errors.unauthenticated('Invalid setup token')
      }
      assertPasswordOk(body.password, body.username)
      const passwordHash = await hashPassword(body.password)
      const user = transaction(ctx.store.db, () => {
        if (ctx.users.count() > 0) throw Errors.conflict('Setup has already been completed')
        return ctx.users.create({ username: body.username, passwordHash, role: 'admin' })
      })
      ctx.setup.clear()
      request.auditInfo = { userId: user.id, username: user.username }
      return { user, csrfToken: startSession(request, reply, user.id) }
    },
  )

  app.post(
    '/auth/login',
    { config: signInRoute('auth.login'), preHandler: requireTeamMode },
    async (request, reply) => {
      const body = parseInput(LoginBody, request.body)
      request.auditInfo = { userId: null, username: body.username }
      assertNotBanned(ctx, request, body.username)
      // Refused as busy before anything is counted against the account; an account that signed in
      // from here lately has places kept for it (review of the bans, I4).
      try {
        ctx.passwordWork.admit(knownHere(ctx, request, body.username))
      } catch (e) {
        busyRefused(request)
        throw e
      }
      const { keys, done } = signInKeys(ctx, body.username, request.ip)
      const record = ctx.users.findByUsername(body.username)
      const valid = await guardedAttempt(
        ctx,
        keys,
        async () => {
          const stored = record?.passwordHash ?? (await dummyHash())
          const ok = await ctx.passwordWork.run(() => verifyPassword(body.password, stored))
          return ok && record !== undefined && !record.disabled
        },
        request,
      )
      if (!record || !valid) throw Errors.unauthenticated('Invalid username or password')
      // Read again: the password may have changed while the old one was checked, and a change
      // revokes every session — this one must not come after it (review of the deferred fixes, M7).
      const current = ctx.users.findById(record.id)
      if (!current || current.disabled || !safeEqual(current.passwordHash, record.passwordHash))
        throw Errors.unauthenticated('Invalid username or password')
      request.auditInfo = { userId: record.id, username: record.username }
      const factors = secondFactors(ctx, record)
      if (factors.length > 0) {
        request.auditInfo = { userId: record.id, username: record.username, details: { mfaRequired: true } }
        return {
          mfaRequired: true,
          ticket: ctx.tickets.issue(record.id, record.passwordHash),
          methods: [...factors, 'recovery'],
        }
      }
      done()
      return { user: toPublicUser(record), csrfToken: startSession(request, reply, record.id) }
    },
  )

  app.post(
    '/auth/login/totp',
    { config: signInRoute('auth.login.totp'), preHandler: requireTeamMode },
    async (request, reply) => {
      const body = parseInput(TicketCodeBody, request.body)
      return completeSecondFactor(request, reply, body.ticket, (record) => {
        if (!record.totpEnabled) return false
        const step = verifyTotp(openTotpSecret(ctx, record), body.code, ctx.now(), record.totpLastStep)
        if (step === null) return false
        ctx.users.setTotpLastStep(record.id, step)
        return true
      })
    },
  )

  app.post(
    '/auth/login/recovery',
    { config: signInRoute('auth.login.recovery'), preHandler: requireTeamMode },
    async (request, reply) => {
      const body = parseInput(TicketCodeBody, request.body)
      return completeSecondFactor(request, reply, body.ticket, (record) =>
        ctx.recoveryCodes.consume(record.id, body.code),
      )
    },
  )

  app.post('/auth/logout', { config: { audit: 'auth.logout' }, preHandler: team }, async (request, reply) => {
    const principal = userPrincipal(request)
    ctx.sessions.revoke(principal.sessionId)
    clearSessionCookie(request, reply)
    // Security audit 2026-10-16: a command still running in the user's shells ends with the sign-out
    // (shells belong to the account, not to one session: all of them go).
    await ctx.shell.closeFor({ userId: principal.userId }, 'access')
    return reply.status(204).send()
  })

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
    const principal = request.principal!
    const base = {
      mode: ctx.config.auth ? 'team' : 'local',
      permissions: [...permissionsFor(principal.role, { readOnly: ctx.config.readOnly })],
      csrfToken: principal.csrfToken,
      readOnly: ctx.config.readOnly,
    }
    if (principal.kind === 'local') {
      return {
        ...base,
        user: { id: 'local', username: 'owner', role: 'admin' },
        twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
      }
    }
    const record = currentUser(request)
    const passkeys = ctx.passkeys.countForUser(record.id)
    const pending = twoFactorPendingReason(ctx, principal)
    return {
      ...base,
      user: { id: record.id, username: record.username, role: record.role },
      // Phase 4c §4: the app shows the 2FA set-up alone until it is done — and why (required 2FA).
      twoFactorRequired: pending !== null,
      ...(pending ? { twoFactorRequiredBy: pending } : {}),
      twoFactor: {
        enabled: record.totpEnabled || passkeys > 0,
        totp: record.totpEnabled,
        passkeys,
        recoveryCodesRemaining: ctx.recoveryCodes.remaining(record.id),
      },
    }
  })

  app.post(
    '/auth/password',
    { config: { audit: 'auth.password' }, preHandler: team },
    async (request, reply) => {
      const body = parseInput(PasswordBody, request.body)
      const record = currentUser(request)
      if (!(await checkPassword(ctx, record, body.currentPassword)))
        throw Errors.validation('Current password is incorrect', WRONG_PASSWORD)
      assertPasswordOk(body.newPassword, record.username)
      ctx.users.setPassword(record.id, await hashPassword(body.newPassword))
      ctx.sessions.revokeAllForUser(record.id)
      // Security audit 2026-10-16: every session went, and so do the shells they held.
      await ctx.shell.closeFor({ userId: record.id }, 'access')
      return { csrfToken: startSession(request, reply, record.id) }
    },
  )

  app.post(
    '/auth/totp/enroll',
    { config: { audit: 'auth.totp.enroll' }, preHandler: team },
    async (request) => {
      const body = parseInput(PasswordOnlyBody, request.body)
      const record = currentUser(request)
      if (record.totpEnabled)
        throw Errors.conflict('An authenticator app is already enabled', { reason: 'totp_enabled' })
      if (!(await checkPassword(ctx, record, body.password)))
        throw Errors.validation('Password is incorrect', WRONG_PASSWORD)
      requireStepUp(request, record)
      const secret = generateTotpSecret()
      ctx.users.setTotp(record.id, ctx.secretBox.seal(secret, totpContext(record.id)), false)
      return { secret, otpauthUri: totpUri(secret, record.username) }
    },
  )

  app.post(
    '/auth/totp/confirm',
    { config: { audit: 'auth.totp.confirm' }, preHandler: team },
    async (request) => {
      const body = parseInput(CodeBody, request.body)
      const record = currentUser(request)
      if (record.totpEnabled || !record.totpSecretSealed)
        throw Errors.conflict('No pending authenticator enrollment', { reason: 'no_pending_enrollment' })
      const step = verifyTotp(openTotpSecret(ctx, record), body.code, ctx.now())
      if (step === null) throw Errors.validation('Invalid authenticator code', { reason: 'invalid_code' })
      const isFirstFactor = secondFactors(ctx, record).length === 0
      ctx.users.setTotp(record.id, record.totpSecretSealed, true)
      ctx.users.setTotpLastStep(record.id, step)
      // A factor just proved by its owner (L2).
      markStepUp(request)
      return isFirstFactor ? { recoveryCodes: ctx.recoveryCodes.replace(record.id) } : {}
    },
  )

  app.post(
    '/auth/totp/disable',
    { config: { audit: 'auth.totp.disable' }, preHandler: team },
    async (request, reply) => {
      const body = parseInput(DisableTotpBody, request.body)
      const record = currentUser(request)
      if (!record.totpEnabled)
        throw Errors.conflict('No authenticator app is enabled', { reason: 'totp_not_enabled' })
      if (keepsLastFactor(ctx, record, ctx.passkeys.countForUser(record.id)))
        throw lastFactorRefusal(ctx, record)
      const passwordOk = await checkPassword(ctx, record, body.password)
      // Security review 2026-10-13 (L2): the code is throttled too, apart from the password.
      let step: number | null = null
      const codeOk = await guardedAttempt(ctx, [`factor:${record.id}`], () => {
        step = verifyTotp(openTotpSecret(ctx, record), body.code, ctx.now(), record.totpLastStep)
        return step !== null
      })
      if (!passwordOk || !codeOk || step === null)
        throw Errors.validation('Password or authenticator code is incorrect', {
          reason: 'wrong_password_or_code',
        })
      // 4c review M1: decided again as things are now, nothing awaited before the change.
      const fresh = ctx.users.findById(record.id)
      if (fresh && keepsLastFactor(ctx, fresh, ctx.passkeys.countForUser(fresh.id)))
        throw lastFactorRefusal(ctx, fresh)
      ctx.users.setTotp(record.id, null, false)
      dropRecoveryCodesIfNoFactor(ctx, record.id)
      return reply.status(204).send()
    },
  )

  app.post(
    '/auth/recovery-codes',
    { config: { audit: 'auth.recovery.regenerate' }, preHandler: team },
    async (request) => {
      const body = parseInput(PasswordOnlyBody, request.body)
      const record = currentUser(request)
      if (secondFactors(ctx, record).length === 0)
        throw Errors.conflict('Enable two-factor authentication first', { reason: 'two_factor_required' })
      if (!(await checkPassword(ctx, record, body.password)))
        throw Errors.validation('Password is incorrect', WRONG_PASSWORD)
      requireStepUp(request, record)
      return { recoveryCodes: ctx.recoveryCodes.replace(record.id) }
    },
  )

  /**
   * Security review 2026-10-13 (L2): proving a second factor in this session — an authenticator
   * code or a recovery code (used up) — for managing second factors. Throttled per account.
   */
  app.post(
    '/auth/step-up',
    { config: { audit: 'auth.stepUp' }, preHandler: team },
    async (request, reply) => {
      const body = parseInput(CodeBody, request.body)
      const record = currentUser(request)
      const ok = await guardedAttempt(ctx, [`factor:${record.id}`], () => {
        if (record.totpEnabled) {
          const step = verifyTotp(openTotpSecret(ctx, record), body.code, ctx.now(), record.totpLastStep)
          if (step !== null) {
            ctx.users.setTotpLastStep(record.id, step)
            return true
          }
        }
        return secondFactors(ctx, record).length > 0 && ctx.recoveryCodes.consume(record.id, body.code)
      })
      if (!ok) throw Errors.validation('The code is not right', { reason: 'invalid_code' })
      markStepUp(request)
      return reply.status(204).send()
    },
  )
}
