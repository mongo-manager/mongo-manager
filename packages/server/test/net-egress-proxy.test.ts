import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { createServer as createHttps } from 'node:https'
import selfsigned from 'selfsigned'
import type { AddressInfo } from 'node:net'
import { EgressError, createEgress, type LookupFn } from '../src/net/egress'
import { resolveConfig } from '../src/config'
import { startHttpsServer } from './support/https-server'
import { pastedBundle } from './support/tls'

/**
 * W4 item 5 (completion design §2 W4.5): destinations through an HTTP(S) proxy. The egress guard
 * still judges the target: it resolves and checks the address itself, then asks the proxy to CONNECT
 * to that very address (the proxy never resolves a name), with TLS to the target's name end to end.
 */
type S = Awaited<ReturnType<typeof startHttpsServer>>
let target: S
beforeAll(async () => {
  target = await startHttpsServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }))
  })
})
afterAll(async () => target?.close())

interface FakeProxy {
  url: string
  connects: Array<{ line: string; auth: string | null }>
  close(): Promise<void>
}
let proxies: FakeProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.map((p) => p.close()))
  proxies = []
})

/**
 * A CONNECT proxy that records what it is asked, then tunnels to the test server whatever the target
 * (or answers `status`, or floods its headers).
 */
async function startProxy(
  opts: { status?: number; flood?: boolean; upstream?: number; hold?: boolean; refuse?: string[] } = {},
): Promise<FakeProxy> {
  const connects: FakeProxy['connects'] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => {
    sockets.add(client)
    let head = ''
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      client.off('data', onData)
      const lines = head.slice(0, end).split('\r\n')
      const auth = lines.find((l) => /^proxy-authorization:/i.test(l))?.replace(/^[^:]+:\s*/, '') ?? null
      connects.push({ line: lines[0]!, auth })
      if (opts.hold) return
      if (opts.refuse?.some((a) => lines[0]!.includes(` ${a}:`))) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (opts.flood) {
        client.write('HTTP/1.1 200 OK\r\n' + 'X-Fill: ' + 'a'.repeat(40_000))
        return
      }
      if (opts.status && opts.status !== 200) {
        client.end(`HTTP/1.1 ${opts.status} No\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      const upstream = connect(opts.upstream ?? target.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
      sockets.add(upstream)
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    }
    client.on('data', onData)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const p: FakeProxy = {
    url: `http://127.0.0.1:${port}`,
    connects,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
  proxies.push(p)
  return p
}

/** "localhost" (the test certificate's name) resolved to a public address the guard lets through. */
const publicLookup =
  (address = '93.184.216.34'): LookupFn =>
  async () => [{ address, family: 4 }]

async function until(test: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'none'
  } catch (e) {
    expect(e).toBeInstanceOf(EgressError)
    return (e as EgressError).reason
  }
}

describe('destinations through a proxy (W4.5)', () => {
  // Review 2026-10-17 (minor 1): through the proxy too, every CA of a bundle pasted run together.
  it('trusts every CA of a bundle pasted with its blocks run together', async () => {
    const proxy = await startProxy()
    const egress = createEgress({ networks: [], lookup: publicLookup(), proxy: proxy.url })
    const r = await egress.buffer({
      method: 'GET',
      url: `https://localhost:${target.port}/bundle`,
      caPem: await pastedBundle(target.caPem),
    })
    expect(r.status).toBe(200)
  })

  it('tunnels to the address it judged, with TLS to the name, and sends the proxy credentials', async () => {
    const proxy = await startProxy()
    const egress = createEgress({
      networks: [],
      lookup: publicLookup(),
      proxy: `http://ada:s3cret@${proxy.url.slice('http://'.length)}`,
    })
    const r = await egress.buffer({
      method: 'GET',
      url: `https://localhost:${target.port}/a`,
      caPem: target.caPem,
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString())).toMatchObject({ path: '/a', host: `localhost:${target.port}` })
    expect(proxy.connects).toEqual([
      {
        line: `CONNECT 93.184.216.34:${target.port} HTTP/1.1`,
        auth: `Basic ${Buffer.from('ada:s3cret').toString('base64')}`,
      },
    ])
  })

  it('refuses a metadata or a private address before the proxy is ever asked', async () => {
    const proxy = await startProxy()
    for (const address of ['169.254.169.254', '10.0.0.5']) {
      const egress = createEgress({ networks: [], lookup: publicLookup(address), proxy: proxy.url })
      const why = await reason(
        egress.buffer({ method: 'GET', url: `https://localhost:${target.port}/`, caPem: target.caPem }),
      )
      expect(['address_never', 'address_refused']).toContain(why)
    }
    expect(proxy.connects).toEqual([])
  })

  it('goes straight to a listed private network, never through the proxy', async () => {
    const proxy = await startProxy()
    const egress = createEgress({ networks: ['127.0.0.1/32'], proxy: proxy.url })
    const r = await egress.buffer({ method: 'GET', url: `${target.url}/direct`, caPem: target.caPem })
    expect(r.status).toBe(200)
    expect(proxy.connects).toEqual([])
  })

  it('says when the proxy refuses (407 credentials, 403), or floods its answer', async () => {
    for (const [opts, expected] of [
      [{ status: 407 }, 'proxy'],
      [{ status: 403 }, 'proxy'],
      [{ flood: true }, 'proxy'],
    ] as const) {
      const proxy = await startProxy(opts)
      const egress = createEgress({ networks: [], lookup: publicLookup(), proxy: proxy.url })
      expect(
        await reason(
          egress.buffer({ method: 'GET', url: `https://localhost:${target.port}/`, caPem: target.caPem }),
        ),
      ).toBe(expected)
    }
  })

  it('still checks the target certificate through the tunnel', async () => {
    const proxy = await startProxy()
    const egress = createEgress({ networks: [], lookup: publicLookup(), proxy: proxy.url })
    // Without the test CA the server is not trusted, proxy or not.
    expect(await reason(egress.buffer({ method: 'GET', url: `https://localhost:${target.port}/` }))).toBe(
      'tls',
    )
  })

  // W4 review I1: an IP-address target is checked against that address, not against "localhost".
  it('checks an IP-address target’s certificate against that address through the proxy', async () => {
    const proxy = await startProxy()
    const egress = createEgress({ networks: [], proxy: proxy.url })
    // The test server's certificate names localhost and 127.0.0.1 — not this address.
    expect(
      await reason(
        egress.buffer({ method: 'GET', url: `https://93.184.216.34:${target.port}/`, caPem: target.caPem }),
      ),
    ).toBe('tls')
    // A certificate that names the address is trusted.
    const ca = await selfsigned.generate([{ name: 'commonName', value: 'IP Test CA' }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true },
      ],
    })
    const leaf = await selfsigned.generate([{ name: 'commonName', value: '93.184.216.34' }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '93.184.216.34' }] }],
    })
    const server = createHttps({ key: leaf.private, cert: leaf.cert }, (_req, res) => res.end('{"ok":true}'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as AddressInfo).port
      const viaIp = await startProxy({ upstream: port })
      const ok = createEgress({ networks: [], proxy: viaIp.url })
      const r = await ok.buffer({ method: 'GET', url: `https://93.184.216.34:${port}/`, caPem: ca.cert })
      expect(r.status).toBe(200)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  // W4 review (minor): a stop while the proxy has not answered is a stop, not a proxy failure.
  it('says "aborted" when stopped while waiting for the proxy', async () => {
    const proxy = await startProxy({ hold: true })
    const egress = createEgress({ networks: [], lookup: publicLookup(), proxy: proxy.url })
    const ctl = new AbortController()
    const pending = reason(
      egress.buffer({
        method: 'GET',
        url: `https://localhost:${target.port}/`,
        caPem: target.caPem,
        signal: ctl.signal,
      }),
    )
    await until(() => proxy.connects.length === 1)
    ctl.abort()
    expect(await pending).toBe('aborted')
  })

  // W4 review (minor): every address a name resolves to is tried in turn.
  it('tries the next address when the proxy cannot reach the first', async () => {
    const proxy = await startProxy({ refuse: ['93.184.216.34'] })
    const egress = createEgress({
      networks: [],
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ],
      proxy: proxy.url,
    })
    const r = await egress.buffer({
      method: 'GET',
      url: `https://localhost:${target.port}/n`,
      caPem: target.caPem,
    })
    expect(r.status).toBe(200)
    expect(proxy.connects.map((c) => c.line)).toEqual([
      `CONNECT 93.184.216.34:${target.port} HTTP/1.1`,
      `CONNECT 93.184.216.35:${target.port} HTTP/1.1`,
    ])
  })

  it('never sends the proxy credentials in a message or an error', async () => {
    const proxy = await startProxy({ status: 407 })
    const egress = createEgress({
      networks: [],
      lookup: publicLookup(),
      proxy: `http://ada:s3cret@${proxy.url.slice(7)}`,
    })
    try {
      await egress.buffer({ method: 'GET', url: `https://localhost:${target.port}/`, caPem: target.caPem })
    } catch (e) {
      expect(JSON.stringify({ m: (e as Error).message, d: (e as EgressError).detail })).not.toMatch(
        /s3cret|ada/,
      )
    }
  })
})

describe('the proxy setting (W4.5)', () => {
  const cfg = (value: string) => () => resolveConfig({ cli: {}, env: { MM_BACKUP_PROXY: value } })
  it('takes an http(s) address with optional credentials', () => {
    expect(resolveConfig({ cli: {}, env: { MM_BACKUP_PROXY: 'http://proxy.corp:3128' } }).backup.proxy).toBe(
      'http://proxy.corp:3128',
    )
    expect(resolveConfig({ cli: {}, env: { MM_BACKUP_PROXY: 'https://u:p@proxy.corp' } }).backup.proxy).toBe(
      'https://u:p@proxy.corp',
    )
  })
  it('refuses another scheme, a path, a query, and a metadata or link-local proxy', () => {
    for (const bad of [
      'socks5://proxy:1080',
      'http://proxy:3128/x',
      'http://proxy:3128?a=1',
      'http://169.254.169.254:80',
      'http://[fe80::1]:3128',
      'not a url',
    ])
      expect(cfg(bad), bad).toThrow()
  })
})
