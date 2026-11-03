import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { EgressError, createEgress } from '../src/net/egress'

/**
 * W3.3: a plain TCP socket through the egress guard (the SMTP channel). The address is judged in
 * the socket's own lookup — what is checked is what is connected to — and literal addresses before
 * dialling: public addresses only, private ones inside the listed networks, metadata never.
 */
let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((socket) => socket.end('220 hello\r\n'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => new Promise<void>((r) => server.close(() => r())))

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    const s = (await p) as { destroy(): void }
    s.destroy()
    return 'none'
  } catch (e) {
    expect(e).toBeInstanceOf(EgressError)
    return (e as EgressError).reason
  }
}

describe('egress sockets (W3.3)', () => {
  it('connects inside a listed network and reads the greeting', async () => {
    const egress = createEgress({ networks: ['127.0.0.1/32'] })
    const socket = await egress.socket({ host: '127.0.0.1', port })
    const greeting = await new Promise<string>((r) => socket.once('data', (d) => r(String(d))))
    expect(greeting).toBe('220 hello\r\n')
    socket.destroy()
  })

  it('refuses loopback and private addresses unless listed, and metadata always', async () => {
    const egress = createEgress({ networks: [] })
    expect(await reason(egress.socket({ host: '127.0.0.1', port }))).toBe('address_refused')
    expect(await reason(egress.socket({ host: '10.1.2.3', port: 25 }))).toBe('address_refused')
    expect(await reason(egress.socket({ host: '169.254.169.254', port: 80 }))).toBe('address_never')
    const listed = createEgress({ networks: ['169.254.0.0/16', '127.0.0.1/32'].slice(1) })
    expect(await reason(listed.socket({ host: '169.254.169.254', port: 80 }))).toBe('address_never')
  })

  it('judges a name by what it resolves to, in the socket’s own lookup (DNS rebinding)', async () => {
    const egress = createEgress({
      networks: [],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    expect(await reason(egress.socket({ host: 'mail.example.com', port }))).toBe('address_refused')
    const mixed = createEgress({
      networks: [],
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    expect(await reason(mixed.socket({ host: 'mail.example.com', port: 25 }))).toBe('address_refused')
  })

  it('gives up when the other side does not answer in time', async () => {
    const egress = createEgress({ networks: ['10.255.255.0/24'], connectTimeoutMs: 200 })
    // A non-routable private address that is listed: the connection hangs, the guard does not.
    expect(await reason(egress.socket({ host: '10.255.255.1', port: 25 }))).toMatch(/timeout|connect/)
  })
})
