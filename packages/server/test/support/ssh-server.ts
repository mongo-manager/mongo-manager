import net from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import ssh2 from 'ssh2'
import { fingerprintOf } from '../../src/connections/ssh'

const { Server, utils } = ssh2

/**
 * An ed25519 key pair ssh2 can read back: about 3 in 1000 of those it generates cannot be parsed
 * ("Malformed OpenSSH private key"), which made SSH tests fail now and then.
 */
export function sshKeyPair(): { private: string; public: string } {
  for (let i = 0; i < 20; i++) {
    const pair = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair
  }
  throw new Error('could not generate a readable SSH key')
}

export interface TestSshServer {
  port: number
  fingerprint: string
  /** Ends every client session from the server side, like an sshd restart. */
  dropClients(): void
  /** Forwarded channels open now. */
  readonly channels: number
  /** How the next forwards behave: refused, or answered only after a delay. */
  forwarding: { refuse: boolean; delayMs: number }
  close(): Promise<void>
}

/** A real SSH server (ssh2) that accepts one user and forwards direct-tcpip channels. */
export async function startSshServer(opts: {
  password?: string
  publicKey?: string
}): Promise<TestSshServer> {
  const hostKey = sshKeyPair()
  const allowedKey = opts.publicKey ? utils.parseKey(opts.publicKey) : undefined
  const clients = new Set<{ end(): void }>()
  let channels = 0
  const forwarding = { refuse: false, delayMs: 0 }
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'tunnel') return ctx.reject()
      if (ctx.method === 'password' && opts.password && ctx.password === opts.password) return ctx.accept()
      if (ctx.method === 'publickey' && allowedKey && !(allowedKey instanceof Error)) {
        const same =
          ctx.key.algo === allowedKey.type &&
          ctx.key.data.length === allowedKey.getPublicSSH().length &&
          timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH())
        if (same && (!ctx.signature || allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true))
          return ctx.accept()
      }
      return ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const answer = () => {
          if (forwarding.refuse) return reject()
          const channel = accept()
          channels++
          channel.on('close', () => channels--)
          const upstream = net.connect(info.destPort, info.destIP)
          upstream.on('error', () => channel.destroy())
          channel.on('error', () => upstream.destroy())
          channel.pipe(upstream).pipe(channel)
        }
        if (forwarding.delayMs > 0) setTimeout(answer, forwarding.delayMs)
        else answer()
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const publicKey = utils.parseKey(hostKey.public)
  if (publicKey instanceof Error) throw publicKey
  return {
    port: (server.address() as net.AddressInfo).port,
    fingerprint: fingerprintOf(publicKey.getPublicSSH()),
    dropClients: () => {
      for (const c of clients) c.end()
    },
    get channels() {
      return channels
    },
    forwarding,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
