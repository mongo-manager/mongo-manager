// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { MongoClient } from 'mongodb'
import { ConnectionError, classifyError } from '../connections/errors'
import { isRefusal, type ConnectionManager } from '../connections/manager'

/**
 * The connection's client a shell is planned with (its topology, its tunnel): none when the server
 * is out of reach for now, the shell saying so itself. A sign-in the server refused, kept or met
 * now, is not: no shell opens, so it does not sign in again (fifth review of the unreachable fix,
 * I1: its proxy signed in on every socket its worker's driver opened).
 */
export async function shellClient(
  manager: ConnectionManager,
  connectionId: string,
): Promise<MongoClient | undefined> {
  // Sixth review (I1): its client may still be open (signed in before the password changed).
  const kept = manager.refusalOf(connectionId)
  if (kept) throw new ConnectionError(kept.kind, kept.message, kept.fingerprint, true)
  try {
    return await manager.getClient(connectionId)
  } catch (e) {
    const failure = classifyError(e)
    // A kept refusal is said again as the one kept, of the same kind.
    if (isRefusal(failure)) throw failure
    return undefined
  }
}

/**
 * Sixth review (I1, SSH): the shell's own tunnel signs in to SSH for each session; a refusal met
 * while planning is kept for the connection as its clients' would be.
 */
export async function keepingRefusal<T>(
  manager: ConnectionManager,
  connectionId: string,
  plan: () => Promise<T>,
): Promise<T> {
  try {
    return await plan()
  } catch (e) {
    const failure = classifyError(e)
    if (isRefusal(failure)) manager.noteRefusal(connectionId, failure)
    throw e
  }
}
