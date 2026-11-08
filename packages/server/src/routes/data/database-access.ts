// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { MongoClient } from 'mongodb'
import type { AuditAction } from '@mongo-manager/shared'
import { z } from 'zod'
import {
  AccessDbSchema,
  AccessListQuerySchema,
  DatabaseNameSchema,
  DbRoleCreateSchema,
  DbRoleUpdateSchema,
  DbRolesChangeSchema,
  DbUserCreateSchema,
  DbUserUpdateSchema,
  DropQuerySchema,
  EXTERNAL_DB,
  RoleNameSchema,
  UserNameSchema,
  type Privilege,
  type RoleRef,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { assertNotDrillScratch, requireConnection, restrictedByOthers } from '../../connections/access'
import { clientFor } from '../../data/mongo-errors'
import { notSupported } from '../../masking/gate/refusal'
import {
  broadDefinition,
  broadRoles,
  changeUserRoles,
  createRole,
  createUser,
  dropRole,
  dropUser,
  listRoles,
  listUsers,
  ownsRole,
  updateRole,
  updateUser,
  userDetail,
  type OwnAccount,
} from '../../dbaccess/commands'
import { OwnAccounts } from '../../dbaccess/own'

const UserParams = z.object({ id: z.string().max(64), db: AccessDbSchema, userName: UserNameSchema })
const RoleParams = z.object({ id: z.string().max(64), db: DatabaseNameSchema, roleName: RoleNameSchema })

const roleNames = (roles: readonly RoleRef[]) => roles.map((r) => `${r.role}@${r.db}`)

/**
 * W3.1 (Atlas "Database Access"): MongoDB's users and custom roles. Every route needs the app's
 * databases:admin on the connection, and MongoDB's own rights apply on top (a refusal is said as
 * MongoDB's). A user whose personal data is hidden never sees accounts; a read-only connection lists
 * but changes nothing; every change is audited with names only — a password is never stored, logged,
 * audited or sent back. W3 review: the connection's own account (as MongoDB says it) and the roles
 * it holds are changed only when confirmed (M2); rights over the deployment are given only when
 * confirmed (M4).
 */
export async function databaseAccessRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/database-access'
  const owns = new OwnAccounts(app.ctx.now)
  const connection = requireConnection('databases:admin')
  const guard = async (request: FastifyRequest): Promise<void> => {
    await connection(request)
    // Accounts and their rights are no place for one hidden from by someone else's rule (user report
    // 2026-10-30: one who hides values from themselves manages them — the lists hold names and roles).
    if (restrictedByOthers(app.ctx, request.principal!, request.connection!.id))
      throw notSupported('Managing MongoDB users', request.connection!.id)
  }
  const change = async (request: FastifyRequest): Promise<void> => {
    await guard(request)
    if (app.ctx.config.readOnly || request.connection!.readOnly) throw Errors.readOnly()
  }
  /** The client, and who the connection signs in as. */
  const open = async (request: FastifyRequest): Promise<{ client: MongoClient; own: OwnAccount | null }> => {
    const client = await clientFor(request)
    const c = request.connection!
    return { client, own: await owns.get(c.id, c.updatedAt, client, c.settings) }
  }
  /** After a change: what the account holds may have changed. */
  const changed = (request: FastifyRequest) => owns.forget(request.connection!.id)
  const ownRefusal = () =>
    Errors.conflict(
      'This is the account the connection signs in with: changing it can lock the connection out. Confirm to go on.',
      { reason: 'own_account' },
    )
  /** A change to the connection's own account can lock it out: it must be confirmed. */
  const assertOwn = (own: OwnAccount | null, db: string, user: string, confirmed: boolean | undefined) => {
    if (own && own.db === db && own.user === user && confirmed !== true) throw ownRefusal()
  }
  /** So can a change to a role it holds (W3 review M2). */
  const assertOwnRole = (
    own: OwnAccount | null,
    db: string,
    role: string,
    confirmed: boolean | undefined,
  ) => {
    if (ownsRole(own, role, db) && confirmed !== true) throw ownRefusal()
  }
  /** W3 review (M4): rights over the deployment are given only when the request says so. */
  const assertBroad = async (
    client: MongoClient,
    grant: { roles?: readonly RoleRef[]; privileges?: readonly Privilege[] },
    confirmed: boolean | undefined,
    definition = false,
  ) => {
    if (confirmed === true) return
    const broad = definition
      ? await broadDefinition(client, grant.privileges, grant.roles)
      : (await broadRoles(client, grant.roles ?? [])).length > 0
    if (broad)
      throw Errors.conflict(
        'These rights can hand out or take over accounts, or act on more than their data: confirm to give them.',
        {
          reason: 'broad_role',
        },
      )
  }
  // User report 2026-10-30: names and roles only, no document value — refused by the guard to one an
  // administrator hides personal data from, not to one who hides it from themselves.
  const read = { preHandler: guard, config: { masking: 'names-only' as const } }
  const write = (audit: AuditAction) => ({
    preHandler: change,
    config: { masking: 'names-only' as const, audit },
  })

  app.get(`${base}/users`, read, async (request) => {
    const { db } = parseInput(AccessListQuerySchema, request.query ?? {})
    const { client, own } = await open(request)
    return listUsers(client, db, own)
  })

  app.get(`${base}/users/:db/:userName`, read, async (request) => {
    const { db, userName } = parseInput(UserParams, request.params)
    const { client, own } = await open(request)
    return userDetail(client, db, userName, own)
  })

  app.post(`${base}/users`, write('mongo.users.create'), async (request, reply) => {
    const input = parseInput(DbUserCreateSchema, request.body)
    // W4 final review (minor): no grant names a restore drill’s scratch database.
    assertNoScratchRefs(input)
    request.auditInfo = {
      details: {
        user: input.user,
        db: input.db,
        roles: roleNames(input.roles),
        broad: input.confirmBroad === true,
      },
    }
    const { client, own } = await open(request)
    await assertBroad(client, { roles: input.roles }, input.confirmBroad)
    const created = await createUser(client, input, own)
    return reply.code(201).send(created)
  })

  app.patch(`${base}/users/:db/:userName`, write('mongo.users.update'), async (request) => {
    const { db, userName } = parseInput(UserParams, request.params)
    const body = parseInput(DbUserUpdateSchema, request.body)
    // W4 final review (minor): no grant names a restore drill’s scratch database.
    assertNoScratchRefs(body)
    request.auditInfo = {
      details: {
        user: userName,
        db,
        ...(body.roles ? { roles: roleNames(body.roles) } : {}),
        ...(body.password !== undefined ? { newCredential: true } : {}),
      },
    }
    const { client, own } = await open(request)
    assertOwn(own, db, userName, body.confirmOwn)
    if (body.roles) await assertBroad(client, { roles: body.roles }, body.confirmBroad)
    const updated = await updateUser(client, db, userName, body, own)
    changed(request)
    return updated
  })

  for (const action of ['grant', 'revoke'] as const)
    app.post(`${base}/users/:db/:userName/${action}`, write(`mongo.users.${action}`), async (request) => {
      const { db, userName } = parseInput(UserParams, request.params)
      const body = parseInput(DbRolesChangeSchema, request.body)
      // W4 final review (minor): no grant names a restore drill’s scratch database.
      assertNoScratchRefs(body)
      request.auditInfo = { details: { user: userName, db, roles: roleNames(body.roles) } }
      const { client, own } = await open(request)
      assertOwn(own, db, userName, body.confirmOwn)
      if (action === 'grant') await assertBroad(client, { roles: body.roles }, body.confirmBroad)
      const updated = await changeUserRoles(client, db, userName, action, body.roles, own)
      changed(request)
      return updated
    })

  app.delete(`${base}/users/:db/:userName`, write('mongo.users.drop'), async (request, reply) => {
    const { db, userName } = parseInput(UserParams, request.params)
    const { confirmOwn } = parseInput(DropQuerySchema, request.query ?? {})
    request.auditInfo = { details: { user: userName, db } }
    const { client, own } = await open(request)
    assertOwn(own, db, userName, confirmOwn === 'true')
    await dropUser(client, db, userName)
    changed(request)
    return reply.code(204).send()
  })

  app.get(`${base}/roles`, read, async (request) => {
    const { db } = parseInput(AccessListQuerySchema, request.query ?? {})
    if (db === EXTERNAL_DB) throw Errors.validation('Roles do not live in $external')
    const { client, own } = await open(request)
    return listRoles(client, db, own)
  })

  app.post(`${base}/roles`, write('mongo.roles.create'), async (request, reply) => {
    const input = parseInput(DbRoleCreateSchema, request.body)
    // W4 final review (minor): no grant names a restore drill’s scratch database.
    assertNoScratchRefs(input)
    request.auditInfo = {
      details: {
        role: input.role,
        db: input.db,
        roles: roleNames(input.roles),
        privileges: input.privileges.length,
      },
    }
    const { client, own } = await open(request)
    await assertBroad(client, input, input.confirmBroad, true)
    return reply.code(201).send(await createRole(client, input, own))
  })

  app.patch(`${base}/roles/:db/:roleName`, write('mongo.roles.update'), async (request) => {
    const { db, roleName } = parseInput(RoleParams, request.params)
    const body = parseInput(DbRoleUpdateSchema, request.body)
    // W4 final review (minor): no grant names a restore drill’s scratch database.
    assertNoScratchRefs(body)
    request.auditInfo = {
      details: {
        role: roleName,
        db,
        ...(body.roles ? { roles: roleNames(body.roles) } : {}),
        ...(body.privileges ? { privileges: body.privileges.length } : {}),
      },
    }
    const { client, own } = await open(request)
    assertOwnRole(own, db, roleName, body.confirmOwn)
    await assertBroad(client, body, body.confirmBroad, true)
    const updated = await updateRole(client, db, roleName, body, own)
    changed(request)
    return updated
  })

  app.delete(`${base}/roles/:db/:roleName`, write('mongo.roles.drop'), async (request, reply) => {
    const { db, roleName } = parseInput(RoleParams, request.params)
    const { confirmOwn } = parseInput(DropQuerySchema, request.query ?? {})
    request.auditInfo = { details: { role: roleName, db } }
    const { client, own } = await open(request)
    assertOwnRole(own, db, roleName, confirmOwn === 'true')
    await dropRole(client, db, roleName)
    changed(request)
    return reply.code(204).send()
  })
}

/** W4 final review (minor): a user's or a role's database, roles and privileges, never a drill's scratch. */
export function assertNoScratchRefs(input: {
  db?: string
  roles?: ReadonlyArray<{ role?: string; db?: string }>
  privileges?: ReadonlyArray<{ resource?: object; actions?: readonly string[] }>
}): void {
  assertNotDrillScratch(
    input.db,
    ...(input.roles ?? []).map((r) => r.db),
    ...(input.privileges ?? []).map((p) =>
      p.resource && 'db' in p.resource ? String((p.resource as { db: unknown }).db) : undefined,
    ),
  )
}
