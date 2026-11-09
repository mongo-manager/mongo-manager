// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem, SnippetView } from '@mongo-manager/shared'
import { i18n } from '../src/i18n'
import SaveSnippetDialog from '../src/shell/SaveSnippetDialog.vue'
import SnippetRunDialog from '../src/shell/SnippetRunDialog.vue'
import { useShellInbox } from '../src/stores/shellInbox'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { openLibraryItem } from '../src/library/openItem'
import { mockApi, mountApp } from './support/app'

/** Phase 3a-2 spec §3.5: snippets in the web — save, fill parameters safely, insert, never run. */
beforeEach(() => {
  // The tabs store restores tabs from storage: start each test from none.
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const field = (label: string) =>
  [...document.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))!
const input = (label: string) => document.getElementById(field(label).htmlFor) as HTMLInputElement
async function fill(label: string, value: string) {
  const el = input(label)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!

describe('SaveSnippetDialog', () => {
  const code = 'db.orders.find({ tag: {{tag}} }).limit({{n}})'

  it('offers a parameter row for each placeholder and saves the snippet', async () => {
    const { calls } = mockApi({
      'POST connections/c1/snippets': (body) => [
        201,
        { id: 's1', ...(body as object), mine: true, owner: null },
      ],
    })
    const { wrapper } = mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code } })
    expect(
      [...document.querySelectorAll('[data-param-row]')].map((r) => r.getAttribute('data-param-row')),
    ).toEqual(['tag', 'n'])
    await fill('Name', 'Top tags')
    const type = document.querySelector('[data-param-row="n"] select') as HTMLSelectElement
    type.value = 'number'
    type.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({
      name: 'Top tags',
      code,
      params: [
        { name: 'tag', type: 'string' },
        { name: 'n', type: 'number' },
      ],
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('shows an invalid default beside its field and saves nothing', async () => {
    const { calls } = mockApi({})
    mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code } })
    await fill('Name', 'x')
    const type = document.querySelector('[data-param-row="n"] select') as HTMLSelectElement
    type.value = 'number'
    type.dispatchEvent(new Event('change', { bubbles: true }))
    const dflt = document.querySelector('[data-param-row="n"] input[data-param-default]') as HTMLInputElement
    dflt.value = 'abc'
    dflt.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(document.querySelector('[data-param-row="n"]')!.textContent).toContain('not a valid number')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('offers sharing in team mode only', async () => {
    mockApi({})
    mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code } })
    expect(document.body.textContent).not.toContain('Share with the team')
    document.body.innerHTML = ''
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
    mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code } })
    expect(document.body.textContent).toContain('Share with the team')
  })
})

