// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MongoClient } from 'mongodb'
import { currentOps } from '../jobs/current-op'
import { AppError } from '../errors'

/** Kills every operation whose command carries this comment. Best effort: missing privileges → 0. */
export async function killByComment(client: MongoClient, comment: string): Promise<number> {
  const admin = client.db('admin')
  // Every user's operations when the account may list them, else its own, which it may always kill
  // (final review I3: least-privilege accounts could not cancel their own copies).
  const ops = await currentOps(client, { 'command.comment': comment })
  let killed = 0
  for (const op of ops) {
    try {
      await admin.command({ killOp: 1, op: op.opid })
      killed++
    } catch {
      // already finished
    }
  }
  return killed
}

/**
 * The HTTP client went away. The request itself is destroyed once its body was read: the response
 * and the socket tell (the socket first, before the response is closed).
 */
export const clientGone = (request: FastifyRequest, reply: FastifyReply): boolean =>
  reply.raw.destroyed || request.raw.socket?.destroyed === true

/**
 * Tags the request's MongoDB operations and kills them if the HTTP client goes away before the
 * response is written (spec §4.6). Returns the comment to pass to the driver.
 */
export function trackOperation(request: FastifyRequest, reply: FastifyReply, client: MongoClient): string {
  const comment = `mm:${request.id}`
  // Independent review of the security pass (I2): a client that left while the operation was still
  // on its way (connecting, being checked) gets none started: it would run with nobody to kill it.
  if (clientGone(request, reply))
    throw new AppError('GONE', 'The client went away before the operation started', 499)
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) void request.server.ctx.ops.kill(client, comment).catch(() => undefined)
  })
  return comment
}
