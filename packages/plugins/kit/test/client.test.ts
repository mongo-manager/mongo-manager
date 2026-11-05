// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A page's window in a frame: messages from its host, and what it posts there. */
const host = { postMessage: vi.fn() }
let page: EventTarget & { parent: typeof host }
const fromHost = (data: unknown) => {
  const event = new Event('message')
  Object.assign(event, { data, source: host })
  page.dispatchEvent(event)
}

beforeEach(() => {
  vi.resetModules()
  host.postMessage.mockReset()
  page = Object.assign(new EventTarget(), { parent: host })
  vi.stubGlobal('window', page)
  vi.stubGlobal('location', { hash: '#cellRenderer=objectid' })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the plugin kit client (plugins wave 1 review M9)', () => {
  it('sends nothing before the app greeted the page, then the request with its token', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    const answer = client.ask('context.get')
    expect(host.postMessage).not.toHaveBeenCalled()
    fromHost({ mm: 1, type: 'hello', token: 't-1' })
    expect(host.postMessage).toHaveBeenCalledWith({ mm: 1, id: 1, method: 'context.get', token: 't-1' }, '*')
    fromHost({ mm: 1, id: 1, result: { locale: 'tr' } })
    await expect(answer).resolves.toEqual({ locale: 'tr' })
  })

  it('tells the page the language, theme and accent as they change, an unknown accent as Emerald', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    const seen: unknown[] = []
    client.onContext((locale, theme, accent) => seen.push([locale, theme, accent]))
    fromHost({ mm: 1, type: 'hello', token: 't' })
    fromHost({ mm: 1, type: 'context.changed', locale: 'tr', theme: 'dark', accent: 'ocean' })
    fromHost({ mm: 1, type: 'context.changed', locale: 'en', theme: 'light', accent: 'url(x)' })
    fromHost({ mm: 1, type: 'context.changed', locale: 'en', theme: 'light' })
    expect(seen).toEqual([
      ['tr', 'dark', 'ocean'],
      ['en', 'light', 'emerald'],
      ['en', 'light', 'emerald'],
    ])
  })

  it('gives a cell renderer the language the app asks in (review M8)', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    const seen: unknown[] = []
    client.onCells((renderer, values, locale) => {
      seen.push([renderer, locale])
      return values.map(() => ({ text: 'x' }))
    })
    fromHost({ mm: 1, type: 'hello', token: 't-1' })
    fromHost({
      mm: 1,
      id: 'c1',
      method: 'cells.render',
      params: { renderer: 'objectid', values: [1], locale: 'tr' },
    })
    expect(seen).toEqual([['objectid', 'tr']])
    await vi.waitFor(() =>
      expect(host.postMessage).toHaveBeenLastCalledWith(
        { mm: 1, id: 'c1', token: 't-1', result: [{ text: 'x' }] },
        '*',
      ),
    )
  })
})

describe('what the app answered, in the plugin’s words (wave 1 review Minor 10)', () => {
  it('says why the app did not take a request, in English and Turkish', async () => {
    const { AskError, askMessage } = await import('../src/client')
    expect(askMessage(new AskError('no_activation', 'x'), 'en')).toMatch(/click/i)
    expect(askMessage(new AskError('no_activation', 'x'), 'tr')).toMatch(/tıkla/i)
    expect(askMessage(new AskError('too_many', 'x'), 'tr')).toMatch(/dakika/)
    expect(askMessage(new AskError('something_else', 'As the app said'), 'tr')).toBe('As the app said')
    expect(askMessage(new Error('plain'), 'en')).toBe('plain')
    // Wave 3 second review: a "no" said to a save or an import is no failure of what was there.
    expect(askMessage(new AskError('declined', 'x'), 'en')).toBe('Nothing was done: you said no.')
    expect(askMessage(new AskError('declined', 'x'), 'tr')).toBe('Hiçbir şey yapılmadı: hayır dedin.')
    // Third review: a question nobody answered is no "no".
    expect(askMessage(new AskError('unanswered', 'x'), 'en')).toBe(
      'No answer came in time: nothing was done.',
    )
    expect(askMessage(new AskError('unanswered', 'x'), 'tr')).toBe(
      'Zamanında yanıt gelmedi: hiçbir şey yapılmadı.',
    )
  })

  // Starter review 2026-10-30: a view refused, a document gone, a method missing here or an answer too
  // large read in the user's language, not as the app's English message. A failure keeps the app's
  // own words: they say why (MongoDB's error, a limit), which a general sentence would hide.
  it('says the other refusals in every language too', async () => {
    const { AskError, askMessage } = await import('../src/client')
    const { LANGUAGES } = await import('../src/i18n')
    expect(askMessage(new AskError('failed', 'MongoDB denied this operation'), 'tr')).toBe(
      'MongoDB denied this operation',
    )
    for (const code of ['read_only', 'not_found', 'unavailable', 'too_large'])
      for (const lang of LANGUAGES) {
        const said = askMessage(new AskError(code, 'The app’s English'), lang)
        expect(said, `${code} ${lang}`).not.toBe('The app’s English')
        if (lang !== 'en') expect(said, `${code} ${lang}`).not.toBe(askMessage(new AskError(code, 'x'), 'en'))
      }
    expect(askMessage(new AskError('read_only', 'x'), 'tr')).toBe(
      'Bu bir görünüm, salt okunur: hiçbir şey değişmedi.',
    )
  })

  it('writes Russian with е, as the app does', async () => {
    const { AskError, ASK_CODES, askMessage } = await import('../src/client')
    for (const code of ASK_CODES) expect(askMessage(new AskError(code, 'x'), 'ru'), code).not.toMatch(/ё/)
  })
})

