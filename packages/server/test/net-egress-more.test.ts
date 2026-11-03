import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { rootCertificates } from 'node:tls'
import { Readable } from 'node:stream'
import selfsigned from 'selfsigned'
import { EgressError, JSON_LIMIT, createEgress, scrubText, type LookupFn } from '../src/net/egress'
import { classifyAddress, embeddedIPv4, ipBytes } from '../src/net/cidr'
import { isRetryable } from '../src/backup/destinations/retry'
import { startHttpsServer } from './support/https-server'
import { pastedBundle } from './support/tls'
import { slow } from './support/slowness'

type S = Awaited<ReturnType<typeof startHttpsServer>>
const loopback = ['127.0.0.1/32']
const PUBLIC = '93.184.216.34'

/** Requests that reached the counting server: a refused request must never get there. */
let hits: string[] = []
let target: S
let echo: S
let redirects: S
let sized: S
let stall: S
let overflow: S
let truncated: S
let plain: S
let silent: net.Server
let silentPort: number
const silentSockets: net.Socket[] = []
beforeAll(async () => {
  target = await startHttpsServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.end('target')
  })
  echo = await startHttpsServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    res.end(Buffer.concat(chunks))
  })
  // /<status>?to=<name>: a redirect with that status to one of a fixed set of locations, named (the
  // request never gives the location itself); no "to": a 3xx without a Location.
  redirects = await startHttpsServer((req, res) => {
    const u = new URL(req.url!, 'https://x')
    res.statusCode = Number(u.pathname.slice(1))
    const to = u.searchParams.get('to')
    if (to !== null) {
      const location = new Map([
        ['target', `${target.url}/stolen`],
        ['relative', '/elsewhere'],
        ['unparsable', 'http://[::1'],
      ]).get(to)
      if (location === undefined) res.statusCode = 400
      else res.setHeader('location', location)
    }
    res.end()
  })
  // /<n>: exactly n bytes, in two writes (chunked, no content-length).
  sized = await startHttpsServer((req, res) => {
    const n = Number(req.url!.slice(1))
    const half = Math.floor(n / 2)
    res.write(Buffer.alloc(half, 0x61))
    res.end(Buffer.alloc(n - half, 0x62))
  })
  // Headers, then nothing: neither a byte of body nor the end.
  stall = await startHttpsServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.flushHeaders()
  })
  overflow = await startHttpsServer((_req, res) => {
    res.setHeader('x-padding', 'p'.repeat(20 * 1024))
    res.end('{}')
  })
  // Promises 100 bytes, sends 3, then drops the connection.
  truncated = await startHttpsServer((_req, res) => {
    res.writeHead(200, { 'content-length': '100' })
    res.write('abc', () => setTimeout(() => res.socket?.destroy(), 20))
  })
  plain = await startHttpsServer(
    (req, res) => {
      hits.push(`plain ${req.method} ${req.url}`)
      res.end('plain')
    },
    { plain: true },
  )
  // Accepts TCP, reads and says nothing: the TLS handshake never completes.
  silent = net.createServer((s) => {
    silentSockets.push(s)
    s.on('error', () => undefined)
    s.resume()
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  silentPort = (silent.address() as AddressInfo).port
})
afterAll(async () => {
  await Promise.all(
    [target, echo, redirects, sized, stall, overflow, truncated, plain].map((s) => s?.close()),
  )
  for (const s of silentSockets) s.destroy()
  await new Promise<void>((resolve) => silent.close(() => resolve()))
})

