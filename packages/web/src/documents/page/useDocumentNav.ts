// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, watch, type Ref } from 'vue'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import type { CollectionViewState } from '@/stores/collectionViews'
import { toRows, type DocumentRow, type Row } from '../rows'

/** How long prev or next waits for a page of results to load before it stays where it is. */
const PAGE_WAIT_MS = 30_000

/**
 * Document page design §6.3 (user request 2026-11-04): prev and next walk the query's results from
 * the open document, into the next or the previous page at the end of one. The order is the one the
 * results had when the page opened (`begin`), so a document a save took out of the query keeps its
 * place and the walk goes on.
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
}) {
  const slot = opts.state.inspector
  const idsOf = (rows: Row[]) =>
    rows.filter((r): r is DocumentRow => r.kind === 'document').map((r) => opts.identify(r))
  const openId = opts.openId
  const order = computed(() => slot.order ?? [])
  const index = computed(() => (openId.value === null ? -1 : order.value.indexOf(openId.value)))
  const first = computed(() => opts.state.query.skip ?? 0)

  /** Takes the results shown as the order to walk. */
  function begin(): void {
    slot.order = idsOf(opts.rows.value)
    slot.orderStart = opts.skip.value
  }

  /** 1-based, over the whole result; 0 when the document is not in the order. */
  const position = computed(() => (index.value < 0 ? 0 : slot.orderStart - first.value + index.value + 1))
  const end = computed(() => slot.orderStart + order.value.length)
  const canNext = computed(
    () =>
      index.value >= 0 &&
      (index.value < order.value.length - 1 ||
        (opts.total.value !== undefined ? end.value - first.value < opts.total.value : opts.hasMore.value)),
  )
  const canPrev = computed(() => index.value > 0 || (index.value === 0 && slot.orderStart > first.value))
  const stale = computed(() => openId.value !== null && !idsOf(opts.rows.value).includes(openId.value))

  /** Shows the page of results starting at `skip`, and resolves once its rows are there. */
  function loadAt(skip: number): Promise<boolean> {
    const limit = opts.state.query.limit
    opts.state.page = Math.max(0, Math.round((skip - first.value) / limit))
    return new Promise((resolve) => {
      let stop: (() => void) | undefined = undefined
      const timer = setTimeout(() => {
        stop?.()
        resolve(false)
      }, PAGE_WAIT_MS)
      stop = watch(
        [opts.skip, opts.rows],
        () => {
          if (opts.skip.value !== skip) return
          clearTimeout(timer)
          stop?.()
          resolve(true)
        },
        { immediate: true },
      )
    })
  }

  async function next(): Promise<void> {
    const at = index.value
    if (!canNext.value || !(await opts.mayLeave())) return
    if (at < order.value.length - 1) return opts.open(order.value[at + 1]!)
    if (!(await loadAt(end.value))) return
    const known = new Set(order.value)
    const added = idsOf(opts.rows.value).filter((id) => !known.has(id))
    if (!added.length) return
    slot.order = [...order.value, ...added]
    opts.open(added[0]!)
  }

  async function prev(): Promise<void> {
    const at = index.value
    if (!canPrev.value || !(await opts.mayLeave())) return
    if (at > 0) return opts.open(order.value[at - 1]!)
    const skip = Math.max(first.value, slot.orderStart - opts.state.query.limit)
    if (!(await loadAt(skip))) return
    const known = new Set(order.value)
    const added = idsOf(opts.rows.value).filter((id) => !known.has(id))
    if (!added.length) return
    slot.order = [...added, ...order.value]
    slot.orderStart = skip
    opts.open(added.at(-1)!)
  }

  return { begin, position, total: opts.total, canPrev, canNext, prev, next, stale }
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
