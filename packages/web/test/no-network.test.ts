import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

let server: Server | null = null
afterEach(async () => {
  await new Promise((r) => server?.close(r) ?? r(undefined))
  server = null
})

/** What test/support/setup.ts answered in this process instead of the network. */
const intercepted = () => (globalThis as { __mmIntercepted?: string[] }).__mmIntercepted!

/** A local server counting what reaches it: none of it should. */
async function listening(): Promise<{ origin: string; seen: string[] }> {
  const seen: string[] = []
  server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.end('')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

/** Until happy-dom has nothing left loading (review 2026-10-17, minor 4: no fixed wait). */
const settled = () =>
  (window as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM.waitUntilComplete()

/**
 * CI: a plugin's frame made happy-dom load its page from the test origin (localhost:4321, where a
 * developer's own server answers), so a test reached a real server, and failed noisily where none
 * runs. A test never loads anything from the network.
 */
describe('the test document', () => {
  it('loads no frame’s page from the network', async () => {
    const { origin, seen } = await listening()
    const frame = document.createElement('iframe')
    frame.src = `${origin}/plugin-frame/x/index.html`
    document.body.append(frame)
    await settled()
    frame.remove()
    expect(seen).toEqual([])
    expect(intercepted()).toContain(`${origin}/plugin-frame/x/index.html`)
  })

  // A script is never loaded at all (happy-dom's default): a style sheet was.
  it('loads no style sheet from the network', async () => {
    const { origin, seen } = await listening()
    const sheet = document.createElement('link')
    sheet.rel = 'stylesheet'
    sheet.href = `${origin}/a.css`
    document.head.append(sheet)
    await settled()
    sheet.remove()
    expect(seen).toEqual([])
    expect(intercepted()).toContain(`${origin}/a.css`)
  })

  // Review 2026-10-17 (minor 3): a call no test stubbed is answered as mockApi answers one.
  it('answers an API call no test stubbed as mockApi does, from the process', async () => {
    const { origin, seen } = await listening()
    const answer = await window.fetch(`${origin}/api/forgotten`, { method: 'POST' })
    expect(answer.status).toBe(404)
    expect(await answer.json()).toEqual({ code: 'NOT_FOUND', message: 'no mock for POST forgotten' })
    expect(seen).toEqual([])
    expect(intercepted()).toEqual([`${origin}/api/forgotten`])
  })

  // Second review 2026-10-17 (minor 2): a path that does not decode threw inside happy-dom's task,
  // which was then never closed, and the next wait for happy-dom never ended.
  it('answers a path that does not decode, and happy-dom settles after it', async () => {
    const { origin } = await listening()
    expect((await window.fetch(`${origin}/api/a%zz`)).status).toBe(404)
    await settled()
    expect(intercepted()).toEqual([`${origin}/api/a%zz`])
  }, 5_000)

  it('leaves a data: URL and an aborted request to happy-dom', async () => {
    expect(await (await window.fetch('data:text/plain,hello')).text()).toBe('hello')
    const abort = new AbortController()
    abort.abort()
    await expect(window.fetch('http://127.0.0.1:1/never', { signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(intercepted()).toEqual([])
  })
})
