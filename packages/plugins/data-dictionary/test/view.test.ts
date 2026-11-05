// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError, askMessage } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount } from '../src/view'
import type { Model } from '../src/dictionary'

/** Plugins wave 3 (spec §5): the dictionary tab — one model read, then each collection's definitions. */
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const MODEL: Model = {
  db: 'shop',
  sampleSize: 200,
  collections: [
    {
      name: 'orders',
      type: 'collection',
      sampled: 3,
      fields: [
        { path: '_id', types: ['objectId'], share: 1 },
        { path: 'card', types: [], share: 1, masked: true },
      ],
      moreFields: 0,
    },
    {
      name: 'users',
      type: 'collection',
      sampled: 2,
      fields: [{ path: '_id', types: ['objectId'], share: 1 }],
      moreFields: 0,
    },
    { name: 'recent', type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: 'orders' },
  ],
  references: [],
  skipped: 0,
  at: '2026-10-26T00:00:00.000Z',
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function opened(
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  waits: number[] = [],
) {
  const fake = fakeClient(
    { place: PLACE },
    {
      'database.model': () => MODEL,
      'indexes.list': (p) =>
        p.coll === 'orders'
          ? [{ name: '_id_', key: { _id: 1 }, options: {} }]
          : [{ name: 'users_id', key: { _id: 1 }, options: {} }],
      'validation.get': () => ({
        validator: { $jsonSchema: { required: ['_id'] } },
        validationLevel: 'strict',
        validationAction: 'error',
      }),
      ...handlers,
    },
  )
  mount(app(), fake.client, {
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  fake.greet()
  await flush(12)
  return fake
}
const sectionOf = (name: string) => app().querySelector(`section[data-collection="${name}"]`)!

describe('the data dictionary tab', () => {
  it('reads the model once, then the indexes and rules of each collection — never a view’s', async () => {
    const { calls } = await opened()
    expect(calls.filter((c) => c.method === 'database.model')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'indexes.list').map((c) => c.params.coll)).toEqual([
      'orders',
      'users',
    ])
    expect(calls.filter((c) => c.method === 'validation.get').map((c) => c.params.coll)).toEqual([
      'orders',
      'users',
    ])
    const sections = [...app().querySelectorAll<HTMLElement>('section[data-collection]')].map(
      (s) => s.dataset.collection,
    )
    expect(sections).toEqual(['orders', 'users', 'recent'])
    const orders = app().querySelector('section[data-collection="orders"]')!
    expect(orders.textContent).toContain('_id_')
    expect(orders.textContent).toContain('Validation: strict, error.')
    expect(orders.querySelector('tbody tr:nth-child(2)')!.textContent).toContain('hidden')
    expect(app().querySelector('section[data-collection="recent"]')!.textContent).toContain(
      'A view of orders.',
    )
    expect([...app().querySelectorAll('.dd-contents a')].map((a) => a.getAttribute('href'))).toEqual([
      '#coll-orders',
      '#coll-users',
      '#coll-recent',
    ])
  })

  // Wave 3 review: names on the page carry no character that reverses or hides text.
  it('shows names and notes without reversing or unseen characters', async () => {
    const rlo = String.fromCharCode(0x202e)
    const zw = String.fromCharCode(0x200b)
    await opened({
      'database.model': () => ({
        ...MODEL,
        collections: [
          {
            name: `ord${rlo}ers`,
            type: 'collection',
            sampled: 1,
            fields: [{ path: `to${zw}tal`, types: ['int'], share: 1 }],
            moreFields: 0,
          },
          { name: `v${rlo}iew`, type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: `ord${rlo}ers` },
        ],
        references: [
          { from: `ord${rlo}ers`, field: `user${rlo}Id`, to: 'users', many: false, sources: ['name'] },
        ],
      }),
      'indexes.list': () => [{ name: `by${rlo}x`, key: { [`a${zw}b`]: 1 }, options: {} }],
    })
    const text = app().textContent!
    expect(text).toContain('orders')
    expect(text).toContain('total')
    expect(text).not.toContain(rlo)
    expect(text).not.toContain(zw)
  })

  it('saves Markdown and HTML, and copies Markdown, through the app', async () => {
    const { calls } = await opened({ 'ui.download': () => true, 'ui.copy': () => true })
    app().querySelector<HTMLButtonElement>('#save-markdown')!.click()
    app().querySelector<HTMLButtonElement>('#save-html')!.click()
    app().querySelector<HTMLButtonElement>('#copy-markdown')!.click()
    await flush()
    const downloads = calls.filter((c) => c.method === 'ui.download').map((c) => c.params)
    expect(downloads[0]).toMatchObject({
      name: 'shop-dictionary',
      type: 'markdown',
      text: expect.stringContaining('# shop — data dictionary'),
    })
    expect(downloads[1]).toMatchObject({
      type: 'html',
      html: { title: 'shop — data dictionary', body: expect.stringContaining('<h1>') },
    })
    expect(calls.find((c) => c.method === 'ui.copy')!.params.text).toContain('## orders')
  })

  it('says what failed, a collection whose definitions it may not read included', async () => {
    await opened({
      'indexes.list': () => {
        throw new AskError('forbidden', 'No')
      },
    })
    expect(sectionOf('orders').textContent).toContain('Its indexes could not be read: ')
    document.body.innerHTML = '<div id="app"></div>'
    await opened({
      'database.model': () => {
        throw new AskError('not_permitted', 'This plugin was not approved for database:read')
      },
    })
    expect(app().textContent).toContain(
      'Reading the other collections needs the plugin’s database permission.',
    )
  })

  // Wave 3 review: a time-out on one collection's definitions replaced the whole dictionary.
  it('marks only the collection whose definitions failed, and reads the rest', async () => {
    const { calls } = await opened({
      'indexes.list': (p) => {
        if (p.coll === 'orders') throw new AskError('timeout', 'Slow')
        return [{ name: 'users_id', key: { _id: 1 }, options: {} }]
      },
    })
    expect(sectionOf('orders').textContent).toContain(
      `Its indexes could not be read: ${askMessage(new AskError('timeout', 'Slow'), 'en')}`,
    )
    expect(sectionOf('orders').textContent).toContain('Validation: strict, error.')
    expect(sectionOf('users').textContent).toContain('users_id')
    expect(calls.filter((c) => c.method === 'validation.get')).toHaveLength(2)
    expect(app().querySelector('.mm-callout-danger')).toBeNull()
    expect(app().querySelector('#save-markdown')).not.toBeNull()
  })

  it('waits and tries again when the minute’s reads are spent, a few times at most', async () => {
    let tries = 0
    const waits: number[] = []
    await opened(
      {
        'indexes.list': (p) => {
          if (p.coll === 'orders' && tries++ < 2) throw new AskError('too_many', 'Too many')
          return [{ name: `${String(p.coll)}_id`, key: { _id: 1 }, options: {} }]
        },
      },
      waits,
    )
    expect(tries).toBe(3)
    expect(waits).toHaveLength(2)
    expect(sectionOf('orders').textContent).toContain('orders_id')

    document.body.innerHTML = '<div id="app"></div>'
    const always: number[] = []
    const { calls } = await opened(
      {
        'indexes.list': () => {
          throw new AskError('too_many', 'Too many')
        },
      },
      always,
    )
    // Bounded: a few waits for each collection, then that collection is marked.
    expect(calls.filter((c) => c.method === 'indexes.list')).toHaveLength(8)
    expect(always).toHaveLength(6)
    expect(sectionOf('users').textContent).toContain('Its indexes could not be read: ')
  })

  it('never says a collection has no rules when its rules could not be read', async () => {
    await opened({
      'validation.get': () => {
        throw new AskError('forbidden', 'No')
      },
    })
    expect(sectionOf('orders').textContent).toContain('Its rules could not be read: ')
    expect(sectionOf('orders').textContent).not.toContain('No validation rules.')
  })

  // Wave 3 second review: a failure's words were shown with what turns text around.
  it('shows why definitions could not be read without reversing or unseen characters', async () => {
    const rlo = String.fromCharCode(0x202e)
    await opened({
      'indexes.list': () => {
        throw new AskError('failed', `bad${rlo}name`)
      },
      'validation.get': () => {
        throw new AskError('failed', `odd${rlo}rule`)
      },
    })
    const text = sectionOf('orders').textContent!
    expect(text).toContain('badname')
    expect(text).toContain('oddrule')
    expect(text).not.toContain(rlo)
  })

  it('shows no note when the user says no to a save', async () => {
    await opened({
      'ui.download': () => {
        throw new AskError('declined', 'The user said no')
      },
    })
    app().querySelector<HTMLButtonElement>('#save-markdown')!.click()
    await flush()
    expect(app().querySelector('.mm-callout-danger')).toBeNull()
    expect(app().querySelector('.mm-callout-warning')).toBeNull()
  })

  it('saves the first collections that fit when the dictionary is over the limits, and says so', async () => {
    const many: Model = {
      ...MODEL,
      collections: Array.from({ length: 12 }, (_, i) => ({
        name: `c${i}`,
        type: 'collection' as const,
        sampled: 1,
        fields: Array.from({ length: 10 }, (_, j) => ({ path: `field_${j}`, types: ['string'], share: 1 })),
        moreFields: 0,
      })),
    }
    const fake = fakeClient(
      { place: PLACE },
      {
        'database.model': () => many,
        'indexes.list': () => [],
        'validation.get': () => null,
        'ui.download': () => true,
      },
    )
    mount(app(), fake.client, { wait: async () => undefined, saveLimits: { chars: 3000, bytes: 6000 } })
    fake.greet()
    await flush(40)
    app().querySelector<HTMLButtonElement>('#save-markdown')!.click()
    await flush()
    const text = fake.calls.find((c) => c.method === 'ui.download')!.params.text as string
    expect(text.length).toBeLessThanOrEqual(3000)
    expect(app().querySelector('.mm-callout-warning')!.textContent).toMatch(
      /Only the first \d+ of 12 collections were saved/,
    )
  })

  // Wave 3 third review: when not one collection fits, nothing is saved and the page says why.
  it('saves nothing and says so when not even one collection fits', async () => {
    const fake = fakeClient(
      { place: PLACE },
      {
        'database.model': () => MODEL,
        'indexes.list': () => [],
        'validation.get': () => null,
        'ui.download': () => true,
      },
    )
    mount(app(), fake.client, { wait: async () => undefined, saveLimits: { chars: 100, bytes: 400 } })
    fake.greet()
    await flush(40)
    app().querySelector<HTMLButtonElement>('#save-markdown')!.click()
    await flush()
    expect(fake.calls.some((c) => c.method === 'ui.download')).toBe(false)
    expect(app().querySelector('.mm-callout-danger')!.textContent).toContain(
      'The dictionary is too large to save: even its first collection is over the 1 MB a saved file may be.',
    )
  })

  // Wave 3 review: Copy Markdown cut a long dictionary at 100,000 characters without a word.
  it('says when Copy took only the start of a long dictionary', async () => {
    const big: Model = {
      ...MODEL,
      collections: [
        {
          name: 'orders',
          type: 'collection',
          sampled: 3,
          fields: Array.from({ length: 2000 }, (_, i) => ({
            path: `field_${i}_${'x'.repeat(40)}`,
            types: ['string'],
            share: 1,
          })),
          moreFields: 0,
        },
      ],
    }
    const { calls } = await opened({ 'database.model': () => big, 'ui.copy': () => true })
    app().querySelector<HTMLButtonElement>('#copy-markdown')!.click()
    await flush()
    const text = calls.find((c) => c.method === 'ui.copy')!.params.text as string
    expect(text.length).toBeLessThanOrEqual(100_000)
    expect(text.endsWith('|')).toBe(true)
    expect(app().textContent).toContain('Only the first 100,000 characters were copied')
  })
})
