import { z } from 'zod'
import { DatabaseNameSchema } from '../schemas'

/**
 * W3 (completion §2 W3.1): MongoDB's own users and roles, as Atlas's "Database Access" shows
 * them. Every name is bounded and free of NUL and control characters; the commands are built from
 * these fields alone, so nothing but a name reaches a name's place.
 */

/** Users authenticated outside MongoDB (x.509, LDAP, Kerberos, AWS IAM) live in this database. */
export const EXTERNAL_DB = '$external'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const name = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), 'Control characters are not allowed')

/** A user's or a role's database: a database name, or $external for users. */
export const AccessDbSchema = z.union([z.literal(EXTERNAL_DB), DatabaseNameSchema])
export const UserNameSchema = name(256)
export const RoleNameSchema = name(256)

/**
 * Typed by the administrator (or generated in their browser), sent once to MongoDB inside
 * createUser / updateUser, and never stored, logged or audited by Mongo Manager.
 */
export const MIN_DB_PASSWORD = 12
/** As MongoDB takes one (review of B4, I2: said in the browser too). */
export const MAX_DB_PASSWORD = 256
export const DbPasswordSchema = z
  .string()
  .min(MIN_DB_PASSWORD, `At least ${MIN_DB_PASSWORD} characters`)
  .max(MAX_DB_PASSWORD)
  .refine((v) => !v.includes(String.fromCharCode(0)), 'NUL is not allowed')

export const RoleRefSchema = z.strictObject({ role: RoleNameSchema, db: DatabaseNameSchema })
export type RoleRef = z.infer<typeof RoleRefSchema>
const Roles = z.array(RoleRefSchema).max(100)

/** A privilege action name as MongoDB spells them (camelCase letters). */
export const PrivilegeActionSchema = z.string().regex(/^[A-Za-z]{1,64}$/, 'Not a privilege action')

/**
 * A privilege's resource: a database and collection ("" = any), the cluster, or any resource.
 * Strict objects: a key MongoDB would read differently is refused, never passed through.
 */
export const PrivilegeResourceSchema = z.union([
  z.strictObject({
    db: z.union([z.literal(''), DatabaseNameSchema]),
    collection: z
      .string()
      .max(255)
      .refine((v) => !v.includes('$') && !CONTROL.test(v), 'Not a collection name'),
  }),
  z.strictObject({ cluster: z.literal(true) }),
  z.strictObject({ anyResource: z.literal(true) }),
])
export const PrivilegeSchema = z.strictObject({
  resource: PrivilegeResourceSchema,
  actions: z.array(PrivilegeActionSchema).min(1).max(150),
})
export type Privilege = z.infer<typeof PrivilegeSchema>

/** Who the listings are for: one database, or every database (no `db`). */
export const AccessListQuerySchema = z.strictObject({ db: AccessDbSchema.optional() })

/** A change to the connection's own account must say so (it can lock the connection out). */
const confirmOwn = z.boolean().optional()
/**
 * W3 review (M4): giving rights over the whole deployment (POWERFUL_ROLES, or a custom role that
 * holds or inherits such rights) must say so; the server refuses it otherwise.
 */
const confirmBroad = z.boolean().optional()

export const DbUserCreateSchema = z
  .strictObject({
    db: AccessDbSchema,
    user: UserNameSchema,
    password: DbPasswordSchema.optional(),
    roles: Roles,
    confirmBroad,
  })
  .superRefine((b, ctx) => {
    if (b.db === EXTERNAL_DB && b.password !== undefined)
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Users in $external have no password' })
    if (b.db !== EXTERNAL_DB && b.password === undefined)
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'A password is required' })
  })
export type DbUserCreate = z.infer<typeof DbUserCreateSchema>

/** Roles replace the user's roles whole; a password sets a new one. At least one of the two. */
export const DbUserUpdateSchema = z
  .strictObject({ password: DbPasswordSchema.optional(), roles: Roles.optional(), confirmOwn, confirmBroad })
  .refine((b) => b.password !== undefined || b.roles !== undefined, { message: 'Nothing to change' })
export type DbUserUpdate = z.infer<typeof DbUserUpdateSchema>

export const DbRolesChangeSchema = z.strictObject({ roles: Roles.min(1), confirmOwn, confirmBroad })
export type DbRolesChange = z.infer<typeof DbRolesChangeSchema>

