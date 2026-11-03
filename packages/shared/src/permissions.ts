export const PERMISSIONS = [
  'connections:read',
  'connections:manage',
  'databases:read',
  'databases:write',
  'documents:read',
  'documents:write',
  'indexes:write',
  'aggregation:run',
  'shell:execute',
  'jobs:run',
  /** Phase 3d-1: download a collection, a query or a pipeline as a file. */
  'data:export',
  'users:manage',
  'audit:read',
  'settings:manage',
  'ai:use',
  /** Phase 1i: live metrics, the operation list without command text, and the hottest collections. */
  'server:monitor',
  /** Phase 1i: the command text of running operations (it can hold other users' data), and killOp. */
  'server:operations',
  /**
   * W3 (completion §2): MongoDB's own users and roles, and sharding management (shard a
   * collection, zones, the balancer). Admins only; MongoDB's own rights apply on top. Not a data
   * write: read-only mode keeps the listings and refuses each change itself.
   */
  'databases:admin',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const ROLES = ['admin', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

/** Permissions that modify MongoDB data; removed in read-only mode (spec §4.5). */
export const DATA_WRITE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'databases:write',
  'documents:write',
  'indexes:write',
])

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  editor: [
    'connections:read',
    'databases:read',
    'databases:write',
    'documents:read',
    'documents:write',
    'indexes:write',
    'aggregation:run',
    'jobs:run',
    'data:export',
    'ai:use',
    'server:monitor',
  ],
  viewer: ['connections:read', 'databases:read', 'documents:read', 'aggregation:run'],
}

export interface PermissionOptions {
  readOnly?: boolean
  grants?: readonly Permission[]
}

export function permissionsFor(role: Role, options: PermissionOptions = {}): ReadonlySet<Permission> {
  const set = new Set<Permission>([...ROLE_PERMISSIONS[role], ...(options.grants ?? [])])
  if (options.readOnly) for (const p of DATA_WRITE_PERMISSIONS) set.delete(p)
  return set
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}
