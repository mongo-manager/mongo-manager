import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { EgressError, createEgress, scrubText } from '../src/net/egress'
import { startHttpsServer } from './support/https-server'

type S = Awaited<ReturnType<typeof startHttpsServer>>
let ok: S
let redirect: S
let slow: S
let big: S
let plain: S
beforeAll(async () => {
  ok = await startHttpsServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        auth: req.headers.authorization ?? null,
      }),
    )
  })
  redirect = await startHttpsServer((_req, res) => {
    res.statusCode = 302
    res.setHeader('location', 'http://169.254.169.254/latest/meta-data/')
    res.end()
  })
  slow = await startHttpsServer((_req, res) => {
    res.writeHead(200)
    res.write('a')
  })
  big = await startHttpsServer((_req, res) => res.end(Buffer.alloc(2 * 1024 * 1024, 120)))
  plain = await startHttpsServer((_req, res) => res.end('plain'), { plain: true })
})
afterAll(async () => Promise.all([ok, redirect, slow, big, plain].map((s) => s?.close())))

const loopback = ['127.0.0.1/32']

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'none'
  } catch (e) {
    expect(e).toBeInstanceOf(EgressError)
    return (e as EgressError).reason
  }
}

describe('egress (phase 3d-3b spec §3, D1–D3)', () => {
  it('reaches an allowed network over TLS with its CA, and sends the body', async () => {
    const egress = createEgress({ networks: loopback })
    const r = await egress.buffer({
      method: 'PUT',
      url: `${ok.url}/x`,
      body: Buffer.from('hi'),
      caPem: ok.caPem,
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString())).toMatchObject({ method: 'PUT', body: 'hi' })
    const streamed = await egress.buffer({
      method: 'POST',
      url: `${ok.url}/y`,
      body: Readable.from([Buffer.from('a'), Buffer.from('b')]),
      headers: { 'content-length': '2' },
      caPem: ok.caPem,
    })
    expect(JSON.parse(streamed.body.toString()).body).toBe('ab')
  })

  it('refuses loopback unless listed, by name and as a literal', async () => {
    const egress = createEgress({ networks: [] })
    expect(
      await reason(egress.request({ method: 'GET', url: `https://localhost:${ok.port}/`, caPem: ok.caPem })),
    ).toBe('address_refused')
    expect(
      await reason(egress.request({ method: 'GET', url: `https://127.0.0.1:${ok.port}/`, caPem: ok.caPem })),
    ).toBe('address_refused')
    expect(
      await reason(egress.request({ method: 'GET', url: `https://[::ffff:127.0.0.1]:${ok.port}/` })),
    ).toBe('address_refused')
    // WHATWG URL turns decimal and hex hosts into dotted quads: still loopback.
    expect(await reason(egress.request({ method: 'GET', url: `https://2130706433:${ok.port}/` }))).toBe(
      'address_refused',
    )
    expect(await reason(egress.request({ method: 'GET', url: `https://0x7f.1:${ok.port}/` }))).toBe(
      'address_refused',
    )
  })

  it('checks the address at connect time (DNS rebinding)', async () => {
    let calls = 0
    // Public on the first answer, loopback on the next: the connection's own lookup decides.
    const egress = createEgress({
      networks: [],
      lookup: async () =>
        calls++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    })
    await egress.probe(`https://rebind.example:${ok.port}/`).catch(() => undefined)
    expect(await reason(egress.request({ method: 'GET', url: `https://rebind.example:${ok.port}/` }))).toBe(
      'address_refused',
    )
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('refuses a name when any of its addresses is refused', async () => {
    const egress = createEgress({
      networks: [],
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    })
    const e = (await egress.request({ method: 'GET', url: 'https://mixed.example/' }).then(
      () => null,
      (x: unknown) => x as EgressError,
    )) as EgressError
    expect(e).toBeInstanceOf(EgressError)
    expect(e.reason).toBe('address_never')
    expect(e.message).toMatch(/metadata/)
  })

  it('allows plain http only inside the listed networks', async () => {
    expect(await reason(createEgress({ networks: [] }).request({ method: 'GET', url: plain.url }))).toBe(
      'address_refused',
    )
    const lan = createEgress({ networks: loopback })
    const r = await lan.buffer({ method: 'GET', url: plain.url })
    expect(r.body.toString()).toBe('plain')
    const publicHttp = createEgress({
      networks: [],
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    expect(await reason(publicHttp.request({ method: 'GET', url: 'http://public.example/' }))).toBe(
      'http_refused',
    )
  })

  it('refuses other schemes, credentials in URLs, redirects, oversize bodies and unknown CAs', async () => {
    const egress = createEgress({ networks: loopback })
    expect(await reason(egress.request({ method: 'GET', url: 'ftp://127.0.0.1/' }))).toBe('bad_url')
    expect(await reason(egress.request({ method: 'GET', url: `https://u:p@127.0.0.1:${ok.port}/` }))).toBe(
      'bad_url',
    )
    const e = (await egress.request({ method: 'GET', url: redirect.url, caPem: redirect.caPem }).then(
      () => null,
      (x: unknown) => x as EgressError,
    )) as EgressError
    expect(e.reason).toBe('redirect')
    // Phase 3d-3b final review (A25): the host is an administrator's detail, never in the message.
    expect(e.detail).toContain('169.254.169.254')
    expect(e.message).not.toContain('169.254.169.254')
    expect(await reason(egress.buffer({ method: 'GET', url: big.url, caPem: big.caPem }))).toBe('too_large')
    expect(await reason(egress.request({ method: 'GET', url: ok.url }))).toBe('tls')
  })

  it('stops an idle response and an aborted request', async () => {
    const egress = createEgress({ networks: loopback, idleTimeoutMs: 300 })
    expect(await reason(egress.buffer({ method: 'GET', url: slow.url, caPem: slow.caPem }))).toBe('timeout')
    const ctl = new AbortController()
    const p = egress.buffer({ method: 'GET', url: slow.url, caPem: slow.caPem, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 50)
    expect(await reason(p)).toBe('aborted')
  })

  it('measures a probe and refuses one to a refused address', async () => {
    const probe = await createEgress({ networks: loopback }).probe(ok.url, ok.caPem)
    expect(probe.resolveMs).toBeGreaterThanOrEqual(0)
    expect(probe.connectMs).toBeGreaterThanOrEqual(0)
    expect(await reason(createEgress({ networks: [] }).probe(ok.url, ok.caPem))).toBe('address_refused')
  })

  it('scrubs keys, tokens, signatures, session queries and PEM blocks from texts', () => {
    const text = scrubText(
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIA/x, Signature=abcdef0123 access_token=ya29.secret ' +
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION123 ' +
        '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- refresh_token: "1//rt"',
    )
    for (const secret of ['abcdef0123', 'ya29.secret', 'SESSION123', 'MIIE', '1//rt'])
      expect(text).not.toContain(secret)
    expect(text.length).toBeLessThanOrEqual(300)
  })
})
