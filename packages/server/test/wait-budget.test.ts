import { describe, expect, it, onTestFailed, TestRunner } from 'vitest'
import { countWait, overLimit, resetWaits, SPARE_MS, waitsOf } from './support/wait-budget'
import { asIs } from './support/slowness'

describe('job waits against a test limit', () => {
  it('adds up the waits the running test runs, in a helper too, and only its own', () => {
    const test = TestRunner.getCurrentTest()!
    const helper = () => countWait(7_000)
    countWait(1_000)
    for (let i = 0; i < 2; i++) helper()
    expect(waitsOf(test)).toBe(15_000)
    expect(waitsOf({})).toBe(0)
  })

  it('starts each test at nothing', () => {
    expect(waitsOf(TestRunner.getCurrentTest()!)).toBe(0)
  })

  it('starts a count again', () => {
    const test = TestRunner.getCurrentTest()!
    countWait(3_000)
    resetWaits(test)
    expect(waitsOf(test)).toBe(0)
  })

  // Review of the wait budget (minor 2): 15 s on each of two tries is 15 s, not 30 s — in a 20 s
  // limit, named: a slow runner's default is longer (review of the Windows hardening, C1).
  it('counts each try of a test on its own', { retry: 1, timeout: asIs(20_000) }, ({ task }) => {
    countWait(15_000)
    if (!task.result?.retryCount) throw new Error('the first try fails')
  })

  // Review of the wait budget (minor 3): the setup file fails a test whose waits outrun its limit. The
  // second reads what the first was failed with, so the two run together, in this order.
  describe('the setup file', () => {
    let said: string | undefined
    it.fails('fails a test whose waits do not fit in its limit', { timeout: asIs(20_000) }, () => {
      onTestFailed(({ task }) => {
        said = task.result?.errors?.[0]?.message
      })
      countWait(60_000)
    })

    it('fails it for its waits, saying the limit it needs', () => {
      expect(said).toBe(`This test ${overLimit(60_000, 20_000)}.`)
    })
  })

  it('lets waits through only with time to spare in the limit, or with no limit', () => {
    expect(overLimit(15_000, 20_000)).toBeNull()
    expect(overLimit(0, 20_000)).toBeNull()
    expect(overLimit(60_000, 0)).toBeNull()
    expect(overLimit(15_001, 20_000)).toBe(
      `waits up to 15001 ms for its jobs; with ${SPARE_MS} ms to spare that needs a limit of 20001 ms, ` +
        'and its limit is 20000 ms',
    )
    expect(overLimit(60_000, 20_000)).toMatch(/needs a limit of 65000 ms, and its limit is 20000 ms/)
  })
})
