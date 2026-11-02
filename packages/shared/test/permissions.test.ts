import { describe, expect, it } from 'vitest'
import {
  DATA_WRITE_PERMISSIONS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  isPermission,
  permissionsFor,
} from '../src/permissions'

describe('permissions', () => {
  it('gives admin every permission', () => {
    expect([...permissionsFor('admin')].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('limits viewer to read permissions', () => {
    expect([...ROLE_PERMISSIONS.viewer].sort()).toEqual(
      ['aggregation:run', 'connections:read', 'databases:read', 'documents:read'].sort(),
    )
  })

  it('does not give editor user management, audit, settings, connection management or shell', () => {
    const editor = permissionsFor('editor')
    for (const p of [
      'users:manage',
      'audit:read',
      'settings:manage',
      'connections:manage',
      'shell:execute',
    ] as const) {
      expect(editor.has(p)).toBe(false)
    }
    expect(editor.has('documents:write')).toBe(true)
  })

  it('lets editors watch a server but only admins see command text and kill operations (phase 1i §2)', () => {
    expect(permissionsFor('editor').has('server:monitor')).toBe(true)
    expect(permissionsFor('editor').has('server:operations')).toBe(false)
    expect(permissionsFor('viewer').has('server:monitor')).toBe(false)
    expect(permissionsFor('admin').has('server:operations')).toBe(true)
    // Watching is not a data write; read-only mode keeps it.
    expect(permissionsFor('editor', { readOnly: true }).has('server:monitor')).toBe(true)
  })

  it('strips data writes in read-only mode but keeps admin management', () => {
    const admin = permissionsFor('admin', { readOnly: true })
    for (const p of DATA_WRITE_PERMISSIONS) expect(admin.has(p)).toBe(false)
    expect(admin.has('users:manage')).toBe(true)
    expect(admin.has('documents:read')).toBe(true)
  })

  it('adds explicit grants, still filtered by read-only', () => {
    expect(permissionsFor('editor', { grants: ['shell:execute'] }).has('shell:execute')).toBe(true)
    expect(
      permissionsFor('viewer', { grants: ['documents:write'], readOnly: true }).has('documents:write'),
    ).toBe(false)
  })

  it('lets admins and editors export, not viewers (phase 3d-1)', () => {
    expect(permissionsFor('admin').has('data:export')).toBe(true)
    expect(permissionsFor('editor').has('data:export')).toBe(true)
    expect(permissionsFor('viewer').has('data:export')).toBe(false)
    expect(permissionsFor('editor', { readOnly: true }).has('data:export')).toBe(true)
  })

  it('gives MongoDB users, roles and sharding (databases:admin) to admins only (W3)', () => {
    expect(permissionsFor('admin').has('databases:admin')).toBe(true)
    expect(permissionsFor('editor').has('databases:admin')).toBe(false)
    expect(permissionsFor('viewer').has('databases:admin')).toBe(false)
    // Read-only mode keeps the listing; each change refuses itself there (it is not a data write).
    expect(DATA_WRITE_PERMISSIONS.has('databases:admin')).toBe(false)
    expect(isPermission('databases:admin')).toBe(true)
  })

  it('validates permission strings', () => {
    expect(isPermission('documents:read')).toBe(true)
    expect(isPermission('documents:nuke')).toBe(false)
    expect(isPermission('constructor')).toBe(false)
  })
})
