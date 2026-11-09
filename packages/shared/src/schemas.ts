// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

// MongoDB forbids these in database names on at least one platform; reject them everywhere.
const INVALID_DB_CHARS = /[/\\. "$*<>:|?\0]/

export const DatabaseNameSchema = z
  .string()
  .min(1, 'Database name is required')
  .refine((s) => byteLength(s) <= 63, 'Database name must be at most 63 bytes')
  .refine((s) => !INVALID_DB_CHARS.test(s), 'Database name contains an invalid character')

export const CollectionNameSchema = z
  .string()
  .min(1, 'Collection name is required')
  .refine((s) => byteLength(s) <= 255, 'Collection name must be at most 255 bytes')
  .refine(
    (s) => !s.includes('$') && !s.includes('\0'),
    'Collection name cannot contain "$" or null characters',
  )

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
})

export type Pagination = z.infer<typeof PaginationSchema>

export const UsernameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]{3,64}$/,
    'Username must be 3–64 characters: letters, digits, dot, underscore or hyphen',
  )
