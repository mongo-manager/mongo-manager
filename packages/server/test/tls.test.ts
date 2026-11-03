import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { ConnectionManager } from '../src/connections/manager'
import { startTlsMongo } from './support/tls'

let mongo: Awaited<ReturnType<typeof startTlsMongo>>
beforeAll(async () => {
  mongo = await startTlsMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

const manager = new ConnectionManager({ load: () => undefined })
const tlsSettings = (tls: object) =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: 'localhost', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
    tls: { enabled: true, ...tls },
  })

describe('TLS connections', () => {
  it('connects with the pasted CA certificate', async () => {
    expect(await manager.test(tlsSettings({ caPem: mongo.caPem }))).toMatchObject({ ok: true })
  })

  it('reports an untrusted certificate as a TLS error', async () => {
    expect(await manager.test(tlsSettings({}))).toMatchObject({ ok: false, error: { kind: 'tls' } })
  })

  it('connects when the user explicitly allows invalid certificates', async () => {
    expect(await manager.test(tlsSettings({ allowInvalidCertificates: true }))).toMatchObject({ ok: true })
  })

  it('connects with a pasted client certificate the server does not require', async () => {
    expect(
      await manager.test(tlsSettings({ caPem: mongo.caPem, certificateKeyPem: mongo.clientPem })),
    ).toMatchObject({ ok: true })
  })
})

// Review 2026-10-17 (minor 2): the server above takes connections with no certificate, so it could
// not tell one was presented. This one refuses them.
describe('TLS connections to a server that requires a client certificate', () => {
  let strict: Awaited<ReturnType<typeof startTlsMongo>>
  beforeAll(async () => {
    strict = await startTlsMongo({ requireClientCertificate: true })
  })
  afterAll(async () => {
    await strict?.stop()
  })
  const strictSettings = (tls: object) =>
    ConnectionSettingsSchema.parse({
      hosts: [{ host: 'localhost', port: strict.port }],
      serverSelectionTimeoutMS: 3_000,
      tls: { enabled: true, caPem: strict.caPem, ...tls },
    })

  // One test, the certificate the only difference: the refusal is for the missing certificate (its
  // error is a reset on Windows, an alert elsewhere), not a port, the CA or a timeout (second review
  // 2026-10-17, minor 4).
  it('is refused without one, and presents the certificate and key pasted run together', async () => {
    expect(await manager.test(strictSettings({}))).toMatchObject({ ok: false })
    expect(strict.clientPem).toMatch(/-----END CERTIFICATE----------BEGIN /)
    expect(await manager.test(strictSettings({ certificateKeyPem: strict.clientPem }))).toMatchObject({
      ok: true,
    })
  })
})
