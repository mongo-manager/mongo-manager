// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MongoMemoryServer } from 'mongodb-memory-server'

export interface TestMongo {
  host: string
  port: number
  stop(): Promise<void>
}

export async function startMongo(
  opts: {
    auth?: { user: string; password: string }
    args?: string[]
    /** A MongoDB version other than the run's (MONGOMS_VERSION): two servers of different versions. */
    version?: string
  } = {},
): Promise<TestMongo> {
  const server = await MongoMemoryServer.create({
    instance: { args: opts.args ?? [] },
    ...(opts.version ? { binary: { version: opts.version } } : {}),
    ...(opts.auth
      ? { auth: { enable: true, customRootName: opts.auth.user, customRootPwd: opts.auth.password } }
      : {}),
  })
  const url = new URL(server.getUri())
  return { host: url.hostname, port: Number(url.port), stop: async () => void (await server.stop()) }
}
