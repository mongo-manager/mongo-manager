import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Db, Document } from 'mongodb'
import {
  ERROR_AND_LOG_SINCE,
  ValidationBodySchema,
  ValidationTestSchema,
  parseMongoVersion,
  serializeValue,
  toWire,
  type ValidationSaved,
  type ValidationState,
  type ValidationTestResult,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { READ_OPTIONS, fromClient } from '../../data/ejson-io'
import { trackOperation } from '../../data/operations'
import { maskerFor } from '../../masking/request'
import { maskValidator } from '../../masking/definitions'
import { gateFor } from '../../masking/restricted'
import { PERSONAL_FIELD, guardFind, guardValidator, isOrderRefusal } from '../../masking/gate'
import { presenterFor } from '../../masking/present'
import { holdReadSlot } from '../../data/page'
import { CollParams, assertNoServerJs, assertTargetAllowed } from './params'
import { refuseRepeats, repeatsRefused } from '../../masking/repeats'

const BASE = '/connections/:id/databases/:db/collections/:coll/validation'
/** The validator's canonical EJSON, at most, in bytes (spec §2.2). */
const MAX_VALIDATOR_BYTES = 256 * 1024
/** failingAtLeast counts up to this many when the full count takes too long. */
export const LOWER_BOUND_LIMIT = 10_000
/** The failing examples stop at this much encoded output (final review 2b, M12). */
const SAMPLE_BYTES = 4 * 1024 * 1024
const TIME_LIMIT_CODE = 50

const isTimeLimit = (e: unknown) => (e as { code?: unknown })?.code === TIME_LIMIT_CODE

async function serverVersion(db: Db): Promise<string> {
  return String((await db.admin().command({ buildInfo: 1 })).version)
}

/** Bytes, not characters (final review 2b, M2). */
function checkSize(validator: unknown): void {
  if (Buffer.byteLength(JSON.stringify(validator ?? null)) > MAX_VALIDATOR_BYTES)
    throw Errors.validation('The rules are too large (256 KiB at most)')
}

/** The rules as stored now; `version` identifies them, so a save can refuse rules changed since. */
async function stateOf(request: FastifyRequest, dbName: string, coll: string): Promise<ValidationState> {
  const db = (await clientFor(request)).db(dbName)
  const [info] = (await withMongo(() =>
    db.listCollections({ name: coll }, { ...READ_OPTIONS } as never).toArray(),
  )) as Array<{ type?: string; options?: Document }>
  if (!info) throw Errors.notFound('Collection not found')
  const options = (info.options ?? {}) as Document
  const validator = options.validator as Document | undefined
  const rules = {
    validator:
      validator && Object.keys(validator).length
        ? (serializeValue(validator) as Record<string, unknown>)
        : null,
    validationLevel: (options.validationLevel ?? 'strict') as ValidationState['validationLevel'],
    validationAction: (options.validationAction ?? 'error') as ValidationState['validationAction'],
  }
  return {
    ...rules,
    // Keyed (phase 3c §4.5): a plain digest would let a restricted user confirm a guessed value.
    version: createHmac('sha256', request.server.ctx.rulesVersionKey).update(toWire(rules)).digest('hex'),
    kind: info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection',
    serverVersion: await withMongo(() => serverVersion(db)),
  }
}

/** Phase 2b spec §2.2: read, set and test a collection's validation rules. */
export async function validationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    BASE,
    { preHandler: requireConnection('databases:read'), config: { masking: 'guarded' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const state = await stateOf(request, db, coll)
      const masker = maskerFor(request)
      return masker && state.validator
        ? {
            ...state,
            validator: maskValidator(state.validator, db, coll, masker) as ValidationState['validator'],
          }
        : state
    },
  )

  app.put(
    BASE,
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'guarded', audit: 'collections.validation' },
    },
    async (request): Promise<ValidationSaved> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ValidationBodySchema, request.body ?? {})
      // The rules can hold values (enums, patterns): only the level and the action are logged.
      request.auditInfo = { details: { level: body.validationLevel, action: body.validationAction } }
      assertTargetAllowed(request, db, coll)
      checkSize(body.validator)
      const validator = body.validator ? fromClient<Document>(body.validator, 'validator') : {}
      assertNoServerJs(request, validator)
      // Phase 3c §5.4: a restricted user's validator uses no personal field ($jsonSchema neither).
      const gate = gateFor(request, await clientFor(request))
      if (gate) await withMongo(() => guardValidator(db, coll, validator, gate))
      const masker = maskerFor(request)
      const database = (await clientFor(request)).db(db)
      if (body.validationAction === 'errorAndLog') {
        const version = parseMongoVersion(await withMongo(() => serverVersion(database)))
        const [major, minor] = ERROR_AND_LOG_SINCE.split('.').map(Number) as [number, number]
        if (!version || version.major < major || (version.major === major && version.minor < minor))
          throw Errors.validation(`errorAndLog needs MongoDB ${ERROR_AND_LOG_SINCE} or newer`)
      }
      // Read just before writing: what this save replaces (for Restore), and a check that nobody
      // changed the rules since this user read them (final review 2b, I3).
      const before = await stateOf(request, db, coll)
      if (body.expected && body.expected !== before.version)
        throw new AppError(
          'CONFLICT',
          'The rules were changed since you opened them; reload them before saving',
          409,
          { reason: 'rules_changed' },
        )
      await withMongo(() =>
        database.command({
          collMod: coll,
          validator,
          validationLevel: body.validationLevel,
          validationAction: body.validationAction,
        }),
      )
      return {
        ...(await stateOf(request, db, coll)),
        previous: {
          // Someone else's rules: their values at personal paths stay hidden (§4.5).
          validator:
            masker && before.validator
              ? (maskValidator(before.validator, db, coll, masker) as ValidationState['validator'])
              : before.validator,
          validationLevel: before.validationLevel,
          validationAction: before.validationAction,
        },
      }
    },
  )

  app.post(
    `${BASE}/test`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply): Promise<ValidationTestResult> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ValidationTestSchema, request.body ?? {})
      checkSize(body.validator)
      const validator = fromClient<Document>(body.validator, 'validator')
      assertNoServerJs(request, validator)
      // Security audit 2026-10-16 (Important 2): the test counts the whole collection (up to 120 s) —
      // one of the user's run slots, as a run.
      holdReadSlot(request, reply, request.server.ctx.aggregation.slots)
      const client = await clientFor(request)
      // Phase 3c §3.1: a validator is a filter, so a probe; the failing samples are masked, and
      // come in the gate's order, never a hidden value's (twelfth review, Minor 4).
      const gate = gateFor(request, client)
      const guarded = gate
        ? await withMongo(() => guardFind(db, coll, { filter: validator }, gate, { order: false }))
        : null
      // The samples' order; none where no order hides a hidden value: the counts still answer
      // (thirteenth review, M5).
      const order = gate
        ? await withMongo(() => guardFind(db, coll, { filter: validator }, gate)).catch((e: unknown) => {
            if (isOrderRefusal(e)) return null
            throw e
          })
        : undefined
      const present = presenterFor(request, guarded?.output ?? null, {
        ns: `${db}.${coll}`,
        stored: !guarded?.fromView,
      })
      const comment = trackOperation(request, reply, client)
      const collection = client.db(db).collection(coll)
      const failingFilter = { $nor: [guarded?.filter ?? validator] }
      // One budget for the whole test: each call gets what is left of it (final review 2b, I1).
      const deadline = Date.now() + body.maxTimeMS
      const left = () => Math.max(100, deadline - Date.now())
      const total = await withMongo(() => collection.estimatedDocumentCount({ maxTimeMS: left(), comment }))
      let failing: number | null = null
      let failingAtLeast: number | undefined
      try {
        failing = await collection.countDocuments(failingFilter, { maxTimeMS: left(), comment })
      } catch (e) {
        if (!isTimeLimit(e)) return withMongo(() => Promise.reject(e))
        try {
          failingAtLeast = await collection.countDocuments(failingFilter, {
            maxTimeMS: left(),
            comment,
            limit: LOWER_BOUND_LIMIT,
          })
        } catch (e2) {
          if (!isTimeLimit(e2)) return withMongo(() => Promise.reject(e2))
        }
      }
      // Examples help; they are not the answer: none when time ran out for them.
      let docs: Document[] = []
      try {
        if (order !== null)
          docs = await collection
            .find(failingFilter, {
              ...READ_OPTIONS,
              ...(order?.sort ? { sort: order.sort } : {}),
              ...(order?.hint ? { hint: order.hint } : {}),
              maxTimeMS: left(),
              comment,
              limit: 10,
            })
            .toArray()
        // A page the order's check refuses (a document _id that may hold a hidden value) is no
        // sample; the counts still answer (fourteenth review, Minor 1).
        if (order)
          try {
            const read = docs
            docs = []
            const ids = order.repeats ? read.map((x) => x._id) : []
            const finished = order.finish(read)
            if (order.repeats)
              await refuseRepeats(collection, ids, { comment, maxTimeMS: left() }).catch((e: unknown) => {
                // A question not answered in time is no answer: the sample stays out (nineteenth review, I1).
                if (isTimeLimit(e)) throw repeatsRefused(`${db}.${coll}`)
                throw e
              })
            docs = finished
          } catch (e) {
            // Nor a page of a time series' equal _ids (sixteenth review, M3).
            if (
              (e as { details?: { reason?: unknown } }).details?.reason !== PERSONAL_FIELD &&
              !isOrderRefusal(e)
            )
              throw e
            docs = []
          }
      } catch (e) {
        if (!isTimeLimit(e)) return withMongo(() => Promise.reject(e))
      }
      const sample: ValidationTestResult['sample'] = []
      let bytes = 0
      let sampleTruncated = false
      for (const doc of docs) {
        const item = present.item(doc)
        const size = Buffer.byteLength(JSON.stringify(item))
        if (bytes + size > SAMPLE_BYTES) {
          sampleTruncated = true
          break
        }
        bytes += size
        sample.push(item)
      }
      return {
        total,
        failing,
        ...(failingAtLeast !== undefined ? { failingAtLeast } : {}),
        sample,
        ...(sampleTruncated ? { sampleTruncated } : {}),
      }
    },
  )
}
