// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AgentVia } from '../ai/agent/calls'
import type { FastifyRequest } from 'fastify'
import type { AppError } from '../errors'
import type { AuditRepo } from '../audit/audit'
import type { Principal } from '../http/context'
import { MASKING_UNSUPPORTED, PERSONAL_FIELD, PERSONAL_INDEX, PERSONAL_WRITE } from './gate/refusal'

export const REFUSALS_PER_MINUTE = 10
const MAX_TRACKED_USERS = 10_000

/**
 * Phase 3c §8: every gate refusal is audited with the field name, never the value or the query. At
 * most ten rows a minute per user; the rest are counted and written as one row with that user's
 * next refusal in a later minute.
 */
export class RefusalAudit {
  private readonly windows = new Map<string, { minute: number; n: number }>()

  constructor(
    private readonly audit: Pick<AuditRepo, 'append'>,
    private readonly now: () => number,
  ) {}

  refused(request: FastifyRequest, error: AppError): void {
    this.refusedBy(
      {
        principal: request.principal ?? null,
        ip: request.ip,
        connectionId: request.connection?.id ?? null,
        // Review of B6 (M1): made for an agent's turn, said with it.
        agent: request.agentVia ?? null,
      },
      error,
    )
  }

  /** Phase 3e-1: a refusal outside a request (a socket message), by whoever caused it. */
  refusedBy(
    who: {
      principal: Principal | null
      ip: string | null
      connectionId: string | null
      agent?: AgentVia | null
    },
    error: AppError,
  ): void {
    const d = error.details as { reason?: unknown; field?: unknown; what?: unknown; ns?: unknown } | undefined
    if (
      d?.reason !== PERSONAL_FIELD &&
      d?.reason !== MASKING_UNSUPPORTED &&
      d?.reason !== PERSONAL_WRITE &&
      d?.reason !== PERSONAL_INDEX
    )
      return
    const principal = who.principal
    const user = principal?.kind === 'user' ? principal.userId : 'local'
    const minute = Math.floor(this.now() / 60_000)
    const base = {
      action: 'masking.refused' as const,
      outcome: 'denied' as const,
      userId: principal?.kind === 'user' ? principal.userId : null,
      username: principal?.username ?? null,
      ip: who.ip,
      connectionId: who.connectionId,
      namespace: typeof d.ns === 'string' ? d.ns : null,
    }
    const current = this.windows.get(user)
    if (current && current.minute !== minute && current.n > REFUSALS_PER_MINUTE)
      this.audit.append({ ...base, details: { suppressed: current.n - REFUSALS_PER_MINUTE } })
    const window = current && current.minute === minute ? current : { minute, n: 0 }
    window.n++
    if (this.windows.size >= MAX_TRACKED_USERS && !this.windows.has(user)) this.windows.clear()
    this.windows.set(user, window)
    if (window.n > REFUSALS_PER_MINUTE) return
    this.audit.append({
      ...base,
      details: {
        reason: d.reason,
        ...(d.field !== undefined ? { field: d.field } : d.what !== undefined ? { what: d.what } : {}),
        ...(who.agent ? { agent: { ...who.agent } } : {}),
      },
    })
  }
}
