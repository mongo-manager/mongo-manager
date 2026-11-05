// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AiAgentPolicySchema, type AiAgentPolicy } from '@mongo-manager/shared'
import { SettingsRepo } from '../../store/settings'
import type { ServerContext } from '../../http/context'
import { Errors } from '../../errors'

const KEY = 'ai.agent.policy'
const Stored = AiAgentPolicySchema

/**
 * The AI database manager (design 2026-10-25, A2): what an administrator allows the agent on this
 * server — off, read-only or full. Each person's own switch still starts off; this only narrows it.
 */
export function agentPolicy(ctx: ServerContext): AiAgentPolicy['policy'] {
  const repo = new SettingsRepo(ctx.store.db, ctx.now)
  // Full where nothing was set; a value that does not read (a newer version's, a damaged row) is no
  // permission — off (review of A2, minor 7).
  if (!repo.has(KEY)) return 'full'
  const unread: AiAgentPolicy = { policy: 'off' }
  return repo.get(KEY, Stored, unread).policy
}

/** Whether a stored policy reads (none stored reads as full). */
export function agentPolicyReadable(ctx: ServerContext): boolean {
  const repo = new SettingsRepo(ctx.store.db, ctx.now)
  return !repo.has(KEY) || repo.get(KEY, Stored, null) !== null
}

export function setAgentPolicy(ctx: ServerContext, policy: AiAgentPolicy['policy']): void {
  new SettingsRepo(ctx.store.db, ctx.now).set(KEY, { policy })
}

/** A turn, or an answer to a change, under the policy as it is now. */
export function refuseUnderPolicy(ctx: ServerContext, change: boolean): void {
  const policy = agentPolicy(ctx)
  if (policy === 'off')
    throw Errors.forbidden('An administrator turned agent mode off on this server', {
      reason: 'agent_policy_off',
    })
  if (change && policy === 'read')
    throw Errors.forbidden('An administrator allows the agent to read only on this server', {
      reason: 'agent_policy_read',
    })
}
