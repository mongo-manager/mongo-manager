// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { AccessList, resolveConfig } from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

/**
 * Panel access (2026-10-30): an administrator who left their own address out of the panel's list
 * lets every address in again from the command line.
 */
async function run(argv: string[]) {
  const io = fakeIo()
  return { code: await main(argv, io), io }
}

describe('the access command', () => {
  it('lists the addresses the panel answers, and clears them with an audit row', async () => {
    const dir = tempDir()
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })
    try {
      new AccessList(data.store.db, Date.now).set([
        { range: '203.0.113.0/24', label: 'Office' },
        { range: '192.0.2.1', label: '' },
      ])
    } finally {
      data.close()
    }
    const listed = await run(['access', 'list', '--data-dir', dir])
    expect(listed.code).toBe(0)
    expect(listed.io.out()).toMatch(/203\.0\.113\.0\/24\s+Office/)
    expect(listed.io.out()).toMatch(/192\.0\.2\.1/)
    const cleared = await run(['access', 'clear', '--data-dir', dir])
    expect(cleared.io.out()).toMatch(/Cleared 2 addresses: every address reaches the panel again/)
    expect((await run(['access', 'list', '--data-dir', dir])).io.out()).toMatch(
      /Every address reaches the panel/,
    )
    expect((await run(['access', 'clear', '--data-dir', dir])).io.out()).toMatch(/No list was set/)
    const after = await openData(resolveConfig({ cli: { dataDir: dir } }))
    try {
      expect(new AccessList(after.store.db, Date.now).current()).toEqual([])
      const rows = after.store.db
        .prepare("SELECT username, details FROM audit_log WHERE action = 'users.access' ORDER BY id")
        .all() as Array<{ username: string; details: string }>
      expect(
        rows.map((r) => [r.username, JSON.parse(r.details).cleared, JSON.parse(r.details).removed]),
      ).toEqual([
        ['cli', 2, ['203.0.113.0/24', '192.0.2.1']],
        ['cli', 0, []],
      ])
    } finally {
      after.close()
    }
  })

  it('says when the stored list does not read, and how to clear it', async () => {
    const dir = tempDir()
    const data = await openData(resolveConfig({ cli: { dataDir: dir } }), { create: true })
    try {
      data.store.db
        .prepare(
          'INSERT INTO app_settings (key, value, updated_at) VALUES (\'access.allowlist\', \'{"entries":[{"range":"nope","label":""}]}\', 0)',
        )
        .run()
    } finally {
      data.close()
    }
    const listed = await run(['access', 'list', '--data-dir', dir])
    expect(listed.io.out()).toMatch(
      /does not read: no address reaches the panel\. Run "mongo-manager access clear"/,
    )
  })

  it('refuses what it does not understand', async () => {
    const dir = tempDir()
    expect((await run(['access', 'drop', '--data-dir', dir])).code).toBe(2)
    expect((await run(['access', '--data-dir', dir])).code).toBe(2)
  })
})
