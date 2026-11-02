/**
 * Data review 2026-10-13 (M2, M3; round 2 Minor 9–11): what is said of a field the app would not
 * write back as stored — before a change (a caution on the document) or when one is refused.
 */
export type CautionKind = 'ejson_like' | 'undefined' | 'too_deep' | 'unmatched' | 'bad_date'
export interface Caution {
  kind: CautionKind
  field: string
  /** How many more such fields the document holds. */
  others?: number
}
type Translate = (key: string, params?: Record<string, unknown>) => string

/** A kind as the server sends it; one it does not know reads as a misread name. */
export function cautionKind(kind: unknown): CautionKind {
  return kind === 'undefined' || kind === 'too_deep' || kind === 'unmatched' || kind === 'bad_date'
    ? kind
    : 'ejson_like'
}

/** Whether no change of the document can be made from here, whatever it touches. */
export const locksDocument = (c: Pick<Caution, 'kind'>) => c.kind !== 'ejson_like' && c.kind !== 'bad_date'

/** Whether a change of `path` (a top-level field, a dotted path) touches the cautioned field. */
export function touches(c: Caution, path: string): boolean {
  if (locksDocument(c) || !c.field) return true
  return c.field === path || c.field.startsWith(`${path}.`) || path.startsWith(`${c.field}.`)
}

/**
 * The words for a caution: `refused` when a save was refused; `edit` before one, saying what can
 * still change; `clone` before a copy, which would hold the value shown.
 */
export function cautionText(t: Translate, raw: Partial<Caution>, when: 'refused' | 'edit' | 'clone'): string {
  const c: Caution = { kind: cautionKind(raw.kind), field: String(raw.field ?? ''), others: raw.others }
  const field = c.field
  let text: string
  if (c.kind === 'unmatched' || !field) text = t('documents.notRoundTrip.unmatched')
  else if (when === 'clone') text = t('documents.cloneCaution', { field })
  else if (when === 'edit')
    text = locksDocument(c)
      ? t(`documents.notRoundTrip.${c.kind}`, { field })
      : t('documents.editCaution', { field })
  else text = t(`documents.notRoundTrip.${c.kind}`, { field })
  return c.others ? `${text} ${t('documents.cautionOthers', { count: c.others })}` : text
}
