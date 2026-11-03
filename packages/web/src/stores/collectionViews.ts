import { markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AggregationMemory } from '@/aggregation/memory'
import type { AssistantStep } from '@/aggregation/steps'
import { defaultQuery, emptyDraft, type FindQuery, type QueryDraft } from '@/documents/queryBuild'
import type { ColumnPrefs, EditDraft, InspectorMode } from '@/documents/rows'
import type {
  ExplainResult,
  ExplainVerbosity,
  Sample,
  ValidationState,
  ValidationTestResult,
} from '@mongo-manager/shared/browser'
import type { Card } from '@/aggregation/stages'
import type { ChartSpec } from '@/documents/chartModel'

/** W1 (completion §2): the results drawn as a chart, beside the table, cards and JSON. */
export type ViewMode = 'table' | 'json' | 'cards' | 'chart'
export type CollectionSection =
  | 'documents'
  | 'aggregations'
  | 'explain'
  | 'schema'
  | 'indexes'
  | 'validation'
  | 'overview'
  | 'watch'
  /** User request 2026-10-23: the collection's personal-data rules. */
  | 'personalData'
  /** User request 2026-10-30: the backups that hold the collection. */
  | 'backups'
  /** Phase 4b §3: a plugin's collection tab, `plugin:<pluginId>:<tabId>`. */
  | `plugin:${string}`

/** Phase 2b: what the Explain section explains; request grows with each "Why is it slow?". */
export interface ExplainState {
  source: 'documents' | 'aggregation'
  verbosity: ExplainVerbosity
  request: number
  /** The last request answered: opening the section again does not run it again (final review 2b, I5). */
  handled: number
  /** The last result, and what it was for (M9). */
  result: ExplainResult | null
  resultFor: string
}

/** Phase 2b: the Validation section's editor, kept with the tab (final review 2b, I3). */
export interface ValidationDraft {
  text: string
  level: ValidationState['validationLevel']
  action: ValidationState['validationAction']
  /** The version of the rules the draft started from: saves are checked against it. */
  base: string
  tested: ValidationTestResult | null
  /** The text the test result is for. */
  testedFor: string
  /** The personal data rules' count it was asked under: shown while they stand (2026-10-26). */
  testedEpoch?: number
}

/** Phase 2a: the aggregation builder's state in a tab. */
export interface AggregationState {
  cards: Card[]
  textMode: boolean
  /** The pipeline as text, while text mode is on. */
  text: string
  /** The text when text mode started: unchanged, the cards are kept as they were. */
  textBase: string
  sample: Sample
  previewMode: 'json' | 'tree'
  /** The saved pipeline these cards were opened from or saved as, when it is the user's. */
  saved: { id: string; name: string; shared: boolean; tags?: string[] } | null
  /** UI redesign R1 review: the words the assistant wrote these stages from. */
  intent: string | null
  /** Words handed over from Documents (a find could not answer them), asked on arrival. */
  pendingAsk: string | null
  /** The words being written for the assistant, kept while other sections are looked at. */
  askDraft: string
  /** The previews and the last run, kept while other sections are looked at (never reactive). */
  memory: AggregationMemory
  /** UI redesign R1 review: the pipeline being built, or the results of its run. */
  pane: 'pipeline' | 'results'
  /** The assistant's steps: each request, its reply, the stages it led to and what changed. */
  steps: AssistantStep[]
  /** The step gone back to, when not the last. */
  stepAt: number | null
  /** The next request changes the stages there are, or writes a new pipeline. */
  askMode: 'change' | 'new'
  /** User review 2026-10-09: the chain the assistant's requests share, for the AI history. */
  aiThread: string | null
  /**
   * Plugins wave 1 review I2: stages a plugin put here (its name, the stages as text) — not
   * previewed until the user changes them or asks: no plugin runs a pipeline without a click.
   */
  handed: { by: string; stages: string } | null
  /**
   * User report 2026-10-13: a pipeline the assistant wrote, opened from the chat to run — the cards
   * as handed over (cardsKey): run once the builder has them, unless they changed since (review M4) or
   * write ($out, $merge are confirmed by the user, never run for them).
   */
  runOnArrival: string | null
  /**
   * W2.2 (2026-10-16): the view whose pipeline these stages are, opened from the view to edit
   * (Compass's "modifying the pipeline backing a view"); Update view writes them back to it.
   */
  editingView: { name: string; base: { viewOn: string; pipeline: unknown[] } } | null
}

