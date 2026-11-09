// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { permissionsFor, type AiChatTarget } from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../http/context'
import { SYSTEM_DATABASES, effectiveRole, isDrillScratch } from '../connections/access'
import type { ConnectionRecord } from '../connections/repo'
import { connectionLabels, type Named } from './labels'

/**
 * User request 2026-10-10: a general assistant turn is told the collections the person may open,
 * so that its answer can name one and the panel can run the query there. Names only — never a
 * document, a field or a value — and only of connections whose assistant is on, that the person may
 * read and use the assistant on; a local-only connection only when the provider is known to be local.
 * System databases and collections are never named.
 */
export const CATALOGUE_LIMIT = 300
/** The connections whose collections are listed, the most recently used first (all are named). */
const CONNECTIONS = 10
/** At most this many connections named (names only). */
const MAX_NAMED = 200
/** Review I6: how long one connection may take; what it listed by then is kept. */
const PER_CONNECTION_MS = 4000
/** Review I6: a connection's list is kept this long — a general question does not list again. */
const KEEP_MS = 60_000
/** Databases listed at once on one connection. */
const PARALLEL = 4

/** Fifth review (M5): the connections named to the assistant — by a turn about a collection too. */
export interface Naming {
  /** Their labels, as sent. */
  names: string[]
  /** By id and label: those a turn names are recorded as named. */
  labelled: Named[]
  /** A local-only connection is named: the request must stay inside. */
  local: boolean
}

/** The connections the person may use with the assistant, most recently used first. */
function eligibleConnections(ctx: ServerContext, principal: Principal, providerLocal: boolean | null) {
  return ctx.connections
    .list()
    .filter((c) => {
      if (c.aiPolicy === 'off') return false
      if (c.aiPolicy === 'local' && providerLocal !== true) return false
      const role = effectiveRole(ctx, principal, c.id)
      const may = role ? permissionsFor(role) : null
      return !!may && may.has('ai:use') && may.has('documents:read') && may.has('databases:read')
    })
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}

function namingOf(eligible: ConnectionRecord[], labels: Map<string, string>): Naming {
  const names: string[] = []
  const labelled: Named[] = []
  let local = false
  // Review of fa862922 (I2): every one named — a new connection, never used, was the first left out.
  for (const c of eligible.slice(0, MAX_NAMED)) {
    const label = labels.get(c.id)!
    names.push(label)
    labelled.push({ id: c.id, label, name: c.name })
    // A name carries no data: a connection only named is no source of the turn — a change there
    // would leave every earlier general turn out, and hide a shared one (second review, I-A to I-C).
    // One the turn names is recorded as named, its policy checked later (third review, I-2).
    if (c.aiPolicy === 'local') local = true
  }
  return { names, labelled, local }
}

/** Fifth review (M5): the connections named with a turn about a collection — names only. */
export function connectionNaming(
  ctx: ServerContext,
  principal: Principal,
  providerLocal: boolean | null,
): Naming {
  const eligible = eligibleConnections(ctx, principal, providerLocal)
  return namingOf(eligible, connectionLabels(eligible))
}

export interface Catalogue {
  /** "connection / database.collection" → where it is. */
  entries: Map<string, AiChatTarget>
  /** A local-only connection's names are in it: the request must stay inside. */
  local: boolean
  /** Review I1: the connections whose names were sent — the turn's sources, as history weighs them. */
  connections: Set<string>
  /**
   * User report 2026-10-24: the connections the person may use with the assistant, by name — one
   * with no collection yet (an empty server) included, or the assistant says it was not found.
   */
  names: string[]
  /** The connections named, by id and label: those an answer names are recorded as named. */
  labelled: Named[]
}

type Listing = Array<[string, string]>
const kept = new WeakMap<ServerContext, Map<string, { at: number; list: Listing }>>()

/**
 * A connection's collections, as [database, collection], sorted; system ones left out. Fills `out`
 * as it goes, so that a slow connection still gives what it listed in time.
 */
async function collectionsOf(
  ctx: ServerContext,
  id: string,
  out: Listing,
  signal: AbortSignal | undefined,
): Promise<void> {
  const release = ctx.manager.hold(id)
  try {
    const client = await ctx.manager.getClient(id)
    if (signal?.aborted) return
    const dbs = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })
    const names = dbs.databases
      .map((d) => d.name)
      .filter((n) => !SYSTEM_DATABASES.has(n) && !isDrillScratch(n))
      .sort()
    const lists: Listing[] = names.map(() => [])
    let next = 0
    const worker = async () => {
      while (next < names.length && !signal?.aborted) {
        const i = next++
        const db = names[i]!
        const colls = await client
          .db(db)
          .listCollections({}, { nameOnly: true, authorizedCollections: true, maxTimeMS: PER_CONNECTION_MS })
          .toArray()
        lists[i] = colls
          .map((c) => c.name)
          .filter((n) => !n.startsWith('system.'))
          .sort()
          .map((coll): [string, string] => [db, coll])
        // In database order, so that a cut keeps the first ones whole.
        out.length = 0
        for (const l of lists) for (const pair of l) if (out.length < CATALOGUE_LIMIT) out.push(pair)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, names.length) }, worker))
  } finally {
    release()
  }
}

/** Waits `ms` at most; a slow listing gives what it has. */
function listing(ctx: ServerContext, id: string, signal: AbortSignal | undefined): Promise<Listing> {
  const cache = kept.get(ctx) ?? new Map<string, { at: number; list: Listing }>()
  kept.set(ctx, cache)
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < KEEP_MS) return Promise.resolve(hit.list)
  const out: Listing = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = collectionsOf(ctx, id, out, signal).then(
    () => {
      cache.set(id, { at: Date.now(), list: [...out] })
      return out
    },
    () => out,
  )
  const late = new Promise<Listing>((resolve) => {
    timer = setTimeout(() => resolve([...out]), PER_CONNECTION_MS)
  })
  return Promise.race([done, late]).finally(() => clearTimeout(timer))
}

export async function namespaceCatalogue(
  ctx: ServerContext,
  principal: Principal,
  providerLocal: boolean | null,
  signal?: AbortSignal,
): Promise<Catalogue> {
  const eligible = eligibleConnections(ctx, principal, providerLocal)
  // Connections of one name told apart as the agent tells them, over all of them (connectionLabels).
  const labels = connectionLabels(eligible)
  const listed = eligible.slice(0, CONNECTIONS)
  const lists = await Promise.all(listed.map((c) => listing(ctx, c.id, signal)))
  const entries = new Map<string, AiChatTarget>()
  const shared = new Set<string>()
  const connections = new Set<string>()
  const { names, labelled, local: namedLocal } = namingOf(eligible, labels)
  let local = namedLocal
  listed.forEach((c, i) => {
    const name = labels.get(c.id)!
    for (const [db, coll] of lists[i]!) {
      if (entries.size >= CATALOGUE_LIMIT) return
      const label = `${name} / ${db}.${coll}`
      // Review M3: a name two collections would share is given to neither.
      if (shared.has(label)) continue
      if (entries.has(label)) {
        entries.delete(label)
        shared.add(label)
        continue
      }
      entries.set(label, { connectionId: c.id, db, coll })
      connections.add(c.id)
      if (c.aiPolicy === 'local') local = true
    }
  })
  return { entries, local, connections, names, labelled }
}
