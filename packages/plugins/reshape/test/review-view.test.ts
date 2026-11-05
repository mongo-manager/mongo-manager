// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { PREVIEW_DELAY, mount } from '../src/view'

/** Wave 3 review (2026-10-26): the reshape tab's findings 23 and 28–30. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [['contact', 'phone']],
}
const PEOPLE = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    fullName: 'Ada',
    contact: { phone: '***', city: 'Izmir' },
    address: { city: 'Izmir', zip: '35000' },
    country: null,
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a02' },
    fullName: 'Grace',
    contact: { phone: '***', city: 'Ankara' },
    address: { city: 'Ankara', zip: '06000' },
    country: 'TR',
  },
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
const stages = () => JSON.parse(app().querySelector('#stages')!.textContent!) as unknown[]

async function opened(
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  docs: unknown[] = PEOPLE,
  locale = 'en',
) {
  const fake = fakeClient(
    { place: PLACE, locale },
    {
      'documents.find': () => ({ documents: docs }),
      'documents.aggregate': () => ({ documents: docs }),
      ...handlers,
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('a field hidden from the user (review 23)', () => {
  it('is never offered, nor the object holding it, and a step naming it is refused', async () => {
    const { calls } = await opened()
    await addStep('remove')
    const offered = [...app().querySelectorAll<HTMLOptionElement>('#steps select option')].map((o) => o.value)
    expect(offered).not.toContain('contact')
    expect(offered).not.toContain('contact.phone')
    expect(offered).toContain('contact.city')
    await addStep('flatten')
    const objects = [...app().querySelectorAll<HTMLOptionElement>('[data-step="flatten"] select option')].map(
      (o) => o.value,
    )
    expect(objects).toEqual(['address'])
    await addStep('rename')
    const to = app().querySelector<HTMLInputElement>('[data-step="rename"] input')!
    change(to, 'contact.phone')
    await settle()
    expect(app().querySelector('[data-step="rename"] [data-problem="hidden"]')).not.toBeNull()
    expect(JSON.stringify(stages())).not.toContain('phone')
    expect(JSON.stringify(calls.filter((c) => c.method !== 'context.get'))).not.toContain('phone')
  })
})

describe('the preview (review 28)', () => {
  it('waits for the edits to stop, then reads once', async () => {
    const { calls } = await opened()
    await addStep('rename')
    const to = app().querySelector<HTMLInputElement>('[data-step="rename"] input')!
    for (const name of ['a', 'ab', 'abc', 'abcd', 'name']) change(to, name)
    await settle()
    const runs = calls.filter((c) => c.method === 'documents.aggregate')
    expect(runs).toHaveLength(1)
    expect((runs[0]!.params.pipeline as unknown[]).slice(1)).toEqual([
      { $set: { name: '$fullName' } },
      { $unset: 'fullName' },
    ])
  })

  it('runs one at a time, then once more with the latest steps — never refused as busy', async () => {
    let release: () => void = () => {}
    const { calls } = await opened({
      'documents.aggregate': async () => {
        await new Promise<void>((r) => (release = r))
        return { documents: PEOPLE }
      },
    })
    await addStep('remove')
    await settle() // the first preview is running
    const field = app().querySelector<HTMLSelectElement>('[data-step="remove"] select')!
    change(field, 'address')
    await settle() // the second waits for the first
    expect(calls.filter((c) => c.method === 'documents.aggregate')).toHaveLength(1)
    release()
    await flush()
    await flush()
    release()
    await flush()
    const runs = calls.filter((c) => c.method === 'documents.aggregate')
    expect(runs).toHaveLength(2)
    expect((runs[1]!.params.pipeline as unknown[]).slice(1)).toEqual([{ $unset: 'address' }])
    expect(app().textContent).not.toContain('still waiting')
    expect(app().textContent).not.toContain('could not be made')
  })

  it('shows the same documents before and after when they have no _id', async () => {
    const docs = PEOPLE.map(({ _id, ...rest }) => (void _id, rest))
    const { calls } = await opened(
      {
        'documents.aggregate': () => ({
          documents: [{ before: docs, after: docs.map(({ fullName, ...rest }) => (void fullName, rest)) }],
        }),
      },
      docs,
    )
    await addStep('remove')
    await settle()
    const run = calls.find((c) => c.method === 'documents.aggregate')!
    expect(run.params.pipeline).toEqual([
      { $limit: 5 },
      { $facet: { before: [], after: [{ $unset: 'fullName' }] } },
    ])
    expect(app().querySelector('#before')!.textContent).toContain("fullName: 'Ada'")
    expect(app().querySelector('#after')!.textContent).not.toContain('fullName')
    expect(app().querySelector('#after')!.textContent).toContain("city: 'Izmir'")
  })
})

describe('focus (review 29)', () => {
  it('stays on the control the user changed, through the preview', async () => {
    await opened()
    await addStep('rename')
    const to = app().querySelector<HTMLInputElement>('[data-step="rename"] input')!
    to.focus()
    change(to, 'name')
    await settle()
    expect(to.isConnected).toBe(true)
    expect(document.activeElement).toBe(to)
    const from = app().querySelector<HTMLSelectElement>('[data-step="rename"] select')!
    from.focus()
    change(from, 'address')
    await settle()
    expect(from.isConnected).toBe(true)
    expect(document.activeElement).toBe(from)
  })

  it('moves to the same control when a step is drawn again, and on after a step is removed', async () => {
    await opened()
    await addStep('default')
    const kindOfValue = () => app().querySelectorAll<HTMLSelectElement>('[data-step="default"] select')[1]!
    kindOfValue().focus()
    change(kindOfValue(), 'number')
    await flush()
    expect(document.activeElement).toBe(kindOfValue())
    await addStep('remove')
    app().querySelector<HTMLButtonElement>('[data-step="default"] button')!.click()
    await flush()
    // The next step's Remove, now the first.
    expect(document.activeElement).toBe(app().querySelector('[data-step="remove"] button'))
    app().querySelector<HTMLButtonElement>('[data-step="remove"] button')!.click()
    await flush()
    expect(document.activeElement).toBe(app().querySelector('#kind'))
  })
})

describe('what the page says (review 30)', () => {
  it('names each Remove button and the kind of a new step', async () => {
    await opened()
    expect(app().querySelector('#kind')!.getAttribute('aria-label')).toBe('Kind of step')
    await addStep('rename')
    await addStep('remove')
    const removes = [...app().querySelectorAll('#steps .rs-step-head button')].map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(removes).toEqual(['Remove step 1: Rename or move', 'Remove step 2: Remove'])
  })

  it('in Turkish too', async () => {
    await opened({}, PEOPLE, 'tr')
    expect(app().querySelector('#kind')!.getAttribute('aria-label')).toBe('Adım türü')
    await addStep('remove')
    expect(app().querySelector('#steps .rs-step-head button')!.getAttribute('aria-label')).toBe(
      '1. adımı kaldır: Kaldır',
    )
  })

  it('says what a step writes over', async () => {
    await opened()
    await addStep('rename')
    change(app().querySelector<HTMLInputElement>('[data-step="rename"] input')!, 'address')
    await flush()
    expect(app().querySelector('[data-clash]')!.textContent).toBe(
      'address already exists: its value is replaced.',
    )
    expect(stages()).toHaveLength(2)
  })

  it('fills a missing field only, or a null one too when chosen', async () => {
    await opened()
    await addStep('default')
    const path = app().querySelector<HTMLSelectElement>('[data-step="default"] select')!
    change(path, 'country')
    await flush()
    expect(JSON.stringify(stages())).toContain('"missing"')
    const when = app().querySelector<HTMLSelectElement>(
      '[data-step="default"] select[aria-label="Fill where the field is"]',
    )!
    change(when, 'missingOrNull')
    await flush()
    expect(JSON.stringify(stages())).toContain('$ifNull')
  })

  it('says when steps with a problem are left out of the stages', async () => {
    const { calls } = await opened({ 'ui.useAggregation': () => true })
    await addStep('rename')
    change(app().querySelector<HTMLInputElement>('[data-step="rename"] input')!, '$where')
    await addStep('remove')
    await flush()
    expect(app().querySelector('#left-out')!.textContent).toBe(
      '1 step with a problem is left out of the stages.',
    )
    app().querySelector<HTMLButtonElement>('#use')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useAggregation')!.params).toEqual({
      stages: [{ $unset: 'fullName' }],
    })
  })

  it('refuses more stages than a preview and a hand-off may hold', async () => {
    const { calls } = await opened()
    for (let i = 0; i < 49; i++) await addStep('remove')
    await settle()
    expect(stages()).toHaveLength(49)
    expect(app().querySelector('[data-too-many]')!.textContent).toContain('at most 48')
    expect(app().querySelector<HTMLButtonElement>('#use')!.disabled).toBe(true)
    expect(app().querySelector<HTMLButtonElement>('#copy')!.disabled).toBe(true)
    // No preview of them: its $match and their 49 would pass the bridge's 50, the cap alone stops it.
    expect(
      calls.some((c) => c.method === 'documents.aggregate' && (c.params.pipeline as unknown[]).length > 49),
    ).toBe(false)
  })

  it('says whether the stages were copied', async () => {
    let fail = true
    await opened({
      'ui.copy': () => {
        if (fail) throw new AskError('failed', 'Click in the page first')
        return true
      },
    })
    await addStep('remove')
    app().querySelector<HTMLButtonElement>('#copy')!.click()
    await flush()
    expect(app().textContent).toContain('Click in the page first')
    fail = false
    app().querySelector<HTMLButtonElement>('#copy')!.click()
    await flush()
    expect(app().textContent).toContain('The stages were copied.')
  })
})
