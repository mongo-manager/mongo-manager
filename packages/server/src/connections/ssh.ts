// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import net from 'node:net'
import { createHash } from 'node:crypto'
import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2'
import { ConnectionError } from './errors'
import type { OpenTunnel } from './manager'
import { acceptSocks, newSocksCredentials } from './socks'

/** Handshakes under way at once; more are refused (review of the deferred fixes, M3). */
const MAX_HANDSHAKES = 32

const { Client } = ssh2

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * Opens an SSH session and a local 127.0.0.1 listener that forwards to target through it.
 * With a pinned fingerprint, any other host key aborts the handshake (spec §4.4, TOFU).
 * The listener forwards only a SOCKS5 client with this tunnel's own credentials (socks.ts).
 * A stop (`opts.signal`) ends the handshake at once, with the signal's reason.
 */
export const openSshTunnel: OpenTunnel = async (ssh, target, opts = {}) => {
  const { signal } = opts
  signal?.throwIfAborted()
  const client = new Client()
  let fingerprint = ''
  let mismatch = false
  // Review of the open's stop (minor 5): a host that does not answer held the handshake for its
  // ready timeout, and with it an edit of the connection.
  let stopped: (() => void) | undefined
  await new Promise<void>((resolve, reject) => {
    stopped = () => {
      client.destroy()
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', stopped, { once: true })
    client.once('ready', () => resolve())
    client.once('error', (e) => {
      reject(
        mismatch
          ? new ConnectionError(
              'ssh-host-key',
              `The SSH server's host key changed: expected ${ssh.hostFingerprint}, got ${fingerprint}. ` +
                'If the server was reinstalled, clear the saved fingerprint and connect again.',
              fingerprint,
            )
          : new ConnectionError('ssh', `SSH connection failed: ${e.message}`),
      )
    })
    const config: ConnectConfig = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      readyTimeout: opts.readyTimeoutMs ?? 10_000,
      hostVerifier: (key: Buffer) => {
        fingerprint = fingerprintOf(key)
        if (ssh.hostFingerprint && ssh.hostFingerprint !== fingerprint) {
          mismatch = true
          return false
        }
        return true
      },
    }
    if (ssh.method === 'password') config.password = ssh.password ?? ''
    else {
      config.privateKey = ssh.privateKey ?? ''
      if (ssh.passphrase) config.passphrase = ssh.passphrase
    }
    client.connect(config)
  }).finally(() => signal?.removeEventListener('abort', stopped!))

  const credentials = newSocksCredentials()
  let handshakes = 0
  const sockets = new Set<net.Socket>()
  const listeners = new Set<() => void>()
  let down = false
  // Any end of the SSH session (error, clean close, sshd restart) tears the tunnel down exactly once.
  const shutdown = () => {
    if (down) return
    down = true
    for (const socket of sockets) socket.destroy()
    server.close()
    client.end()
    for (const listener of listeners) listener()
  }

  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    if (down) {
      socket.destroy()
      return
    }
    // Any program on the machine can connect: only so many may be half-way through at once.
    if (handshakes >= MAX_HANDSHAKES) {
      socket.destroy()
      return
    }
    handshakes++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const forward = () =>
      new Promise<ClientChannel>((resolve, reject) => {
        if (down) return reject(new Error('the tunnel is closed'))
        try {
          client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) =>
            err ? reject(err) : resolve(stream),
          )
        } catch (e) {
          // ssh2 throws synchronously ("Not connected") once the session is gone.
          shutdown()
          reject(e as Error)
        }
      })
    acceptSocks(socket, credentials, forward)
      .then(
        (stream) => {
          // The client may have gone while the channel opened: close the channel with it (M4).
          if (socket.destroyed || down) {
            stream.destroy()
            socket.destroy()
            return
          }
          stream.on('error', () => socket.destroy())
          socket.on('close', () => stream.destroy())
          socket.pipe(stream).pipe(socket)
          socket.resume()
        },
        // A client without the tunnel's credentials, or whose channel failed, was answered and
        // closed by acceptSocks.
        () => undefined,
      )
      .finally(() => handshakes--)
  })
  server.on('error', () => undefined)
  client.on('error', shutdown)
  client.on('end', shutdown)
  client.on('close', shutdown)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  let closed: Promise<void> | undefined
  return {
    localPort: (server.address() as net.AddressInfo).port,
    credentials,
    fingerprint,
    onClose: (listener) => {
      if (down) listener()
      else listeners.add(listener)
    },
    close: () =>
      (closed ??= new Promise<void>((resolve) => {
        if (!server.listening) {
          shutdown()
          resolve()
          return
        }
        server.once('close', () => resolve())
        shutdown()
      })),
  }
}
