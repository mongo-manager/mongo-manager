// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { SchemaAnalyser, type ValidationState } from '@mongo-manager/shared'
import ValidationView from '../src/validation/ValidationView.vue'
import { useDialogStore } from '../src/stores/dialogs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { rulesChanged } from '../src/masking/rulesEpoch'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const rules = { $jsonSchema: { required: ['n'] } }
const state = (over: Partial<ValidationState> = {}): ValidationState => ({
  validator: rules,
  validationLevel: 'moderate',
  validationAction: 'warn',
  kind: 'collection',
  serverVersion: '8.0.4',
  version: 'f'.repeat(64),
  ...over,
})
/** What a save answers: the new rules and the ones it replaced. */
const savedAnswer = (body: unknown) => ({
  ...state(),
  ...(body as object),
  previous: { validator: rules, validationLevel: 'moderate', validationAction: 'warn' },
})
const doc = (n: number) => ({ document: { n: { $numberInt: String(n) } }, hash: 'h'.repeat(64) })

async function mountView(handlers: Record<string, Handler>, canWrite = true) {
  const api = mockApi({ [`GET ${BASE}/validation`]: () => [200, state()], ...handlers })
  mountApp(ValidationView, { props: { target, canWrite } })
  await flushPromises()
  return api
}

const editor = () => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Rules')!
  return document.getElementById(label.htmlFor) as HTMLTextAreaElement
}
const select = (label: string) => byLabel<HTMLSelectElement>(label)
const typeInto = async (el: HTMLTextAreaElement, text: string) => {
  el.value = text
  el.dispatchEvent(new Event('input'))
  await flushPromises()
}

describe('the Validation section (phase 2b spec §3.2)', () => {
  it('shows the current rules, level and action, offering only what the server supports', async () => {
    await mountView({})
    expect(editor().value).toContain('$jsonSchema')
    expect(editor().value).toContain('required')
    expect(select('Level').value).toBe('moderate')
    expect(select('Action').value).toBe('warn')
    expect([...select('Action').options].map((o) => o.value)).toEqual(['error', 'warn'])
    document.body.innerHTML = ''
    mockApi({ [`GET ${BASE}/validation`]: () => [200, state({ serverVersion: '8.2.1' })] })
    mountApp(ValidationView, { props: { target, canWrite: true } })
    await flushPromises()
    expect([...select('Action').options].map((o) => o.value)).toContain('errorAndLog')
  })

  it('generates rules from a sample, asking before it replaces what is there', async () => {
    const analyser = new SchemaAnalyser()
    for (let i = 0; i < 5; i++) analyser.add({ n: i, name: 'x' })
    const { calls } = await mountView({
      [`POST ${BASE}/schema`]: () => [200, { ...analyser.result(), truncated: false }],
    })
    button('Generate from sample').click()
    await flushPromises()
    expect(useDialogStore().current).not.toBeNull()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(true)
    expect(editor().value).toContain('bsonType')
    expect(editor().value).toContain('name')
  })

  it('tests the rules against the documents: how many fail, with examples, or at least how many (Review Focus 4)', async () => {
    let timedOut = false
    const { calls } = await mountView({
      [`POST ${BASE}/validation/test`]: () =>
        timedOut
          ? [200, { total: 10, failing: null, failingAtLeast: 5, sample: [] }]
          : [200, { total: 10, failing: 3, sample: [doc(1), doc(2), doc(3)] }],
    })
    button('Test against existing documents').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/validation/test'))!.body).toEqual({
      validator: { $jsonSchema: { required: ['n'] } },
    })
    const result = document.querySelector('[data-validation-test]')!
    expect(result.textContent).toContain('3 of 10 documents would fail')
    expect(result.querySelectorAll('li')).toHaveLength(3)
    timedOut = true
    button('Test against existing documents').click()
    await flushPromises()
    expect(document.querySelector('[data-validation-test]')!.textContent).toContain('At least 5 of 10')
  })

  it('saves after a warning when failing documents would be locked, and can restore the rules before', async () => {
    const { calls } = await mountView({
      [`POST ${BASE}/validation/test`]: () => [200, { total: 10, failing: 3, sample: [] }],
      [`PUT ${BASE}/validation`]: (body) => [200, savedAnswer(body)],
    })
    await typeInto(editor(), '{ $jsonSchema: { required: ["n", "name"] } }')
    select('Level').value = 'strict'
    select('Level').dispatchEvent(new Event('change'))
    select('Action').value = 'error'
    select('Action').dispatchEvent(new Event('change'))
    button('Test against existing documents').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(useDialogStore().current!.message).toMatch(/3 documents.*refused/)
    useDialogStore().settle(true)
    await flushPromises()
    const puts = () => calls.filter((c) => c.method === 'PUT')
    expect(puts()[0]!.body).toMatchObject({
      validator: { $jsonSchema: { required: ['n', 'name'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    })
    button('Restore the previous rules').click()
    await flushPromises()
    expect(puts()[1]!.body).toMatchObject({
      validator: rules,
      validationLevel: 'moderate',
      validationAction: 'warn',
    })
  })

  it('saves no rules at all from an empty editor', async () => {
    const { calls } = await mountView({
      [`PUT ${BASE}/validation`]: (body) => [200, savedAnswer(body)],
    })
    await typeInto(editor(), '')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ validator: null })
  })

  it('blocks Test and Save while the rules do not parse', async () => {
    await mountView({})
    await typeInto(editor(), '{ $jsonSchema: ')
    expect(button('Test against existing documents').disabled).toBe(true)
    expect(button('Save').disabled).toBe(true)
    // UI redesign R2: the syntax error is the editor's own, tied to it, not a separate alert.
    expect(editor().getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(editor().getAttribute('aria-describedby')!)!.textContent).toMatch(/line 1/)
  })

  it('is read-only without the right to change the collection', async () => {
    await mountView({}, false)
    expect(() => button('Save')).toThrow()
    expect(select('Level').disabled).toBe(true)
    expect(button('Test against existing documents').disabled).toBe(false)
  })
})

