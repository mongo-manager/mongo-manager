/**
 * Phase 2a: facts about a pipeline that the web app and the server both need, read from the
 * decoded stage values (never from shell text).
 */

export const WRITE_STAGES = ['$out', '$merge'] as const
export type WriteStage = (typeof WRITE_STAGES)[number]

export interface WriteTarget {
  db: string
  coll: string
  stage: WriteStage
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The operator of a stage: its single key, when that key starts with `$`; else null. */
export function stageOperator(stage: unknown): string | null {
  if (!isPlainObject(stage)) return null
  const keys = Object.keys(stage)
  return keys.length === 1 && keys[0]!.startsWith('$') ? keys[0]! : null
}

const isWriteStage = (op: string | null): op is WriteStage => op === '$out' || op === '$merge'

/** True when the last stage writes ($out or $merge): the only place MongoDB allows one. */
export function isWritePipeline(stages: readonly unknown[]): boolean {
  return stages.length > 0 && isWriteStage(stageOperator(stages[stages.length - 1]))
}

/** A `{db?, coll}` namespace, or a bare collection name; null when neither. */
function namespace(value: unknown, db: string): { db: string; coll: string } | null {
  if (typeof value === 'string') return value ? { db, coll: value } : null
  if (!isPlainObject(value) || typeof value.coll !== 'string' || !value.coll) return null
  if (value.db !== undefined && (typeof value.db !== 'string' || !value.db)) return null
  return { db: (value.db as string | undefined) ?? db, coll: value.coll }
}

/**
 * Where the pipeline's last stage writes, in every form MongoDB accepts:
 * `$out: 'c'`, `$out: {db, coll}`, `$merge: 'c'`, `$merge: {into: 'c' | {db, coll}}`.
 * Null when the pipeline does not write, or names its target in a form we do not understand.
 */
export function writeTarget(stages: readonly unknown[], db: string): WriteTarget | null {
  const last = stages[stages.length - 1]
  const op = stageOperator(last)
  if (!isWriteStage(op)) return null
  const value = (last as Record<string, unknown>)[op]
  const target = op === '$merge' && isPlainObject(value) ? namespace(value.into, db) : namespace(value, db)
  return target ? { ...target, stage: op } : null
}
