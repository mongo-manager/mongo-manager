// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Db, Document, MongoClient } from 'mongodb'
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_NAMES,
  EXTERNAL_DB,
  DEPLOYMENT_DBS,
  isBroadPrivilege,
  isBroadRoleRef,
  type DbRoleCreate,
  type DbRoleUpdate,
  type DbRoleView,
  type DbRolesAnswer,
  type DbUserCreate,
  type DbUserDetail,
  type DbUserView,
  type DbUsersAnswer,
  type Privilege,
  type RoleRef,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { isDrillScratch } from '../connections/access'
import { toAppError } from '../data/mongo-errors'
import type { OwnAccount } from './own'

export type { OwnAccount }

/**
 * W3.1: MongoDB's own users and roles. Every command is built here from validated fields (shared
 * database-access schemas); credentials are never asked for (showCredentials stays off) and a
 * password goes to MongoDB once, inside createUser / updateUser, and nowhere else.
 */
export const MAX_USERS = 2000
export const MAX_ROLES = 2000
/** "Every database" lists roles database by database; at most this many are asked. */
const MAX_ROLE_DATABASES = 200
/** Each answer is bounded in time: a cluster that hangs fails in seconds (the page shows it). */
const COMMAND_MS = 15_000
const MECHANISM = 'SCRAM-SHA-256'

const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : '')

const roleRefs = (v: unknown): RoleRef[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, 500)
    .map((r: Document) =>
      typeof r === 'string' ? { role: r, db: '' } : { role: str(r.role), db: str(r.db) },
    )
    .filter((r) => r.role !== '')

/** A privilege as MongoDB answers it, kept to the shape the app knows (anything else dropped). */
function privilege(p: Document): Privilege | null {
  const r = (p.resource ?? {}) as Document
  const resource =
    r.cluster === true
      ? { cluster: true as const }
      : r.anyResource === true
        ? { anyResource: true as const }
        : typeof r.db === 'string' && typeof r.collection === 'string'
          ? { db: r.db.slice(0, 64), collection: r.collection.slice(0, 255) }
          : null
  if (!resource) return null
  const actions = (Array.isArray(p.actions) ? p.actions : [])
    .filter((a: unknown): a is string => typeof a === 'string')
    .slice(0, 300)
    .map((a: string) => a.slice(0, 64))
  return { resource, actions }
}
const privileges = (v: unknown): Privilege[] | null =>
  Array.isArray(v)
    ? v
        .slice(0, 1000)
        .map((p) => privilege(p as Document))
        .filter((p): p is Privilege => p !== null)
    : null

const isOwn = (own: OwnAccount | null, user: string, db: string) =>
  own !== null && own.user === user && own.db === db

function userView(u: Document, own: OwnAccount | null): DbUserView {
  const user = str(u.user)
  const db = str(u.db, 64)
  return {
    user,
    db,
    roles: roleRefs(u.roles),
    mechanisms: (Array.isArray(u.mechanisms) ? u.mechanisms : []).map((m: unknown) => str(m, 32)),
    own: isOwn(own, user, db),
    restrictions: Array.isArray(u.authenticationRestrictions) ? u.authenticationRestrictions.length : 0,
  }
}

/** A role the connection's own account holds, directly or through another (W3 review M2). */
export const ownsRole = (own: OwnAccount | null, role: string, db: string): boolean =>
  own !== null && own.roles.some((r) => r.role === role && r.db === db)

/** Review of B5 (nit): a built-in of admin that is not one every database has (one this app does not list). */
const DATABASE_BUILTINS: ReadonlySet<string> = new Set(
  BUILTIN_ROLES.filter((b) => b.scope === 'any').map((b) => b.role),
)
const adminOnlyBuiltin = (r: { role: string; db: string }) =>
  r.db === 'admin' && !DATABASE_BUILTINS.has(r.role)

/** Rights over the deployment, held or inherited (W3 review M4). */
function isBroadRole(r: Document): boolean {
  // Review of B4 (I1): a built-in over the deployment, any role of local or config, or one inheriting one.
  const self = { role: str(r.role), db: str(r.db, 64) }
  if (r.isBuiltin === true ? isBroadRoleRef(self) || adminOnlyBuiltin(self) : DEPLOYMENT_DBS.has(self.db))
    return true
  if (roleRefs(r.inheritedRoles).some((x) => isBroadRoleRef(x))) return true
  const held = privileges(r.inheritedPrivileges) ?? privileges(r.privileges) ?? []
  return held.some((x) => isBroadPrivilege(x))
}