// W5: a saved snippet's code and parameters are edited in the Library, checked as a new one is.
describe('editing a snippet', () => {
  const saved = {
    id: 's1',
    name: 'Top tags',
    tags: ['sales'],
    code: 'db.orders.find({ tag: {{tag}} })',
    params: [{ name: 'tag', type: 'string' as const, default: 'a', required: true }],
    shared: true,
  }
  const codeBox = () => document.getElementById(field('Code').htmlFor) as HTMLTextAreaElement

  it('changes the code, follows its placeholders, keeps tags and sharing, and sends a change', async () => {
    const { calls } = mockApi({
      'PUT connections/c1/snippets/s1': (body) => [
        200,
        { ...saved, ...(body as object), mine: true, owner: null },
      ],
    })
    const { wrapper } = mountApp(SaveSnippetDialog, {
      props: { connectionId: 'c1', code: '', snippet: saved },
    })
    expect(document.body.textContent).toContain('Edit the snippet')
    expect(input('Name').value).toBe('Top tags')
    expect(codeBox().value).toBe(saved.code)
    codeBox().value = 'db.orders.find({ tag: {{tag}} }).limit({{n}})'
    codeBox().dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // The old parameter keeps its settings; the new one gets a row.
    expect(
      [...document.querySelectorAll('[data-param-row]')].map((r) => r.getAttribute('data-param-row')),
    ).toEqual(['tag', 'n'])
    expect(
      (document.querySelector('[data-param-row="tag"] input[data-param-default]') as HTMLInputElement).value,
    ).toBe('a')
    const type = document.querySelector('[data-param-row="n"] select') as HTMLSelectElement
    type.value = 'number'
    type.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({
      name: 'Top tags',
      tags: ['sales'],
      code: 'db.orders.find({ tag: {{tag}} }).limit({{n}})',
      params: [
        { name: 'tag', type: 'string', default: 'a', required: true },
        { name: 'n', type: 'number', required: false },
      ],
      // Local mode offers no sharing, and an edit there never turns a shared snippet private.
      shared: true,
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  // Review (minor): typing through a placeholder (deleting it, writing it again) keeps its settings.
  it('keeps a parameter’s settings while its placeholder is typed over', async () => {
    mockApi({})
    mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code: '', snippet: saved } })
    const type = async (text: string) => {
      codeBox().value = text
      codeBox().dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
    }
    await type('db.orders.find({ tag: {{ta}} })')
    expect(document.querySelector('[data-param-row="tag"]')).toBeNull()
    await type('db.orders.find({ tag: {{tag}} })')
    const row = document.querySelector('[data-param-row="tag"]')!
    expect((row.querySelector('input[data-param-default]') as HTMLInputElement).value).toBe('a')
    expect((row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
  })

  it('refuses code with a placeholder in a string, beside the code, and sends nothing', async () => {
    const { calls } = mockApi({})
    mountApp(SaveSnippetDialog, { props: { connectionId: 'c1', code: '', snippet: saved } })
    codeBox().value = 'db.orders.find({ tag: "{{tag}}" })'
    codeBox().dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(codeBox().getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain('inside a string')
    codeBox().value = ''
    codeBox().dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(document.body.textContent).toContain('no code')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

describe('SnippetRunDialog (review focus 3)', () => {
  const snippet: SnippetView = {
    id: 's1',
    name: 'Tagged',
    tags: [],
    code: 'db.orders.insertOne({ tag: {{tag}}, n: {{n}} })',
    params: [
      { name: 'tag', type: 'string' },
      { name: 'n', type: 'number', default: '1' },
    ],
    shared: true,
    mine: false,
    owner: 'ada',
    updatedAt: '2026-09-29T00:00:00.000Z',
  }

  it('names the author of a shared snippet', () => {
    mountApp(SnippetRunDialog, { props: { snippet } })
    expect(document.body.textContent).toContain('by ada')
  })

  it('inserts hostile text as an inert literal', async () => {
    const { wrapper } = mountApp(SnippetRunDialog, { props: { snippet } })
    await fill('tag', '"); db.dropDatabase(); ("')
    button('Insert').click()
    await flushPromises()
    expect(wrapper.emitted('insert')).toEqual([
      [`db.orders.insertOne({ tag: ${JSON.stringify('"); db.dropDatabase(); ("')}, n: 1 })`],
    ])
  })

  it('shows a bad number beside its field and inserts nothing', async () => {
    const { wrapper } = mountApp(SnippetRunDialog, { props: { snippet } })
    await fill('tag', 'x')
    await fill('n', '1;drop')
    button('Insert').click()
    await flushPromises()
    expect(wrapper.emitted('insert')).toBeUndefined()
    expect(document.body.textContent).toContain('not a number')
  })
})

describe('opening a snippet from the Library', () => {
  const item: LibraryItem = {
    type: 'snippet',
    id: 's1',
    db: '',
    coll: '',
    name: 'Tagged',
    tags: [],
    kind: 'shell',
    preview: 'db.orders.find()',
    body: { code: 'db.orders.find()', params: [] },
    at: '2026-09-29T00:00:00.000Z',
    shared: false,
    mine: true,
  }
  const t = (key: string) => key

  it('opens a shell on the default database and hands it the snippet', async () => {
    await openLibraryItem('c1', item, { t })
    expect(useTabsStore().active).toMatchObject({ kind: 'shell', params: { connectionId: 'c1', db: 'test' } })
    expect(useShellInbox().take('c1')).toBe('s1')
  })

  it('uses the connection’s shell tab when one is open', async () => {
    const tabs = useTabsStore()
    const shell = tabs.open({ kind: 'shell', title: 'Shell', params: { connectionId: 'c1', db: 'shop' } })
    tabs.open({ kind: 'connection', title: 'c1', params: { connectionId: 'c1' } })
    await openLibraryItem('c1', item, { t })
    expect(tabs.activeId).toBe(shell)
    expect(useShellInbox().take('c1')).toBe('s1')
  })
})