export const DropQuerySchema = z.strictObject({ confirmOwn: z.enum(['true', 'false']).optional() })

export const DbRoleCreateSchema = z.strictObject({
  db: DatabaseNameSchema,
  role: RoleNameSchema,
  privileges: z.array(PrivilegeSchema).max(100),
  roles: Roles,
  confirmBroad,
})
export type DbRoleCreate = z.infer<typeof DbRoleCreateSchema>

/** Privileges and inherited roles replace the role's own, each when given. */
export const DbRoleUpdateSchema = z
  .strictObject({
    privileges: z.array(PrivilegeSchema).max(100).optional(),
    roles: Roles.optional(),
    confirmOwn,
    confirmBroad,
  })
  .refine((b) => b.privileges !== undefined || b.roles !== undefined, { message: 'Nothing to change' })
export type DbRoleUpdate = z.infer<typeof DbRoleUpdateSchema>

export interface DbUserView {
  user: string
  db: string
  roles: RoleRef[]
  mechanisms: string[]
  /** The connection signs in as this user: changing it can lock the connection out. */
  own: boolean
  /** How many authentication restrictions it has (they are not changed here). */
  restrictions: number
}

export interface DbUserDetail extends DbUserView {
  /** What the user may do through all its roles, as MongoDB resolves them (showPrivileges). */
  inheritedPrivileges: Privilege[] | null
  inheritedRoles: RoleRef[]
}

export interface DbRoleView {
  role: string
  db: string
  /** The connection's own account holds it (W3 review M2): changing it is confirmed. */
  own: boolean
  /** It gives rights over the deployment (W3 review M4): granting it is confirmed. */
  broad: boolean
  builtin: boolean
  roles: RoleRef[]
  inheritedRoles: RoleRef[]
  privileges: Privilege[] | null
  inheritedPrivileges: Privilege[] | null
}

/** A listing, with the parts MongoDB refused to the connection's account named, never hidden. */
export interface DbUsersAnswer {
  users: DbUserView[]
  more: boolean
  refused: string | null
}
export interface DbRolesAnswer {
  roles: DbRoleView[]
  more: boolean
  /** Databases whose roles MongoDB would not list, by name. */
  refused: string[]
}

/**
 * MongoDB's built-in roles (database user, database administration, cluster administration,
 * backup, all-database and superuser roles): `admin` ones exist in the admin database only.
 */
export const BUILTIN_ROLES = [
  { role: 'read', scope: 'any', group: 'user' },
  { role: 'readWrite', scope: 'any', group: 'user' },
  { role: 'dbAdmin', scope: 'any', group: 'dbAdmin' },
  { role: 'dbOwner', scope: 'any', group: 'dbAdmin' },
  { role: 'userAdmin', scope: 'any', group: 'dbAdmin' },
  { role: 'clusterAdmin', scope: 'admin', group: 'cluster' },
  { role: 'clusterManager', scope: 'admin', group: 'cluster' },
  { role: 'clusterMonitor', scope: 'admin', group: 'cluster' },
  { role: 'hostManager', scope: 'admin', group: 'cluster' },
  { role: 'enableSharding', scope: 'admin', group: 'cluster' },
  { role: 'backup', scope: 'admin', group: 'backup' },
  { role: 'restore', scope: 'admin', group: 'backup' },
  { role: 'readAnyDatabase', scope: 'admin', group: 'allDatabases' },
  { role: 'readWriteAnyDatabase', scope: 'admin', group: 'allDatabases' },
  { role: 'userAdminAnyDatabase', scope: 'admin', group: 'allDatabases' },
  { role: 'dbAdminAnyDatabase', scope: 'admin', group: 'allDatabases' },
  { role: 'root', scope: 'admin', group: 'superuser' },
] as const
export type BuiltinRoleName = (typeof BUILTIN_ROLES)[number]['role']
export const BUILTIN_ROLE_NAMES: ReadonlySet<string> = new Set(BUILTIN_ROLES.map((r) => r.role))
/** Roles that hold every right on the deployment (or can give themselves any): confirmed on grant. */
export const POWERFUL_ROLES: ReadonlySet<string> = new Set([
  'root',
  'userAdminAnyDatabase',
  'userAdmin',
  'dbOwner',
  'clusterAdmin',
  'clusterManager',
  'hostManager',
  // W3 review (M4): restore writes any collection (system ones too), backup reads them all.
  'restore',
  'backup',
  'readWriteAnyDatabase',
  'dbAdminAnyDatabase',
  '__queryableBackup',
  '__system',
])