describe('restoring the previous rules (phase 2b, found by e2e)', () => {
  it('stays possible after leaving the section and coming back', async () => {
    const { calls } = mockApi({
      [`GET ${BASE}/validation`]: () => [200, state()],
      [`PUT ${BASE}/validation`]: (body) => [200, savedAnswer(body)],
    })
    const first = mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-v' } })
    await flushPromises()
    await typeInto(editor(), '{ a: 1 }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    first.wrapper.unmount()
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-v' } })
    await flushPromises()
    button('Restore the previous rules').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT').at(-1)!.body).toMatchObject({
      validator: rules,
      validationLevel: 'moderate',
      validationAction: 'warn',
    })
  })
})

describe('validation editor fixes (final review 2b)', () => {
  const VERSION = 'a'.repeat(64)
  const withVersion = (over: Partial<ValidationState> = {}) => ({ ...state(over), version: VERSION })

  it('keeps the rules being typed when the section is left and opened again (I3)', async () => {
    mockApi({ [`GET ${BASE}/validation`]: () => [200, withVersion()] })
    const first = mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-d' } })
    await flushPromises()
    await typeInto(editor(), '{ typed: 1 }')
    first.wrapper.unmount()
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-d' } })
    await flushPromises()
    expect(editor().value).toBe('{ typed: 1 }')
  })

  it('saves against the version it read, restores what the first save replaced, and stops on a conflict (I3)', async () => {
    let conflict = false
    const { calls } = mockApi({
      [`GET ${BASE}/validation`]: () => [200, withVersion()],
      [`PUT ${BASE}/validation`]: (body) =>
        conflict
          ? [409, { code: 'CONFLICT', message: 'changed', details: { reason: 'rules_changed' } }]
          : [
              200,
              {
                ...withVersion(),
                ...(body as object),
                version: 'b'.repeat(64),
                previous: {
                  validator: { server: 'side' },
                  validationLevel: 'strict',
                  validationAction: 'error',
                },
              },
            ],
    })
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-c' } })
    await flushPromises()
    await typeInto(editor(), '{ a: 1 }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    const puts = () => calls.filter((c) => c.method === 'PUT')
    expect(puts()[0]!.body).toMatchObject({ expected: VERSION })
    await typeInto(editor(), '{ a: 2 }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(puts()[1]!.body).toMatchObject({ expected: 'b'.repeat(64) })
    // Restore brings back the rules from before the first save of the session, as the server read them.
    button('Restore the previous rules').click()
    await flushPromises()
    expect(puts()[2]!.body).toMatchObject({ validator: { server: 'side' }, validationLevel: 'strict' })
    conflict = true
    await typeInto(editor(), '{ a: 3 }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(document.querySelector('[data-conflict]')!.textContent).toContain('changed since you opened them')
    button('Load the current rules').click()
    await flushPromises()
    expect(editor().value).toContain('$jsonSchema')
  })

  it('drops a test result that came back for rules edited since (I4)', async () => {
    let release!: () => void
    const { fetchMock } = mockApi({
      [`GET ${BASE}/validation`]: () => [200, withVersion()],
      [`POST ${BASE}/validation/test`]: async () => {
        await new Promise<void>((r) => (release = r))
        return [200, { total: 10, failing: 0, sample: [] }]
      },
    })
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-t' } })
    await flushPromises()
    button('Test against existing documents').click()
    await flushPromises()
    await typeInto(editor(), '{ changed: 1 }')
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/validation/test'))!
    expect((call[1] as RequestInit).signal!.aborted).toBe(true)
    release()
    await flushPromises()
    expect(document.querySelector('[data-validation-test]')).toBeNull()
  })

  it('says when failing documents could not be counted, and warns on save anyway (I1)', async () => {
    mockApi({
      [`GET ${BASE}/validation`]: () => [
        200,
        withVersion({ validationLevel: 'strict', validationAction: 'error' }),
      ],
      [`POST ${BASE}/validation/test`]: () => [200, { total: 10, failing: null, sample: [] }],
    })
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-u' } })
    await flushPromises()
    button('Test against existing documents').click()
    await flushPromises()
    expect(document.querySelector('[data-validation-test]')!.textContent).toContain(
      'could not be counted in time',
    )
    button('Save').click()
    await flushPromises()
    expect(useDialogStore().current).toMatchObject({ danger: true })
    expect(useDialogStore().current!.message).toContain('could not be counted')
  })

  it('says a time-series collection cannot have rules (M10)', async () => {
    mockApi({ [`GET ${BASE}/validation`]: () => [200, withVersion({ kind: 'timeseries' })] })
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-ts' } })
    await flushPromises()
    expect(document.body.textContent).toContain('Time-series collections cannot have validation rules.')
  })
})

describe('rules survive the editor unchanged (final review 2b, declined item)', () => {
  it('saves exactly the rules it loaded when nothing was edited: Int64, Decimal128 and regex options kept', async () => {
    const typed = {
      $jsonSchema: {
        properties: {
          n: { bsonType: 'long', minimum: { $numberLong: '9007199254740993' } },
          price: { bsonType: 'decimal', maximum: { $numberDecimal: '12.50' } },
          ratio: { bsonType: 'double', minimum: { $numberDouble: '1.0' } },
          code: { bsonType: 'string', pattern: '^A' },
        },
      },
      name: { $regularExpression: { pattern: '^jo', options: 'i' } },
    }
    const { calls } = mockApi({
      [`GET ${BASE}/validation`]: () => [200, state({ validator: typed })],
      [`PUT ${BASE}/validation`]: (body) => [200, savedAnswer(body)],
    })
    mountApp(ValidationView, { props: { target, canWrite: true, tabId: 'tab-rt' } })
    await flushPromises()
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ validator: typed })
  })
})

// Review of K+R2 (minor): the rules load with a placeholder, and a failure to load offers a retry.
describe('the Validation section loading', () => {
  it('retries a failed load', async () => {
    let fail = true
    await mountView({
      [`GET ${BASE}/validation`]: () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, state()],
    })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    fail = false
    button('Retry').click()
    await vi.waitFor(() => expect(editor()).not.toBeUndefined())
  })
})

