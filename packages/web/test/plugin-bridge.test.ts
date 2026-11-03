import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { MAX_MESSAGE_BYTES, MAX_OUTSTANDING, createBridge, type BridgeHandlers } from '../src/plugins/bridge'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** A plugin frame, and what the host sends to it. */
function frame() {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const win = iframe.contentWindow!
  const sent: unknown[] = []
  vi.spyOn(win, 'postMessage').mockImplementation((data: unknown) => void sent.push(data))
  return { win, sent }
}
/** The token the host gave its frame's page (in every message of that page's). */
let token = ''
const send = (data: unknown, source: unknown, origin = 'null') => {
  const own = data && typeof data === 'object' && !Array.isArray(data) && (data as { mm?: unknown }).mm === 1
  const message = own && !('token' in data) ? { ...data, token } : data
  window.dispatchEvent(new MessageEvent('message', { data: message, origin, source: source as Window }))
}
/** The host greets the page once it loaded: the token goes to it then. */
function greet(bridge: ReturnType<typeof createBridge>, sent: unknown[]) {
  bridge.hello()
  const hello = sent.shift() as { mm: number; type: string; token: string }
  expect(hello).toMatchObject({ mm: 1, type: 'hello' })
  token = hello.token
}

function setup(handlers: BridgeHandlers = {}, permissions: ('documents:read' | 'documents:write')[] = []) {
  const f = frame()
  const bridge = createBridge({ frame: () => f.win, permissions: () => permissions, handlers })
  greet(bridge, f.sent)
  return { ...f, bridge }
}