async function failure(p: Promise<unknown>): Promise<EgressError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e, 'the call should have failed').toBeInstanceOf(EgressError)
  return e as EgressError
}
const reason = async (p: Promise<unknown>) => (await failure(p)).reason

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('egress address policy at the socket (phase 3d-3b spec §3, D1)', () => {
  it.each([
    ['an IPv4-mapped private address', '::ffff:10.0.0.1', 'private'],
    ['an IPv4-mapped private address in hex', '::ffff:c0a8:101', 'private'],
    ['an IPv4-compatible private address', '::10.1.2.3', 'private'],
    ['a NAT64 private address', '64:ff9b::a00:1', 'private'],
    ['a NAT64 loopback address', '64:ff9b::7f00:1', 'loopback'],
    ['an IPv4-mapped metadata address', '::ffff:169.254.169.254', 'metadata'],
    ['a NAT64 metadata address', '64:ff9b::a9fe:a9fe', 'metadata'],
    ['the AWS IPv6 metadata address', 'fd00:ec2::254', 'metadata'],
    ['the Alibaba metadata address', '100.100.100.200', 'metadata'],
    ['an IPv6 link-local address', 'fe80::1', 'link_local'],
    ['the unspecified address', '0.0.0.0', 'reserved'],
    ['a multicast address', '224.0.0.251', 'reserved'],
  ])('refuses a name resolving to %s (%s)', async (_what, address, why) => {
    const egress = createEgress({ networks: [], lookup: resolvesTo(address) })
    const e = await failure(egress.request({ method: 'GET', url: 'https://storage.example/' }))
    expect(e.reason).toBe(why === 'private' || why === 'loopback' ? 'address_refused' : 'address_never')
    expect(e.message).toContain(`(${why})`)
  })

  it.each([
    ['[::ffff:10.0.0.1]', 'private'],
    ['[::ffff:a9fe:a9fe]', 'metadata'],
    ['[::10.0.0.1]', 'private'],
    ['[64:ff9b::a9fe:a9fe]', 'metadata'],
    ['[fd00:ec2::254]', 'metadata'],
    ['[fe80::1]', 'link_local'],
    ['[::1]', 'loopback'],
    ['100.100.100.200', 'metadata'],
    ['169.254.169.254', 'metadata'],
    ['192.168.0.1', 'private'],
  ])('refuses the literal %s (%s) before any lookup or connection', async (host, why) => {
    let lookups = 0
    const egress = createEgress({
      networks: [],
      lookup: async () => {
        lookups++
        return [{ address: PUBLIC, family: 4 }]
      },
    })
    const e = await failure(egress.request({ method: 'GET', url: `https://${host}/` }))
    expect(e.reason).toBe(why === 'private' || why === 'loopback' ? 'address_refused' : 'address_never')
    expect(e.message).toContain(`(${why})`)
    expect(lookups).toBe(0)
  })

  it('never reaches metadata through a listed network, in any IPv6 form', async () => {
    // Even with every private range listed, the metadata endpoint stays refused.
    const egress = createEgress({
      networks: ['10.0.0.0/8', '100.64.0.0/10', 'fd00::/8'],
      lookup: resolvesTo('::ffff:169.254.169.254'),
    })
    expect(await reason(egress.request({ method: 'GET', url: 'https://lan.example/' }))).toBe('address_never')
    const aws = createEgress({ networks: ['fd00::/8'], lookup: resolvesTo('fd00:ec2::254') })
    expect(await reason(aws.request({ method: 'GET', url: 'https://lan.example/' }))).toBe('address_never')
    const ali = createEgress({ networks: ['100.64.0.0/10'], lookup: resolvesTo('100.100.100.200') })
    expect(await reason(ali.request({ method: 'GET', url: 'https://lan.example/' }))).toBe('address_never')
  })

  it.each([
    ['public then private', [PUBLIC, '10.0.0.7']],
    ['private then public', ['192.168.1.20', PUBLIC]],
    ['public then a mapped private', [PUBLIC, '::ffff:172.16.0.1']],
    ['public IPv6 then NAT64 loopback', ['2606:4700:4700::1111', '64:ff9b::7f00:1']],
  ])('refuses a name whose answer mixes addresses (%s)', async (_what, list) => {
    const egress = createEgress({ networks: [], lookup: resolvesTo(...list) })
    expect(await reason(egress.request({ method: 'GET', url: 'https://mixed.example/' }))).toBe(
      'address_refused',
    )
  })

  it('does not connect when one address is allowed and another is refused', async () => {
    hits = []
    // 127.0.0.1 is listed and reachable; the second address is not: the whole name is refused.
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1', '169.254.169.254') })
    const e = await failure(
      egress.request({ method: 'GET', url: `https://localhost:${target.port}/x`, caPem: target.caPem }),
    )
    expect(e.reason).toBe('address_never')
    expect(e.message).toMatch(/metadata/)
    expect(hits).toEqual([])
  })

  it('connects to a name whose every address is allowed, verifying the certificate against the name', async () => {
    hits = []
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const r = await egress.buffer({
      method: 'GET',
      url: `https://localhost:${target.port}/n`,
      caPem: target.caPem,
    })
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('target')
    expect(hits).toEqual(['GET /n'])
    // The same address under a name the certificate does not hold: refused by TLS, not reached.
    const e = await failure(
      egress.request({ method: 'GET', url: `https://other.example:${target.port}/`, caPem: target.caPem }),
    )
    expect(e.reason).toBe('tls')
    expect(e.detail).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
  })

  // Review of the stream errors (2026-10-20): a body that cannot be read (a backup file gone before
  // its send) was taken for a broken connection, so it was retried as one and said "The connection
  // to the destination failed". It is the body's failure, said as such, and never retried.
  it("says a body that cannot be read is the body's failure, not the connection's", async () => {
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const body = new Readable({ read() {} })
    setImmediate(() => body.destroy(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })))
    const e = await failure(
      egress.request({ method: 'PUT', url: `https://localhost:${echo.port}/up`, caPem: echo.caPem, body }),
    )
    expect(e.reason).toBe('body')
    expect(e.message).toBe('The data to send could not be read')
    expect(e.detail).toBe('ENOENT')
    expect(isRetryable(e)).toBe(false)
  })

  // Review of db45c424 (M-5): a request refused before it was sent (a stopped signal, a bad address)
  // never read its body, and left it open: a file handle, which on Windows also locks the backup.
  it('lets go of the body of a request refused before it is sent', async () => {
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const stopped = new AbortController()
    stopped.abort()
    const cases = [
      { url: `https://localhost:${echo.port}/up`, signal: stopped.signal },
      { url: 'not a url' },
      { url: 'https://169.254.169.254/latest' },
    ]
    for (const c of cases) {
      const body = new Readable({ read() {} })
      await failure(egress.request({ method: 'PUT', caPem: echo.caPem, body, ...c }))
      expect(body.destroyed, c.url).toBe(true)
    }
  })

  // Review 2026-10-17 (minor 1): a destination's CA bundle pasted with its blocks run together
  // trusted only its first CA, so a server signed by the second was refused.
  it('trusts every CA of a bundle pasted with its blocks run together', async () => {
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const r = await egress.buffer({
      method: 'GET',
      url: `https://localhost:${target.port}/b`,
      caPem: await pastedBundle(target.caPem),
    })
    expect(r.status).toBe(200)
  })

  it('judges the answer when the socket asks for one address only (autoSelectFamily off)', async () => {
    const before = net.getDefaultAutoSelectFamily()
    net.setDefaultAutoSelectFamily(false)
    try {
      const ok = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
      const r = await ok.buffer({
        method: 'GET',
        url: `https://localhost:${target.port}/`,
        caPem: target.caPem,
      })
      expect(r.body.toString()).toBe('target')
      const refused = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1', '10.0.0.1') })
      expect(
        await reason(
          refused.request({ method: 'GET', url: `https://localhost:${target.port}/`, caPem: target.caPem }),
        ),
      ).toBe('address_refused')
    } finally {
      net.setDefaultAutoSelectFamily(before)
    }
  })

  it('maps resolution failures: no address, NXDOMAIN, a temporary failure, an unknown error', async () => {
    const empty = createEgress({ networks: [], lookup: async () => [] })
    expect(await reason(empty.request({ method: 'GET', url: 'https://empty.example/' }))).toBe('dns')
    const nx = createEgress({
      networks: [],
      lookup: () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
    })
    const e = await failure(nx.request({ method: 'GET', url: 'https://nx.example/' }))
    expect(e.reason).toBe('dns')
    expect(e.detail).toBe('ENOTFOUND')
    const again = createEgress({
      networks: [],
      lookup: () => Promise.reject(Object.assign(new Error('try later'), { code: 'EAI_AGAIN' })),
    })
    expect(await reason(again.request({ method: 'GET', url: 'https://later.example/' }))).toBe('dns')
    const odd = createEgress({ networks: [], lookup: () => Promise.reject(new Error('resolver crashed')) })
    const o = await failure(odd.request({ method: 'GET', url: 'https://odd.example/' }))
    expect(o.reason).toBe('network')
    expect(o.detail).toBeUndefined()
    // The resolver's own text is not passed on.
    expect(o.message).not.toContain('crashed')
    // A lookup stopped by its caller reads as stopped, not as a network failure.
    const stopped = createEgress({
      networks: [],
      lookup: () => Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
    })
    expect(await reason(stopped.request({ method: 'GET', url: 'https://stopped.example/' }))).toBe('aborted')
    const coded = createEgress({
      networks: [],
      lookup: () => Promise.reject(Object.assign(new Error('stop'), { code: 'ABORT_ERR' })),
    })
    expect(await reason(coded.probe('https://stopped.example/'))).toBe('aborted')
  })

  it(
    'uses the system resolver by default, and a name that does not exist reads as dns',
    async () => {
      // RFC 6761: .invalid never resolves.
      const egress = createEgress({ networks: [] })
      expect(await reason(egress.request({ method: 'GET', url: 'https://mm-egress-test.invalid/' }))).toBe(
        'dns',
      )
    },
    slow(30_000),
  )
})

