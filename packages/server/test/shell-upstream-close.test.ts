import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { openUpstream } from '../src/shell/proxy/upstream'
import { FrameSplitter, OP_MSG, encodeFrame, encodeOpMsg } from '../src/shell/proxy/wire'

// Review of the deferred fixes (M5): an upstream whose handshake or sign-in failed stayed open — over
// SSH, an SSH channel too, one more for every failed shell start.
const servers: net.Server[] = []
const accepted: net.Socket[] = []
afterEach(async () => {
  // A connection the client left open would hold close() for ever: end them here.
  for (const s of accepted.splice(0)) s.destroy()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

/** A server that answers every command with { ok: 0 }, and reports when the client closes. */
async function refusing(): Promise<{ port: number; closed: Promise<void> }> {
  let onClosed: () => void = () => undefined
  const closed = new Promise<void>((r) => (onClosed = r))
  const server = net.createServer((socket) => {
    const frames = new FrameSplitter()
    accepted.push(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => onClosed())
    socket.on('data', (chunk: Buffer) => {
      for (const frame of frames.push(chunk)) {
        const body = encodeOpMsg({ flags: 0, command: { ok: 0, errmsg: 'refused', code: 18 }, sequences: [] })
        socket.write(encodeFrame({ requestID: 1, responseTo: frame.requestID, opCode: OP_MSG, body }))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as net.AddressInfo).port, closed }
}

const settings = (auth: object) =>
  ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }], auth })

describe('an upstream that cannot be used', () => {
  it('is closed when the handshake fails', async () => {
    const { port, closed } = await refusing()
    await expect(
      openUpstream(settings({ mechanism: 'none' }), '127.0.0.1', port, { appName: 't', tls: null }),
    ).rejects.toThrow(/handshake failed/)
    await expect(
      Promise.race([closed, new Promise((_, no) => setTimeout(() => no(new Error('still open')), 1_000))]),
    ).resolves.toBeUndefined()
  })
})
