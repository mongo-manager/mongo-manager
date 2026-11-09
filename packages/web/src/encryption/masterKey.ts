// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { KmsProvider, MasterKey } from '@mongo-manager/shared/browser'

/**
 * W8: a master key as the forms edit it — one text per field, the provider's own — and as the API
 * takes it (empty optional fields left out).
 */
export interface MasterKeyForm {
  provider: KmsProvider
  region: string
  key: string
  endpoint: string
  keyVaultEndpoint: string
  keyName: string
  keyVersion: string
  projectId: string
  location: string
  keyRing: string
  keyId: string
}

export const emptyMasterKey = (provider: KmsProvider = 'local'): MasterKeyForm => ({
  provider,
  region: '',
  key: '',
  endpoint: '',
  keyVaultEndpoint: '',
  keyName: '',
  keyVersion: '',
  projectId: '',
  location: '',
  keyRing: '',
  keyId: '',
})

/** The fields each provider asks for, in order; `optional` ones may stay empty. */
export const MASTER_KEY_FIELDS: Record<KmsProvider, Array<{ key: keyof MasterKeyForm; optional?: true }>> = {
  local: [],
  aws: [{ key: 'region' }, { key: 'key' }, { key: 'endpoint', optional: true }],
  azure: [{ key: 'keyVaultEndpoint' }, { key: 'keyName' }, { key: 'keyVersion', optional: true }],
  gcp: [
    { key: 'projectId' },
    { key: 'location' },
    { key: 'keyRing' },
    { key: 'keyName' },
    { key: 'keyVersion', optional: true },
    { key: 'endpoint', optional: true },
  ],
  kmip: [
    { key: 'keyId', optional: true },
    { key: 'endpoint', optional: true },
  ],
}

export function masterKeyOf(f: MasterKeyForm): MasterKey {
  const out: Record<string, string> = { provider: f.provider }
  for (const { key } of MASTER_KEY_FIELDS[f.provider]) {
    const value = String(f[key]).trim()
    if (value) out[key] = value
  }
  return out as unknown as MasterKey
}