describe('egress address forms a resolver may answer (phase 3d-3b spec §3, D1)', () => {
  it.each([
    ['a zero-padded (octal-looking) IPv4', '010.0.0.1'],
    ['a zero-padded loopback', '0127.0.0.1'],
    ['an IPv4 with a part over 255', '10.0.0.256'],
    ['an IPv4 with three parts', '10.0.1'],
    ['an IPv6 with a bad embedded IPv4', '::ffff:10.0.1'],
    ['an IPv6 with a zero-padded embedded IPv4', '::ffff:010.0.0.1'],
    ['an IPv6 with too few groups', '1:2:3:4:5:6:7'],
    ['an IPv6 with too many groups', '1:2:3:4:5:6:7:8:9'],
    ['an IPv6 with a five-digit group', '12345::1'],
    ['an IPv6 compressing nothing', '1:2:3:4::5:6:7:8'],
    ['an IPv6 with a zone id', 'fe80::1%25eth0'],
  ])('refuses %s instead of guessing what it means', async (_what, address) => {
    // Unparsable forms are never treated as public: they are refused like reserved addresses.
    expect(ipBytes(address)).toBeNull()
    expect(classifyAddress(address, [])).toEqual({ ok: false, reason: 'reserved' })
    const egress = createEgress({ networks: [], lookup: resolvesTo(address) })
    expect(await reason(egress.request({ method: 'GET', url: 'https://odd.example/' }))).toBe(
      // Unreadable forms are never guessed, so never allowed either.
      'address_never',
    )
  })

  it('finds no embedded IPv4 in an IPv4 address or in :: and ::1', () => {
    expect(embeddedIPv4(ipBytes('10.0.0.1')!)).toBeNull()
    expect(embeddedIPv4(ipBytes('::')!)).toBeNull()
    expect(embeddedIPv4(ipBytes('::1')!)).toBeNull()
    expect(Array.from(embeddedIPv4(ipBytes('::2')!)!)).toEqual([0, 0, 0, 2])
  })
})

