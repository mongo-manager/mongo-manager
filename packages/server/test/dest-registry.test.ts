import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEgress } from '../src/net/egress'
import { adapterFor, testDestination } from '../src/backup/destinations/registry'
import type { DestinationRecord } from '../src/backup/destinations/repo'
import { backupLimits } from '../src/backup/limits'
import { resolveConfig } from '../src/config'
import { startFakeS3, type FakeS3 } from './support/fake-s3'

let s3: FakeS3
let base: string
beforeAll(async () => {
  s3 = await startFakeS3()
  base = mkdtempSync(join(tmpdir(), 'mm-reg-'))
  mkdirSync(join(base, 'root'))
})
afterAll(async () => {
  await s3?.close()
  if (base) rmSync(base, { recursive: true, force: true })
})
const record = (type: DestinationRecord['type'], config: Record<string, unknown>): DestinationRecord => ({
  id: '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6',
  name: 'x',
  type,
  config,
  policy: { encryptedOnly: true },
  status: { state: 'unknown', checkedAt: null },
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  secretFields: [],
})
function deps(networks: string[]) {
  const config = resolveConfig({
    cli: { dataDir: join(base, 'data') },
    env: { MM_BACKUP_FOLDER_ROOTS: join(base, 'root') },
  })
  return {
    egress: createEgress({ networks }),
    googleHosts: { oauth: 'https://x', api: 'https://x', upload: 'https://x' },
    limits: backupLimits(config),
    dataDir: join(base, 'data'),
    now: () => Date.now(),
    tokens: new Map(),
    saveStatus: () => undefined,
  }
}
const s3Config = () => ({
  preset: 'minio',
  endpoint: s3.url,
  region: 'us-east-1',
  bucket: 'mm-test',
  prefix: 'p',
  pathStyle: true,
  storageClass: 'STANDARD',
  sse: { kind: 'none' },
  caPem: s3.caPem,
})
const signal = new AbortController().signal

describe('destination test (phase 3d-3b spec §1.2, D2; plan ruling 11)', () => {
  it('passes every step on a working S3 and leaves no probe behind', async () => {
    const d = deps(['127.0.0.1/32'])
    const a = adapterFor(record('s3', s3Config()), s3.credentials, d)
    const out = await testDestination(a, 'p', d, signal)
    expect(out.steps.map((s) => [s.step, s.ok])).toEqual([
      ['resolve', true],
      ['connect', true],
      ['auth', true],
      ['write', true],
      ['read', true],
      ['delete', true],
    ])
    expect([...s3.objects.keys()].filter((k) => k.includes('.probe-'))).toEqual([])
  })

  it('stops at the first failure and says why', async () => {
    const d = deps(['127.0.0.1/32'])
    const a = adapterFor(
      record('s3', s3Config()),
      { ...s3.credentials, secretAccessKey: 'wrong-secret-value' },
      d,
    )
    const out = await testDestination(a, 'p', d, signal)
    expect(out.steps.find((s) => s.step === 'auth')).toMatchObject({ ok: false, reason: 'auth' })
    expect(
      out.steps
        .filter((s) => ['write', 'read', 'delete'].includes(s.step))
        .every((s) => !s.ok && s.reason === 'skipped'),
    ).toBe(true)
  })

  it('fails the resolve step for a refused address', async () => {
    const d = deps([])
    const out = await testDestination(adapterFor(record('s3', s3Config()), s3.credentials, d), 'p', d, signal)
    expect(out.steps[0]).toMatchObject({ step: 'resolve', ok: false, reason: 'address_refused' })
  })

  it('tests a folder without network steps', async () => {
    const d = deps([])
    const out = await testDestination(
      adapterFor(record('folder', { path: join(base, 'root', 'mm') }), {}, d),
      '',
      d,
      signal,
    )
    expect(out.steps.slice(0, 2)).toEqual([
      { step: 'resolve', ok: true, ms: null, reason: 'local' },
      { step: 'connect', ok: true, ms: null, reason: 'local' },
    ])
    expect(out.steps.every((s) => s.ok)).toBe(true)
  })

  it('refuses to build an adapter without its secrets', () => {
    expect(() => adapterFor(record('s3', s3Config()), {}, deps([]))).toThrow(/credentials|secrets/)
  })
})
