import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createEgress, type LookupFn } from '../src/net/egress'

/**
 * W4 item 5: a plain TCP connection through the egress guard (an SFTP destination's SSH session). The
 * address is resolved and judged as for https, and a proxy, when one is set, is asked to CONNECT to
 * that judged address — never to a name.
 */
let echo: Server
let echoPort: number
let proxy: Server
let proxyPort: number
const connects: string[] = []
const sockets = new Set<Socket>()
beforeAll(async () => {
  echo = createServer((s) => {
    sockets.add(s)
    s.pipe(s)
  })
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as AddressInfo).port
  proxy = createServer((client) => {
    sockets.add(client)
    let head = ''
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      client.off('data', onData)
      connects.push(head.slice(0, head.indexOf('\r\n')))
      // Whatever was asked, the test tunnels to the echo server.
      const up = connect(echoPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        up.pipe(client)
        client.pipe(up)
      })
      sockets.add(up)
      up.on('error', () => client.destroy())
      client.on('error', () => up.destroy())
    }
    client.on('data', onData)
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  proxyPort = (proxy.address() as AddressInfo).port
})
afterAll(async () => {
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => echo.close(() => r()))
  await new Promise<void>((r) => proxy.close(() => r()))
})

async function roundTrip(s: Socket): Promise<string> {
  s.write('ping')
  const got = await new Promise<Buffer>((r) => s.once('data', r))
  s.destroy()
  return got.toString()
}
const publicLookup =
  (address: string): LookupFn =>
  async () => [{ address, family: 4 }]

describe('TCP through the egress guard (W4.5)', () => {
  it('connects to a listed private address directly, and says how long it took', async () => {
    const egress = createEgress({ networks: ['127.0.0.1/32'] })
    let timing: { address: string; resolveMs: number } | null = null
    const out = await egress.socket({ host: '127.0.0.1', port: echoPort, onTiming: (t) => (timing = t) })
    expect(timing).toMatchObject({ address: '127.0.0.1' })
    expect(timing!.resolveMs).toBeGreaterThanOrEqual(0)
    expect(await roundTrip(out)).toBe('ping')
  })

  it('refuses a private address that is not listed, and a metadata address always', async () => {
    const egress = createEgress({ networks: [] })
    await expect(egress.socket({ host: '127.0.0.1', port: echoPort })).rejects.toMatchObject({
      reason: 'address_refused',
    })
    const meta = createEgress({ networks: ['169.254.0.0/16'], lookup: publicLookup('169.254.169.254') })
    await expect(meta.socket({ host: 'sftp.example', port: 22 })).rejects.toMatchObject({
      reason: 'address_never',
    })
    // A name with one bad address among good ones is refused (DNS rebinding).
    const mixed = createEgress({
      networks: [],
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    await expect(mixed.socket({ host: 'sftp.example', port: 22 })).rejects.toMatchObject({
      reason: 'address_refused',
    })
  })

  it('goes through the proxy to the judged address, never a name', async () => {
    const egress = createEgress({
      networks: ['127.0.0.1/32'],
      lookup: publicLookup('93.184.216.34'),
      proxy: `http://127.0.0.1:${proxyPort}`,
      connectTimeoutMs: 500,
    })
    connects.length = 0
    // Without asking for it, no proxy: the alert channels never use MM_BACKUP_PROXY (W4.5, W3.3).
    await expect(egress.socket({ host: 'sftp.example', port: 2222 })).rejects.toBeTruthy()
    expect(connects).toEqual([])
    const out = await egress.socket({ host: 'sftp.example', port: 2222, viaProxy: true })
    expect(connects).toEqual(['CONNECT 93.184.216.34:2222 HTTP/1.1'])
    expect(await roundTrip(out)).toBe('ping')
  })

  // W4 review (minor): every address a name resolves to is tried in turn.
  it('tries the next judged address when the first does not answer', async () => {
    const egress = createEgress({
      networks: ['127.0.0.1/32', '10.255.255.0/24'],
      connectTimeoutMs: 300,
      lookup: async () => [
        { address: '10.255.255.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })
    expect(await roundTrip(await egress.socket({ host: 'sftp.example', port: echoPort }))).toBe('ping')
  })

  it('refuses a bad port, and stops when asked', async () => {
    const egress = createEgress({ networks: ['127.0.0.1/32'] })
    for (const port of [0, 65_536, 1.5])
      await expect(egress.socket({ host: '127.0.0.1', port })).rejects.toMatchObject({ reason: 'bad_url' })
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      egress.socket({ host: '127.0.0.1', port: echoPort, signal: ctl.signal }),
    ).rejects.toMatchObject({
      reason: 'aborted',
    })
  })
})
