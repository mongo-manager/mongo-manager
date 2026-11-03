import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AiAgentDecisionSchema,
  AiAgentPolicySchema,
  AiAgentPreferenceSchema,
  type AiAgentPolicy,
  AiAgentTurnSchema,
  DbPasswordSchema,
  MIN_BACKUP_PASSWORD,
  MIN_DB_PASSWORD,
  permissionsFor,
  type AiAgentPreference,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import { mayUseAi } from '../ai/access'
import { effectiveRole } from '../connections/access'
import { agentAuthOf } from '../ai/agent/calls'
import { AGENT_PREFERENCE, agentModeOn, agentOwnerKey, runAgentTurn } from '../ai/agent/turn'
import { agentPolicy, agentPolicyReadable, refuseUnderPolicy, setAgentPolicy } from '../ai/agent/policy'

const RunParams = z.strictObject({ run: z.uuid() })

/** W6.3 (completion §2): the agentic assistant's routes. */
export async function aiAgentRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const requireAi = async (request: FastifyRequest) => {
    if (!mayUseAi(ctx, request.principal!)) throw Errors.forbidden()
  }
  function refuseIfNoLongerAllowed(request: FastifyRequest, connectionId: string, tool?: string): void {
    const principal = request.principal!
    if (!ctx.config.ai.enabled)
      throw Errors.forbidden('The AI assistant is turned off on this server', { reason: 'ai_off' })
    if (!agentModeOn(ctx, principal) || !mayUseAi(ctx, principal))
      throw Errors.forbidden('Agent mode is off', { reason: 'agent_off' })
    // A2: an administrator's policy as it is now — a change already on its card included.
    refuseUnderPolicy(ctx, true)
    const c = ctx.connections.get(connectionId)
    const role = c ? effectiveRole(ctx, principal, c.id) : null
    if (!c || !role) throw new AppError('NOT_FOUND', 'Connection not found', 404, { reason: 'not_found' })
    if (c.aiPolicy === 'off')
      throw Errors.forbidden('The AI assistant is off for this connection', { reason: 'ai_off' })
    if (!c.aiAgentWrites)
      throw Errors.forbidden('The agent may not make changes on this connection', {
        reason: 'agent_writes_off',
      })
    // C5: the change's tool turned off on the connection since its card.
    if (tool && (c.aiAgentToolsOff as readonly string[]).includes(tool))
      throw Errors.forbidden('An administrator turned this tool off on this connection', {
        reason: 'tool_off',
      })
    if (!permissionsFor(role).has('ai:use')) throw Errors.forbidden()
  }

  // Agent mode is the person's own switch; it is offered where they may use the assistant, and an
  // administrator has not turned the agent off (A2).
  const preference = (request: FastifyRequest, on: boolean): AiAgentPreference => {
    const policy = agentPolicy(ctx)
    const assistant = ctx.config.ai.enabled && mayUseAi(ctx, request.principal!)
    return { on, available: assistant && policy !== 'off', assistant, policy }
  }
  app.get('/me/ai-agent', { preHandler: requireAuth }, async (request): Promise<AiAgentPreference> =>
    preference(request, agentModeOn(ctx, request.principal!)),
  )

  // A2: the server's policy for the agent, an administrator's to set.
  const admin = requirePermission('settings:manage')
  app.get('/ai/agent-policy', { preHandler: admin }, async (): Promise<AiAgentPolicy> => ({
    policy: agentPolicy(ctx),
  }))
  app.put(
    '/ai/agent-policy',
    { preHandler: admin, config: { audit: 'ai.agent.policy' } },
    async (request): Promise<AiAgentPolicy> => {
      const { policy } = parseInput(AiAgentPolicySchema, request.body)
      const from = agentPolicy(ctx)
      // Review of A2 (minor 9): the value it replaced kept with it; a save of the same, nothing —
      // unless what is stored does not read (re-review, nit: saved again, it is repaired).
      if (from === policy && agentPolicyReadable(ctx)) {
        request.auditInfo = { quiet: true }
        return { policy }
      }
      setAgentPolicy(ctx, policy)
      // Re-review (I1): narrowed, a change waiting on its card ends now — said so in its turn.
      const narrowed = policy === 'off' || (policy === 'read' && from === 'full')
      const ended = narrowed
        ? ctx.ai.agent.runs.endWaiting({ state: 'error', reason: `agent_policy_${policy}` })
        : 0
      request.auditInfo = { details: { policy, from, ...(ended ? { ended } : {}) } }
      return { policy }
    },
  )
  app.put(
    '/me/ai-agent',
    { preHandler: requireAuth, config: { audit: 'ai.agent.mode' } },
    async (request): Promise<AiAgentPreference> => {
      const { on } = parseInput(AiAgentPreferenceSchema, request.body)
      ctx.preferences.set(agentOwnerKey(request.principal!), AGENT_PREFERENCE, { on })
      request.auditInfo = { details: { on } }
      return preference(request, on)
    },
  )

  app.post(
    '/ai/agent',
    { preHandler: [requireAuth, requireAi], config: { audit: 'ai.chat' } },
    async (request, reply) => {
      const body = parseInput(AiAgentTurnSchema, request.body ?? {})
      const out = await runAgentTurn(request, reply, body)
      // The stream writes its own audit rows when it ends (the turn's, and one per tool call).
      request.auditInfo = { quiet: true }
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(out)
    },
  )

  /**
   * Spec §3 (W6.3): the person's answer to a proposed change. Only the person whose turn proposed it
   * may answer (another finds nothing); the first answer is taken, a second is refused; the change
   * runs through its route as the person answering — this request, with its own session and CSRF
   * token — and the turn goes on with how it ended.
   */
  app.post(
    '/ai/agent/runs/:run/decide',
    { preHandler: requireAuth, config: { audit: 'ai.agent.decision' } },
    async (request) => {
      const { run } = parseInput(RunParams, request.params)
      const body = parseInput(AiAgentDecisionSchema, request.body)
      const owner = agentOwnerKey(request.principal!)
      const runs = ctx.ai.agent.runs
      // Review of B6 (M2): the run is named in the row once it is the person's (else it was only asked).
      request.auditInfo = { details: { asked: run, call: body.call, decision: body.decision } }
      const pending = runs.pending(run, owner, body.call)
      // Review of B8 (M3): the person's own run, whether its change still waits or not.
      if (pending || runs.owns(run, owner))
        request.auditInfo = { details: { run, call: body.call, decision: body.decision } }
      if (!pending)
        throw new AppError('NOT_FOUND', 'This change is no longer waiting for an answer', 404, {
          reason: 'not_pending',
        })
      // Design 2026-10-25 (C4): the backup the card offers, made before its change may be confirmed.
      if (body.decision === 'backup') {
        if (!pending.backup)
          throw Errors.conflict('This change offers no backup', { reason: 'no_backup_offer' })
        refuseIfNoLongerAllowed(request, pending.connectionId, pending.tool)
        if (!body.backupPassword)
          throw Errors.validation('The backup needs its password', { reason: 'password_required' })
        if (body.backupPassword.length < MIN_BACKUP_PASSWORD)
          throw Errors.validation(`A password has at least ${MIN_BACKUP_PASSWORD} characters`, {
            reason: 'password_short',
          })
        if (!runs.startBackup(run, owner, body.call))
          throw Errors.conflict('The backup was made or is being made', { reason: 'backup_taken' })
        const via = { run, call: body.call, ...(pending.chat ? { chat: pending.chat } : {}) }
        let started: { job: string } | { reason: string }
        try {
          started = await pending.backup({ ...agentAuthOf(request), via }, body.backupPassword)
        } catch (e) {
          request.log.warn({ err: e }, 'AI agent: a backup before a change failed')
          started = { reason: 'tool_failed' }
        }
        if ('reason' in started) {
          runs.endBackup(run, body.call, false)
          pending.notify?.({ state: 'error', reason: started.reason })
          request.auditInfo = {
            details: { run, call: body.call, decision: 'backup', reason: started.reason },
          }
          return { state: 'error', reason: started.reason }
        }
        const job = started.job
        pending.notify?.({ state: 'running', job })
        // The change waits for the job's end: made, it may be confirmed; not, it may be asked again.
        let off = () => {}
        const ended = (j: { id: string; state: string }) => {
          if (j.id !== job || j.state === 'running') return
          off()
          const made = j.state === 'done'
          runs.endBackup(run, body.call, made)
          pending.notify?.(made ? { state: 'done', job } : { state: 'error', job, reason: 'backup_failed' })
        }
        off = ctx.jobs.onChange(ended)
        const now = ctx.jobs.get(job)
        if (now) ended(now)
        request.auditInfo = { details: { run, call: body.call, decision: 'backup', job } }
        // Review of C4 (nit): a job that ended already is said as it ended.
        const state =
          now && now.state !== 'running' ? (now.state === 'done' ? 'backed_up' : 'error') : 'backing_up'
        return state === 'error' ? { state, reason: 'backup_failed', job } : { state, job }
      }
      if (body.decision === 'decline') {
        if (!runs.take(run, owner, body.call))
          throw Errors.conflict('This change was answered already', { reason: 'already_decided' })
        runs.finish(run, { state: 'declined' })
        return { state: 'declined' }
      }
      // What allowed the change is read again now (the card may have waited 10 minutes): the
      // assistant and agent mode still on for this person, the connection's assistant on and the
      // agent's writes allowed there. Declining is never held back.
      // Refused by an administrator's policy, the change ends — said so in the turn — instead of waiting
      // out its ten minutes (review of A2, I4). Refused for the person's own switch or the connection's,
      // it waits: the person may still decline it (W6.3).
      try {
        refuseIfNoLongerAllowed(request, pending.connectionId, pending.tool)
      } catch (e) {
        const reason = ((e as AppError).details as { reason?: unknown } | undefined)?.reason
        if (
          typeof reason === 'string' &&
          reason.startsWith('agent_policy_') &&
          runs.take(run, owner, body.call)
        )
          runs.finish(run, { state: 'error', reason })
        throw e
      }
      // C4: the backup asked for first is made before the change may be.
      if (runs.backingUp(run))
        throw Errors.conflict('The backup is still being made', { reason: 'backup_first_running' })
      // As the app's own dialogs: a destructive change needs its name typed exactly.
      if (pending.typed !== undefined && body.confirm !== pending.typed)
        throw Errors.validation('Type the name to confirm', { reason: 'typed_name' })
      // User request 2026-10-26: without a password only where the card offered it — and then none sent.
      if (body.plain && !pending.plain)
        throw Errors.validation('This change cannot be made without a password', { reason: 'no_plain_offer' })
      if (body.plain && body.password !== undefined)
        throw Errors.validation('A backup without a password takes none', { reason: 'plain_with_password' })
      if (pending.password && !body.plain && !body.password)
        throw Errors.validation('This change needs its password', { reason: 'password_required' })
      // B2: a new backup's password is long enough; one that opens a backup is as it was made.
      // Review of B4 (nit 7): a new MongoDB user's, as Database Access takes one.
      const least = pending.passwordFor === 'user' ? MIN_DB_PASSWORD : MIN_BACKUP_PASSWORD
      if (pending.password && !body.plain && !pending.opening && body.password!.length < least)
        throw Errors.validation(`A password has at least ${least} characters`, {
          reason: 'password_short',
        })
      // B4: a new MongoDB user's, as Database Access takes one (at most 256 characters, no NUL).
      if (pending.passwordFor === 'user' && !DbPasswordSchema.safeParse(body.password).success)
        throw Errors.validation('That password cannot be a MongoDB user’s', { reason: 'password_invalid' })
      if (!runs.take(run, owner, body.call))
        throw Errors.conflict('This change was answered already', { reason: 'already_decided' })
      let end
      try {
        // B6: the change's own route rows name the turn and the step they were made for.
        const via = { run, call: body.call, ...(pending.chat ? { chat: pending.chat } : {}) }
        end = await pending.run(
          { ...agentAuthOf(request), via },
          { confirm: body.confirm, password: body.password, ...(body.plain ? { plain: true } : {}) },
        )
      } catch (e) {
        request.log.warn({ err: e }, 'AI agent: a confirmed change failed')
        end = { state: 'error' as const, reason: 'tool_failed' }
      }
      runs.finish(run, end)
      request.auditInfo = {
        details: {
          run,
          call: body.call,
          decision: body.decision,
          ...(body.plain ? { plain: true } : {}),
          state: end.state,
          ...('reason' in end ? { reason: end.reason } : {}),
        },
      }
      return end.state === 'done'
        ? { state: 'done', summary: end.summary }
        : { state: end.state, ...('reason' in end ? { reason: end.reason } : {}) }
    },
  )
}
