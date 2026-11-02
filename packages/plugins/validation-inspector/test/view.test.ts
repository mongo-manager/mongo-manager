// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const int = (n: number) => ({ $numberInt: String(n) })

type Params = { pipeline?: Array<Record<string, unknown>>; filter?: unknown; limit?: number }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'check' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'validation-inspector', version: '1' },
          contribution: { kind: 'collectionTab', id: 'check' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'customers', documentId: null }
const VALIDATOR = {
  $jsonSchema: {
    required: ['name', 'email'],
    properties: { age: { bsonType: 'int', minimum: int(0) } },
  },
}
const RULES = { validator: VALIDATOR, validationLevel: 'strict', validationAction: 'error' }
/** Answers the check: 1,000 read, 15 broken; name 0, email 12, age 3. */
const ANSWER = {
  documents: [
    { read: [{ n: int(1000) }], broken: [{ n: int(15) }], r0: [], r1: [{ n: int(12) }], r2: [{ n: int(3) }] },
  ],
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-rule]')]
const app = () => document.getElementById('app')!

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('validation check', () => {
  it('checks 1,000 random documents on opening, in one read, the rules most broken first', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => ANSWER,
    })
    mount(app(), client)
    greet()
    await flush()
    const asked = calls.filter((c) => c.method === 'documents.aggregate')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.params.pipeline![0]).toEqual({ $sample: { size: int(1000) } })
    expect(asked[0]!.params.limit).toBe(1)
    expect(cards().map((c) => [c.querySelector('h3')!.textContent, c.dataset.broken])).toEqual([
      ['email is required', '12'],
      ['age', '3'],
      ['name is required', '0'],
    ])
    expect(cards()[0]!.textContent).toContain('12 documents (1.2%)')
    expect(cards()[1]!.querySelector('code')!.textContent).toBe("bsonType: 'int', minimum: 0")
    expect(cards()[2]!.textContent).toContain('No document breaks it')
    expect(document.getElementById('status')!.textContent).toBe(
      '1,000 documents checked · 15 break the rules (1.5%)',
    )
    expect(app().textContent).toContain('A random sample')
  })

  it('shows a rule’s documents, and all that break the rules, in Documents', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => ANSWER,
      'ui.useQuery': () => true,
    })
    mount(app(), client)
    greet()
    await flush()
    cards()[0]!.querySelector<HTMLButtonElement>('[data-show]')!.click()
    document.getElementById('show-all')!.click()
    await flush()
    expect(calls.filter((c) => c.method === 'ui.useQuery').map((c) => c.params.filter)).toEqual([
      { $nor: [{ $jsonSchema: { required: ['email'] } }] },
      { $nor: [VALIDATOR] },
    ])
    // A rule no document breaks has nothing to show.
    expect(cards()[2]!.querySelector('[data-show]')).toBeNull()
  })

  it('checks the whole collection when All is chosen', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => ANSWER,
    })
    mount(app(), client)
    greet()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#size button')]
      .find((b) => b.textContent === 'All')!
      .click()
    await flush()
    const last = calls.filter((c) => c.method === 'documents.aggregate').at(-1)!
    expect(Object.keys(last.params.pipeline![0]!)).toEqual(['$facet'])
    expect(app().textContent).not.toContain('A random sample')
  })

  // Review I1: the app runs one pipeline of a frame at a time and refuses the next.
  it('waits for a check running before the one asked for, and shows the one asked for', async () => {
    const answers: Array<(v: unknown) => void> = []
    let running = false
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => {
        if (running) throw new AskError('busy', 'Its last pipeline is still running')
        running = true
        return new Promise((r) =>
          answers.push((v) => {
            running = false
            r(v)
          }),
        )
      },
    })
    mount(app(), client)
    greet()
    await flush()
    ;[...document.querySelectorAll<HTMLButtonElement>('#size button')]
      .find((b) => b.textContent === 'All')!
      .click()
    await flush()
    expect(answers).toHaveLength(1)
    answers[0]!(ANSWER)
    await flush()
    expect(answers).toHaveLength(2)
    answers[1]!({ documents: [{ read: [{ n: int(7) }], broken: [], r0: [], r1: [], r2: [] }] })
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      '7 documents checked · 0 break the rules (0%)',
    )
    expect(app().textContent).not.toContain('could not run')
  })

  it('names a level or an action that lets broken rules through', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => ({ ...RULES, validationLevel: 'moderate', validationAction: 'warn' }),
      'documents.aggregate': () => ANSWER,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('summary')!.textContent).toBe('Level: moderate · Action: warn')
    expect(document.getElementById('notes')!.textContent).toContain(
      'Writes that break the rules may still be made',
    )
    // Said once: the note does not name them again.
    expect(document.getElementById('notes')!.textContent).not.toContain('Level: moderate')
  })

  it('says when every document follows the rules, when there are none, and when the collection is empty', async () => {
    const clean = { documents: [{ read: [{ n: int(40) }], broken: [], r0: [], r1: [], r2: [] }] }
    let answer: unknown = clean
    let rules: unknown = RULES
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => rules,
      'documents.aggregate': () => answer,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Every document checked follows the rules')
    answer = { documents: [{ read: [], broken: [] }] }
    document.getElementById('check')!.click()
    await flush()
    expect(app().textContent).toContain('No documents to check')
    rules = { validator: {}, validationLevel: 'strict', validationAction: 'error' }
    document.getElementById('check')!.click()
    await flush()
    expect(app().textContent).toContain('This collection has no validation rules')
  })

  it('says a view has no rules of its own', async () => {
    const { client, greet, calls } = fakeClient({ ...PLACE, view: true } as PluginContext['place'], {
      'validation.get': () => null,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('A view has no validation rules of its own')
    expect(calls.some((c) => c.method === 'documents.aggregate')).toBe(false)
  })

  it('says why a check failed, and tries again', async () => {
    let fail = true
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => {
        if (fail) throw new AskError('failed', 'The operation exceeded its time limit')
        return ANSWER
      },
    })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('The check could not run')
    expect(app().textContent).toContain('The operation exceeded its time limit')
    fail = false
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Try again')!
      .click()
    await flush()
    expect(cards()).toHaveLength(3)
  })

  it('says it in Turkish', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => ANSWER,
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(cards()[0]!.querySelector('h3')!.textContent).toBe('email zorunlu')
    // Compared with Intl called the same way, not with a hand-typed ICU string.
    const percent = (f: number) =>
      new Intl.NumberFormat('tr', { style: 'percent', maximumFractionDigits: 1 }).format(f)
    const thousand = new Intl.NumberFormat('tr', { maximumFractionDigits: 2 }).format(1000)
    expect(cards()[0]!.textContent).toContain(`12 belge (${percent(0.012)})`)
    expect(percent(0.012).startsWith('%')).toBe(true)
    expect(document.getElementById('status')!.textContent).toBe(
      `${thousand} belge denetlendi · 15 belge kurallara uymuyor (${percent(0.015)})`,
    )
  })

  it('needs a collection', async () => {
    const { client, greet } = fakeClient(null, {})
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to check it.')
    expect((document.getElementById('check') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('validation check, review fixes', () => {
  it('says one document in the singular, and a share under 0.1% as such', async () => {
    const one = {
      documents: [
        { read: [{ n: int(10_000) }], broken: [{ n: int(1) }], r0: [], r1: [{ n: int(1) }], r2: [] },
      ],
    }
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => one,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      '10,000 documents checked · 1 breaks the rules (<0.1%)',
    )
    expect(cards()[0]!.textContent).toContain('1 document (<0.1%)')
    // One document checked, too.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const single = { documents: [{ read: [{ n: int(1) }], broken: [], r0: [], r1: [], r2: [] }] }
    const second = fakeClient(PLACE, { 'validation.get': () => RULES, 'documents.aggregate': () => single })
    mount(app(), second.client)
    second.greet()
    await flush()
    expect(document.getElementById('status')!.textContent).toBe('1 document checked · 0 break the rules (0%)')
  })

  it('says rules about hidden fields are not checked, when some are hidden or it cannot be told', async () => {
    for (const hidden of [[['email']], null]) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
      const { client, greet } = fakeClient({ ...PLACE, hidden } as PluginContext['place'], {
        'validation.get': () => RULES,
        'documents.aggregate': () => ANSWER,
      })
      mount(app(), client)
      greet()
      await flush()
      expect(document.getElementById('notes')!.textContent).toContain(
        'Rules about fields hidden from you are not checked',
      )
    }
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const { client, greet } = fakeClient({ ...PLACE, hidden: [] } as PluginContext['place'], {
      'validation.get': () => RULES,
      'documents.aggregate': () => ANSWER,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('notes')!.textContent).not.toContain('hidden from you')
  })

  it('suggests a sample when the whole collection could not be checked', async () => {
    let fail = false
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => {
        if (fail) throw new AskError('failed', 'The operation exceeded its time limit')
        return ANSWER
      },
    })
    mount(app(), client)
    greet()
    await flush()
    fail = true
    ;[...document.querySelectorAll<HTMLButtonElement>('#size button')]
      .find((b) => b.textContent === 'All')!
      .click()
    await flush()
    expect(app().textContent).toContain('choose a random sample')
  })

  it('says a validator nested too deep for a plugin cannot be checked here', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => RULES,
      'documents.aggregate': () => {
        throw new AskError('bad_params', 'Too deeply nested')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('nested deeper than a plugin’s pipeline may be')
  })

  it('names the patterns allowed beside the fields', async () => {
    const rules = {
      validator: {
        $jsonSchema: { properties: { a: {} }, patternProperties: { '^x_': {} }, additionalProperties: false },
      },
    }
    const answer = { documents: [{ read: [{ n: int(5) }], broken: [{ n: int(1) }], r0: [{ n: int(1) }] }] }
    const { client, greet } = fakeClient(PLACE, {
      'validation.get': () => rules,
      'documents.aggregate': () => answer,
    })
    mount(app(), client)
    greet()
    await flush()
    expect(cards()[0]!.querySelector('code')!.textContent).toBe('Allowed: a and fields matching ^x_')
  })
})
