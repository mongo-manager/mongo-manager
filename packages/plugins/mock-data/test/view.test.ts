// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { answerOf, apiLog, fakeClient, flush } from '../../kit/test/fakeClient'
import { mount } from '../src/view'

/** Numbers as a language writes them, asked of Intl rather than spelled out. */
const grouped = (n: number, lang: string) => new Intl.NumberFormat(lang).format(n)
const megabytes = (n: number, lang: string) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/** Plugins wave 3 (spec §3): the test data tab — fields, templates, preview, handed to Import. */
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null }
const PEOPLE = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    name: 'Ada',
    email: '***',
    status: 'active',
    age: { $numberInt: '36' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a02' },
    name: 'Grace',
    email: '***',
    status: 'left',
    age: { $numberInt: '45' },
  },
  // Each status seen twice: a few values repeated are offered (wave 3 review).
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a03' },
    name: 'Linus',
    email: '***',
    status: 'active',
    age: { $numberInt: '51' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a04' },
    name: 'Ken',
    email: '***',
    status: 'left',
    age: { $numberInt: '29' },
  },
]

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const rows = () => [...app().querySelectorAll<HTMLElement>('#fields tbody tr')].map((r) => r.dataset.plan)
const select = (path: string) => app().querySelector<HTMLSelectElement>(`select[data-field="${path}"]`)!

