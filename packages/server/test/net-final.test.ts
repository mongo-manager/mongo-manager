import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { EgressError, createEgress, rangedBody, scrubText } from '../src/net/egress'
import { classifyAddress, parseCidr, privateNetworkProblem } from '../src/net/cidr'
import { resolveConfig } from '../src/config'
import { startHttpsServer } from './support/https-server'
import { slow } from './support/slowness'

/*
 * Phase 3d-3b final review: egress and address-policy findings — unwanted bodies are dropped, not
 * downloaded; abort listeners do not pile up; small answers have an overall deadline; a redirect's
 * host stays out of user-visible text; scrubText; the private-network setting accepts private ranges
 * only.
 */

type S = Awaited<ReturnType<typeof startHttpsServer>>
const loopback = ['127.0.0.1/32']
const fail = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as EgressError
  }
  throw new Error('expected a rejection')
}

let firehose: S
let firehoseBytes = 0
let firehoseClosed = false
let drip: S
let plainOk: S
beforeAll(async () => {
  // A redirect that keeps streaming a body as fast as the client takes it.
  firehose = await startHttpsServer((_req, res) => {
    res.writeHead(302, { location: 'https://elsewhere.example.test/x' })
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    res.on('close', () => {
      firehoseClosed = true
    })
    const pump = () => {
      while (!res.destroyed) {
        firehoseBytes += chunk.length
        if (!res.write(chunk)) return void res.once('drain', pump)
      }
    }
    pump()
  })
  // Headers, then one byte every 50 ms forever: never idle long enough for the idle timer.
  drip = await startHttpsServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' })
    const t = setInterval(() => res.write('x'), 50)
    res.on('close', () => clearInterval(t))
  })
  plainOk = await startHttpsServer((_req, res) => res.end('ok'))
})
afterAll(async () => {
  await Promise.all([firehose, drip, plainOk].map((s) => s?.close()))
})

