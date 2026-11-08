// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import selfsigned from 'selfsigned'

let cached: Promise<{ caPem: string; key: string; cert: string }> | null = null
/** One test CA and a server certificate for localhost and 127.0.0.1, made once per test file. */
export function certificates() {
  cached ??= (async () => {
    const ca = await selfsigned.generate([{ name: 'commonName', value: 'Mongo Manager Egress Test CA' }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true },
      ],
    })
    const server = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    })
    return { caPem: ca.cert, key: server.private, cert: server.cert }
  })()
  return cached
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

/** An HTTPS (or plain HTTP) server on 127.0.0.1 with a random port, for egress and adapter tests. */
export async function startHttpsServer(handler: Handler, opts: { plain?: boolean } = {}) {
  const { caPem, key, cert } = await certificates()
  const wrapped = (req: IncomingMessage, res: ServerResponse) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      res.statusCode = 500
      res.end(String(e))
    })
  }
  const server = opts.plain ? createHttp(wrapped) : createHttps({ key, cert }, wrapped)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    caPem,
    // An IP literal: localhost also resolves to ::1, and a name with any refused address is refused.
    url: `${opts.plain ? 'http' : 'https'}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
