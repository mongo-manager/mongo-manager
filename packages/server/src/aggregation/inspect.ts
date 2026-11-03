import type { FastifyRequest } from 'fastify'
import { stageOperator, writeTarget, type WriteTarget } from '@mongo-manager/shared'
import { Errors } from '../errors'
import {
  SYSTEM_DATABASES,
  isAdminOnlyNamespace,
  isDrillScratch,
  isRestrictedNamespace,
} from '../connections/access'
import { assertNoServerJs } from '../routes/data/params'

/** Stages that are not reads of this collection: other routes (or phases) own them. */
export const REFUSED_STAGES = new Set(['$changeStream', '$currentOp', '$listSessions', '$listLocalSessions'])
/**
 * Stages that read other users' queries (with their values) or every collection's catalog entry:
 * connection admins only, as in the shell (data review 2026-10-13, M6).
 */
export const ADMIN_ONLY_STAGES = new Set([
  '$planCacheStats',
  '$listSampledQueries',
  '$queryStats',
  '$listCatalog',
  '$querySettings',
  '$listClusterCatalog',
])
const MAX_NESTING = 20

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

interface Walk {
  /** The caller is the connection's admin (admin-only stages and namespaces are theirs). */
  admin: boolean
  db: string
  /** W6.3 security review (I1): told of every namespace a stage reads. */
  onRead?: (db: string, coll: string) => void
  /** W6.3 re-review (N1): told of every stage, at any depth, before it is checked. */
  onStage?: (op: string) => void
}

/** A namespace another stage reads: a name, or `{db?, coll}`; anything else is refused. */
function readNamespace(w: Walk, op: string, value: unknown): void {
  let db = w.db
  let coll: unknown = value
  if (isObject(value)) {
    if (value.db !== undefined && typeof value.db !== 'string')
      throw Errors.validation(`${op}: db must be a string`)
    db = (value.db as string | undefined) ?? w.db
    coll = value.coll
  }
  if (typeof coll !== 'string' || !coll) throw Errors.validation(`${op}: the collection must be a name`)
  // W4 review C1: a restore drill's scratch database, for no one.
  if (isDrillScratch(db))
    throw Errors.forbidden(`${op} cannot read ${db}.${coll}: it is a restore drill’s scratch database`)
  w.onRead?.(db, coll)
  if (!w.admin && isAdminOnlyNamespace(db, coll))
    throw Errors.forbidden(`${op} cannot read ${db}.${coll}: it is restricted to connection admins`)
}

function subPipeline(w: Walk, op: string, value: unknown, depth: number): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw Errors.validation(`${op}: pipeline must be an array of stages`)
  stagesOf(w, value, depth + 1, false)
}

/** Checks every stage, recursing into the sub-pipelines that can reach other collections. */
function stagesOf(w: Walk, stages: readonly unknown[], depth: number, top: boolean): void {
  if (depth > MAX_NESTING) throw Errors.validation('The pipeline is nested too deeply')
  stages.forEach((stage, i) => {
    const op = stageOperator(stage)
    if (!op) throw Errors.validation(`Stage ${i + 1} must be an object with exactly one $ operator`)
    w.onStage?.(op)
    if (REFUSED_STAGES.has(op)) throw Errors.validation(`${op} cannot be run from the aggregation builder`)
    if (ADMIN_ONLY_STAGES.has(op) && !w.admin)
      throw Errors.forbidden(`${op} is restricted to connection admins`)
    if (op === '$out' || op === '$merge') {
      if (!top || i !== stages.length - 1)
        throw Errors.validation(`${op} can only be the last stage of the pipeline`)
      return
    }
    const value = (stage as Record<string, unknown>)[op]
    switch (op) {
      case '$lookup': {
        if (!isObject(value)) throw Errors.validation('$lookup must be an object')
        // Without `from`, the sub-pipeline starts with $documents; it is still inspected.
        if (value.from !== undefined) readNamespace(w, op, value.from)
        subPipeline(w, op, value.pipeline, depth)
        break
      }
      case '$graphLookup': {
        if (!isObject(value)) throw Errors.validation('$graphLookup must be an object')
        readNamespace(w, op, value.from)
        break
      }
      case '$unionWith': {
        if (typeof value === 'string') {
          readNamespace(w, op, value)
          break
        }
        if (!isObject(value)) throw Errors.validation('$unionWith must be a collection name or an object')
        if (value.coll !== undefined) readNamespace(w, op, { coll: value.coll })
        subPipeline(w, op, value.pipeline, depth)
        break
      }
      case '$facet': {
        if (!isObject(value)) throw Errors.validation('$facet must be an object')
        for (const branch of Object.values(value)) subPipeline(w, op, branch, depth)
        break
      }
    }
  })
}

/**
 * Phase 2a spec §3.1: the checks every aggregation route (and view creation) makes before MongoDB
 * sees the pipeline. Reads of other namespaces follow the direct routes' rule (credential
 * collections need the connection admin role); writes never go to admin, local or config, and
 * into a system collection only for the connection admin.
 */
export function inspectPipeline(
  request: FastifyRequest,
  stages: readonly Record<string, unknown>[],
  db: string,
): { write: WriteTarget | null } {
  stagesOf({ admin: request.connectionRole === 'admin', db }, stages, 0, true)
  assertNoServerJs(request, stages)
  const last = stageOperator(stages[stages.length - 1])
  if (last !== '$out' && last !== '$merge') return { write: null }
  const write = writeTarget(stages, db)
  if (!write) throw Errors.validation(`${last} must name its target collection`)
  if (SYSTEM_DATABASES.has(write.db))
    throw Errors.forbidden(`${last} cannot write into the ${write.db} database`)
  // W4 re-review (minor): nor into a restore drill's scratch database.
  if (isDrillScratch(write.db))
    throw Errors.forbidden(`${last} cannot write into a restore drill’s scratch database`)
  if (request.connectionRole !== 'admin' && isRestrictedNamespace(write.db, write.coll, true))
    throw Errors.forbidden('System namespaces are restricted to connection admins')
  return { write }
}

/**
 * W6.3 security review (I1): every namespace a pipeline reads besides its own collection — through
 * $lookup, $graphLookup, $unionWith and $facet, at any depth. Malformed stages are refused as the
 * aggregation routes refuse them.
 */
export function pipelineReads(
  stages: readonly unknown[],
  db: string,
  onStage?: (op: string) => void,
): Array<{ db: string; coll: string }> {
  const reads: Array<{ db: string; coll: string }> = []
  stagesOf(
    { admin: true, db, onRead: (d, c) => reads.push({ db: d, coll: c }), ...(onStage ? { onStage } : {}) },
    stages,
    0,
    true,
  )
  return reads
}
