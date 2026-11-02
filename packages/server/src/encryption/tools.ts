import { ClientEncryption, type Binary, type Db, type Document, type MongoClient } from 'mongodb'
import type { ConnectionSettings, MasterKey } from '@mongo-manager/shared'
import type { Egress } from '../net/egress'
import { kmsConnect, kmsProvidersFor } from './options'
import type { ConnectionPolicy } from '../connections/policy'

/**
 * W8 (completion): what the data-key and encrypted-collection routes ask of the driver's
 * ClientEncryption (which needs mongodb-client-encryption; tests give a fake). Its sockets to key
 * management services go through the egress guard, as automatic encryption's do.
 */
export interface EncryptionTools {
  createDataKey(provider: string, options: { masterKey?: Document; keyAltNames?: string[] }): Promise<Binary>
  rewrapManyDataKey(
    filter: Document,
    options: { provider: string; masterKey?: Document },
  ): Promise<{ bulkWriteResult?: { modifiedCount?: number } }>
  createEncryptedCollection(
    db: Db,
    name: string,
    options: {
      provider: string
      masterKey?: Document
      createCollectionOptions: { encryptedFields: Document }
    },
  ): Promise<{ encryptedFields: Document }>
}

export type EncryptionToolsFactory = (
  client: MongoClient,
  settings: ConnectionSettings,
) => Promise<EncryptionTools>

export function encryptionToolsFactory(
  egress: Pick<Egress, 'socket'>,
  policy: () => ConnectionPolicy,
): EncryptionToolsFactory {
  return async (client, settings) => {
    const e = settings.encryption!
    return new ClientEncryption(client, {
      keyVaultNamespace: e.keyVaultNamespace,
      kmsProviders: kmsProvidersFor(e),
      // Security review C1: the same KMS hosts as automatic encryption, then the egress guard.
      kmsConnectCallback: kmsConnect(settings, policy(), egress.socket!),
    }) as unknown as EncryptionTools
  }
}

/** A master key as the driver takes it (its provider apart; nothing for a local key). */
export function masterKeyOf(m: MasterKey): Document | undefined {
  const { provider: _provider, ...rest } = m
  return Object.keys(rest).length ? rest : undefined
}
