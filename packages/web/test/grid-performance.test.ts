import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { markRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DocumentTable from '../src/documents/DocumentTable.vue'
import type { DocumentRow } from '../src/documents/rows'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

// Every grid is unmounted after its test by test/support/app.ts (whole-branch review, minor 15).
afterEach(() => {
  document.body.innerHTML = ''
})

const ROWS = 100_000
const ROW_HEIGHT = 32
const COLUMNS = ['_id', 'name', 'qty', 'price', 'city', 'tags', 'at', 'ok', 'note', 'n']

function rows(count = ROWS): DocumentRow[] {
  return Array.from({ length: count }, (_, i) => {
    const value = markRaw({
      _id: i,
      name: `name ${i}`,
      qty: i % 97,
      price: i / 7,
      city: 'Izmir',
      tags: ['a', 'b'],
      at: new Date(1_700_000_000_000 + i * 1000),
      ok: i % 2 === 0,
      note: 'x'.repeat(20),
      n: i,
    })
    return { key: `${i}`, kind: 'document', raw: markRaw({ _id: i }), hash: 'h'.repeat(64), value }
  })
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/**
 * CI 2026-10-18: a turn of the event loop, after each mount and scroll and outside its time. happy-dom
 * holds its nodes through WeakRefs, whose targets V8 keeps alive until the task that made them ends;
 * awaiting only nextTick never ends it, so every scroll kept the whole DOM it replaced (about 90 MB a
 * scroll, at 20 000 rows as at 100 000) and the run ran its worker out of memory. A browser ends a
 * task at each scroll event.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A grid mounted on the rows given, timed; its rows and scrolling read from its own element. */
async function grid(data: DocumentRow[]) {
  const count = data.length
  const started = performance.now()
  const { wrapper } = mountApp(DocumentTable, {
    props: {
      rows: data,
      columns: COLUMNS,
      canWrite: true,
      rowHeight: ROW_HEIGHT,
      inlineEdit: true,
      target: { connectionId: 'c', db: 'd', coll: 'e' },
    },
  })
  await nextTick()
  const mountMs = performance.now() - started
  await settle()
  const root = wrapper.element as HTMLElement
  const body = () => root.querySelector('tbody')!
  const rendered = () => root.querySelectorAll('tbody tr[data-row]').length
  const container = body().closest('div') as HTMLElement
  const times: number[] = []
  return {
    mountMs,
    rendered,
    times,
    async scrollTo(fraction: number) {
      const row = Math.floor(fraction * count)
      const at = performance.now()
      container.scrollTop = row * ROW_HEIGHT
      container.dispatchEvent(new Event('scroll'))
      await nextTick()
      times.push(performance.now() - at)
      const text = body().textContent ?? ''
      await settle()
      return { row, text }
    },
  }
}

describe('the document grid with 100 000 rows (spec §9 benchmark)', () => {
  // Each test's mount times, so that the second counts the faster of two mounts each.
  const mounts = { small: [] as number[], large: [] as number[] }

  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })

  /**
   * CI 2026-10-18: building 100 000 rows and mounting a grid on them takes seconds under coverage with
   * every package testing at once (the file took 16 s for its two tests, then a test passed the 15 s
   * every test is given). What is checked is time against the 1 000-row grid's under the same load,
   * never time itself, so these tests are given a minute.
   */
  const BENCHMARK_MS = 60_000

  /** A small grid and a large one, mounted in turn, their times kept. */
  async function pair() {
    // The first grid of each pair pays for what is compiled and cached once: neither measured one does.
    await grid(rows(100))
    const small = await grid(rows(1_000))
    const large = await grid(rows(ROWS))
    mounts.small.push(small.mountMs)
    mounts.large.push(large.mountMs)
    return { small, large }
  }

  // Two mounts each, taking turns, and the faster of each two (whole-branch review, minor 15).
  // CI 2026-10-18: test-utils keeps every grid a test mounts, unmounted or not, until the test ends,
  // and 100 000 rows with the grid drawn on them hold about 300 MB. So each test mounts one large
  // grid, on rows of its own that nothing keeps after it.
  it(
    'mounts its 100 000 rows, drawing only the visible window',
    async () => {
      const { large } = await pair()
      expect(large.rendered()).toBeLessThanOrEqual(100)
    },
    BENCHMARK_MS,
  )

  /**
   * CI 2026-10-17: a fixed 1 s bound failed at 1056 ms with coverage on and every package testing at
   * once; on a quiet machine a scroll takes about 150 ms at 1 000 rows and at 100 000 alike. What a
   * scroll costs is drawing its window, and the machine's load scales that, not the row count. So the
   * 100 000-row grid is timed against a 1 000-row one under the same load, their scrolls taking turns:
   * per-scroll work over every row that costs about as much as drawing a window fails it, whatever
   * the machine's speed (copying each row did: 591 ms against a bound of 343). Cheaper work, such as
   * one pass of a filter, is below what timing can tell apart. The row count is the exact guarantee.
   */
  it(
    'mounts and scrolls as fast as a grid of 1 000 rows, rendering only the visible window',
    async () => {
      const { small, large } = await pair()
      expect(large.rendered()).toBeLessThanOrEqual(100)
      // The faster of the two tests' mounts each; run alone, this test's one each. The margin stays
      // wide, as the large one also collects the garbage of building its rows.
      expect(Math.min(...mounts.large)).toBeLessThan(4 * Math.min(...mounts.small) + 200)

      // No nearer the end than 0.96: a window reaches 35 rows below its first one (25 in view, 10 drawn
      // ahead), and past the small grid's 1 000th it would be cut short, and lighter to draw.
      for (const fraction of [0.25, 0.5, 0.75, 0.96, 0.1, 0.6, 0.33, 0.9, 0.05, 0.5]) {
        await small.scrollTo(fraction)
        const { row, text } = await large.scrollTo(fraction)
        expect(large.rendered()).toBeLessThanOrEqual(100)
        expect(small.rendered()).toBe(large.rendered())
        expect(text).toContain(`name ${row}`)
      }
      expect(median(large.times)).toBeLessThan(2 * median(small.times) + 50)
    },
    BENCHMARK_MS,
  )
})
