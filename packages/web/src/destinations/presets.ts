// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { S3Preset } from '@mongo-manager/shared/browser'

/** DigitalOcean's Spaces regions; Cold Storage is offered in the same ones (Spaces availability, read 2026-10-03). */
const SPACES_REGIONS = [
  'nyc1',
  'nyc2',
  'nyc3',
  'ams3',
  'sfo2',
  'sfo3',
  'sgp1',
  'lon1',
  'fra1',
  'tor1',
  'blr1',
  'syd1',
  'atl1',
  'ric1',
  'mkc1',
  'mem1',
]

/**
 * Phase 3d-3b spec §2.3: what each provider needs. The endpoint comes from the region (and R2's
 * account id); notes are i18n keys under destinations.preset.<id>Note.
 */
export const S3_PRESET_INFO: Record<
  S3Preset,
  {
    endpoint: (region: string, account: string) => string
    region: string
    pathStyle: boolean
    account?: boolean
    regions?: string[]
    note?: boolean
  }
> = {
  aws: { endpoint: (r) => `https://s3.${r}.amazonaws.com`, region: 'us-east-1', pathStyle: false },
  minio: { endpoint: () => '', region: 'us-east-1', pathStyle: true, note: true },
  r2: {
    endpoint: (_r, a) => `https://${a}.r2.cloudflarestorage.com`,
    region: 'auto',
    pathStyle: false,
    account: true,
  },
  b2: { endpoint: (r) => `https://s3.${r}.backblazeb2.com`, region: 'us-west-004', pathStyle: false },
  spaces: {
    endpoint: (r) => `https://${r}.digitaloceanspaces.com`,
    region: 'fra1',
    pathStyle: false,
    regions: SPACES_REGIONS,
  },
  spacesCold: {
    endpoint: (r) => `https://${r}.digitaloceanspaces.com`,
    region: 'fra1',
    pathStyle: false,
    regions: SPACES_REGIONS,
    note: true,
  },
  wasabi: { endpoint: (r) => `https://s3.${r}.wasabisys.com`, region: 'eu-central-1', pathStyle: false },
  custom: { endpoint: () => '', region: 'us-east-1', pathStyle: true },
}

export const WEBDAV_PRESET_INFO = {
  generic: { note: false },
  nextcloud: { note: true },
} as const