describe('a save answered after the personal data rules changed (2026-10-26)', () => {
  it('keeps neither the rules it answers nor those it replaced: they are read again as now shown', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    const secret = { $jsonSchema: { properties: { email: { enum: ['ada@example.com'] } } } }
    let reads = 0
    const { calls } = mockApi({
      [`GET ${BASE}/validation`]: () => {
        reads++
        // Read after the rules: the value hidden.
        return [200, state(reads > 1 ? { validator: { $jsonSchema: { properties: { email: {} } } } } : {})]
      },
      [`PUT ${BASE}/validation`]: () => new Promise((resolve) => (answer = resolve)),
    })
    mountApp(ValidationView, { props: { target, canWrite: true } })
    await flushPromises()
    await typeInto(editor(), '{ $jsonSchema: { required: ["n", "name"] } }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
    // The rules change while the save is on its way (the card's refresh says so).
    rulesChanged()
    // The server answered from before the rules: the value in clear, in what it replaced too.
    answer([
      200,
      {
        ...state({ validator: secret }),
        previous: { validator: secret, validationLevel: 'moderate', validationAction: 'warn' },
      },
    ])
    await flushPromises()
    await flushPromises()
    expect(reads).toBe(2)
    expect(document.body.textContent).not.toContain('ada@example.com')
    expect(editor().value).not.toContain('ada@example.com')
    // Nothing to put back that would quote it.
    expect(document.body.textContent).not.toContain('Restore the previous rules')
  })
})