function roleView(r: Document, own: OwnAccount | null): DbRoleView {
  return {
    role: str(r.role),
    db: str(r.db, 64),
    own: ownsRole(own, str(r.role), str(r.db, 64)),
    broad: isBroadRole(r),
    builtin: r.isBuiltin === true,
    roles: roleRefs(r.roles),
    inheritedRoles: roleRefs(r.inheritedRoles),
    privileges: privileges(r.privileges),
    inheritedPrivileges: privileges(r.inheritedPrivileges),
  }
}

/**
 * MongoDB's answer as the app shows it. A refusal (code 13) names the command and says it is
 * MongoDB's, not the app's: the connection's account lacks the right. Any secret given is scrubbed
 * from the text, whatever MongoDB chose to quote.
 */
export function accessError(
  e: unknown,
  command: string,
  db: string,
  secrets: readonly string[] = [],
): unknown {
  const code = (e as { code?: unknown }).code
  if (code === 13)
    return Errors.forbidden(
      `MongoDB refused ${command} on ${db}: the connection's account lacks the privilege (user administration needs userAdmin on that database, or userAdminAnyDatabase)`,
      { reason: 'mongo_not_permitted', command },
    )
  if (code === 11 || code === 31) return Errors.notFound(code === 11 ? 'User not found' : 'Role not found')
  if (code === 51002)
    return Errors.conflict('A role with that name already exists', { reason: 'role_exists' })
  if (code === 51003 || code === 11000)
    return Errors.conflict('A user with that name already exists', { reason: 'user_exists' })
  // W3 review (M3): with a password in the command, MongoDB's words are never shown — they could
  // quote it in any spelling (escaped, encoded, cut short) — only its code name.
  if (secrets.some(Boolean)) {
    const codeName = (e as { codeName?: unknown }).codeName
    const named =
      typeof codeName === 'string' && /^\w{1,64}$/.test(codeName) ? codeName : `code ${Number(code) || 0}`
    const name = (e as { name?: unknown }).name
    if (
      typeof name === 'string' &&
      name.startsWith('Mongo') &&
      !/^Mongo(Network|ServerSelection|NotConnected|TopologyClosed)/.test(name)
    )
      return new AppError('MONGO_ERROR', `MongoDB refused ${command} on ${db}: ${named}`, 400, {
        code: Number(code) || null,
        codeName: typeof codeName === 'string' ? named : null,
      })
  }
  return toAppError(e)
}

async function run(db: Db, cmd: Document, name: string, secrets: readonly string[] = []): Promise<Document> {
  try {
    return await db.command(cmd, { timeoutMS: COMMAND_MS })
  } catch (e) {
    throw accessError(e, name, db.databaseName, secrets)
  }
}

export async function listUsers(
  client: MongoClient,
  db: string | undefined,
  own: OwnAccount | null,
): Promise<DbUsersAnswer> {
  const target = client.db(db ?? 'admin')
  const cmd = db
    ? { usersInfo: 1, showCredentials: false }
    : { usersInfo: { forAllDBs: true }, showCredentials: false }
  let answer: Document
  try {
    answer = await target.command(cmd, { timeoutMS: COMMAND_MS })
  } catch (e) {
    if ((e as { code?: unknown }).code === 13) return { users: [], more: false, refused: 'not_permitted' }
    throw accessError(e, 'usersInfo', db ?? 'admin')
  }
  const all = (Array.isArray(answer.users) ? answer.users : []) as Document[]
  const users = all
    .slice(0, MAX_USERS)
    .map((u) => userView(u, own))
    .sort((a, b) => a.db.localeCompare(b.db) || a.user.localeCompare(b.user))
  return { users, more: all.length > MAX_USERS, refused: null }
}

export async function userDetail(
  client: MongoClient,
  db: string,
  user: string,
  own: OwnAccount | null,
): Promise<DbUserDetail> {
  const answer = await run(
    client.db(db),
    { usersInfo: { user, db }, showPrivileges: true, showCredentials: false },
    'usersInfo',
  )
  const u = (answer.users as Document[] | undefined)?.[0]
  if (!u) throw new AppError('NOT_FOUND', 'User not found', 404, { reason: 'user_unknown' })
  return {
    ...userView(u, own),
    inheritedPrivileges: privileges(u.inheritedPrivileges),
    inheritedRoles: roleRefs(u.inheritedRoles),
  }
}

