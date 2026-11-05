// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { SignInBans, banTarget, type Config } from '@mongo-manager/server'
import { UsageError, type Values } from '../args'
import { openData } from '../data'
import type { Io } from '../io'

/**
 * Sign-in bans (2026-10-30): the addresses refused at the team-mode sign-in, and lifting them — the
 * way back in for an administrator whose own address is banned and who has no session left. Bans
 * are read from the store on every sign-in, so a lift holds at once beside a running server (its
 * throttle may still hold the address back for some minutes).
 */
export async function bansCommand(
  positionals: string[],
  values: Values,
  config: Config,
  io: Io,
): Promise<number> {
  const [sub, target] = positionals
  if (sub !== 'list' && sub !== 'lift')
    throw new UsageError(`Unknown bans command "${sub}" (use list or lift)`)
  if (sub === 'list' && (target !== undefined || values.all))
    throw new UsageError('"bans list" takes nothing more')
  if (sub === 'lift' && !target === !values.all)
    throw new UsageError('"bans lift" needs an address, or --all for every ban')
  const address = target === undefined ? null : banTarget(target)
  if (target !== undefined && !address) throw new UsageError(`"${target}" is not an IP address`)

  const data = await openData(config, { io })
  try {
    const bans = new SignInBans(data.store.db, Date.now)
    if (sub === 'list') {
      const { bans: rows, total } = bans.list()
      if (rows.length === 0) io.stdout.write('No address is banned.\n')
      for (const b of rows)
        io.stdout.write(
          `${b.address.padEnd(24)} ${b.reason === 'manual' ? 'manual ' : 'sign-in'} until ${new Date(b.until).toISOString()}  strikes ${b.strikes}${b.by ? `  by ${b.by}` : ''}\n`,
        )
      if (total > rows.length) io.stdout.write(`… and ${total - rows.length} more.\n`)
      return 0
    }
    const audit = (details: Record<string, unknown>) =>
      data.audit.append({
        action: 'users.bans.lift',
        outcome: 'success',
        userId: null,
        username: 'cli',
        ip: null,
        details: { ...details, via: 'cli' },
      })
    if (!address) {
      // Every ban, and every record of past ones (their strikes) with them.
      const count = bans.liftAll()
      audit({ all: true, lifted: count })
      io.stdout.write(`Lifted ${count} ban${count === 1 ? '' : 's'}.\n`)
      return 0
    }
    const outcome = bans.lift(address)
    if (outcome === 'none') {
      io.stderr.write(`Error: ${address} is not banned\n`)
      return 1
    }
    audit({ address, lifted: outcome === 'lifted', outcome })
    io.stdout.write(
      outcome === 'lifted'
        ? `Lifted the ban of ${address}.\n`
        : `${address} is not banned now; its past bans were forgotten.\n`,
    )
    return 0
  } finally {
    data.close()
  }
}
