import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { Errors } from '../errors'
import { keepsLastFactor, lastFactorRefusal } from '../auth/policy'
import { parseInput } from '../validate'
import { passkeySupport, relyingParty } from '../auth/webauthn'
import type { Passkey } from '../auth/passkeys'
import { requireAuth, requireTeamMode, userPrincipal } from '../http/guards'
import {
  WRONG_PASSWORD,
  checkPassword,
  completeSecondFactor,
  dropRecoveryCodesIfNoFactor,
  factorAttempt,
  markStepUp,
  requireStepUp,
  secondFactors,
  signInRoute,
  ticketExpired,
  ticketUser,
} from './auth'

const CredentialJson = z.looseObject({
  id: z.string().min(1).max(2048),
  type: z.literal('public-key'),
  response: z.looseObject({}),
})
const AddBody = z.object({ name: z.string().trim().min(1).max(64), response: CredentialJson })
const RenameBody = z.object({ name: z.string().trim().min(1).max(64) })
const DeleteBody = z.object({ password: z.string().min(1).max(1024) })
const IdParams = z.object({ id: z.string().min(1).max(2048) })
const TicketBody = z.object({ ticket: z.string().min(1).max(100) })
const LoginBody = z.object({ ticket: z.string().min(1).max(100), response: CredentialJson })

const publicPasskey = (p: Passkey) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
})

