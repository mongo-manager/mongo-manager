// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref, watch, type Ref } from 'vue'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import type { CollectionViewState } from '@/stores/collectionViews'
import { toRows, type DocumentRow, type Row } from '../rows'

/** How long prev or next waits for a page of results to load before it stays where it is. */
const PAGE_WAIT_MS = 30_000

/** A page of results that could not be loaded: why, or null when it did not come in time. */
export interface PageFailure {
  message: string | null
}

/**
 * Document page design §6.3 (user request 2026-11-04): prev and next walk the query's results from
 * the open document, into the next or the previous page at the end of one.
 *
 * Review 2026-11-07: the walk goes over the rows shown — always the page it loaded, as they are now —
 * so the document it opens is the one the page shows, at the place the position says. The page the
 * open document was last seen on is kept with the tab (`order`): a document a save or another user
 * took out of the query keeps its place among the ones still there, and the walk goes on from it.
 */
export function useDocumentNav(opts: {
  state: CollectionViewState
  rows: Ref<Row[]>
  /** The skip of the rows shown (the query's skip and its page). */
  skip: Ref<number>
  total: Ref<number | undefined>
  hasMore: Ref<boolean>
  identify: (row: DocumentRow) => string
  /** The open document's id: the page's own (the shell keeps it apart from the tab's state). */
  openId: Ref<string | null>
  mayLeave: () => Promise<boolean>
  open: (id: string) => void
  /** The page of results that failed to load (its skip), and why. */
  pageError?: Ref<{ skip: number; message: string } | null>
  /** Loads the page shown again; resolves once its rows are the server's as they are now. */
  refresh?: () => Promise<unknown>
}) {
  const slot = opts.state.inspector
  const openId = opts.openId
  const first = computed(() => opts.state.query.skip ?? 0)
  const ids = computed(() =>
    opts.rows.value.filter((r): r is DocumentRow => r.kind === 'document').map((r) => opts.identify(r)),
  )
  /** The open document's place in the rows shown; -1 when it is not among them. */
  const at = computed(() => (openId.value === null ? -1 : ids.value.indexOf(openId.value)))

  // The page the open document is on, kept as it was last seen.
  watch(
    [ids, at],
    () => {
      if (at.value < 0) return
      const same =
        slot.orderStart === opts.skip.value &&
        slot.order?.length === ids.value.length &&
        slot.order.every((id, i) => id === ids.value[i])
      if (same) return
      slot.order = ids.value
      slot.orderStart = opts.skip.value
    },
    // Each change seen: rows that come and go within one tick still leave the place known.
    { immediate: true, flush: 'sync' },
  )

  /**
   * The place of the row just before the open document: its own place less one, or — when it left
   * the rows — the place of the nearest document before it on its page that is still shown (-1: none).
   * Null when the open document's place is not known.
   */
  const before = computed<number | null>(() => {
    if (at.value >= 0) return at.value - 1
    const order = slot.order ?? []
    const i = openId.value === null ? -1 : order.indexOf(openId.value)
    if (i < 0) return null
    for (let j = i - 1; j >= 0; j--) {
      const k = ids.value.indexOf(order[j]!)
      if (k >= 0) return k
    }
    return -1
  })
  /** The place of the row after the open document. */
  const after = computed(() =>
    before.value === null ? null : at.value >= 0 ? at.value + 1 : before.value + 1,
  )

  /** 1-based, over the whole result; 0 when the document's place is not known. */
  const position = computed(() => {
    if (at.value >= 0) return opts.skip.value - first.value + at.value + 1
    const i = openId.value === null ? -1 : (slot.order ?? []).indexOf(openId.value)
    // Left the results: where it was.
    return i < 0 ? 0 : slot.orderStart - first.value + i + 1
  })
  const morePages = computed(() =>
    opts.total.value !== undefined
      ? opts.skip.value - first.value + ids.value.length < opts.total.value
      : opts.hasMore.value,
  )
  const canNext = computed(() => after.value !== null && (after.value < ids.value.length || morePages.value))
  const canPrev = computed(
    () => before.value !== null && (before.value >= 0 || opts.skip.value > first.value),
  )
  /** While a page of results loads for prev or next; and the last one that failed. */
  const moving = ref(false)
  // Not while prev or next loads a page: the open document is on the page left, not out of the query.
  const stale = computed(() => openId.value !== null && at.value < 0 && !moving.value)
  const failure = ref<PageFailure | null>(null)
  let lastMove: (() => Promise<void>) | null = null

  /**
   * Shows the page of results starting at `skip`, and resolves once its rows are there (true), or
   * once it failed (false): then the page shown before is shown again and the failure is said.
   */
  function loadAt(skip: number): Promise<boolean> {
    const limit = opts.state.query.limit
    const shown = opts.state.page
    opts.state.page = Math.max(0, Math.round((skip - first.value) / limit))
    // A failure said before this load is not this load's.
    const known = opts.pageError?.value
    return new Promise((resolve) => {
      let settled = false
      let stop: (() => void) | undefined = undefined
      const done = (ok: boolean, why?: PageFailure) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stop?.()
        if (!ok) {
          opts.state.page = shown
          failure.value = why ?? { message: null }
        }
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), PAGE_WAIT_MS)
      stop = watch(
        [opts.skip, opts.rows, () => opts.pageError?.value],
        () => {
          const error = opts.pageError?.value
          // Review 2026-11-07: a page that failed is said at once, not waited on.
          if (error && error !== known && error.skip === skip) done(false, { message: error.message })
          else if (opts.skip.value === skip) done(true)
        },
        { immediate: true },
      )
      if (settled) stop()
    })
  }

  /** Runs a move to another page: one at a time, said while it loads, its failure kept to try again. */
  async function moveOver(move: () => Promise<void>, again: () => Promise<void>): Promise<void> {
    moving.value = true
    failure.value = null
    lastMove = again
    try {
      await move()
    } finally {
      moving.value = false
    }
  }

  async function next(): Promise<void> {
    if (moving.value || !canNext.value || !(await opts.mayLeave())) return
    failure.value = null
    if (after.value !== null && after.value < ids.value.length) return opts.open(ids.value[after.value]!)
    await moveOver(async () => {
      // Review 2026-11-07: the page as it is now first — a document that left the query moved the
      // next one up into it; the next page is only asked for past its end.
      await opts.refresh?.()
      if (after.value === null) return
      if (after.value < ids.value.length) return opts.open(ids.value[after.value]!)
      if (!morePages.value) return
      if (!(await loadAt(opts.skip.value + opts.state.query.limit))) return
      const id = ids.value.find((x) => x !== openId.value)
      if (id) opts.open(id)
    }, next)
  }

  async function prev(): Promise<void> {
    if (moving.value || !canPrev.value || !(await opts.mayLeave())) return
    failure.value = null
    if (before.value !== null && before.value >= 0) return opts.open(ids.value[before.value]!)
    await moveOver(async () => {
      const skip = Math.max(first.value, opts.skip.value - opts.state.query.limit)
      if (!(await loadAt(skip))) return
      const id = ids.value.findLast((x) => x !== openId.value)
      if (id) opts.open(id)
    }, prev)
  }

  /** Tries the move that failed again. */
  function retry(): Promise<void> {
    failure.value = null
    return lastMove ? lastMove() : Promise.resolve()
  }

  return { position, total: opts.total, canPrev, canNext, prev, next, stale, moving, failure, retry }
}

/**
 * Design §6.4a: a row of a projected query holds part of its document; the page shows, searches and
 * edits the whole one, loaded by its _id — never the part (a replace of it would delete the rest).
 */
export async function loadFull(
  target: CollectionTarget,
  row: DocumentRow,
): Promise<DocumentRow | { error: string }> {
  try {
    const item = await documentsApi.get(target, row.raw._id)
    if (!('document' in item)) return { error: item.unsupported.reason }
    const [full] = toRows([item], Number(row.key.split(':')[0]))
    return full as DocumentRow
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