describe('what a test or a save keeps, once the personal data rules changed (review 2026-10-26, I1)', () => {
  const sample = {
    total: 2,
    failing: 1,
    sample: [{ document: { email: 'ada@example.com' }, hash: 'h'.repeat(64) }],
  }

  it('drops a test that answered after the rules changed', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    await mountView({ [`POST ${BASE}/validation/test`]: () => new Promise((resolve) => (answer = resolve)) })
    button('Test against existing documents').click()
    await flushPromises()
    rulesChanged()
    answer([200, sample])
    // The answer is read in a few turns: waited for in full.
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    expect(document.querySelector('[data-validation-test]')).toBeNull()
    // Not kept with the tab either, to be shown later.
    expect(useCollectionViewsStore().stateFor('c1/shop/orders').validationDraft!.tested).toBeNull()
  })

  it('stops showing a test result from before the rules changed', async () => {
    await mountView({ [`POST ${BASE}/validation/test`]: () => [200, sample] })
    button('Test against existing documents').click()
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    // Its sample (documents) is in the result's card.
    expect(document.querySelector('[data-validation-test]')).not.toBeNull()
    rulesChanged()
    await flushPromises()
    expect(document.querySelector('[data-validation-test]')).toBeNull()
  })

  it('offers no rules to put back that were kept from before the rules changed', async () => {
    await mountView({ [`PUT ${BASE}/validation`]: (body) => [200, savedAnswer(body)] })
    await typeInto(editor(), '{ $jsonSchema: { required: ["n", "name"] } }')
    button('Save').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(document.body.textContent).toContain('Restore the previous rules')
    rulesChanged()
    await flushPromises()
    expect(document.body.textContent).not.toContain('Restore the previous rules')
  })
})