describe('egress URLs and plain http (phase 3d-3b spec §3)', () => {
  it.each([
    ['not a URL', 'not a url'],
    ['a host with a space', 'https://exa mple.com/'],
    ['a file URL', 'file:///etc/passwd'],
    ['a gopher URL', 'gopher://127.0.0.1:70/'],
    ['a data URL', 'data:text/plain,hi'],
    ['a user name only', 'https://admin@example.com/'],
  ])('refuses %s as bad_url', async (_what, url) => {
    const egress = createEgress({ networks: loopback, lookup: resolvesTo(PUBLIC) })
    expect(await reason(egress.request({ method: 'GET', url }))).toBe('bad_url')
  })

  it('refuses plain http to a name with any address outside the listed networks', async () => {
    hits = []
    const port = new URL(plain.url).port
    const inside = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const r = await inside.buffer({ method: 'GET', url: `http://nas.lan:${port}/in` })
    expect(r.body.toString()).toBe('plain')
    expect(hits).toEqual(['plain GET /in'])
    // One public address in the answer: plain http could go out in the clear.
    const mixed = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1', PUBLIC) })
    expect(await reason(mixed.request({ method: 'GET', url: `http://nas.lan:${port}/out` }))).toBe(
      'http_refused',
    )
    expect(hits).toEqual(['plain GET /in'])
  })

  it('refuses plain http to a public literal before connecting', async () => {
    const egress = createEgress({ networks: ['10.0.0.0/8'] })
    const e = await failure(egress.request({ method: 'GET', url: `http://${PUBLIC}/` }))
    expect(e.reason).toBe('http_refused')
    expect(e.message).toMatch(/MM_BACKUP_PRIVATE_NETWORKS/)
  })

  it('stops before connecting when the signal is already aborted', async () => {
    hits = []
    const ctl = new AbortController()
    ctl.abort()
    const egress = createEgress({ networks: loopback })
    expect(
      await reason(
        egress.request({ method: 'GET', url: target.url, caPem: target.caPem, signal: ctl.signal }),
      ),
    ).toBe('aborted')
    expect(hits).toEqual([])
  })
})

