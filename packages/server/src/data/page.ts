import type { FastifyReply, FastifyRequest } from 'fastify'
import { Errors } from '../errors'
import type { RunSlots } from '../aggregation/run'
import { whenHandlerSettled } from '../http/lifecycle'

/**
 * Security review 2026-10-13 (M3, round 2 I5): a page of documents stops at this many bytes of
 * BSON. As canonical EJSON and then JSON it grows several times (arrays of numbers or dates the
 * most), so this leaves room under what one response may hold in memory.
 */
export const MAX_PAGE_BYTES = 16 * 1024 * 1024

/** Whose reads are counted together: a user, or the one local owner. */
export const readerKey = (request: FastifyRequest): string =>
  request.principal?.kind === 'user' ? request.principal.userId : 'local'

/**
 * A read slot held for the response's whole life — until it is sent or its client is gone — not
 * only while the database answers (round 2, I5): a client that never reads its response holds one.
 */
export function holdReadSlot(request: FastifyRequest, reply: FastifyReply, slots: RunSlots): void {
  const release = slots.acquire(readerKey(request))
  if (!release) throw Errors.rateLimited(2_000, 'reads_busy')
  holdUntilDone(request, reply, release)
}

/**
 * Independent review of the security pass (I2): a slot goes back once the response is over AND the
 * handler is done — a client that leaves while its read is still on its way (connecting, checked
 * by the gate) never frees a slot for a read that then starts anyway.
 */
export function holdUntilDone(request: FastifyRequest, reply: FastifyReply, release: () => void): void {
  let responded = false
  let settled = false
  const maybe = () => {
    if (responded && settled) release()
  }
  const over = () => {
    responded = true
    maybe()
  }
  reply.raw.once('finish', over)
  reply.raw.once('close', over)
  whenHandlerSettled(request, () => {
    settled = true
    maybe()
  })
}
