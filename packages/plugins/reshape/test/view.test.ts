// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { PREVIEW_DELAY, mount } from '../src/view'

/** Plugins wave 3 (spec §6): the reshape tab — steps, before and after, handed to Aggregations. */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [['ssn']],
}
const PEOPLE = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    fullName: 'Ada',
    ssn: '***',
    address: { city: 'Izmir', zip: '35000' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a02' },
    fullName: 'Grace',
    ssn: '***',
    address: { city: 'Ankara', zip: '06000' },
  },
]

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
/** The preview runs once the edits stop (review 28). */
const settle = async () => {
  await new Promise((r) => setTimeout(r, PREVIEW_DELAY + 30))
  await flush()
}
const addStep = async (kind: string) => {
  app().querySelector<HTMLSelectElement>('#kind')!.value = kind
  app().querySelector<HTMLButtonElement>('#add-step')!.click()
  await settle()
}

async function opened(handlers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const fake = fakeClient(
    { place: PLACE },
    {
      'documents.find': () => ({ documents: PEOPLE }),
      'documents.aggregate': (p) => {
        const stages = (p.pipeline as Array<Record<string, unknown>>).slice(1)
        // A stand-in for MongoDB: the flatten of address, as it would come back.
        return {
          documents: PEOPLE.map((d) =>
            JSON.stringify(stages).includes('address_city')
              ? {
                  _id: d._id,
                  fullName: d.fullName,
                  ssn: d.ssn,
                  address_city: d.address.city,
                  address_zip: d.address.zip,
                }
              : d,
          ),
        }
      },
      ...handlers,
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the reshape tab', () => {
  it('offers the fields one may reshape — never _id, nor a hidden one', async () => {
    await opened()
    await addStep('remove')
    const options = [...app().querySelectorAll<HTMLOptionElement>('#steps select option')].map((o) => o.value)
    expect(options).toEqual(['fullName', 'address', 'address.city', 'address.zip'])
    expect(app().textContent).toContain(
      'Fields hidden from you as personal data are not offered, nor the objects holding them.',
    )
  })

  it('previews the same documents before and after, from the stages it builds', async () => {
    const { calls } = await opened()
    await addStep('flatten')
    expect(app().querySelector('#stages')!.textContent).toContain('"address_city": "$address.city"')
    const aggregate = calls.find((c) => c.method === 'documents.aggregate')!
    expect((aggregate.params.pipeline as unknown[])[0]).toEqual({
      $match: { _id: { $in: PEOPLE.map((d) => d._id) } },
    })
    expect(app().querySelector('#before')!.textContent).toContain("city: 'Izmir'")
    expect(app().querySelector('#after')!.textContent).toContain("address_city: 'Izmir'")
  })

  it('says what a step may not do, and leaves it out of the stages', async () => {
    await opened()
    await addStep('rename')
    const to = app().querySelector<HTMLInputElement>('#steps input')!
    to.value = '$where'
    to.dispatchEvent(new Event('change'))
    await flush()
    expect(app().querySelector('[data-problem="name"]')).not.toBeNull()
    expect(JSON.parse(app().querySelector('#stages')!.textContent!)).toEqual([])
    expect(app().querySelector<HTMLButtonElement>('#use')!.disabled).toBe(true)
    to.value = 'name'
    to.dispatchEvent(new Event('change'))
    await flush()
    expect(JSON.parse(app().querySelector('#stages')!.textContent!)).toEqual([
      { $set: { name: '$fullName' } },
      { $unset: 'fullName' },
    ])
  })

  it('hands the stages to Aggregations and says how to write them to a new collection', async () => {
    const { calls } = await opened({ 'ui.useAggregation': () => true })
    await addStep('remove')
    app().querySelector<HTMLButtonElement>('#use')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useAggregation')!.params).toEqual({
      stages: [{ $unset: 'fullName' }],
    })
    expect(app().textContent).toContain('add a $out stage naming it')
  })

  it('says when the preview could not be made, or the user kept their pipeline', async () => {
    await opened({
      'documents.aggregate': () => {
        throw new AskError('failed', 'The pipeline failed')
      },
      'ui.useAggregation': () => {
        throw new AskError('declined', 'The user kept the pipeline there')
      },
    })
    await addStep('remove')
    expect(app().textContent).toContain('The preview could not be made: The pipeline failed')
    app().querySelector<HTMLButtonElement>('#use')!.click()
    await flush()
    expect(app().textContent).toContain('Nothing was done: you said no.')
  })
})
