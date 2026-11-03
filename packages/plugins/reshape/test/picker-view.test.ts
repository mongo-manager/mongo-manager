// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount } from '../src/view'

/**
 * 2026-10-26 (user report): a nest step's Fields were a select of several squeezed into the kit's
 * one-line select box, its names drawn over each other. They are a list of checkboxes now.
 */
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
const addStep = async (kind: string) => {
  app().querySelector<HTMLSelectElement>('#kind')!.value = kind
  app().querySelector<HTMLButtonElement>('#add-step')!.click()
  await flush()
}
const nest = () => app().querySelector<HTMLElement>('[data-step="nest"]')!
const box = (name: string) =>
  [...nest().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((b) => b.value === name)!
const tick = async (name: string) => {
  const el = box(name)
  el.focus()
  el.checked = !el.checked
  el.dispatchEvent(new Event('change'))
  await flush()
}

async function opened(place: Partial<typeof PLACE> = {}, locale = 'en') {
  const fake = fakeClient(
    { place: { ...PLACE, ...place }, locale },
    {
      'documents.find': () => ({ documents: PEOPLE }),
      'documents.aggregate': () => ({ documents: PEOPLE }),
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('a nest step’s fields', () => {
  it('are checkboxes in a group named Fields, never a select of several', async () => {
    await opened()
    await addStep('nest')
    expect(nest().querySelector('select[multiple]')).toBeNull()
    expect(nest().querySelector('fieldset > legend')!.textContent).toBe('Fields')
    const names = [...nest().querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')].map(
      (b) => b.value,
    )
    expect(names).toEqual(expect.arrayContaining(['fullName', 'country']))
    // Each box is named by its field, the name clicked as well as the box.
    expect(box('country').closest('label')!.textContent).toBe('country')
  })

  it('nests the fields ticked, in the order they are offered', async () => {
    await opened()
    await addStep('nest')
    await tick('country')
    await tick('fullName')
    const into = nest().querySelector<HTMLInputElement>('input[type="text"]')!
    into.value = 'who'
    into.dispatchEvent(new Event('change'))
    await flush()
    expect(app().querySelector('#incomplete')).toBeNull()
    const stages = app().querySelector('#stages')!.textContent!
    expect(stages).toContain('who')
    expect(stages.indexOf('$fullName')).toBeGreaterThan(-1)
    expect(stages.indexOf('$fullName')).toBeLessThan(stages.indexOf('$country'))
  })

  it('leaves out a field ticked off again, and keeps the focus on its box', async () => {
    await opened()
    await addStep('nest')
    await tick('fullName')
    await tick('country')
    await tick('fullName')
    expect(box('fullName').checked).toBe(false)
    expect(box('country').checked).toBe(true)
    expect(document.activeElement).toBe(box('fullName'))
  })

  it('keeps its ticks when the steps are drawn again', async () => {
    await opened()
    await addStep('nest')
    await tick('country')
    await addStep('remove')
    expect(box('country').checked).toBe(true)
    expect(box('fullName').checked).toBe(false)
  })

  it('counts what is ticked', async () => {
    await opened()
    await addStep('nest')
    const offered = nest().querySelectorAll('fieldset input[type="checkbox"]').length
    expect(nest().querySelector('[data-picked]')!.textContent).toBe(`Chosen: 0 of ${offered}`)
    await tick('country')
    expect(nest().querySelector('[data-picked]')!.textContent).toBe(`Chosen: 1 of ${offered}`)
  })

  it('says so in Turkish', async () => {
    await opened({}, 'tr')
    await addStep('nest')
    expect(nest().querySelector('fieldset > legend')!.textContent).toBe('Alanlar')
    await tick('country')
    const offered = nest().querySelectorAll('fieldset input[type="checkbox"]').length
    expect(nest().querySelector('[data-picked]')!.textContent).toBe(`Seçili: 1 / ${offered}`)
  })

  it('says when there is no field to offer', async () => {
    await opened({ hidden: null })
    await addStep('nest')
    expect(nest().querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(nest().querySelector('[data-no-fields]')!.textContent).toBe('No field to offer.')
  })
})

describe('the step boxes’ styles', () => {
  const reshapeCss = readFileSync(join(__dirname, '..', 'src', 'style.css'), 'utf8')
  const kitCss = readFileSync(join(__dirname, '..', '..', 'kit', 'src', 'ui.css'), 'utf8')

  it('scroll a long list of fields inside its own box', () => {
    expect(reshapeCss).toMatch(/\.rs-pick-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/)
  })

  it('never squeeze a kit select of several into one line', () => {
    expect(kitCss).toMatch(/\.mm-select\[multiple\][^{]*\{[^}]*height:\s*auto[^}]*background-image:\s*none/)
  })
})
