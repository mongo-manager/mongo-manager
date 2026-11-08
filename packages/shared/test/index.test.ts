// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, it } from 'vitest'
import * as shared from '../src/index'

it('exposes the public API', () => {
  for (const name of [
    'ERROR_CODES',
    'PERMISSIONS',
    'ROLES',
    'ROLE_PERMISSIONS',
    'DATA_WRITE_PERMISSIONS',
    'permissionsFor',
    'isPermission',
    'toWire',
    'fromWire',
    'serializeValue',
    'deserializeValue',
    'bsonTypeOf',
    'parseShellExpression',
    'parseQueryObject',
    'parsePipeline',
    'QueryParseError',
    'MAX_DEPTH',
    'MAX_INPUT_LENGTH',
    'formatShell',
    'DatabaseNameSchema',
    'CollectionNameSchema',
    'PaginationSchema',
    'UsernameSchema',
    'parseConnectionUri',
    'buildConnectionUri',
    'maskSecrets',
    'mergeSecrets',
    'ConnectionSettingsSchema',
    'SECRET_MASK',
    // Phase 3d-1: file import and export.
    'TRANSFER_FORMATS',
    'FIELD_TYPES',
    'DialectSchema',
    'TransferPreviewRequestSchema',
    'MappingEntrySchema',
    'ConstantSchema',
    'ImportRequestSchema',
    'ExportSourceSchema',
    'ExportRequestSchema',
    'PresetBodySchema',
    'PresetSchema',
  ]) {
    expect(shared, name).toHaveProperty(name)
  }
})