async function opened(
  place = { ...PLACE, hidden: [['email']] },
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
) {
  const fake = fakeClient({ place }, { 'documents.find': () => ({ documents: PEOPLE }), ...handlers })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the test data tab', () => {
  it('lists the fields with test values chosen by their names, a hidden one as hidden', async () => {
    await opened()
    expect(rows()).toEqual(['name', 'email', 'status', 'age'])
    expect(select('name').value).toBe('fullName')
    // Hidden: text until the user picks (spec §3), whatever the name says.
    expect(select('email').value).toBe('sentence')
    expect(select('status').value).toBe('existing')
    expect(select('age').value).toBe('age')
    const email = app().querySelector('tr[data-plan="email"]')!
    expect(email.textContent).toContain('hidden')
    // Its values are never offered as "existing" (none were read).
    expect([...select('email').options].some((o) => o.value === 'existing')).toBe(false)
    expect(select('name').options.length).toBeGreaterThanOrEqual(100)
  })

  // User report 2026-11-07: API logs of ~60 KB a document — 100 of them are over what one answer may
  // be, and the tab stopped on "too large" before showing a field.
  it('lists the fields of a collection of documents too large for one answer', async () => {
    const logs = Array.from({ length: 150 }, (_, i) => apiLog(i))
    const fake = await opened({ ...PLACE, hidden: [] }, { 'documents.find': (p) => answerOf(logs, p) })
    expect(app().textContent).not.toContain('could not be read')
    expect(rows()).toEqual(expect.arrayContaining(['path', 'status', 'request.body', 'response.body']))
    expect(fake.calls.find((c) => c.method === 'documents.find')!.params).toMatchObject({ fit: true })
  })

  it('previews documents as the shell writes them, and changes with a template or a setting', async () => {
    await opened()
    const preview = () => app().querySelector('#preview')!.textContent!
    expect(preview()).toMatch(/name: '.+ .+'/)
    // The hidden e-mail is text until chosen; chosen, it is an address on a reserved domain.
    select('email').value = 'email'
    select('email').dispatchEvent(new Event('change'))
    expect(preview()).toMatch(/email: '[^']+@(example\.(com|org|net)|mail\.test|shop\.test)'/)
    expect(preview()).not.toContain('_id')
    const before = preview()
    select('name').value = 'constant'
    select('name').dispatchEvent(new Event('change'))
    const constant = app().querySelector<HTMLInputElement>('.md-constant')!
    constant.value = 'Test user'
    constant.dispatchEvent(new Event('change'))
    expect(preview()).toContain("name: 'Test user'")
    const seed = app().querySelector<HTMLInputElement>('#seed')!
    seed.value = '77'
    seed.dispatchEvent(new Event('change'))
    expect(preview()).not.toBe(before)
    // A field left out is not made.
    app().querySelector<HTMLInputElement>('tr[data-plan="age"] input[type="checkbox"]')!.click()
    expect(preview()).not.toContain('age:')
  })

  it('adds a field by a safe name only', async () => {
    await opened()
    // The page is drawn again after each try: the box is found anew.
    const name = () => app().querySelector<HTMLInputElement>('#new-field')!
    for (const bad of ['$where', 'a..b', 'with space', '']) {
      name().value = bad
      app().querySelector<HTMLButtonElement>('#add-field')!.click()
    }
    expect(rows()).toEqual(['name', 'email', 'status', 'age'])
    // The last refused name (here, empty) stays in the box.
    expect(name().value).toBe('')
    name().value = 'profile.phone'
    app().querySelector<HTMLButtonElement>('#add-field')!.click()
    expect(rows()).toContain('profile.phone')
    expect(select('profile.phone').value).toBe('phone')
  })

  it('hands the documents to the Import wizard, and says so', async () => {
    const fake = await opened(undefined, { 'ui.importDocuments': () => true })
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '20'
    count.dispatchEvent(new Event('change'))
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    const ndjson = fake.calls.find((c) => c.method === 'ui.importDocuments')!.params.ndjson as string
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(20)
    for (const line of lines) expect(Object.keys(JSON.parse(line))).not.toContain('_id')
    expect(app().textContent).toContain('Opened in the Import wizard')
  })

  it('says why the wizard did not open, and when the documents are over 1 MB', async () => {
    await opened(undefined, {
      'ui.importDocuments': () => {
        throw new AskError('not_permitted', 'You may not import into this collection')
      },
    })
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    // The user may not import: said as such, never as the plugin's fault (wave 3 review).
    expect(app().textContent).toContain('You may not import into this collection')
    expect(app().textContent).not.toContain('The plugin is not allowed')
    select('name').value = 'paragraph'
    select('name').dispatchEvent(new Event('change'))
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '5000'
    count.dispatchEvent(new Event('change'))
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    expect(app().textContent).toContain(
      `one hand-off to the wizard takes at most ${grouped(1_000_000, 'en')} characters and ${megabytes(1.04, 'en')} MB as sent: make fewer`,
    )
  })

  // Wave 3 review (opus, 2026-10-26).
  it('refuses a new field that reaches a prototype, _id, or one already there above or below', async () => {
    await opened({ ...PLACE, hidden: [] })
    const name = () => app().querySelector<HTMLInputElement>('#new-field')!
    const add = () => app().querySelector<HTMLButtonElement>('#add-field')!.click()
    for (const bad of ['__proto__', 'a.constructor', 'prototype.x', '_id', '_id.x', 'name', 'name.first']) {
      name().value = bad
      add()
      expect(rows(), bad).toEqual(['name', 'email', 'status', 'age'])
      expect(app().querySelector('#new-field-note')!.textContent, bad).toContain('Not added')
      // Kept in the box, to be corrected, and marked as refused.
      expect(name().value, bad).toBe(bad)
      expect(name().getAttribute('aria-invalid'), bad).toBe('true')
    }
    name().value = 'profile.city'
    add()
    expect(rows()).toContain('profile.city')
    expect(app().querySelector('#new-field-note')!.textContent).toBe('')
    expect(name().value).toBe('')
    // Now `profile` holds one: neither it nor `profile.city.zip` may be added.
    for (const bad of ['profile', 'profile.city.zip']) {
      name().value = bad
      add()
      expect(rows().filter((r) => r!.startsWith('profile'))).toEqual(['profile.city'])
    }
  })

  // Review I4: the app measures the message as sent, every quote escaped once more; documents under
  // 1 MB of NDJSON were refused as "A message is at most 1 MB" and never said to be too many.
  it('measures the documents as the app receives them, for the wizard and for a download', async () => {
    const fake = await opened(undefined, { 'ui.importDocuments': () => true, 'ui.download': () => true })
    select('name').value = 'constant'
    select('name').dispatchEvent(new Event('change'))
    const constant = app().querySelector<HTMLInputElement>('.md-constant')!
    constant.value = '"'.repeat(100)
    constant.dispatchEvent(new Event('change'))
    for (const path of ['email', 'status', 'age'])
      app().querySelector<HTMLInputElement>(`tr[data-plan="${path}"] input[type="checkbox"]`)!.click()
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '4500'
    count.dispatchEvent(new Event('change'))
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    expect(fake.calls.some((c) => c.method === 'ui.importDocuments')).toBe(false)
    expect(app().textContent).toContain(
      `one hand-off to the wizard takes at most ${grouped(1_000_000, 'en')} characters and ${megabytes(1.04, 'en')} MB as sent: make fewer`,
    )
    app().querySelector<HTMLButtonElement>('#download')!.click()
    await flush()
    expect(fake.calls.some((c) => c.method === 'ui.download')).toBe(false)
    expect(app().textContent).toContain(
      `one download takes at most ${grouped(1_000_000, 'en')} characters and ${megabytes(1.04, 'en')} MB as sent: make fewer`,
    )
  })

  it('keeps the focus where it was when the page is drawn again', async () => {
    await opened()
    select('status').focus()
    select('status').value = 'word'
    select('status').dispatchEvent(new Event('change'))
    expect(document.activeElement).toBe(select('status'))
    const seed = app().querySelector<HTMLInputElement>('#seed')!
    seed.focus()
    seed.value = '5'
    seed.dispatchEvent(new Event('change'))
    expect(document.activeElement).toBe(app().querySelector('#seed'))
    const include = () => app().querySelector<HTMLInputElement>('tr[data-plan="age"] input[type="checkbox"]')!
    include().focus()
    include().click()
    expect(document.activeElement).toBe(include())
  })

  it("counts in the reader's language, and says when the preview is all of them", async () => {
    await opened()
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '5000'
    count.dispatchEvent(new Event('change'))
    expect(app().textContent).toContain(`The first 5 of ${grouped(5000, 'en')}`)
    app().querySelector<HTMLInputElement>('#count')!.value = '1'
    app().querySelector<HTMLInputElement>('#count')!.dispatchEvent(new Event('change'))
    expect(app().textContent).toContain('The only document')
    expect(app().textContent).not.toContain('The first 1 of 1')
  })

  it('says a hidden field is left out by the wizard until included there, in both languages', async () => {
    await opened()
    expect(app().querySelector('tr[data-plan="email"] [title]')!.getAttribute('title')).toContain(
      'Import wizard leaves it out',
    )
  })

  it('makes nothing for a view, and speaks Turkish', async () => {
    const fake = fakeClient({ place: { ...PLACE, view: true } }, {})
    mount(app(), fake.client)
    fake.greet()
    await flush()
    expect(app().textContent).toContain('A view holds no documents of its own')
    expect(fake.calls.some((c) => c.method === 'documents.find')).toBe(false)
    document.body.innerHTML = '<div id="app"></div>'
    const tr = fakeClient({ place: PLACE, locale: 'tr' }, { 'documents.find': () => ({ documents: PEOPLE }) })
    mount(app(), tr.client)
    tr.greet()
    await flush()
    expect(app().textContent).toContain('Test verisi')
    expect(app().querySelector<HTMLSelectElement>('#lang')!.value).toBe('tr')
    // Import and Add read apart (wave 3 review); numbers as Turkish writes them.
    expect(app().querySelector('#insert')!.textContent).toBe('İçe aktar…')
    expect(app().querySelector('#add-field')!.textContent).toBe('Ekle')
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '5000'
    count.dispatchEvent(new Event('change'))
    expect(app().textContent).toContain(`${grouped(5000, 'tr')} belgenin ilk 5 tanesi`)
    expect(app().querySelector('tr[data-plan="email"] [title]')).toBeNull()
  })
})

