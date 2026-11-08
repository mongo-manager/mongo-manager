// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, reactive, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { onlineManager, useQuery, useQueryClient, type Query, type QueryClient } from '@tanstack/vue-query'
import { ApiError } from '@/api/client'
import { connectionsApi, queryKeys } from '@/api/connections'

/**
 * A failed open's kinds that are not about the server: a pool all busy for now, or an open the app
 * itself stopped (closing, or the connection edited meanwhile). Every other kind is a server not
 * reached, or not signed in to.
 */
const NOT_THE_SERVER = new Set(['busy', 'closed', 'pool'])

/**
 * User report 2026-10-23: a connection whose server timed out still offered "Start backup", and the
 * sheet opened. Whether an answer says the app cannot work with the connection's server for now: an
 * open that failed (network, DNS, TLS, timeout, SSH, sign-in, its settings or modules), a connection
 * lost, a server, shard or primary not available (503, MongoDB's own codes), or a server older than
 * the app supports.
 */
export function cannotReach(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false
  if (e.code === 'UNSUPPORTED_SERVER') return true
  if (e.code !== 'MONGO_ERROR') return false
  const kind = kindOf(e)
  if (typeof kind === 'string') return !NOT_THE_SERVER.has(kind)
  // Review (M3): a server, a shard or a primary not available is answered 503 with MongoDB's code.
  return e.status === 503
}
const kindOf = (e: ApiError): unknown => (e.details as { kind?: unknown } | null | undefined)?.kind

/**
 * Third review (I3): what may pass by itself, and so is read again unasked: the network, a timeout,
 * DNS, a server not available. A sign-in refused, settings, a host key or a server too old are not:
 * reading again would only repeat a failed sign-in (and lock a directory account out).
 */
const PASSING = new Set(['network', 'timeout', 'dns'])
export function passesByItself(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.code !== 'MONGO_ERROR') return false
  const kind = kindOf(e)
  return typeof kind === 'string' ? PASSING.has(kind) : e.status === 503
}

/**
 * User reports 2026-10-23: what needs the server is shown only while the app is connected to it.
 * Third review (I1, I2): that is the server's last answer to the connection's databases, not the
 * read in progress. A read again with nothing read before is pending (TanStack clears its error),
 * and going by that hid what opened it, failed, showed it again and so on for ever, and hid the
 * error with its Retry and Edit for as long as each read took. So each answer is kept as it
 * settles: read → connected; failed saying the server cannot be reached → not; any other failure
 * (a busy pool, a query past its time limit, a right refused) is the server answering → connected.
 * Before any answer, it is connecting: not connected.
 */
interface Answer {
  connected: boolean
  /** The failure that said the server cannot be reached, for what says so while a read runs again. */
  unreachable: unknown
}
const answersBy = new WeakMap<QueryClient, Map<string, Answer>>()

function databasesOf(query: Query): string | null {
  const key = query.queryKey
  return key.length === 3 && key[0] === 'connections' && key[2] === 'databases' && typeof key[1] === 'string'
    ? key[1]
    : null
}