describe('egress TLS options (phase 3d-3b spec §3)', () => {
  it('adds the given CA to the public roots, asks for TLS 1.2+, uses a fresh agent and sends the name as SNI', async () => {
    const spy = vi.spyOn(https, 'request')
    try {
      const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
      await egress.buffer({ method: 'GET', url: `https://localhost:${target.port}/`, caPem: target.caPem })
      await egress.buffer({ method: 'GET', url: target.url, caPem: target.caPem })
      const [byName, byLiteral] = spy.mock.calls.map((c) => c[1] as https.RequestOptions)
      // Added, not replacing: a public-CA endpoint keeps working when a private CA is configured.
      expect(byName!.ca).toEqual([...rootCertificates, target.caPem])
      expect(byName!.minVersion).toBe('TLSv1.2')
      expect(byName!.servername).toBe('localhost')
      expect(byName!.maxHeaderSize).toBe(16 * 1024)
      const agent = byName!.agent as https.Agent
      expect(agent).toBeInstanceOf(https.Agent)
      expect(agent).not.toBe(https.globalAgent)
      expect(agent.options.keepAlive).toBe(false)
      expect(byLiteral!.agent).not.toBe(agent)
      // No SNI for an IP literal (RFC 6066).
      expect(byLiteral!.servername).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not trust a server signed by a CA other than the one given', async () => {
    const other = await selfsigned.generate([{ name: 'commonName', value: 'Another CA' }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      extensions: [{ name: 'basicConstraints', cA: true }],
    })
    const egress = createEgress({ networks: loopback })
    const e = await failure(egress.request({ method: 'GET', url: target.url, caPem: other.cert }))
    expect(e.reason).toBe('tls')
  })
})

describe('egress redirects (phase 3d-3b spec §3: never followed)', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i and never requests its target', async (status) => {
    hits = []
    const egress = createEgress({ networks: loopback })
    // To the target's /stolen.
    const e = await failure(
      egress.request({ method: 'GET', url: `${redirects.url}/${status}?to=target`, caPem: redirects.caPem }),
    )
    expect(e.reason).toBe('redirect')
    expect(e.detail).toBe(`127.0.0.1:${target.port}`)
    expect(e.message).not.toContain('127.0.0.1')
    expect(hits).toEqual([])
  })

  it('names the origin (as the detail) for a relative Location, and none for an unparsable one', async () => {
    const egress = createEgress({ networks: loopback })
    const rel = await failure(
      // To /elsewhere.
      egress.request({ method: 'GET', url: `${redirects.url}/302?to=relative`, caPem: redirects.caPem }),
    )
    expect(rel.reason).toBe('redirect')
    expect(rel.detail).toBe(`127.0.0.1:${redirects.port}`)
    const bad = await failure(
      egress.request({
        method: 'GET',
        // To http://[::1, which no URL parser reads.
        url: `${redirects.url}/302?to=unparsable`,
        caPem: redirects.caPem,
      }),
    )
    expect(bad.reason).toBe('redirect')
    expect(bad.detail).toBeUndefined()
  })

  it('returns a 3xx without a Location as an answer (304 Not Modified)', async () => {
    const egress = createEgress({ networks: loopback })
    const r = await egress.buffer({ method: 'GET', url: `${redirects.url}/304`, caPem: redirects.caPem })
    expect(r.status).toBe(304)
    expect(r.body.length).toBe(0)
  })
})

