// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import { startMongo, type TestMongo } from './mongo'

const pemFile = (...blocks: string[]): string => blocks.map((b) => `${b.trim()}\n`).join('')

/**
 * A CA bundle as people paste it: an unrelated CA first, the one that signed the server second, with
 * no line between them. OpenSSL stops at the first END line run into a BEGIN, so none of it was
 * trusted (review 2026-10-17, minor 1).
 */
export async function pastedBundle(caPem: string): Promise<string> {
  const other = await selfsigned.generate([{ name: 'commonName', value: 'Another CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }],
  })
  return `${other.cert.trim()}${caPem.trim()}`
}

/**
 * A mongod speaking TLS with a certificate from a test CA. `requireClientCertificate` makes it refuse
 * a client that presents none, so a test can tell a certificate was presented.
 */
export async function startTlsMongo(
  options: { requireClientCertificate?: boolean } = {},
): Promise<TestMongo & { caPem: string; clientPem: string }> {
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'Mongo Manager Test CA' }], {
    notAfterDate: new Date(Date.now() + 86_400_000),
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ],
  })
  const signedBy = { ca: { key: ca.private, cert: ca.cert } }
  const server = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    notAfterDate: new Date(Date.now() + 86_400_000),
    keySize: 2048,
    ...signedBy,
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
  const client = await selfsigned.generate([{ name: 'commonName', value: 'mm-client' }], {
    notAfterDate: new Date(Date.now() + 86_400_000),
    keySize: 2048,
    ...signedBy,
  })
  const dir = mkdtempSync(join(tmpdir(), 'mm-tls-'))
  // One block per line: OpenSSL on Linux refuses blocks run together ("bad end line"); Windows took them.
  writeFileSync(join(dir, 'server.pem'), pemFile(server.cert, server.private))
  writeFileSync(join(dir, 'ca.pem'), ca.cert)
  const mongo = await startMongo({
    args: [
      '--tlsMode',
      'preferTLS',
      '--tlsCertificateKeyFile',
      join(dir, 'server.pem'),
      '--tlsCAFile',
      join(dir, 'ca.pem'),
      ...(options.requireClientCertificate ? [] : ['--tlsAllowConnectionsWithoutCertificates']),
    ],
  })
  // The client certificate and key as people paste them, run together: the driver mends them.
  return { ...mongo, caPem: ca.cert, clientPem: `${client.cert.trim()}${client.private.trim()}` }
}
