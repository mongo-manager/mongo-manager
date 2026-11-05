// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { SignInBans, resolveConfig } from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

/**
 * Sign-in bans (2026-10-30): an administrator whose own address is banned, with no session left,
 * lifts the ban from the command line — beside a running server too (it reads bans from the store).
 */
async function run(argv: string[]) {
  const io = fakeIo()
  return { code: await main(argv, io), io }
}

async function seed(dir: string, ...ips: string[]) {
  const data = await openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })
  try {
    const bans = new SignInBans(data.store.db, Date.now)
    for (const ip of ips) bans.block(ip, 3_600_000, 'admin')
  } finally {
    data.close()
  }
}

describe('the bans command', () => {
  it('lists the addresses refused at the sign-in, and says when there are none', async () => {
    const dir = tempDir()
    await seed(dir)
    const none = await run(['bans', 'list', '--data-dir', dir])
    expect(none.code).toBe(0)
    expect(none.io.out()).toMatch(/No address is banned/)
    await seed(dir, '203.0.113.7', '2001:db8:1:2::9')
    const { code, io } = await run(['bans', 'list', '--data-dir', dir])
    expect(code).toBe(0)
    expect(io.out()).toMatch(/203\.0\.113\.7\s+manual\s+until /)
    expect(io.out()).toMatch(/2001:db8:1:2::\/64/)
  })

  it('lifts one ban by the address or the one shown, and every ban with --all, auditing each', async () => {
    const dir = tempDir()
    await seed(dir, '203.0.113.7', '2001:db8:1:2::9', '198.51.100.3')
    const one = await run(['bans', 'lift', '203.0.113.7', '--data-dir', dir])
    expect(one.code).toBe(0)
    expect(one.io.out()).toMatch(/Lifted the ban of 203\.0\.113\.7/)
    const shown = await run(['bans', 'lift', '2001:DB8:1:2::/64', '--data-dir', dir])
    expect(shown.io.out()).toMatch(/Lifted the ban of 2001:db8:1:2::\/64/)
    // An ended ban's record of strikes is forgotten too, and said so.
    const data0 = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      new SignInBans(data0.store.db, () => Date.now() - 2 * 3_600_000).block('192.0.2.99', 3_600_000, 'admin')
    } finally {
      data0.close()
    }
    const ended = await run(['bans', 'lift', '192.0.2.99', '--data-dir', dir])
    expect(ended.code).toBe(0)
    expect(ended.io.out()).toMatch(/192\.0\.2\.99 is not banned now; its past bans were forgotten/)
    const none = await run(['bans', 'lift', '192.0.2.200', '--data-dir', dir])
    expect(none.code).toBe(1)
    expect(none.io.err()).toMatch(/192\.0\.2\.200 is not banned/)
    const all = await run(['bans', 'lift', '--all', '--data-dir', dir])
    expect(all.io.out()).toMatch(/Lifted 1 ban/)
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(new SignInBans(data.store.db, Date.now).list()).toEqual({ bans: [], total: 0 })
      const rows = data.store.db
        .prepare("SELECT username, details FROM audit_log WHERE action = 'users.bans.lift' ORDER BY id")
        .all() as Array<{ username: string; details: string }>
      expect(rows.map((r) => [r.username, JSON.parse(r.details)])).toEqual([
        ['cli', expect.objectContaining({ address: '203.0.113.7', lifted: true })],
        ['cli', expect.objectContaining({ address: '2001:db8:1:2::/64', lifted: true })],
        ['cli', expect.objectContaining({ address: '192.0.2.99', lifted: false, outcome: 'forgotten' })],
        ['cli', expect.objectContaining({ all: true, lifted: 1 })],
      ])
    } finally {
      data.close()
    }
  })

  it('refuses what it does not understand', async () => {
    const dir = tempDir()
    expect((await run(['bans', 'lift', '--data-dir', dir])).code).toBe(2)
    expect((await run(['bans', 'lift', 'not-an-address', '--data-dir', dir])).code).toBe(2)
    expect((await run(['bans', 'drop', '--data-dir', dir])).code).toBe(2)
    expect((await run(['bans', 'list', '--all', '--data-dir', dir])).code).toBe(2)
    expect((await run(['bans', 'lift', '203.0.113.7', '--all', '--data-dir', dir])).code).toBe(2)
  })
})