describe('egress bounds (phase 3d-3b spec §3)', () => {
  it('accepts a body of exactly the limit and refuses one byte more', async () => {
    const egress = createEgress({ networks: loopback })
    const at = await egress.buffer({ method: 'GET', url: `${sized.url}/1000`, caPem: sized.caPem }, 1000)
    expect(at.body.length).toBe(1000)
    expect(
      await reason(egress.buffer({ method: 'GET', url: `${sized.url}/1001`, caPem: sized.caPem }, 1000)),
    ).toBe('too_large')
  })

  it('bounds a body at 1 MiB by default', async () => {
    const egress = createEgress({ networks: loopback })
    const at = await egress.buffer({ method: 'GET', url: `${sized.url}/${JSON_LIMIT}`, caPem: sized.caPem })
    expect(at.body.length).toBe(JSON_LIMIT)
    expect(JSON_LIMIT).toBe(1024 * 1024)
    const e = await failure(
      egress.buffer({ method: 'GET', url: `${sized.url}/${JSON_LIMIT + 1}`, caPem: sized.caPem }),
    )
    expect(e.reason).toBe('too_large')
  })

  it('refuses headers over 16 KiB', async () => {
    const egress = createEgress({ networks: loopback })
    expect(await reason(egress.buffer({ method: 'GET', url: overflow.url, caPem: overflow.caPem }))).toBe(
      'too_large',
    )
  })

  it('ends an answer that sends its headers and then stalls', async () => {
    const egress = createEgress({ networks: loopback, idleTimeoutMs: 300 })
    const t0 = Date.now()
    const res = await egress.request({ method: 'GET', url: stall.url, caPem: stall.caPem })
    expect(res.status).toBe(200)
    const read = (async () => {
      for await (const _c of res.body) {
        // nothing ever arrives
      }
    })()
    const e = await failure(read)
    expect(e.reason).toBe('timeout')
    expect(e.message).toMatch(/stopped answering/)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(await reason(egress.buffer({ method: 'GET', url: stall.url, caPem: stall.caPem }))).toBe('timeout')
  })

  it('times out a connection whose TLS handshake never completes, and closes it', async () => {
    const egress = createEgress({ networks: loopback, connectTimeoutMs: 200, idleTimeoutMs: 10_000 })
    const before = silentSockets.length
    const t0 = Date.now()
    const e = await failure(egress.request({ method: 'GET', url: `https://127.0.0.1:${silentPort}/` }))
    expect(e.reason).toBe('timeout')
    expect(e.message).toMatch(/did not answer in time/)
    expect(Date.now() - t0).toBeLessThan(5_000)
    // The connection is not left open behind the refusal.
    const socket = silentSockets[before]!
    if (!socket.closed) await new Promise((resolve) => socket.once('close', resolve))
    expect(socket.closed).toBe(true)
  })

  it('reports a body cut short as a network failure, not a short answer', async () => {
    const egress = createEgress({ networks: loopback })
    const e = await failure(egress.buffer({ method: 'GET', url: truncated.url, caPem: truncated.caPem }))
    expect(e.reason).toBe('network')
    expect(e.detail).toBe('ECONNRESET')
  })

  it(
    'reports a refused connection as connect',
    async () => {
      const free = net.createServer()
      await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve))
      const port = (free.address() as AddressInfo).port
      await new Promise<void>((resolve) => free.close(() => resolve()))
      const egress = createEgress({ networks: loopback })
      const e = await failure(egress.request({ method: 'GET', url: `https://127.0.0.1:${port}/` }))
      expect(e.reason).toBe('connect')
      expect(e.detail).toBe('ECONNREFUSED')
    },
    slow(20_000),
  )
})

describe('egress request bodies (phase 3d-3b spec §3)', () => {
  it('fails the request when the streamed body fails, without the source text', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from('part'))
        this.destroy(new Error('disk read failed at /secret/path'))
      },
    })
    const egress = createEgress({ networks: loopback })
    const e = await failure(
      egress.request({
        method: 'PUT',
        url: `${echo.url}/up`,
        body,
        headers: { 'content-length': '100' },
        caPem: echo.caPem,
      }),
    )
    // The body's failure (review of the stream errors, 2026-10-20), not the connection's.
    expect(e.reason).toBe('body')
    expect(e.message).not.toContain('/secret/path')
    expect(e.detail ?? '').not.toContain('/secret/path')
  })

  it('stops an upload in progress when its signal is aborted', async () => {
    const ctl = new AbortController()
    // A body that sends a first part and then waits, as a slow disk would.
    const body = new Readable({ read() {} })
    body.push(Buffer.from('start'))
    const egress = createEgress({ networks: loopback })
    const p = egress.request({
      method: 'PUT',
      url: `${echo.url}/abort`,
      body,
      headers: { 'content-length': '100' },
      caPem: echo.caPem,
      signal: ctl.signal,
    })
    setTimeout(() => ctl.abort(), 50)
    expect(await reason(p)).toBe('aborted')
    expect(body.destroyed).toBe(true)
  })
})