/** The second review of wave 3 (opus, 2026-10-26). */
describe('the test data tab after the second review', () => {
  it('treats every field as hidden while what is hidden is unknown, and reads again on Try again', async () => {
    const place: Record<string, unknown> = { ...PLACE, hidden: null }
    const fake = fakeClient({ place } as never, { 'documents.find': () => ({ documents: PEOPLE }) })
    mount(app(), fake.client)
    fake.greet()
    await flush()
    const warning = app().querySelector('#hidden-unknown')!
    expect(warning.textContent).toContain('Which fields are hidden from you could not be told')
    // Nothing is told of any field: no type, no existing value, text everywhere.
    for (const path of ['name', 'email', 'status', 'age']) {
      expect(app().querySelector(`tr[data-plan="${path}"]`)!.textContent, path).toContain('hidden')
      expect(select(path).value, path).toBe('sentence')
      expect(
        [...select(path).options].some((o) => o.value === 'existing'),
        path,
      ).toBe(false)
    }
    place.hidden = [['email']]
    app().querySelector<HTMLButtonElement>('#hidden-retry')!.click()
    await flush()
    expect(app().querySelector('#hidden-unknown')).toBeNull()
    expect(select('status').value).toBe('existing')
    expect(select('name').value).toBe('fullName')
    expect(fake.calls.filter((c) => c.method === 'context.get')).toHaveLength(2)
  })

  // Third review 15: the warning is the kit's own callout, Try again inside it; what the user chose
  // stays when it is read again.
  it('keeps what the user chose when it tries again, and shows Try again inside the warning', async () => {
    const place: Record<string, unknown> = { ...PLACE, hidden: null }
    const fake = fakeClient({ place } as never, { 'documents.find': () => ({ documents: PEOPLE }) })
    mount(app(), fake.client)
    fake.greet()
    await flush()
    const warning = app().querySelector('#hidden-unknown')!
    expect(warning.classList.contains('mm-callout')).toBe(true)
    expect(warning.querySelector('#hidden-retry')).not.toBeNull()
    // The user picks a template, leaves a field out, and adds one of their own.
    const age = select('age')
    age.value = 'smallInt'
    age.dispatchEvent(new Event('change'))
    const include = app().querySelector<HTMLInputElement>('tr[data-plan="status"] input[type="checkbox"]')!
    include.checked = false
    include.dispatchEvent(new Event('change'))
    app().querySelector<HTMLInputElement>('#new-field')!.value = 'note'
    app().querySelector<HTMLButtonElement>('#add-field')!.click()
    await flush()
    place.hidden = [['email']]
    app().querySelector<HTMLButtonElement>('#hidden-retry')!.click()
    await flush()
    expect(app().querySelector('#hidden-unknown')).toBeNull()
    expect(select('age').value).toBe('smallInt')
    expect(
      app().querySelector<HTMLInputElement>('tr[data-plan="status"] input[type="checkbox"]')!.checked,
    ).toBe(false)
    expect(rows()).toContain('note')
    // What the user did not touch takes what is now known.
    expect(select('name').value).toBe('fullName')
    expect(app().querySelector('tr[data-plan="email"]')!.textContent).toContain('hidden')
  })

  it('says it in Turkish too', async () => {
    const tr = fakeClient(
      { place: { ...PLACE, hidden: null } as never, locale: 'tr' },
      {
        'documents.find': () => ({ documents: PEOPLE }),
      },
    )
    mount(app(), tr.client)
    tr.greet()
    await flush()
    expect(app().querySelector('#hidden-unknown')!.textContent).toContain('Hangi alanların sizden gizlendiği')
    expect(app().querySelector('#hidden-retry')!.textContent).toBe('Yeniden dene')
  })

  it('says nothing alarming when the user says no to a save or a hand-off', async () => {
    const no = () => {
      throw new AskError('declined', 'The user said no')
    }
    await opened(undefined, { 'ui.importDocuments': no, 'ui.download': no })
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    expect(app().querySelector('.mm-callout-danger')).toBeNull()
    expect(app().textContent).toContain('Not handed over.')
    app().querySelector<HTMLButtonElement>('#download')!.click()
    await flush()
    expect(app().querySelector('.mm-callout-danger')).toBeNull()
    expect(app().textContent).toContain('Not saved.')
  })

  it('refuses a new field inside a list of documents, a $ anywhere, and brackets', async () => {
    const docs = [{ items: [{ qty: { $numberInt: '1' } }] }, { items: [{ qty: { $numberInt: '2' } }] }]
    const fake = fakeClient(
      { place: { ...PLACE, hidden: [] } },
      { 'documents.find': () => ({ documents: docs }) },
    )
    mount(app(), fake.client)
    fake.greet()
    await flush()
    const name = () => app().querySelector<HTMLInputElement>('#new-field')!
    const add = () => app().querySelector<HTMLButtonElement>('#add-field')!.click()
    name().value = 'items.note'
    add()
    expect(rows()).toEqual(['items[].qty'])
    expect(app().querySelector('#new-field-note')!.textContent).toContain('inside a list of documents')
    for (const bad of ['items[].qty', 'items[].note', 'a$b', 'a.b$c', 'x]']) {
      name().value = bad
      add()
      expect(rows(), bad).toEqual(['items[].qty'])
      expect(app().querySelector('#new-field-note')!.textContent, bad).toContain('Not added')
    }
  })

  it('says how large the documents are to the hundredth, and the limit as it is', async () => {
    await opened(undefined, { 'ui.importDocuments': () => true })
    select('name').value = 'paragraph'
    select('name').dispatchEvent(new Event('change'))
    const count = app().querySelector<HTMLInputElement>('#count')!
    count.value = '5000'
    count.dispatchEvent(new Event('change'))
    app().querySelector<HTMLButtonElement>('#insert')!.click()
    await flush()
    const said = app().querySelector('.mm-callout-danger')!.textContent!
    expect(said).toMatch(/These documents are \d+\.\d\d MB as sent/)
    expect(said).toContain('at most 1,000,000 characters and 1.04 MB as sent')
  })

  it('tells a keyboard why a field is hidden', async () => {
    await opened()
    const describedBy = select('email').getAttribute('aria-describedby')!
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy)!.textContent).toContain('Hidden from you as personal data')
    expect(select('name').getAttribute('aria-describedby')).toBeNull()
  })
})