async function oneUser(
  client: MongoClient,
  db: string,
  user: string,
  own: OwnAccount | null,
): Promise<DbUserView> {
  const answer = await run(client.db(db), { usersInfo: { user, db }, showCredentials: false }, 'usersInfo')
  const u = (answer.users as Document[] | undefined)?.[0]
  if (!u) throw new AppError('NOT_FOUND', 'User not found', 404, { reason: 'user_unknown' })
  return userView(u, own)
}

const roleDocs = (roles: readonly RoleRef[]) => roles.map((r) => ({ role: r.role, db: r.db }))

export async function createUser(
  client: MongoClient,
  input: DbUserCreate,
  own: OwnAccount | null,
): Promise<DbUserView> {
  const cmd: Document = { createUser: input.user, roles: roleDocs(input.roles) }
  if (input.db !== EXTERNAL_DB) {
    cmd.pwd = input.password
    cmd.mechanisms = [MECHANISM]
  }
  await run(client.db(input.db), cmd, 'createUser', input.password ? [input.password] : [])
  return oneUser(client, input.db, input.user, own)
}

export async function updateUser(
  client: MongoClient,
  db: string,
  user: string,
  change: { password?: string; roles?: RoleRef[] },
  own: OwnAccount | null,
): Promise<DbUserView> {
  if (db === EXTERNAL_DB && change.password !== undefined)
    throw Errors.validation('Users in $external have no password')
  const cmd: Document = { updateUser: user }
  if (change.password !== undefined) {
    cmd.pwd = change.password
    cmd.mechanisms = [MECHANISM]
  }
  if (change.roles) cmd.roles = roleDocs(change.roles)
  await run(client.db(db), cmd, 'updateUser', change.password ? [change.password] : [])
  return oneUser(client, db, user, own)
}

export async function changeUserRoles(
  client: MongoClient,
  db: string,
  user: string,
  action: 'grant' | 'revoke',
  roles: RoleRef[],
  own: OwnAccount | null,
): Promise<DbUserView> {
  const name = action === 'grant' ? 'grantRolesToUser' : 'revokeRolesFromUser'
  await run(client.db(db), { [name]: user, roles: roleDocs(roles) }, name)
  return oneUser(client, db, user, own)
}

export async function dropUser(client: MongoClient, db: string, user: string): Promise<void> {
  await run(client.db(db), { dropUser: user }, 'dropUser')
}

/** The custom roles of one database, or of every database the account may list. */
export async function listRoles(
  client: MongoClient,
  db: string | undefined,
  own: OwnAccount | null,
): Promise<DbRolesAnswer> {
  let names: string[]
  if (db) names = [db]
  else {
    // Custom roles all live in admin.system.roles, whether or not their database holds data (an
    // empty database is not listed): the databases are read from there when the account may.
    try {
      const held = (await client
        .db('admin')
        .collection('system.roles')
        .distinct('db', {}, { timeoutMS: COMMAND_MS })) as unknown[]
      names = held.filter((n): n is string => typeof n === 'string').sort()
      if (!names.includes('admin')) names.unshift('admin')
    } catch {
      names = []
    }
  }
  if (!db && names.length === 0) {
    try {
      const listed = await client
        .db('admin')
        .admin()
        .listDatabases({ nameOnly: true, authorizedDatabases: true, timeoutMS: COMMAND_MS })
      // W4 re-review C1: a restore drill's scratch database is not listed.
      names = listed.databases.map((d) => d.name).filter((n) => !isDrillScratch(n))
    } catch (e) {
      throw accessError(e, 'listDatabases', 'admin')
    }
    if (!names.includes('admin')) names.unshift('admin')
  }
  const roles: DbRoleView[] = []
  const refused: string[] = []
  let more = false
  for (const name of names.slice(0, MAX_ROLE_DATABASES)) {
    if (name === 'local' || name === 'config') continue
    let answer: Document
    try {
      answer = await client
        .db(name)
        .command({ rolesInfo: 1, showPrivileges: true, showBuiltinRoles: false }, { timeoutMS: COMMAND_MS })
    } catch (e) {
      if ((e as { code?: unknown }).code === 13) {
        refused.push(name)
        continue
      }
      throw accessError(e, 'rolesInfo', name)
    }
    for (const r of (answer.roles ?? []) as Document[]) {
      if (roles.length >= MAX_ROLES) {
        more = true
        break
      }
      // A built-in role is MongoDB's, whatever a database answers (the catalogue lists them).
      if (r.isBuiltin === true || BUILTIN_ROLE_NAMES.has(str(r.role))) continue
      roles.push(roleView(r, own))
    }
  }
  if (names.length > MAX_ROLE_DATABASES) more = true
  roles.sort((a, b) => a.db.localeCompare(b.db) || a.role.localeCompare(b.role))
  return { roles, more, refused }
}

