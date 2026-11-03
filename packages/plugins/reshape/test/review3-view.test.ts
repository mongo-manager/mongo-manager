// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { PREVIEW_DELAY, mount } from '../src/view'

/** Wave 3 third review (2026-10-26): the reshape tab's Important 2 and Minor 15. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [] as string[][] | null,
}
const PEOPLE = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, fullName: 'Ada', status: 'active', contact: { ssn: '***' } },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, fullName: 'Grace', status: 'left', contact: { ssn: '***' } },
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
const offered = () =>
  [...app().querySelectorAll<HTMLOptionElement>('#steps select option')].map((o) => o.value)

describe('a common rule through * (third review 2)', () => {
  it('leaves the top-level values to reshape, and holds back only the object holding the field', async () => {
    const fake = fakeClient(
      { place: { ...PLACE, hidden: [['*', 'ssn']] } },
      {
        'documents.find': () => ({ documents: PEOPLE }),
        'documents.aggregate': () => ({ documents: PEOPLE }),
      },
    )
    mount(app(), fake.client)
    fake.greet()
    await flush()
    await addStep('remove')
    expect(offered()).toEqual(expect.arrayContaining(['fullName', 'status']))
    expect(offered()).not.toContain('contact')
    expect(offered()).not.toContain('contact.ssn')
  })
})

describe('Try again (third review 15)', () => {
  it('keeps the focus near, and shows a fresh preview with what is now known', async () => {
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
    await settle()
    // Each preview made marks its box busy, then not.
    let previews = 0
    new MutationObserver((records) => {
      previews += records.filter((r) => (r.target as Element).getAttribute('aria-busy') === 'true').length
    }).observe(app(), { attributes: true, attributeFilter: ['aria-busy'], subtree: true })
    // Still unknown: the focus returns to Try again.
    const retry = app().querySelector<HTMLButtonElement>('#hidden-retry')!
    retry.focus()
    retry.click()
    await flush()
    expect(document.activeElement?.id).toBe('hidden-retry')
    // Known now: the callout goes, the focus goes to the step kind, and a preview runs again.
    place.hidden = []
    app().querySelector<HTMLButtonElement>('#hidden-retry')!.focus()
    app().querySelector<HTMLButtonElement>('#hidden-retry')!.click()
    await flush()
    await settle()
    expect(app().querySelector('[data-hidden-unknown]')).toBeNull()
    expect(document.activeElement?.id).toBe('kind')
    expect(previews).toBeGreaterThan(0)
  })
})
