// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import type { PartialConfig } from '../../src/config'
import { H, makeApp, type TestApp } from '../helpers'
import type { TestMongo } from './mongo'

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** Phase 3d-1: a raw body (an upload), sent as application/octet-stream unless a header says otherwise. */
type Raw = (
  method: Method,
  path: string,
  body: Buffer,
  headers?: Record<string, string>,
) => Promise<LightMyRequestResponse>

export interface DataHarness {
  t: TestApp
  connectionId: string
  call(method: Method, path: string, payload?: unknown): Promise<LightMyRequestResponse>
  raw: Raw
  /** GET an absolute /api/... URL as this caller (routes outside the connection). */
  get(url: string): Promise<LightMyRequestResponse>
  /** The caller's headers, for t.app.inject on absolute URLs. */
  headers: Record<string, string>
  client(): Promise<MongoClient>
}

export async function dataHarness(
  mongo: TestMongo,
  overrides: PartialConfig = {},
  extra: Parameters<typeof makeApp>[1] = {},
): Promise<DataHarness> {
  const t = await makeApp(overrides, extra)
  const connection = t.app.ctx.connections.create(
    {
      name: 'Test',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        serverSelectionTimeoutMS: 3_000,
      }),
    },
    null,
  )
  const headers = { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }
  return {
    t,
    connectionId: connection.id,
    call: (method, path, payload) =>
      t.app.inject({
        method,
        url: `/api/connections/${connection.id}${path}`,
        headers,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      }),
    raw: (method, path, body, extra = {}) =>
      t.app.inject({
        method,
        url: `/api/connections/${connection.id}${path}`,
        headers: { ...headers, 'content-type': 'application/octet-stream', ...extra },
        payload: body,
      }),
    get: (url) => t.app.inject({ method: 'GET', url, headers }),
    headers,
    client: () => t.app.ctx.manager.getClient(connection.id),
  }
}

/**
 * User request 2026-10-24: an administrator signed in, in team mode, on one connection named
 * "Test" — the harness of local mode's equal (the same calls), for someone who sees the values a
 * connection's rules name unless they hide them from themselves (`hide`). Local mode always
 * hides them now.
 */
export async function teamAdminHarness(
  mongo: TestMongo,
  overrides: PartialConfig = {},
): Promise<DataHarness & { userId: string; hide(hidden: boolean): void }> {
  const t = await makeApp({ auth: true, ...overrides })
  const { ctx } = t.app
  const connection = ctx.connections.create(
    {
      name: 'Test',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        serverSelectionTimeoutMS: 3_000,
      }),
    },
    null,
  )
  const user = ctx.users.create({
    username: `root-${randomUUID()}`,
    passwordHash: 'x',
    role: 'admin',
  })
  const { sessionId, session } = ctx.sessions.create(user.id, {})
  const headers = { ...H, 'x-csrf-token': session.csrfToken, cookie: `mm_sid=${sessionId}` }
  return {
    t,
    connectionId: connection.id,
    userId: user.id,
    hide: (hidden) => ctx.personalFields.setHiddenFromSelf(connection.id, user.id, hidden),
    call: (method, path, payload) =>
      t.app.inject({
        method,
        url: `/api/connections/${connection.id}${path}`,
        headers,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      }),
    raw: (method, path, body, extra = {}) =>
      t.app.inject({
        method,
        url: `/api/connections/${connection.id}${path}`,
        headers: { ...headers, 'content-type': 'application/octet-stream', ...extra },
        payload: body,
      }),
    get: (url) => t.app.inject({ method: 'GET', url, headers }),
    headers,
    client: () => ctx.manager.getClient(connection.id),
  }
}

export interface TeamUser {
  id: string
  call(method: Method, path: string, payload?: unknown): Promise<LightMyRequestResponse>
  raw: Raw
  get(url: string): Promise<LightMyRequestResponse>
}

/**
 * Team mode (auth on) with one connection to the test MongoDB: `user(role)` signs a new user in
 * and calls the connection's routes as them. Phase 2a: roles matter to aggregation routes.
 */
export async function teamHarness(
  mongo: TestMongo,
  overrides: PartialConfig = {},
  connection: { readOnly?: boolean } = {},
): Promise<{
  t: TestApp
  connectionId: string
  user(role: 'admin' | 'editor' | 'viewer'): TeamUser
  client(): Promise<MongoClient>
}> {
  const t = await makeApp({ auth: true, ...overrides })
  const { ctx } = t.app
  const created = ctx.connections.create(
    {
      name: 'Team',
      favorite: false,
      readOnly: connection.readOnly ?? false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port: mongo.port }],
        serverSelectionTimeoutMS: 3_000,
      }),
    },
    null,
  )
  return {
    t,
    connectionId: created.id,
    user(role) {
      const user = ctx.users.create({
        username: `u-${role}-${randomUUID()}`,
        passwordHash: 'x',
        role,
      })
      const { sessionId, session } = ctx.sessions.create(user.id, {})
      const headers = { ...H, 'x-csrf-token': session.csrfToken }
      const cookies = { mm_sid: sessionId }
      return {
        id: user.id,
        call: (method, path, payload) =>
          t.app.inject({
            method,
            url: `/api/connections/${created.id}${path}`,
            headers,
            cookies,
            ...(payload !== undefined ? { payload: payload as object } : {}),
          }),
        raw: (method, path, body, extra = {}) =>
          t.app.inject({
            method,
            url: `/api/connections/${created.id}${path}`,
            headers: { ...headers, 'content-type': 'application/octet-stream', ...extra },
            cookies,
            payload: body,
          }),
        get: (url) => t.app.inject({ method: 'GET', url, headers, cookies }),
      }
    },
    client: () => ctx.manager.getClient(created.id),
  }
}
