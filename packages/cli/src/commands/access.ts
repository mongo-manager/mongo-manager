// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AccessList, type Config } from '@mongo-manager/server'
import { UsageError } from '../args'
import { openData } from '../data'
import type { Io } from '../io'

/**
 * Panel access (2026-10-30): the addresses the team-mode panel answers, and clearing them — the way
 * back in for an administrator who left their own address out. A running server reads the list
 * again within seconds.
 */
export async function accessCommand(positionals: string[], config: Config, io: Io): Promise<number> {
  const [sub] = positionals
  if (sub !== 'list' && sub !== 'clear')
    throw new UsageError(`Unknown access command "${sub}" (use list or clear)`)
  const data = await openData(config, { io })
  try {
    const list = new AccessList(data.store.db, Date.now)
    const entries = list.current()
    if (sub === 'list') {
      if (list.broken()) {
        io.stdout.write(
          'The stored list does not read: no address reaches the panel. Run "mongo-manager access clear".\n',
        )
        return 0
      }
      if (entries.length === 0) io.stdout.write('Every address reaches the panel (no list is set).\n')
      for (const e of entries) io.stdout.write(`${e.range.padEnd(44)} ${e.label}\n`)
      return 0
    }
    list.set([])
    data.audit.append({
      action: 'users.access',
      outcome: 'success',
      userId: null,
      username: 'cli',
      ip: null,
      details: { ranges: [], cleared: entries.length, removed: entries.map((e) => e.range), via: 'cli' },
    })
    io.stdout.write(
      entries.length === 0
        ? 'No list was set: every address already reaches the panel.\n'
        : `Cleared ${entries.length} address${entries.length === 1 ? '' : 'es'}: every address reaches the panel again.\n`,
    )
    return 0
  } finally {
    data.close()
  }
}