describe('egress probe (phase 3d-3b spec §3)', () => {
  it('probes a name with HEAD on the root, whatever path the address has', async () => {
    hits = []
    const egress = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1') })
    const r = await egress.probe(`https://localhost:${target.port}/deep/path?secret=1`, target.caPem)
    expect(r.resolveMs).toBeGreaterThanOrEqual(0)
    expect(r.connectMs).toBeGreaterThanOrEqual(0)
    expect(hits).toEqual(['HEAD /'])
  })

  it('refuses a probe before connecting: no address, a failed lookup, mixed answers, public plain http, bad URLs', async () => {
    hits = []
    expect(
      await reason(createEgress({ networks: [], lookup: async () => [] }).probe('https://x.example/')),
    ).toBe('dns')
    const nx = createEgress({
      networks: [],
      lookup: () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
    })
    expect(await reason(nx.probe('https://nx.example/'))).toBe('dns')
    const mixed = createEgress({ networks: loopback, lookup: resolvesTo('127.0.0.1', '::ffff:10.0.0.1') })
    expect(await reason(mixed.probe(`https://localhost:${target.port}/`, target.caPem))).toBe(
      'address_refused',
    )
    const pub = createEgress({ networks: [], lookup: resolvesTo(PUBLIC) })
    expect(await reason(pub.probe('http://public.example/'))).toBe('http_refused')
    expect(await reason(pub.probe('ftp://public.example/'))).toBe('bad_url')
    expect(await reason(pub.probe('https://u:p@public.example/'))).toBe('bad_url')
    expect(hits).toEqual([])
  })

  it('passes the signal on to the probe request', async () => {
    hits = []
    const ctl = new AbortController()
    ctl.abort()
    const egress = createEgress({ networks: loopback })
    expect(await reason(egress.probe(target.url, target.caPem, ctl.signal))).toBe('aborted')
    expect(hits).toEqual([])
  })
})

describe('scrubText (phase 3d-3b spec §3)', () => {
  it('redacts secret fields in JSON and form bodies', () => {
    const text = scrubText(
      '{"password":"hunter2","client_secret":"cs-123","private_key":"pk-456","id_token":"it-789"} ' +
        'grant_type=authorization_code&code=oauth-code-1&assertion=jwt-abc',
    )
    for (const secret of ['hunter2', 'cs-123', 'pk-456', 'it-789', 'oauth-code-1', 'jwt-abc'])
      expect(text).not.toContain(secret)
    expect(text).toContain('[redacted]')
  })

  it('drops query strings from URLs but keeps the path', () => {
    const text = scrubText(
      'PUT https://bucket.s3.amazonaws.com/a/b.mmbak?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA failed',
    )
    expect(text).toContain('https://bucket.s3.amazonaws.com/a/b.mmbak')
    expect(text).not.toContain('deadbeef')
    expect(text).not.toContain('AKIA')
  })

  it('redacts long opaque tokens and any PEM block, and caps the length at 300', () => {
    const token = 'A'.repeat(20) + 'b1/+'.repeat(10)
    const text = scrubText(
      `token ${token} -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- end`,
    )
    expect(text).not.toContain(token)
    expect(text).not.toContain('abc')
    expect(text).toContain('[redacted key]')
    expect(scrubText('x'.repeat(10) + ' '.repeat(1000)).length).toBe(300)
  })

  it('redacts the credential of an Authorization header, not only its scheme', () => {
    // Basic carries user:password in base64; a short bearer token is still a credential.
    const basic = scrubText('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    expect(basic).not.toContain('dXNlcjpwYXNzd29yZA')
    const bearer = scrubText('authorization: Bearer abc123shorttoken')
    expect(bearer).not.toContain('abc123shorttoken')
  })
})
