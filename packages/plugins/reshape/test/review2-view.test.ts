// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { PREVIEW_DELAY, mount } from '../src/view'
import { MAX_STAGES } from '../src/reshape'

/** Wave 3 second review (2026-10-26): the reshape tab's findings 4, 6, 14 and 15. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [] as string[][] | null,
}
const PEOPLE = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, fullName: 'Ada', meta: { source: 'web' }, country: 'TR' },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, fullName: 'Grace', meta: { source: 'app' }, country: null },
]

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const settle = async () => {
  await new Promise((r) => setTimeout(r, PREVIEW_DELAY + 30))
  await flush()
}
const addStep = async (kind: string) => {
  app().querySelector<HTMLSelectElement>('#kind')!.value = kind
  app().querySelector<HTMLButtonElement>('#add-step')!.click()
  await flush()
}
const change = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('change'))
}
const offered = () =>
  [...app().querySelectorAll<HTMLOptionElement>('#steps select option')].map((o) => o.value)

async function opened(
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  place: Partial<typeof PLACE> = {},
  locale = 'en',
) {
  const fake = fakeClient(
    { place: { ...PLACE, ...place }, locale },
    {
      'documents.find': () => ({ documents: PEOPLE }),
      'documents.aggregate': () => ({ documents: PEOPLE }),
      ...handlers,
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('what is hidden, unknown (second review 6)', () => {
  it('offers no field until what is hidden is known, and asks again on Try again', async () => {
    // The place the app tells: what is hidden unknown at first, known when asked again.
    const place = { ...PLACE, hidden: null as string[][] | null }
    const fake = fakeClient(
      { place },
      {
        'documents.find': () => ({ documents: PEOPLE }),
        'documents.aggregate': () => ({ documents: PEOPLE }),
      },
    )
    mount(app(), fake.client)
    fake.greet()
    await flush()
    const { calls } = fake
    expect(app().querySelector('[data-hidden-unknown]')!.textContent).toContain('could not be told')
    await addStep('remove')
    expect(offered()).toEqual([])
    place.hidden = []
    app().querySelector<HTMLButtonElement>('#hidden-retry')!.click()
    await flush()
    expect(calls.filter((c) => c.method === 'context.get')).toHaveLength(2)
    expect(app().querySelector('[data-hidden-unknown]')).toBeNull()
    await addStep('remove')
    expect(offered()).toContain('fullName')
  })

  it('says so in Turkish', async () => {
    await opened({}, { hidden: null }, 'tr')
    expect(app().querySelector('[data-hidden-unknown]')!.textContent).toContain('anlaşılamadı')
  })
})

describe('a hand-off the user declined (second review 4)', () => {
  it('is said as a plain note, never as a failure', async () => {
    await opened({
      'ui.useAggregation': () => {
        throw new AskError('declined', 'The user kept the pipeline there')
      },
    })
    await addStep('remove')
    app().querySelector<HTMLButtonElement>('#use')!.click()
    await flush()
    expect(app().querySelector('.mm-callout-danger')).toBeNull()
    expect(app().querySelector('[data-note="declined"]')).not.toBeNull()
  })
})

describe('the steps (second review 15)', () => {
  it('calls a new rename or nest step unfinished, not a problem, and leaves it out quietly', async () => {
    await opened()
    await addStep('rename')
    await addStep('nest')
    expect(app().querySelector('[data-problem]')).toBeNull()
    expect(app().querySelector('#left-out')).toBeNull()
    expect(app().querySelector('#incomplete')!.textContent).toBe('2 steps are not finished yet.')
    change(app().querySelector<HTMLInputElement>('[data-step="rename"] input')!, 'name')
    await flush()
    expect(app().querySelector('#incomplete')!.textContent).toBe('1 step is not finished yet.')
  })

  it('names a default by when it fills', async () => {
    await opened()
    await addStep('default')
    expect(app().querySelector('[data-step="default"] strong')!.textContent).toBe('1. Default where missing')
    const when = app().querySelector<HTMLSelectElement>(
      '[data-step="default"] select[aria-label="Fill where the field is"]',
    )!
    change(when, 'missingOrNull')
    await flush()
    expect(app().querySelector('[data-step="default"] strong')!.textContent).toBe(
      '1. Default where missing or null',
    )
    expect(
      app().querySelector('[data-step="default"] .rs-step-head button')!.getAttribute('aria-label'),
    ).toBe('Remove step 1: Default where missing or null')
  })

  it('says a field is hidden by a rule even when the sample showed none', async () => {
    await opened({}, { hidden: [['meta', 'secret']] })
    expect(app().textContent).toContain('Fields hidden from you as personal data are not offered')
    await addStep('remove')
    expect(offered()).not.toContain('meta')
  })

  it('says a target is set in each document of a list', async () => {
    await opened({
      'documents.find': () => ({ documents: [{ _id: 1, name: 'Ada', items: [{ sku: 'a' }] }] }),
    })
    await addStep('rename')
    change(app().querySelector<HTMLInputElement>('[data-step="rename"] input')!, 'items.note')
    await flush()
    expect(app().querySelector('[data-clash]')!.textContent).toBe(
      'items is a list: the value is set in each of its documents.',
    )
  })
})

describe('the preview (second review 15)', () => {
  it('is busy while it runs', async () => {
    let release: () => void = () => {}
    await opened({
      'documents.aggregate': async () => {
        await new Promise<void>((r) => (release = r))
        return { documents: PEOPLE }
      },
    })
    await addStep('remove')
    await settle()
    expect(app().querySelector('.rs-preview-box')!.getAttribute('aria-busy')).toBe('true')
    release()
    await flush()
    await flush()
    expect(app().querySelector('.rs-preview-box')!.getAttribute('aria-busy')).toBe('false')
  })

  it('says why After is not shown past the stages a preview takes, and never sends them', async () => {
    const { calls } = await opened()
    for (let i = 0; i <= MAX_STAGES; i++) await addStep('remove')
    await settle()
    expect(app().querySelector('#after')!.textContent).toContain('more stages than a preview')
    expect(
      calls
        .filter((c) => c.method === 'documents.aggregate')
        .every((c) => (c.params.pipeline as unknown[]).length <= MAX_STAGES + 1),
    ).toBe(true)
  })
})

describe('a step’s messages (second review 15)', () => {
  it('keep their live region in the page when empty', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'style.css'), 'utf8')
    expect(css).not.toMatch(/\.rs-messages:empty\s*\{[^}]*display:\s*none/)
  })
})