describe('plugin bridge (phase 4b §3)', () => {
  it('answers a request from its own frame, by id', async () => {
    const { win, sent, bridge } = setup({ 'context.get': () => ({ locale: 'en' }) })
    send({ mm: 1, id: 7, method: 'context.get' }, win)
    await flushPromises()
    expect(sent).toEqual([{ mm: 1, id: 7, result: { locale: 'en' } }])
    bridge.dispose()
    send({ mm: 1, id: 8, method: 'context.get' }, win)
    await flushPromises()
    expect(sent).toHaveLength(1)
  })

  it('answers only the page it greeted: no token, or another, is no request', async () => {
    const handler = vi.fn(() => 'x')
    const f = frame()
    const bridge = createBridge({
      frame: () => f.win,
      permissions: () => [],
      handlers: { 'context.get': handler },
    })
    // Before the greeting: nothing is answered.
    send({ mm: 1, id: 1, method: 'context.get', token: undefined }, f.win)
    greet(bridge, f.sent)
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    send({ mm: 1, id: 2, method: 'context.get', token: 'guessed' }, f.win)
    send({ mm: 1, id: 3, method: 'context.get', token: undefined }, f.win)
    await flushPromises()
    expect(handler).not.toHaveBeenCalled()
    expect(f.sent).toEqual([])
    send({ mm: 1, id: 4, method: 'context.get' }, f.win)
    await flushPromises()
    expect(f.sent).toEqual([{ mm: 1, id: 4, result: 'x' }])
  })

  it('ignores messages from any other window or origin', async () => {
    const handler = vi.fn(() => 'x')
    const { win, sent } = setup({ 'context.get': handler })
    const other = frame()
    send({ mm: 1, id: 1, method: 'context.get' }, other.win)
    send({ mm: 1, id: 2, method: 'context.get' }, window)
    send({ mm: 1, id: 3, method: 'context.get' }, null)
    // Its own frame, but no longer sandboxed (a same-origin page): ignored.
    send({ mm: 1, id: 4, method: 'context.get' }, win, window.location.origin)
    send({ mm: 1, id: 5, method: 'context.get' }, win, 'https://evil.example')
    await flushPromises()
    expect(handler).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(other.sent).toEqual([])
  })

  it('refuses a method beyond the approved permissions, or one it does not know', async () => {
    const find = vi.fn(() => [])
    const update = vi.fn(() => ({}))
    const { win, sent } = setup({ 'documents.find': find, 'documents.update': update }, ['documents:read'])
    send({ mm: 1, id: 1, method: 'documents.update', params: {} }, win)
    send({ mm: 1, id: 2, method: 'server.shutdown' }, win)
    send({ mm: 1, id: 3, method: '__proto__' }, win)
    send({ mm: 1, id: 4, method: 'documents.find', params: {} }, win)
    await flushPromises()
    expect(update).not.toHaveBeenCalled()
    expect(find).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      { mm: 1, id: 1, error: expect.objectContaining({ code: 'not_permitted' }) },
      { mm: 1, id: 2, error: expect.objectContaining({ code: 'unknown_method' }) },
      { mm: 1, id: 3, error: expect.objectContaining({ code: 'unknown_method' }) },
      { mm: 1, id: 4, result: [] },
    ])
  })

  // Security audit 2026-10-16 (M3): the permissions were read once, when the frame opened — an
  // administrator's change reached a page already open only when it was loaded again.
  it('reads the approved permissions as they are at each request', async () => {
    const write = vi.fn(() => ({}))
    const f = frame()
    let approved: Array<'documents:read' | 'documents:write'> = ['documents:write']
    const bridge = createBridge({
      frame: () => f.win,
      permissions: () => approved,
      handlers: { 'documents.update': write },
    })
    greet(bridge, f.sent)
    send({ mm: 1, id: 1, method: 'documents.update', params: {} }, f.win)
    await flushPromises()
    approved = []
    send({ mm: 1, id: 2, method: 'documents.update', params: {} }, f.win)
    await flushPromises()
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.sent).toEqual([
      { mm: 1, id: 1, result: {} },
      { mm: 1, id: 2, error: expect.objectContaining({ code: 'not_permitted' }) },
    ])
  })

  it('refuses an oversized message, and too many at once', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { win, sent } = setup({ 'context.get': () => held.then(() => 'ok') })
    send({ mm: 1, id: 'big', method: 'context.get', params: 'x'.repeat(MAX_MESSAGE_BYTES) }, win)
    for (let i = 0; i < MAX_OUTSTANDING + 2; i++) send({ mm: 1, id: i, method: 'context.get' }, win)
    await flushPromises()
    expect(sent).toEqual([
      { mm: 1, id: 'big', error: expect.objectContaining({ code: 'too_large' }) },
      { mm: 1, id: MAX_OUTSTANDING, error: expect.objectContaining({ code: 'too_many' }) },
      { mm: 1, id: MAX_OUTSTANDING + 1, error: expect.objectContaining({ code: 'too_many' }) },
    ])
    release()
    await flushPromises()
    expect(sent).toHaveLength(3 + MAX_OUTSTANDING)
  })

  it('ignores malformed messages and never answers with an error it did not make', async () => {
    const { win, sent } = setup({
      'context.get': () => {
        throw new Error('secret internal detail')
      },
    })
    for (const data of [
      null,
      'text',
      42,
      [],
      { id: 1, method: 'context.get' },
      { mm: 1, method: 'context.get' },
      { mm: 1, id: {}, method: 'context.get' },
    ])
      send(data, win)
    send({ mm: 1, id: 9, method: 'context.get' }, win)
    await flushPromises()
    expect(sent).toEqual([{ mm: 1, id: 9, error: { code: 'failed', message: 'The request failed' } }])
  })

  it('sends plain JSON only: an answer holding the app’s reactive state still crosses', async () => {
    const f = frame()
    // As a browser does: the message is copied, and a proxy cannot be.
    vi.spyOn(f.win, 'postMessage').mockImplementation(
      (data: unknown) => void f.sent.push(structuredClone(data)),
    )
    greet(
      createBridge({
        frame: () => f.win,
        permissions: () => [],
        handlers: { 'context.get': () => reactive({ settings: { a: 1 } }) },
      }),
      f.sent,
    )
    send({ mm: 1, id: 1, method: 'context.get' }, f.win)
    await flushPromises()
    expect(f.sent).toEqual([{ mm: 1, id: 1, result: { settings: { a: 1 } } }])
  })

  it('refuses an answer too large to send back', async () => {
    const { win, sent } = setup({ 'context.get': () => 'y'.repeat(MAX_MESSAGE_BYTES + 1) })
    send({ mm: 1, id: 1, method: 'context.get' }, win)
    await flushPromises()
    expect(sent).toEqual([{ mm: 1, id: 1, error: expect.objectContaining({ code: 'too_large' }) }])
  })

  it('asks its frame and takes only the answer to what it asked', async () => {
    const { win, sent, bridge } = setup()
    const answer = bridge.ask('render', { values: [1] }, 1000)
    const asked = sent[0] as { id: string }
    expect(asked).toMatchObject({ mm: 1, method: 'render', params: { values: [1] } })
    send({ mm: 1, id: 'h999', result: 'not asked' }, win)
    send({ mm: 1, id: asked.id, result: [{ text: 'x' }] }, frame().win)
    send({ mm: 1, id: asked.id, result: [{ text: '1, 2' }] }, win)
    await expect(answer).resolves.toEqual([{ text: '1, 2' }])
    vi.useFakeTimers()
    const late = bridge.ask('render', {}, 50)
    vi.advanceTimersByTime(60)
    await expect(late).rejects.toThrow(/time/i)
    vi.useRealTimers()
  })
})
