import { AppError, Errors } from '../../errors'

export const PERSONAL_FIELD = 'personal_field'
export const MASKING_UNSUPPORTED = 'masking_unsupported'
export const PERSONAL_WRITE = 'personal_write'
const shown = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

/**
 * Phase 3c §3: a query, a pipeline, a comparison used a personal field. Names the field and the
 * namespace, never a value (twelfth review of the open's stop, minor 2: "here", not "in a query").
 */
export const personalField = (field: string, ns: string) =>
  Errors.forbidden(`${shown(field)} holds personal data hidden from you and cannot be used here`, {
    reason: PERSONAL_FIELD,
    field: shown(field),
    ns,
  })

/** Phase 3c §5: a write would change, remove, move or bring a personal value. */
export const personalWrite = (field: string, ns: string) =>
  Errors.forbidden(`${shown(field)} holds personal data and cannot be changed`, {
    reason: PERSONAL_WRITE,
    field: shown(field),
    ns,
  })

export const PERSONAL_INDEX = 'personal_index'

/**
 * Eighth review: an explain whose plan reads an index holding personal data. Its counts would tell
 * how many values a document holds there; the index's definition is the user's to see already.
 */
export const personalIndex = (ns: string) =>
  Errors.forbidden(
    'This plan reads an index that holds personal data hidden from you: it is not explained (a query that uses another index is)',
    {
      reason: PERSONAL_INDEX,
      ns,
    },
  )

/** A plan refused for what personalPlan could not tell, said as such, not as a personal index. */
export const planRefused = (refusal: { ns: string; why: 'index' | 'too_many' | 'unplaced' }) =>
  refusal.why === 'index'
    ? personalIndex(refusal.ns)
    : notSupported(
        refusal.why === 'too_many'
          ? 'A plan reading this many collections'
          : 'A plan using an index that cannot be listed here',
        refusal.ns,
      )

/**
 * Fourteenth review of explain masking (I-B): no order hides a hidden value here. Marked, so a
 * caller that can do without an order (a backup leaving the collection out) tells it from the
 * gate's other refusals.
 */
export const orderRefused = (what: string, ns: string) =>
  Errors.forbidden(`${shown(what)} is not available while personal data is hidden`, {
    reason: MASKING_UNSUPPORTED,
    what: shown(what),
    ns,
    order: true,
  })

/** Whether the gate refused for want of an order that hides what rules hide (see orderRefused). */
export const isOrderRefusal = (e: unknown): boolean =>
  (e as { details?: { order?: unknown } } | null)?.details?.order === true

/** Something the gate does not model, or cannot guard here: refused while values are hidden. */
export const notSupported = (what: string, ns: string, extra: { unique?: true; indexes?: true } = {}) =>
  Errors.forbidden(`${shown(what)} is not available while personal data is hidden`, {
    reason: MASKING_UNSUPPORTED,
    what: shown(what),
    ns,
    // Final review of the agent's gate (nit): what refused it, for a caller to say (a unique index,
    // indexes that could not be read), whatever the text's length.
    ...extra,
  })

/**
 * Final review of the agent's gate (M-2): a refusal for indexes that could not be read is the job's,
 * not one record's: the next record would be refused the same way.
 */
export const isIndexesRefusal = (e: unknown): boolean =>
  e instanceof AppError && (e.details as { indexes?: unknown } | undefined)?.indexes === true

/**
 * Final review of the agent's gate (next round, M-B, M-2): a collection's indexes, or its catalog
 * entry, could not be listed for a reason of the server's (a step-down, a shard out of reach, a time
 * limit): nothing is written, and the caller stops, said as that failure (a route answers it as the
 * failure, `cause`).
 */
export class IndexListingFailed extends Error {
  constructor(failure: unknown, what: 'indexes' | 'catalog' = 'indexes') {
    super(
      `The collection's ${what === 'indexes' ? 'indexes' : 'catalog entry'} could not be read: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    )
    this.name = 'IndexListingFailed'
  }
}