// Wave 3 second review: the app asks the user before some requests; the page waits as long as the
// question can stay (the app ends it first), never giving up while the user may still say yes.
describe('a request the app may ask the user about', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for the user, and any other request 15 seconds', async () => {
    const { createClient, QUESTION_TIMEOUT_MS } = await import('../src/client')
    const client = createClient()
    fromHost({ mm: 1, type: 'hello', token: 't' })
    const outcomes: string[] = []
    for (const method of [
      'ui.download',
      'ui.importDocuments',
      'ui.copy',
      'documents.update',
      'ui.useAggregation',
      'documents.find',
    ])
      client.ask(method).then(
        () => outcomes.push(`${method}: answered`),
        () => outcomes.push(`${method}: timeout`),
      )
    await vi.advanceTimersByTimeAsync(15_001)
    expect(outcomes).toEqual(['documents.find: timeout'])
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS)
    expect(outcomes).toHaveLength(6)
    expect(QUESTION_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000)
  })

  // Wave 4 final review I5: a compact answers when it ends — hours on a large collection.
  it('waits for a compact as long as it runs', async () => {
    const { createClient, QUESTION_TIMEOUT_MS } = await import('../src/client')
    const client = createClient()
    fromHost({ mm: 1, type: 'hello', token: 't' })
    let outcome = ''
    client.ask('ui.compact').then(
      () => (outcome = 'answered'),
      () => (outcome = 'timeout'),
    )
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS + 3_600_000)
    expect(outcome).toBe('')
  })
})

describe('cells and their columns (wave 2)', () => {
  it('gives a cell renderer the path of each value, null where none or not text', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    const seen: unknown[] = []
    client.onCells((_renderer, values, _locale, paths) => {
      seen.push(paths)
      return values.map(() => null)
    })
    fromHost({ mm: 1, type: 'hello', token: 't-1' })
    fromHost({
      mm: 1,
      id: 'c1',
      method: 'cells.render',
      params: { renderer: 'r', values: [1, 2, 3], paths: ['a.b', 7], locale: 'en' },
    })
    expect(seen).toEqual([['a.b', null, null]])
  })
})

describe('a renderer that reads before it answers (wave 2)', () => {
  it('waits for its answer, and tells it where the values are', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    const seen: unknown[] = []
    client.onCells(async (_renderer, values, _locale, _paths, place) => {
      seen.push(place)
      await Promise.resolve()
      return values.map(() => ({ text: 'later' }))
    })
    fromHost({ mm: 1, type: 'hello', token: 't-1' })
    const place = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    fromHost({ mm: 1, id: 'c1', method: 'cells.render', params: { renderer: 'r', values: [1], place } })
    await vi.waitFor(() =>
      expect(host.postMessage).toHaveBeenLastCalledWith(
        { mm: 1, id: 'c1', token: 't-1', result: [{ text: 'later' }] },
        '*',
      ),
    )
    expect(seen).toEqual([place])
    fromHost({ mm: 1, id: 'c2', method: 'cells.render', params: { renderer: 'r', values: [1], place: 'x' } })
    await vi.waitFor(() => expect(seen).toEqual([place, null]))
  })

  it('answers nothing for a renderer that fails, at once or later', async () => {
    const { createClient } = await import('../src/client')
    const client = createClient()
    client.onCells(async () => {
      throw new Error('no')
    })
    fromHost({ mm: 1, type: 'hello', token: 't-1' })
    fromHost({ mm: 1, id: 'c3', method: 'cells.render', params: { renderer: 'r', values: [1] } })
    await vi.waitFor(() =>
      expect(host.postMessage).toHaveBeenLastCalledWith({ mm: 1, id: 'c3', token: 't-1', result: [] }, '*'),
    )
  })
})
