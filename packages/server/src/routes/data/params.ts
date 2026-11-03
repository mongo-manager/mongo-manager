import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CollectionNameSchema, DatabaseNameSchema, findServerJs } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { isAdminOnlyNamespace, isRestrictedNamespace } from '../../connections/access'

export const DbParams = z.object({ id: z.string().max(64), db: DatabaseNameSchema })
export const CollParams = DbParams.extend({ coll: CollectionNameSchema })
export { SYSTEM_DATABASES } from '../../connections/access'

/** Creating or renaming into a system namespace (e.g. system.js) needs the connection admin role. */
export function assertTargetAllowed(request: FastifyRequest, db: string, name?: string): void {
  if (request.connectionRole === 'admin') return
  if (isRestrictedNamespace(db, name, true))
    throw Errors.forbidden('System namespaces are restricted to connection admins')
}

/**
 * W2 review (2026-10-16): a view reads its source with the reader's rights through the app, so a
 * view over a credential collection (system.users and the like), or in an admin-only database
 * (local), is for connection admins only, as reading it is (review minor 12: isAdminOnlyNamespace).
 */
export function assertSourceAllowed(request: FastifyRequest, db: string, source: string): void {
  if (request.connectionRole === 'admin') return
  if (isAdminOnlyNamespace(db, source))
    throw Errors.forbidden('A view over this collection is restricted to connection admins')
}

/** Spec §5 S7: server-side JavaScript operators are off unless explicitly enabled. */
export function assertNoServerJs(request: FastifyRequest, ...values: unknown[]): void {
  if (request.server.ctx.config.allowServerJs) return
  for (const value of values) {
    const op = findServerJs(value)
    if (op) {
      throw Errors.validation(
        `${op} runs JavaScript on the MongoDB server and is disabled. Set MM_ALLOW_SERVER_JS=1 (or allowServerJs in the config file) to allow it.`,
      )
    }
  }
}
