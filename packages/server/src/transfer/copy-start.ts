// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import type { PersonalRule } from '@mongo-manager/shared'
import type { JobRecord } from '../jobs/types'
import { ownerOf } from './files'
import type { PrepareInput, Prepared } from './copy-plan'
import type { CopyJobParams } from './copy-job'
import { assertTransferRoom } from '../routes/data/transfer'

/** Phase 3d-2 spec §5.2: the rules the target lacks, appended (never removed) and audited. */
export function addMissingRules(
  request: FastifyRequest,
  input: PrepareInput,
  prepared: Prepared,
  by: string,
): PersonalRule[] {
  const { ctx } = request.server
  const principal = request.principal!
  // Final review of explain masking (I-1): the plan's own rules, those of the pairs it writes.
  const addRules = input.options.addRulesToTarget
    ? prepared.pairs.filter((p) => !(p.create && 'skip' in p.create)).flatMap((p) => p.missing)
    : []
  if (!addRules.length || input.options.dryRun) return addRules
  const current = ctx.personalFields.stored(input.target.connectionId).rules
  ctx.personalFields.set(input.target.connectionId, [...current, ...addRules])
  ctx.audit.append({
    action: 'connections.personalFields',
    outcome: 'success',
    userId: principal.kind === 'user' ? principal.userId : null,
    username: null,
    ip: request.ip,
    connectionId: input.target.connectionId,
    namespace: null,
    details: { before: current.length, after: current.length + addRules.length, by },
  })
  return addRules
}

/** Phase 3d-2 spec §8.2: the copy job, with no await between the room check and the start (3d-1 I9). */
export function startCopyJob(
  request: FastifyRequest,
  input: PrepareInput,
  prepared: Prepared,
  addRules: PersonalRule[],
  label: { coll: string; target: string },
  /** Phase 3e-2 final review I2: a live sync's copy reads the primary. */
  extra: { primaryReads?: boolean } = {},
): JobRecord {
  const { ctx } = request.server
  const principal = request.principal!
  assertTransferRoom(ctx, principal)
  const params: CopyJobParams = {
    owner: ownerOf(principal),
    request: { ...input.options, views: input.views },
    pairs: prepared.pairs,
    views: prepared.views,
    sourcePlan: prepared.sourcePlan,
    sourceMasker: prepared.sourceMasker,
    targetMasker: prepared.targetMasker,
    // Rules added just now are the target's version the job starts under.
    versions: {
      source: prepared.versions.source,
      target: ctx.personalFields.get(input.target.connectionId).version,
    },
    targetDb: input.target.db,
    addRules,
    ...(extra.primaryReads ? { primaryReads: true } : {}),
  }
  return ctx.jobs.start(
    ctx.jobKinds['data.copy'],
    {
      userId: principal.kind === 'user' ? principal.userId : null,
      connectionId: request.connection!.id,
      targetConnectionId: input.target.connectionId,
      db: input.db,
      coll: label.coll,
      target: input.options.dryRun ? `${label.target} (dry run)` : label.target,
    },
    params,
  )
}