export interface QueryIntent {
  prompt: string
  filter: string
  projection: string
  sort: string
}

export interface CollectionViewState {
  section: CollectionSection
  mode: ViewMode
  /** What the user typed. */
  draft: QueryDraft
  /** What was last run (canonical EJSON). */
  query: FindQuery
  /**
   * UI redesign R1 revision 2 §4.2: the words the assistant turned into the draft, and the parts it
   * wrote (the panel names the words while the query run is still the one they produced).
   */
  intent: QueryIntent | null
  /** UI redesign R1 review: Documents' composer mode and the words being written in Ask, kept with the tab. */
  ask: { mode: 'query' | 'ask'; text: string }
  page: number
  /** Table columns chosen in this tab (their order, the hidden ones and their widths). */
  columns: ColumnPrefs
  /** W1 (completion §2): what the results chart draws, kept with the tab. */
  chart: ChartSpec
  /** Reviewer B I1: the inspector and its unsaved edits survive another section or tab. */
  inspector: { mode: InspectorMode | null; draft: EditDraft | null }
  aggregation: AggregationState
  explain: ExplainState
  /** Phase 2b: the rules the last save replaced, to put back while the tab is open. */
  validationDraft: ValidationDraft | null
  validationPrevious: {
    validator: Record<string, unknown> | null
    validationLevel: ValidationState['validationLevel']
    validationAction: ValidationState['validationAction']
  } | null
  /** The personal data rules' count those rules were read under: put back while they stand. */
  validationPreviousEpoch?: number
  /**
   * Research 2026-10-28: fields a plugin suggested as personal data (`by` names it), listed in the
   * Personal data section until each is a rule or the suggestion is dismissed. Nothing is saved on it.
   */
  personalSuggested?: { by: string; fields: string[] } | null
  /**
   * User request 2026-11-02: the sort the tab opened with (newest first), written in its draft — what
   * Reset goes back to. Null: none. `opening`: the tab has not been opened yet, so it may still get one.
   */
  openingSort: string | null
  opening: boolean
}

/** Each collection tab keeps its own query, page and view while other tabs are shown. */
export const useCollectionViewsStore = defineStore('collectionViews', () => {
  const states = ref<Record<string, CollectionViewState>>({})

  function stateFor(tabId: string): CollectionViewState {
    if (!states.value[tabId]) {
      states.value[tabId] = {
        section: 'documents',
        mode: 'table',
        draft: emptyDraft(),
        query: defaultQuery(),
        openingSort: null,
        opening: true,
        intent: null,
        ask: { mode: 'query', text: '' },
        page: 0,
        columns: { order: [], hidden: [], widths: {} },
        chart: { kind: 'bar', x: '', y: '', group: '', measure: 'count' },
        inspector: { mode: null, draft: null },
        aggregation: {
          cards: [],
          textMode: false,
          text: '',
          textBase: '',
          sample: { mode: 'limit', size: 1000 },
          previewMode: 'json',
          saved: null,
          intent: null,
          pendingAsk: null,
          askDraft: '',
          memory: markRaw({ preview: null, run: null }),
          pane: 'pipeline',
          steps: [],
          stepAt: null,
          askMode: 'change',
          handed: null,
          aiThread: null,
          runOnArrival: null,
          editingView: null,
        },
        explain: {
          source: 'documents',
          verbosity: 'executionStats',
          request: 0,
          handled: 0,
          result: null,
          resultFor: '',
        },
        validationDraft: null,
        validationPrevious: null,
      }
    }
    return states.value[tabId]!
  }

  function forget(tabId: string): void {
    delete states.value[tabId]
  }

  /** Drops the state of tabs that no longer exist (closed tabs must not keep old queries). */
  function prune(liveTabIds: ReadonlySet<string>): void {
    for (const id of Object.keys(states.value)) if (!liveTabIds.has(id)) delete states.value[id]
  }

  /** Sign-out: queries can contain data of the previous user. */
  function reset(): void {
    states.value = {}
  }

  /** Reviewer B I1: whether the tab holds edits not yet saved. */
  const hasUnsaved = (tabId: string): boolean => !!states.value[tabId]?.inspector.draft
  const anyUnsaved = (): boolean => Object.values(states.value).some((s) => !!s.inspector.draft)

  return { states, stateFor, forget, prune, reset, hasUnsaved, anyUnsaved }
})