const StepUpBody = z.object({ response: CredentialJson })

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const team = [requireTeamMode, requireAuth]

  const currentUser = (request: Parameters<typeof userPrincipal>[0]) => {
    const record = ctx.users.findById(userPrincipal(request).userId)
    if (!record) throw Errors.unauthenticated()
    return record
  }

  app.get('/auth/passkeys/support', { preHandler: team }, async (request) => passkeySupport(request))

  app.post('/auth/passkeys/options', { preHandler: team }, async (request) => {
    const support = passkeySupport(request)
    if (!support.available)
      throw Errors.conflict(support.message, { reason: 'passkeys_unavailable', why: support.reason })
    const body = parseInput(DeleteBody, request.body)
    const principal = userPrincipal(request)
    const record = currentUser(request)
    if (!(await checkPassword(ctx, record, body.password)))
      throw Errors.validation('Password is incorrect', WRONG_PASSWORD)
    // Security review 2026-10-13 (L2): adding a passkey to an account that has a second factor
    // takes one proved in this session lately.
    requireStepUp(request, record)
    const rp = relyingParty(request)
    const options = await generateRegistrationOptions({
      rpName: 'Mongo Manager',
      rpID: rp.rpID,
      userName: record.username,
      userID: new TextEncoder().encode(record.id),
      attestationType: 'none',
      excludeCredentials: ctx.passkeys
        .listForUser(record.id)
        .map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    })
    ctx.challenges.set(`reg:${principal.sessionIdHash}`, options.challenge)
    return options
  })

  app.post('/auth/passkeys', { preHandler: team, config: { audit: 'auth.passkey.add' } }, async (request) => {
    const body = parseInput(AddBody, request.body)
    const principal = userPrincipal(request)
    const record = currentUser(request)
    const expectedChallenge = ctx.challenges.take(`reg:${principal.sessionIdHash}`)
    if (!expectedChallenge)
      throw Errors.validation('Passkey registration expired; start again', { reason: 'passkey_expired' })
    const rp = relyingParty(request)
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      })
    } catch (e) {
      throw Errors.validation(`Passkey registration failed: ${(e as Error).message}`, {
        reason: 'passkey_failed',
      })
    }
    if (!verification.verified)
      throw Errors.validation('Passkey registration could not be verified', { reason: 'passkey_failed' })
    const { credential } = verification.registrationInfo
    if (ctx.passkeys.find(credential.id))
      throw Errors.conflict('This passkey is already registered', { reason: 'passkey_duplicate' })
    const isFirstFactor = secondFactors(ctx, record).length === 0
    const passkey = ctx.passkeys.add({
      id: credential.id,
      userId: record.id,
      name: body.name,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
    })
    request.auditInfo = { details: { passkey: body.name } }
    // A factor just proved by its owner (L2).
    markStepUp(request)
    return {
      passkey: publicPasskey(passkey),
      ...(isFirstFactor ? { recoveryCodes: ctx.recoveryCodes.replace(record.id) } : {}),
    }
  })

  app.get('/auth/passkeys', { preHandler: team }, async (request) =>
    ctx.passkeys.listForUser(userPrincipal(request).userId).map(publicPasskey),
  )

  app.patch(
    '/auth/passkeys/:id',
    { preHandler: team, config: { audit: 'auth.passkey.rename' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(RenameBody, request.body)
      const userId = userPrincipal(request).userId
      if (!ctx.passkeys.rename(id, userId, body.name)) throw Errors.notFound('Passkey not found')
      return publicPasskey(ctx.passkeys.find(id)!)
    },
  )

  app.delete(
    '/auth/passkeys/:id',
    { preHandler: team, config: { audit: 'auth.passkey.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const body = parseInput(DeleteBody, request.body)
      const record = currentUser(request)
      // Phase 4c §4: never the last method of a user who must have one.
      if (
        keepsLastFactor(ctx, record, (record.totpEnabled ? 1 : 0) + ctx.passkeys.countForUser(record.id) - 1)
      )
        throw lastFactorRefusal(ctx, record)
      if (!(await checkPassword(ctx, record, body.password)))
        throw Errors.validation('Password is incorrect', WRONG_PASSWORD)
      requireStepUp(request, record)
      // 4c review M1: decided again on the state as it is now, with nothing awaited before the
      // delete — two removals racing never take the last method together.
      const fresh = ctx.users.findById(record.id)
      if (
        fresh &&
        keepsLastFactor(ctx, fresh, (fresh.totpEnabled ? 1 : 0) + ctx.passkeys.countForUser(fresh.id) - 1)
      )
        throw lastFactorRefusal(ctx, fresh)
      if (!ctx.passkeys.delete(id, record.id)) throw Errors.notFound('Passkey not found')
      dropRecoveryCodesIfNoFactor(ctx, record.id)
      return reply.status(204).send()
    },
  )

  /** Security review 2026-10-13 (L2): a passkey proved in this session, for managing factors. */
  app.post('/auth/step-up/passkey/options', { preHandler: team }, async (request) => {
    const principal = userPrincipal(request)
    const passkeys = ctx.passkeys.listForUser(principal.userId)
    if (passkeys.length === 0) throw Errors.conflict('No passkey is registered for this account')
    const options = await generateAuthenticationOptions({
      rpID: relyingParty(request).rpID,
      allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      userVerification: 'preferred',
    })
    ctx.challenges.set(`step:${principal.sessionIdHash}`, options.challenge)
    return options
  })

  app.post(
    '/auth/step-up/passkey',
    { preHandler: team, config: { audit: 'auth.stepUp.passkey' } },
    async (request, reply) => {
      const body = parseInput(StepUpBody, request.body)
      const principal = userPrincipal(request)
      const response = body.response as unknown as AuthenticationResponseJSON
      const rp = relyingParty(request)
      const expectedChallenge = ctx.challenges.take(`step:${principal.sessionIdHash}`)
      const passkey = ctx.passkeys.find(response.id)
      const ok = await factorAttempt(ctx, principal.userId, async () => {
        if (!expectedChallenge || !passkey || passkey.userId !== principal.userId) return false
        try {
          const result = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.rpID,
            credential: {
              id: passkey.id,
              publicKey: passkey.publicKey,
              counter: passkey.counter,
              transports: passkey.transports,
            },
            requireUserVerification: false,
          })
          if (!result.verified) return false
          ctx.passkeys.updateUsage(passkey.id, result.authenticationInfo.newCounter)
          return true
        } catch {
          return false
        }
      })
      if (!ok) throw Errors.validation('The passkey could not be verified', { reason: 'passkey_failed' })
      markStepUp(request)
      return reply.status(204).send()
    },
  )

  app.post(
    '/auth/login/passkey/options',
    { config: signInRoute(), preHandler: requireTeamMode },
    async (request) => {
      const body = parseInput(TicketBody, request.body)
      // A ticket a password change ended lists nothing (review of the deferred fixes, M8).
      const record = ticketUser(ctx, body.ticket)
      if (!record) throw ticketExpired(ctx, body.ticket)
      const passkeys = ctx.passkeys.listForUser(record.id)
      if (passkeys.length === 0) throw Errors.conflict('No passkey is registered for this account')
      const options = await generateAuthenticationOptions({
        rpID: relyingParty(request).rpID,
        allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
        userVerification: 'preferred',
      })
      ctx.tickets.setChallenge(body.ticket, options.challenge)
      return options
    },
  )

  app.post(
    '/auth/login/passkey',
    { config: signInRoute('auth.login.passkey'), preHandler: requireTeamMode },
    async (request, reply) => {
      const body = parseInput(LoginBody, request.body)
      const response = body.response as unknown as AuthenticationResponseJSON
      const rp = relyingParty(request)
      return completeSecondFactor(request, reply, body.ticket, async (record) => {
        const expectedChallenge = ctx.tickets.takeChallenge(body.ticket)
        const passkey = ctx.passkeys.find(response.id)
        if (!expectedChallenge || !passkey || passkey.userId !== record.id) return false
        try {
          const result = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.rpID,
            credential: {
              id: passkey.id,
              publicKey: passkey.publicKey,
              counter: passkey.counter,
              transports: passkey.transports,
            },
            requireUserVerification: false,
          })
          if (!result.verified) return false
          ctx.passkeys.updateUsage(passkey.id, result.authenticationInfo.newCounter)
          return true
        } catch {
          return false
        }
      })
    },
  )
}
