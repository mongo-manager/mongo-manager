// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEgress } from '../src/net/egress'
import {
  DRIVE_SCOPE,
  GoogleTokens,
  parseServiceAccountKey,
  pollDeviceFlow,
  serviceAccountAssertion,
  startDeviceFlow,
} from '../src/backup/destinations/google-auth'
import { DeviceFlows } from '../src/backup/destinations/device-flows'
import { startFakeGoogle, type FakeGoogle } from './support/fake-google'

let g: FakeGoogle
const egress = createEgress({ networks: ['127.0.0.1/32'] })
const signal = new AbortController().signal
beforeAll(async () => {
  g = await startFakeGoogle()
})
afterAll(async () => g?.close())

describe('Google sign-in (phase 3d-3b spec §2.4, D9)', () => {
  it('runs the device flow: pending, slow down, approved', async () => {
    const start = await startDeviceFlow(egress, g.hosts, 'client-id-0001.apps.googleusercontent.com', signal)
    expect(start).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://www.google.com/device',
      interval: 5,
    })
    g.device.answers.push('authorization_pending', 'slow_down', 'approved')
    const input = {
      clientId: 'client-id-0001.apps.googleusercontent.com',
      clientSecret: 'client-secret-1',
      deviceCode: start.deviceCode,
    }
    expect((await pollDeviceFlow(egress, g.hosts, input, signal)).state).toBe('pending')
    expect((await pollDeviceFlow(egress, g.hosts, input, signal)).state).toBe('slow_down')
    const done = await pollDeviceFlow(egress, g.hosts, input, signal)
    expect(done).toMatchObject({ state: 'approved', refreshToken: '1//refresh-1' })
  })

  it('reports denial, expiry and a wrong client', async () => {
    const input = {
      clientId: 'client-id-0001.apps.googleusercontent.com',
      clientSecret: 'client-secret-1',
      deviceCode: 'dc-1',
    }
    g.device.answers.push('access_denied', 'expired_token')
    expect((await pollDeviceFlow(egress, g.hosts, input, signal)).state).toBe('denied')
    expect((await pollDeviceFlow(egress, g.hosts, input, signal)).state).toBe('expired')
    await expect(
      pollDeviceFlow(egress, g.hosts, { ...input, clientSecret: 'nope' }, signal),
    ).rejects.toMatchObject({ reason: 'auth' })
    await expect(startDeviceFlow(egress, g.hosts, 'bad-client-id', signal)).rejects.toMatchObject({
      reason: 'auth',
    })
  })

  it('refreshes and caches access tokens, and asks to reconnect when revoked', async () => {
    let t = 0
    const tokens = new GoogleTokens({
      egress,
      hosts: g.hosts,
      source: {
        kind: 'oauth',
        clientId: 'cid-00000001',
        clientSecret: 'client-secret-1',
        refreshToken: '1//refresh-1',
      },
      now: () => t,
    })
    const a = await tokens.token(signal)
    expect(await tokens.token(signal)).toBe(a)
    t = 3_600_000
    expect(await tokens.token(signal)).not.toBe(a)
    g.revoked.add('1//refresh-1')
    tokens.invalidate()
    await expect(tokens.token(signal)).rejects.toMatchObject({ reason: 'reconnect' })
    g.revoked.clear()
  })

  it('signs a service-account assertion Google accepts', async () => {
    const key = parseServiceAccountKey(
      JSON.stringify({ type: 'service_account', project_id: 'p', ...g.serviceKey }),
    )
    expect(Object.keys(key).sort()).toEqual(['client_email', 'private_key', 'private_key_id', 'token_uri'])
    const jwt = serviceAccountAssertion(key, DRIVE_SCOPE, Date.UTC(2026, 9, 3))
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())
    expect(claims).toMatchObject({
      iss: key.client_email,
      scope: DRIVE_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      exp: claims.iat + 3600,
    })
    const tokens = new GoogleTokens({
      egress,
      hosts: g.hosts,
      source: { kind: 'serviceAccount', key },
      now: () => Date.now(),
    })
    expect(await tokens.token(signal)).toMatch(/^ya29\./)
  })

  it('refuses a service-account key that points elsewhere or is not one', () => {
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ ...g.serviceKey, type: 'service_account', token_uri: 'https://evil.example/token' }),
      ),
    ).toThrow()
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow()
    expect(() => parseServiceAccountKey('not json')).toThrow()
  })

  it('keeps device flows per administrator, at most five, for fifteen minutes', () => {
    let now = 0
    const flows = new DeviceFlows(() => now)
    const base = {
      clientId: 'c',
      clientSecret: 's',
      deviceCode: 'd',
      userCode: 'U',
      verificationUrl: 'https://www.google.com/device',
      interval: 5,
    }
    const f = flows.add('admin-1', { ...base, expiresAt: 900_000 })
    expect(flows.get('admin-2', f.id)).toBeUndefined()
    expect(flows.get('admin-1', f.id)?.userCode).toBe('U')
    expect(() => flows.take('admin-1', f.id)).toThrow(/approved/)
    f.state = 'approved'
    f.refreshToken = 'rt'
    expect(flows.take('admin-1', f.id).refreshToken).toBe('rt')
    expect(flows.get('admin-1', f.id)).toBeUndefined()
    for (let i = 0; i < 5; i++) flows.add('admin-1', { ...base, expiresAt: 900_000 })
    expect(() => flows.add('admin-3', { ...base, expiresAt: 900_000 })).toThrow(/five|5/i)
    now = 900_001
    expect(() => flows.add('admin-3', { ...base, expiresAt: 1_800_000 })).not.toThrow()
  })
})
