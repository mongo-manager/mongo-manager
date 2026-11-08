// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  DbRoleCreate,
  DbRoleUpdate,
  DbRoleView,
  DbRolesAnswer,
  DbUserCreate,
  DbUserDetail,
  DbUserView,
  DbUsersAnswer,
  RoleRef,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** W3.1: MongoDB's users and custom roles of a connection (Atlas "Database Access"). */
export const accessKeys = {
  all: (id: string) => ['connections', id, 'database-access'] as const,
  users: (id: string, db: string) => ['connections', id, 'database-access', 'users', db] as const,
  user: (id: string, db: string, user: string) =>
    ['connections', id, 'database-access', 'user', db, user] as const,
  roles: (id: string, db: string) => ['connections', id, 'database-access', 'roles', db] as const,
}

const base = (id: string) => path`connections/${id}/database-access`
const dbQuery = (db: string) => (db ? `?db=${encodeURIComponent(db)}` : '')

export const databaseAccessApi = {
  users: (id: string, db = '') => api.get<DbUsersAnswer>(`${base(id)}/users${dbQuery(db)}`),
  user: (id: string, db: string, user: string) =>
    api.get<DbUserDetail>(`${base(id)}${path`/users/${db}/${user}`}`),
  createUser: (id: string, input: DbUserCreate) => api.post<DbUserView>(`${base(id)}/users`, input),
  updateUser: (
    id: string,
    db: string,
    user: string,
    change: { password?: string; roles?: RoleRef[]; confirmOwn?: boolean; confirmBroad?: boolean },
  ) => api.patch<DbUserView>(`${base(id)}${path`/users/${db}/${user}`}`, change),
  grant: (id: string, db: string, user: string, roles: RoleRef[], confirmOwn?: boolean) =>
    api.post<DbUserView>(`${base(id)}${path`/users/${db}/${user}/grant`}`, {
      roles,
      ...(confirmOwn ? { confirmOwn } : {}),
    }),
  revoke: (id: string, db: string, user: string, roles: RoleRef[], confirmOwn?: boolean) =>
    api.post<DbUserView>(`${base(id)}${path`/users/${db}/${user}/revoke`}`, {
      roles,
      ...(confirmOwn ? { confirmOwn } : {}),
    }),
  dropUser: (id: string, db: string, user: string, confirmOwn = false) =>
    api.delete<void>(`${base(id)}${path`/users/${db}/${user}`}${confirmOwn ? '?confirmOwn=true' : ''}`),
  roles: (id: string, db = '') => api.get<DbRolesAnswer>(`${base(id)}/roles${dbQuery(db)}`),
  createRole: (id: string, input: DbRoleCreate) => api.post<DbRoleView>(`${base(id)}/roles`, input),
  updateRole: (id: string, db: string, role: string, change: DbRoleUpdate) =>
    api.patch<DbRoleView>(`${base(id)}${path`/roles/${db}/${role}`}`, change),
  dropRole: (id: string, db: string, role: string, confirmOwn = false) =>
    api.delete<void>(`${base(id)}${path`/roles/${db}/${role}`}${confirmOwn ? '?confirmOwn=true' : ''}`),
}
