import type { AiAction, AiRequestBody, AiResult } from '@mongo-manager/shared/browser'
import { buildQuery } from '@/documents/queryBuild'
import { decodeValue, toShell } from '@/documents/values'
import { cardsFromStages, toPipeline } from '@/aggregation/stages'
import { useCollectionViewsStore, type CollectionSection } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** Plan ruling 17: what Ask AI offers on each section, the first one chosen. */
export function actionsFor(section: CollectionSection, isView: boolean): AiAction[] {
  switch (section) {
    case 'documents':
      return ['query', 'explain']
    case 'aggregations':
      return ['pipeline', 'explain']
    case 'explain':
      return ['optimise', 'explain']
    case 'validation':
      return isView ? ['describe'] : ['validation']
    case 'schema':
      return ['describe']
    // Review of the tabs (nit 16): the rules page asks the assistant only to describe the data; so
    // does a collection's Backups page (review of the branch, M7: a query has no place there).
    case 'personalData':
    case 'backups':
      return ['describe']
    default:
      return ['query', 'describe']
  }
}

/** The editor's content as canonical EJSON (plan ruling 3); what the action is about. */
export function currentFor(tabId: string, action: AiAction): AiRequestBody['current'] {
  const state = useCollectionViewsStore().stateFor(tabId)
  const pipelineFirst =
    action === 'pipeline' ||
    (action !== 'query' &&
      (state.section === 'aggregations' ||
        (state.section === 'explain' && state.explain.source === 'aggregation')))
  if (pipelineFirst) {
    const built = toPipeline(state.aggregation.cards)
    return built.stages.length && !built.error ? { pipeline: built.stages } : undefined
  }
  if (action === 'validation' || action === 'describe') return undefined
  const built = buildQuery(state.draft)
  if (!built.ok) return undefined
  const { filter, projection, sort } = built.query
  if (!Object.keys(filter).length && !projection && !sort) return undefined
  return { filter, ...(projection ? { projection } : {}), ...(sort ? { sort } : {}) }
}

// The query bar's fields are single lines, as a library item opens them (indent 0).
const shell = (v: Record<string, unknown> | undefined) =>
  v && Object.keys(v).length ? toShell(decodeValue(v), 0) : ''

/** Spec §1.2: the result replaces the editor's content, after a question when the editor holds work. */
export async function insertResult(tabId: string, result: AiResult, t: Translate): Promise<boolean> {
  const state = useCollectionViewsStore().stateFor(tabId)
  const ask = (what: string) =>
    useDialogStore().confirm({
      title: t('ai.insert.title'),
      message: t(`ai.insert.${what}`),
      confirmLabel: t('ai.insert.replace'),
    })
  if (result.kind === 'query') {
    const d = state.draft
    if ((d.filter.trim() || d.projection.trim() || d.sort.trim()) && !(await ask('query'))) return false
    state.draft = {
      ...d,
      filter: shell(result.filter),
      projection: shell(result.projection),
      sort: shell(result.sort),
    }
    state.section = 'documents'
    return true
  }
  if (result.kind === 'pipeline') {
    const agg = state.aggregation
    if ((agg.cards.length > 0 || (agg.textMode && agg.text.trim() !== '')) && !(await ask('pipeline')))
      return false
    agg.cards = cardsFromStages(result.stages).cards
    agg.textMode = false
    agg.saved = null
    // These stages belong to no chain of the assistant's: a change of them starts one.
    agg.aiThread = null
    state.section = 'aggregations'
    return true
  }
  if (result.kind === 'validation') {
    // Plan ruling 15: the draft carries the version saves are checked against.
    const draft = state.validationDraft
    if (!draft) return false
    if (draft.text.trim() && !(await ask('validation'))) return false
    draft.text = toShell(decodeValue(result.validator))
    draft.tested = null
    state.section = 'validation'
    return true
  }
  return false
}
