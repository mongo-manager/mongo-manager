// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AI_CHAT_LIMITS, type AiChatTurnRecord, type AiPolicy } from '@mongo-manager/shared'
import type { StoredTurn } from './chats'
import type { WireTurn } from './wire'
import { isAdminOnlyNs } from '../connections/access'

/** What an earlier turn's connection allows now; null: it may not travel at all. */
export interface TurnAccess {
  policy: AiPolicy
  rulesVersion: number
}

export interface History {
  messages: WireTurn[]
  /** How many earlier turns travel. */
  sent: number
  /** "history:<cause>:<count>": bounds, access, rules, local, unreadable. */
  leftOut: string[]
  /** A local-only connection's turn travels: the request may only reach the listed networks. */
  privateOnly: boolean
  /** Plan ruling 18: the connections whose data the history carries (the new turn inherits them). */
  sources: AiChatTurnRecord['sources']
  /** Fourth review (I-A): the connections the turns sent named (the new turn inherits them). */
  named: string[]
  /** Share review C1: a turn sent may carry a credential collection's data. */
  credential: boolean
  /**
   * Design 2026-10-25 (B7; review I1): what earlier agent turns' steps did — as data for the new turn's
   * envelope, never inside an answer — oldest first, each by how many turns ago it was.
   */
  earlier: Array<{ turnsAgo: number; steps: readonly unknown[] }>
}

/** Spec §2.3: an earlier user message names what it was about. */
export const earlierUserMessage = (namespace: string | null, text: string) =>
  `${namespace ? `[About ${namespace}]` : '[General]'}\n${text}`

/**
 * Phase 4a-2 spec §2.2, C3: the earlier turns that may travel with a new one — newest first while
 * 20 turns and 24 KiB hold; only answers that ended done; each re-checked against the caller's
 * rights, the connection's policy and its personal-data rules, as they are now.
 */
export function buildHistory(
  turns: StoredTurn[],
  access: (connectionId: string) => TurnAccess | null,
  providerCloud: boolean,
  /**
   * W6.3 security review (minor 6): the provider may receive documents. An answer written from
   * documents sent with its turn may quote their values: it travels only to such a provider.
   */
  providerSamples = true,
  /**
   * Third review of the connection names (I-2): a named connection's policy now (null: gone). Only
   * the policy counts — a name carries no data, so neither its rules nor the caller's rights do.
   */
  // Fourth review (M-C): a caller that does not say keeps every turn naming one back.
  policyOf: (connectionId: string) => AiPolicy | null = () => 'off',
  /** Design 2026-10-25 (B7): what a turn's steps did, told as data (the agent's turns). */
  stepsOf: (record: StoredTurn['record']) => readonly unknown[] | null = () => null,
): History {
  // Fifth review (M7): read once per connection, however many turns name it.
  const policies = new Map<string, AiPolicy | null>()
  const policyNow = (id: string) => {
    if (!policies.has(id)) policies.set(id, policyOf(id))
    return policies.get(id)!
  }
  const counts = { bounds: 0, access: 0, rules: 0, local: 0, samples: 0, unreadable: 0 }
  const kept: WireTurn[][] = []
  const sources = new Map<string, number>()
  const named = new Set<string>()
  let credential = false
  let bytes = 0
  let full = false
  let privateOnly = false
  const earlier: History['earlier'] = []
  let ago = 0
  for (const turn of [...turns].reverse()) {
    ago++
    // Review of B7 (I5): an agent turn travels by what its steps did even when its answer did not end
    // well (a provider's error after a drop) — the steps hold names and counts only.
    const steps = stepsOf(turn.record)
    const told = steps?.length ? { turnsAgo: ago, steps } : null
    const readable = turn.user.text !== null && turn.answer.text !== null
    // An empty answer is no message to a provider (and breaks the alternation some require).
    const answered = turn.record.state === 'done' && readable && !!turn.answer.text!.trim()
    // Review of B8 (N1): unreadable only when nothing of it travels.
    if (!answered && !told) {
      if (turn.record.state === 'done' && !readable) counts.unreadable++
      continue
    }
    if (full) {
      counts.bounds++
      continue
    }
    if (!providerSamples && turn.record.parts.samples > 0) {
      counts.samples++
      continue
    }
    // Plan ruling 18: every connection that fed the answer must still allow it to travel.
    let local = false
    let blocked: 'access' | 'rules' | 'local' | null = null
    for (const s of turn.record.sources ?? []) {
      const a = access(s.connectionId)
      if (!a) blocked = 'access'
      else if (a.rulesVersion !== s.rulesVersion) blocked = 'rules'
      else if (a.policy === 'local') {
        if (providerCloud) blocked = 'local'
        else local = true
      }
      if (blocked) break
    }
    for (const id of blocked ? [] : (turn.record.named ?? [])) {
      const policy = policyNow(id)
      if (policy === 'off') blocked = 'access'
      // Gone (sixth review): one made again under its name may be local-only — held as one is: off a
      // cloud provider, the request kept inside otherwise; carried on as any named one (eighth
      // review): a later answer may repeat the name, and, gone, it is no candidate to find it by.
      else if (policy === 'local' || policy === null) {
        if (providerCloud) blocked = 'local'
        else local = true
      }
      if (blocked) break
    }
    if (blocked) {
      counts[blocked]++
      continue
    }
    const pair: WireTurn[] = answered
      ? [
          { role: 'user', content: earlierUserMessage(turn.record.namespace, turn.user.text!) },
          { role: 'assistant', content: turn.answer.text! },
        ]
      : []
    // The steps told count toward the history's bytes too — as the envelope writes them, "<" escaped
    // (review of B8, M4).
    const size =
      pair.reduce((n, m) => n + Buffer.byteLength(m.content), 0) +
      (told ? Buffer.byteLength(JSON.stringify(told).replace(/</g, '\\u003c')) : 0)
    if (kept.length >= AI_CHAT_LIMITS.historyTurns || bytes + size > AI_CHAT_LIMITS.historyBytes) {
      full = true
      counts.bounds++
      continue
    }
    kept.push(pair)
    if (told) earlier.push(told)
    bytes += size
    if (local) privateOnly = true
    for (const s of turn.record.sources ?? []) sources.set(s.connectionId, s.rulesVersion)
    for (const id of turn.record.named ?? []) named.add(id)
    // A turn kept before the mark existed may have carried one: counted, to be safe.
    if (turn.record.credential !== false || isAdminOnlyNs(turn.record.namespace)) credential = true
  }
  return {
    messages: kept.reverse().flat(),
    sent: kept.length,
    leftOut: Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([cause, n]) => `history:${cause}:${n}`),
    privateOnly,
    sources: [...sources].map(([connectionId, rulesVersion]) => ({ connectionId, rulesVersion })),
    named: [...named],
    credential,
    earlier: earlier.reverse(),
  }
}