/**
 * Privilege actions that hand out or take over accounts, or act on everything: a custom role with
 * one of these (or a privilege on the cluster or any resource) is broad (W3 review M4).
 */
export const BROAD_ACTIONS: ReadonlySet<string> = new Set([
  'anyAction',
  'internal',
  'createUser',
  'dropUser',
  'grantRole',
  'revokeRole',
  'createRole',
  'dropRole',
  'changePassword',
  'changeCustomData',
  'setAuthenticationRestriction',
  'impersonate',
])

/**
 * Review of B4 (I1): MongoDB's own databases whose roles reach the whole deployment — `local` holds the
 * oplog (every write made), `config` the sharding metadata and the balancer's settings.
 */
export const DEPLOYMENT_DBS: ReadonlySet<string> = new Set(['local', 'config'])

/**
 * Whether privileges give rights beyond their databases' data (W3 review M4) — or over every
 * database at once (`db: ""`) or MongoDB's own (review of B4, I1).
 */
export function isBroadPrivilege(p: {
  resource: Record<string, unknown>
  actions: readonly string[]
}): boolean {
  return (
    p.resource.cluster === true ||
    p.resource.anyResource === true ||
    p.resource.db === '' ||
    (typeof p.resource.db === 'string' && DEPLOYMENT_DBS.has(p.resource.db)) ||
    p.actions.some((a) => BROAD_ACTIONS.has(a))
  )
}

/**
 * Review of B4 (I1): a role, named with its database, over the whole deployment — one that holds every
 * right or can give itself any (POWERFUL_ROLES), any built-in of the admin database only (each acts on
 * every database or on the cluster), or any role of `local` or `config`. A custom role is also broad
 * as its definition says (isBroadPrivilege, and what it inherits): the server reads that.
 */
export function isBroadRoleRef(r: { role: string; db: string }): boolean {
  return (
    POWERFUL_ROLES.has(r.role) ||
    DEPLOYMENT_DBS.has(r.db) ||
    BUILTIN_ROLES.some((b) => b.role === r.role && b.scope === 'admin')
  )
}

/** Privilege actions offered by the custom role editor, grouped as MongoDB's manual groups them. */
export const PRIVILEGE_ACTIONS = {
  query: ['find', 'insert', 'update', 'remove', 'bypassDocumentValidation', 'changeStream', 'useUUID'],
  database: [
    'createCollection',
    'createIndex',
    'dropIndex',
    'collMod',
    'compact',
    'convertToCapped',
    'dropCollection',
    'dropDatabase',
    'renameCollectionSameDB',
    'listCollections',
    'listIndexes',
    'collStats',
    'dbStats',
    'dbHash',
    'validate',
    'reIndex',
    'enableProfiler',
    'killCursors',
    'planCacheRead',
    'planCacheWrite',
  ],
  users: [
    'changeOwnPassword',
    'changeOwnCustomData',
    'changePassword',
    'createRole',
    'createUser',
    'dropRole',
    'dropUser',
    'grantRole',
    'revokeRole',
    'setAuthenticationRestriction',
    'viewRole',
    'viewUser',
  ],
  deployment: [
    'inprog',
    'killop',
    'serverStatus',
    'top',
    'listDatabases',
    'listSessions',
    'killAnySession',
    'connPoolStats',
    'getCmdLineOpts',
    'getLog',
    'hostInfo',
    'netstat',
    'shutdown',
    'fsync',
    'logRotate',
    'setParameter',
    'getParameter',
    'setFeatureCompatibilityVersion',
  ],
  replication: [
    'replSetGetStatus',
    'replSetGetConfig',
    'replSetConfigure',
    'replSetStateChange',
    'appendOplogNote',
    'resync',
  ],
  sharding: [
    'enableSharding',
    'shardCollection',
    'refineCollectionShardKey',
    'reshardCollection',
    'addShard',
    'removeShard',
    'listShards',
    'moveChunk',
    'splitChunk',
    'splitVector',
    'flushRouterConfig',
    'getShardMap',
    'getShardVersion',
    'cleanupOrphaned',
  ],
} as const
export type PrivilegeActionGroup = keyof typeof PRIVILEGE_ACTIONS
