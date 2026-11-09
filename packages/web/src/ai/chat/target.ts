// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AiAgentShow, AiResult } from '@mongo-manager/shared/browser'
import { useTabsStore } from '@/stores/tabs'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { openCollectionTab } from '@/workspace/openTabs'
import { insertResult } from '../insert'
import { buildQuery } from '@/documents/queryBuild'
import { cardsKey } from '@/aggregation/stages'
import type { ChatTarget, TurnWhere } from './store'

type Translate = (key: string, values?: Record<string, unknown>) => string
interface TabLike {
  id: string
  kind: string
  params: Record<string, string | undefined>
}

/** Spec §1.2: the active tab as the chat's subject — a collection tab, or nothing (general help). */
export function chatTargetOf(tab: TabLike | null | undefined): ChatTarget | null {
  const p = tab?.kind === 'collection' ? tab.params : undefined
  return tab && p?.connectionId && p.db && p.coll
    ? { connectionId: p.connectionId, db: p.db, coll: p.coll, tabId: tab.id }
    : null
}

/**
 * Spec §1.4, C7: a block goes into the collection tab of the turn that wrote it — the active tab when
 * it is that collection, else that collection's tab, opened (or found). A general turn's block goes
 * into the active collection tab, or nowhere.
 */
export function tabForTurn(where: TurnWhere | null, active: ChatTarget | null): ChatTarget | null {
  if (!where) return active
  if (
    active &&
    active.connectionId === where.connectionId &&
    active.db === where.db &&
    active.coll === where.coll
  )
    return active
  const tabId = openCollectionTab(useTabsStore(), where.connectionId, where.db, where.coll)
  return { ...where, tabId }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Inserts with 4a-1's confirmation; a validator waits (5 s at most) for the Validation draft to load. */
export async function insertFromChat(
  tabId: string,
  result: AiResult,
  t: Translate,
): Promise<'inserted' | 'cancelled' | 'not_ready'> {
  const views = useCollectionViewsStore()
  if (result.kind === 'validation' && !views.stateFor(tabId).validationDraft) {
    views.stateFor(tabId).section = 'validation'
    for (let i = 0; i < 50 && !views.stateFor(tabId).validationDraft; i++) await sleep(100)
    if (!views.stateFor(tabId).validationDraft) return 'not_ready'
  }
  return (await insertResult(tabId, result, t)) ? 'inserted' : 'cancelled'
}

/**
 * User report 2026-10-13: a pipeline the assistant wrote, opened in its collection's builder to run
 * there (never one that writes: the builder leaves that to the user).
 */
export async function runPipelineIn(
  tabId: string,
  result: Extract<AiResult, { kind: 'pipeline' }>,
  t: Translate,
): Promise<'ran' | 'cancelled'> {
  if (!(await insertResult(tabId, result, t))) return 'cancelled'
  const agg = useCollectionViewsStore().stateFor(tabId).aggregation
  agg.runOnArrival = cardsKey(agg.cards)
  return 'ran'
}

/**
 * The AI database manager (design 2026-10-25, A1): what the agent opened a collection to show — the
 * find run there, a pipeline put in the builder and run (one that writes only put there), each asking
 * first when the tab holds work, as a block's Run does.
 */
export async function showIn(
  tabId: string,
  show: AiAgentShow,
  t: Translate,
): Promise<'ran' | 'placed' | 'cancelled' | 'invalid'> {
  if (show.kind === 'query') {
    // As many documents as were asked for, once the person's query is the agent's (never on a cancel).
    return runQueryIn(tabId, show, t, show.limit)
  }
  // One that writes is only put there, for the person to run (nothing ran).
  if (show.writes) return (await insertResult(tabId, show, t)) ? 'placed' : 'cancelled'
  return runPipelineIn(tabId, show, t)
}

/**
 * User request 2026-10-10: Run — the query put in the collection tab's query bar (asking first when
 * the bar holds work, its collation, hint and skip kept: review I5), then run there, as if the user
 * had applied it.
 */
export async function runQueryIn(
  tabId: string,
  result: Extract<AiResult, { kind: 'query' }>,
  t: Translate,
  /** Design 2026-10-25 (A1): as many documents as the agent asked for (re-review M5: set once). */
  limit?: number,
): Promise<'ran' | 'cancelled' | 'invalid'> {
  if (!(await insertResult(tabId, result, t))) return 'cancelled'
  const state = useCollectionViewsStore().stateFor(tabId)
  if (limit) state.draft = { ...state.draft, limit }
  const built = buildQuery(state.draft)
  if (!built.ok) return 'invalid'
  state.query = { ...built.query, limit: state.draft.limit }
  state.page = 0
  return 'ran'
}