async function oneRole(
  client: MongoClient,
  db: string,
  role: string,
  own: OwnAccount | null,
): Promise<DbRoleView> {
  const answer = await run(client.db(db), { rolesInfo: { role, db }, showPrivileges: true }, 'rolesInfo')
  const r = (answer.roles as Document[] | undefined)?.[0]
  if (!r) throw Errors.notFound('Role not found')
  return roleView(r, own)
}

/**
 * W3 review (M4): the roles of a grant that give rights over the deployment — built-in ones of
 * POWERFUL_ROLES, and custom ones that hold or inherit such rights (asked of MongoDB). A role
 * MongoDB does not know is left to MongoDB to refuse.
 */
export async function broadRoles(client: MongoClient, roles: readonly RoleRef[]): Promise<RoleRef[]> {
  const out: RoleRef[] = []
  for (const r of roles.slice(0, 100)) {
    // Review of B4 (I1): as the shared rule says — a built-in by its name and database, any role of
    // local or config; a custom one by its definition, read below.
    if (isBroadRoleRef(r)) {
      out.push(r)
      continue
    }
    if (BUILTIN_ROLE_NAMES.has(r.role)) continue
    try {
      const answer = await client
        .db(r.db)
        .command({ rolesInfo: { role: r.role, db: r.db }, showPrivileges: true }, { timeoutMS: COMMAND_MS })
      const found = (answer.roles as Document[] | undefined)?.[0]
      if (found && isBroadRole(found)) out.push(r)
    } catch {
      // Not readable: MongoDB answers the grant itself.
    }
  }
  return out
}

/** A new or changed custom role's own broadness: what it holds and what it inherits (M4). */
export async function broadDefinition(
  client: MongoClient,
  privilegesGiven: readonly Privilege[] | undefined,
  inherits: readonly RoleRef[] | undefined,
): Promise<boolean> {
  if ((privilegesGiven ?? []).some((x) => isBroadPrivilege(x))) return true
  return (await broadRoles(client, inherits ?? [])).length > 0
}

const privilegeDocs = (list: readonly Privilege[]) =>
  list.map((p) => ({ resource: { ...p.resource }, actions: [...p.actions] }))

export async function createRole(
  client: MongoClient,
  input: DbRoleCreate,
  own: OwnAccount | null,
): Promise<DbRoleView> {
  if (BUILTIN_ROLE_NAMES.has(input.role))
    throw Errors.conflict('That name is a built-in role', { reason: 'builtin_role' })
  await run(
    client.db(input.db),
    { createRole: input.role, privileges: privilegeDocs(input.privileges), roles: roleDocs(input.roles) },
    'createRole',
  )
  return oneRole(client, input.db, input.role, own)
}

export async function updateRole(
  client: MongoClient,
  db: string,
  role: string,
  change: DbRoleUpdate,
  own: OwnAccount | null,
): Promise<DbRoleView> {
  if (BUILTIN_ROLE_NAMES.has(role))
    throw Errors.conflict('Built-in roles cannot be changed', { reason: 'builtin_role' })
  const cmd: Document = { updateRole: role }
  if (change.privileges) cmd.privileges = privilegeDocs(change.privileges)
  if (change.roles) cmd.roles = roleDocs(change.roles)
  await run(client.db(db), cmd, 'updateRole')
  return oneRole(client, db, role, own)
}

export async function dropRole(client: MongoClient, db: string, role: string): Promise<void> {
  if (BUILTIN_ROLE_NAMES.has(role))
    throw Errors.conflict('Built-in roles cannot be dropped', { reason: 'builtin_role' })
  await run(client.db(db), { dropRole: role }, 'dropRole')
}