function answersOf(queryClient: QueryClient): Map<string, Answer> {
  const known = answersBy.get(queryClient)
  if (known) return known
  const kept = reactive(new Map<string, Answer>()) as Map<string, Answer>
  const cache = queryClient.getQueryCache()
  const settle = (query: Query): void => {
    const id = databasesOf(query)
    // Fourth review (M2): a query removed meanwhile (a deleted connection, a sign-out) says nothing.
    if (id === null || cache.get(query.queryHash) !== query) return
    const { status, error } = query.state
    let answer: Answer
    if (status === 'success') answer = { connected: true, unreachable: null }
    else if (status !== 'error') return
    else if (cannotReach(error)) answer = { connected: false, unreachable: error }
    // Fourth review (M1): an open the app itself stopped (its connection edited, the app closing) or
    // no answer of the app's own server says nothing of MongoDB's: the last answer stands.
    else if (!(error instanceof ApiError) || (error.code === 'MONGO_ERROR' && kindOf(error) === 'closed'))
      return
    else answer = { connected: true, unreachable: null }
    const before = kept.get(id)
    if (before?.connected !== answer.connected || before.unreachable !== answer.unreachable)
      kept.set(id, answer)
  }
  for (const query of cache.getAll()) settle(query)
  cache.subscribe((event) => {
    if (event.type === 'removed') {
      const id = databasesOf(event.query)
      if (id !== null) kept.delete(id)
    } else if (
      event.type === 'added' ||
      // An answer only: an invalidation (or a reset, a fetch starting) says nothing new, and read as
      // one it brought back an answer an edit had forgotten (fourth review, I2).
      (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
    )
      settle(event.query)
  })
  answersBy.set(queryClient, kept)
  return kept
}

/** Whether the app is connected to a connection's server now, by its last answer (outside a component). */
export const connectedIn = (queryClient: QueryClient, connectionId: string): boolean =>
  answersOf(queryClient).get(connectionId)?.connected === true

/**
 * Fourth review (I2): a connection edited (its address, its sign-in) is not connected until its
 * databases are read again: the answer of its old settings is forgotten.
 */
export function forgetAnswer(queryClient: QueryClient, connectionId: string): void {
  answersOf(queryClient).delete(connectionId)
}

/** Whether the app is connected to a connection's server, by its last answer (see Answer). */
export function useConnected(connectionId: MaybeRefOrGetter<string>): ComputedRef<boolean> {
  const answers = answersOf(useQueryClient())
  return computed(() => answers.get(toValue(connectionId))?.connected === true)
}

/** The last answer's "cannot be reached", kept while a read runs again (third review, I2). */
export function useLastUnreachable(connectionId: MaybeRefOrGetter<string>): ComputedRef<unknown> {
  const answers = answersOf(useQueryClient())
  return computed(() => answers.get(toValue(connectionId))?.unreachable ?? null)
}

/** While the server cannot be reached for a reason that passes by itself, it is read again this often. */
export const REREAD_UNREACHABLE_MS = 15_000
export const rereadWhileUnreachable = (query: {
  state: { status: string; error: unknown }
}): number | false =>
  query.state.status === 'error' && passesByItself(query.state.error) ? REREAD_UNREACHABLE_MS : false

/**
 * For a screen open on the connection (a database's or a collection's tab, the Backups section): it
 * reads the connection's databases as the tree and the connection's tab do (an active query, so a
 * refresh or a passing test reads them again for it too; first review, I2), and says whether it is
 * connected. Opening it reads them only when nothing has (refetchOnMount and retryOnMount off): when
 * to read again is the connection's (Retry, Refresh, a passing test, the reread above).
 */
export function useConnectionState(connectionId: MaybeRefOrGetter<string>): {
  connected: ComputedRef<boolean>
  unreachable: ComputedRef<boolean>
} {
  useQuery({
    queryKey: computed(() => queryKeys.databases(toValue(connectionId))),
    queryFn: () => connectionsApi.databases(toValue(connectionId)),
    refetchInterval: rereadWhileUnreachable,
    refetchOnMount: false,
    retryOnMount: false,
  })
  const connected = useConnected(connectionId)
  const last = useLastUnreachable(connectionId)
  return { connected, unreachable: computed(() => last.value !== null) }
}

/**
 * For a command run from the palette: whether the app is connected to the server now. With no
 * answer yet, or one that said it cannot be reached, it reads the databases (a read on its way is
 * waited for), saying so first (third review, M1): a server back since is not refused.
 */
export async function connectedNow(
  queryClient: QueryClient,
  connectionId: string,
  reading?: () => (() => void) | void,
): Promise<boolean> {
  const answers = answersOf(queryClient)
  if (answers.get(connectionId)?.connected) return true
  // Fourth review (M3): offline, a read would wait for the network, and run the command much later.
  if (!onlineManager.isOnline()) return false
  const done = reading?.()
  try {
    await queryClient
      .fetchQuery({
        queryKey: queryKeys.databases(connectionId),
        queryFn: () => connectionsApi.databases(connectionId),
        staleTime: 0,
        retry: false,
      })
      .catch(() => undefined)
  } finally {
    done?.()
  }
  return answers.get(connectionId)?.connected === true
}