describe('egress final review: unwanted bodies, listeners, deadlines, redirect text', () => {
  it('A1: drops a refused redirect’s body instead of downloading it in the background', async () => {
    firehoseBytes = 0
    firehoseClosed = false
    const egress = createEgress({ networks: loopback })
    const e = await fail(egress.request({ method: 'GET', url: firehose.url, caPem: firehose.caPem }))
    expect(e.reason).toBe('redirect')
    await new Promise((r) => setTimeout(r, 500))
    expect(firehoseClosed).toBe(true)
    expect(firehoseBytes).toBeLessThan(16 * 1024 * 1024)
  })

  it('A3: leaves no abort listener on the caller’s signal once requests are done', async () => {
    const egress = createEgress({ networks: loopback })
    const ac = new AbortController()
    for (let i = 0; i < 25; i++)
      await egress.buffer({ method: 'GET', url: plainOk.url, caPem: plainOk.caPem, signal: ac.signal })
    // A refused one too.
    await fail(egress.request({ method: 'GET', url: firehose.url, caPem: firehose.caPem, signal: ac.signal }))
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })

  it('A3: an abort still stops a body being read', async () => {
    const egress = createEgress({ networks: loopback })
    const ac = new AbortController()
    const res = await egress.request({ method: 'GET', url: drip.url, caPem: drip.caPem, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    const e = await fail(text(res.body))
    expect(e).toBeTruthy()
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })

  it(
    'A16: a small answer that drips one byte at a time ends at its overall deadline',
    async () => {
      const egress = createEgress({ networks: loopback })
      const t0 = Date.now()
      const e = await fail(
        egress.buffer({ method: 'GET', url: drip.url, caPem: drip.caPem, deadlineMs: 400 }, 1024 * 1024),
      )
      expect(e).toBeInstanceOf(EgressError)
      expect(e.reason).toBe('timeout')
      expect(Date.now() - t0).toBeLessThan(3000)
    },
    slow(10_000),
  )

  it(
    'A16: buffer() has a default overall deadline, set per egress',
    async () => {
      const egress = createEgress({ networks: loopback, smallDeadlineMs: 300 })
      const e = await fail(egress.buffer({ method: 'GET', url: drip.url, caPem: drip.caPem }))
      expect(e.reason).toBe('timeout')
    },
    slow(10_000),
  )

  it('A25: a redirect error keeps the target host out of its message (users see it), in the detail only', async () => {
    const egress = createEgress({ networks: loopback })
    const e = await fail(egress.request({ method: 'GET', url: firehose.url, caPem: firehose.caPem }))
    expect(e.reason).toBe('redirect')
    expect(e.message).not.toContain('elsewhere')
    expect(e.detail).toContain('elsewhere.example.test')
  })
})

describe('rangedBody (A12: a resumed read never splices the wrong bytes)', () => {
  const answer = (status: number, headers: Record<string, string>, body: string) => ({
    status,
    headers,
    body: Readable.from([Buffer.from(body)]),
  })
  it('passes a 206 that starts at the offset, skips a 200, and skips the head of an earlier start', async () => {
    expect(await text(rangedBody(answer(206, { 'content-range': 'bytes 3-5/6' }, 'def'), 3))).toBe('def')
    expect(await text(rangedBody(answer(200, {}, 'abcdef'), 3))).toBe('def')
    expect(await text(rangedBody(answer(206, { 'content-range': 'bytes 1-5/6' }, 'bcdef'), 3))).toBe('def')
    expect(await text(rangedBody(answer(200, {}, 'abcdef'), 0))).toBe('abcdef')
  })
  it('refuses a 206 that starts past the offset, or with a Content-Range it cannot read', () => {
    for (const h of [
      { 'content-range': 'bytes 4-5/6' },
      { 'content-range': 'bytes */6' },
      { 'content-range': 'bytes 3-5/6, 0-1/6' },
    ]) {
      const body = Readable.from([Buffer.from('x')])
      expect(() => rangedBody({ status: 206, headers: h, body }, 3)).toThrow(/range/i)
      expect(body.destroyed).toBe(true)
    }
  })
  it('takes a 206 without Content-Range as the range asked for (the end-to-end digest still decides)', async () => {
    expect(await text(rangedBody(answer(206, {}, 'def'), 3))).toBe('def')
  })
})

describe('scrubText final review (A26)', () => {
  it('redacts user:password in a URL', () => {
    const out = scrubText('failed at https://ops:hunter2@dav.example.test/dav/x and http://u@h.example/p')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('ops:')
    expect(out).not.toContain('u@')
    expect(out).toContain('dav.example.test/dav/x')
  })

  it('stays linear on many unterminated BEGIN lines and redacts an unterminated key', () => {
    const hostile = '-----BEGIN A-----\nzz'.repeat(8000)
    const t0 = performance.now()
    scrubText(hostile)
    expect(performance.now() - t0).toBeLessThan(250)
    const cut = scrubText('x -----BEGIN PRIVATE KEY-----\nMIIsecretpart')
    expect(cut).not.toContain('MIIsecretpart')
    expect(cut).toContain('[redacted key]')
  })
})

/** The text MM_BACKUP_PRIVATE_NETWORKS is refused with at start. */
const configProblem = (value: string) => {
  try {
    resolveConfig({ env: { MM_BACKUP_PRIVATE_NETWORKS: value } })
  } catch (e) {
    return String((e as Error).message)
  }
  return ''
}

describe('address policy final review (A17)', () => {
  const none: ReturnType<typeof parseCidr>[] = []
  it('IPv4-translated (::ffff:0:0:0/96) and site-local (fec0::/10) addresses are not public', () => {
    expect(classifyAddress('::ffff:0:a9fe:a9fe', none)).toEqual({ ok: false, reason: 'metadata' })
    expect(classifyAddress('::ffff:0:808:808', none).ok).toBe(false)
    expect(classifyAddress('fec0::1', none).ok).toBe(false)
    expect(classifyAddress('feff::1', none).ok).toBe(false)
  })

  it('accepts private ranges that merely contain a never-allowed address', () => {
    for (const ok of ['100.64.0.0/10', 'fc00::/7', 'fd00::/8', '10.0.0.0/8', '127.0.0.0/8', '::1/128'])
      expect(privateNetworkProblem(ok), ok).toBeNull()
    // The metadata address inside an accepted range is still refused at connect time.
    expect(classifyAddress('100.100.100.200', [parseCidr('100.64.0.0/10')])).toEqual({
      ok: false,
      reason: 'metadata',
    })
    expect(classifyAddress('fd00:ec2::254', [parseCidr('fd00::/8')])).toEqual({
      ok: false,
      reason: 'metadata',
    })
  })

  it('refuses ranges inside the never-allowed set, in any form, naming the range and why', () => {
    for (const bad of [
      '169.254.0.0/16',
      '169.254.169.254/32',
      'fe80::/10',
      'fd00:ec2::254/128',
      '100.100.100.200/32',
      '::ffff:169.254.169.254/128',
      '64:ff9b::a9fe:a9fe/128',
      '::ffff:169.254.0.0/112',
    ]) {
      const p = privateNetworkProblem(bad)
      expect(p, bad).toMatch(/link-local|metadata/)
      expect(configProblem(bad), bad).toContain(bad)
    }
  })

  it('refuses public ranges: the setting is for private networks (D5)', () => {
    for (const bad of [
      '8.8.8.0/24',
      '0.0.0.0/0',
      '::/0',
      '169.0.0.0/8',
      '2001:4860::/32',
      '::ffff:8.8.8.0/120',
      '::ffff:0:0/96',
      '64:ff9b::/96',
    ]) {
      const p = privateNetworkProblem(bad)
      expect(p, bad).toMatch(/not a private network/)
      expect(configProblem(bad), bad).toContain(bad)
    }
  })

  it('accepts private ranges given in IPv4-mapped form', () => {
    expect(privateNetworkProblem('::ffff:10.0.0.0/104')).toBeNull()
  })
})

describe('addresses that can never be allowed say so (final gate)', () => {
  // A reserved, metadata or link-local address was reported like a private one, whose fix is to
  // list its network — but listing those stops the server at start.
  const at = (address: string) =>
    createEgress({
      networks: ['10.1.0.0/16'],
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    })
  const why = async (address: string) =>
    (
      (await at(address)
        .request({ method: 'GET', url: 'https://dest.example/' })
        .catch((e: unknown) => e)) as EgressError
    ).reason
  it('tells a never-allowed address from one an operator may list', async () => {
    for (const address of ['192.0.2.10', '169.254.169.254', 'fe80::1', '::ffff:169.254.169.254'])
      expect(await why(address), address).toBe('address_never')
    for (const address of ['10.0.0.7', '127.0.0.1', '100.64.1.1'])
      expect(await why(address), address).toBe('address_refused')
  })
})
