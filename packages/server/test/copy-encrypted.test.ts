// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { copyEncryption, encryptionRefusals } from '../src/transfer/copy-plan'
import { encryptedFields, isCsfleCollection } from '../src/encryption/fields'

const qe = {
  name: 'patients',
  type: 'collection',
  options: { encryptedFields: { fields: [{ path: 'ssn', bsonType: 'string' }] } },
}
const csfle = {
  name: 'people',
  type: 'collection',
  options: {
    validator: {
      $jsonSchema: {
        properties: {
          ssn: { encrypt: { bsonType: 'string', algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' } },
          address: { bsonType: 'object', properties: { street: { encrypt: { bsonType: 'string' } } } },
        },
      },
    },
  },
}
const plain = { name: 'orders', type: 'collection', options: {} }

describe('W8: copies and encrypted collections', () => {
  // Their encrypted values are tied to the source's encryption metadata (enxcol_ collections and
  // the key vault): a copy elsewhere would be unreadable or corrupt. Refused, never silently skipped.
  it('refuses a copy that includes a Queryable Encryption collection, naming the reason', () => {
    expect(copyEncryption(qe)).toBe('queryable')
    expect(encryptionRefusals([{ encryption: 'queryable' }, { encryption: null }])).toEqual([
      'encrypted_collection',
    ])
    expect(encryptionRefusals([{ encryption: 'ciphertext' }, { encryption: null }])).toEqual([])
  })

  it('copies a CSFLE collection as stored: ciphertext, never decrypted', () => {
    expect(copyEncryption(csfle)).toBe('ciphertext')
    expect(copyEncryption(plain)).toBeNull()
  })

  it('reads the encrypted paths of a validator, nested ones too', () => {
    expect(isCsfleCollection(csfle.options)).toBe(true)
    expect(isCsfleCollection(plain.options)).toBe(false)
    expect(encryptedFields(csfle.options, 'shop.people').fields.map((f) => [f.path, f.kind])).toEqual([
      ['ssn', 'random'],
      ['address.street', 'random'],
    ])
  })
})
