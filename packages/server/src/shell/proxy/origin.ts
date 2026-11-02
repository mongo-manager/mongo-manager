import { EJSON } from 'bson'
import type { QueryOrigin } from '@mongo-manager/shared'
import type { Command } from './policy'

/**
 * Phase 3a-2 spec §3.3: the origin of a shell result — the find or collection aggregate the proxy
 * relayed — in a shape the collection view can reopen. Only the reopenable parts are kept; session,
 * cluster and read-preference fields never appear. An origin over 64 KiB is dropped.
 */
export const MAX_ORIGIN_BYTES = 64 * 1024

const ejson = (value: unknown): unknown => EJSON.serialize(value as never, { relaxed: false })

const count = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function')
    return (value as { toNumber(): number }).toNumber()
  return undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function queryOriginOf(cmd: Command): QueryOrigin | null {
  const { body } = cmd
  let origin: QueryOrigin | null = null
  if (cmd.name === 'find' && typeof body.find === 'string') {
    const skip = count(body.skip)
    const limit = count(body.limit)
    origin = {
      kind: 'find',
      db: cmd.db,
      coll: body.find,
      filter: isObject(body.filter) ? (ejson(body.filter) as Record<string, unknown>) : {},
      ...(isObject(body.projection) ? { projection: ejson(body.projection) as Record<string, unknown> } : {}),
      ...(isObject(body.sort) ? { sort: ejson(body.sort) as Record<string, unknown> } : {}),
      ...(skip !== undefined ? { skip } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(isObject(body.collation) ? { collation: ejson(body.collation) as Record<string, unknown> } : {}),
      ...(typeof body.hint === 'string'
        ? { hint: body.hint }
        : isObject(body.hint)
          ? { hint: ejson(body.hint) as Record<string, unknown> }
          : {}),
    }
  } else if (cmd.name === 'aggregate' && typeof body.aggregate === 'string' && Array.isArray(body.pipeline)) {
    origin = {
      kind: 'aggregate',
      db: cmd.db,
      coll: body.aggregate,
      pipeline: ejson(body.pipeline) as unknown[],
    }
  }
  if (!origin) return null
  return Buffer.byteLength(JSON.stringify(origin)) > MAX_ORIGIN_BYTES ? null : origin
}
