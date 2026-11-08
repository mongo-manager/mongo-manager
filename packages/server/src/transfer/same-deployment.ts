// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { MongoClient } from 'mongodb'
import type { Deployment } from '@mongo-manager/shared'

export interface DeploymentId {
  kind: 'standalone' | 'replicaSet' | 'mongos'
  processId?: string
  setName?: string
  hosts?: string[]
  clusterId?: string
  /** Phase 3e-2: a replica set's own id (its config's settings.replicaSetId), where it can be read. */
  replicaSetId?: string
}

const lower = (hosts: unknown): string[] =>
  Array.isArray(hosts)
    ? hosts.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())
    : []

/**
 * Phase 3d-2 spec §5.5 (plan ruling 2): what identifies the deployment behind a client. A standalone
 * server is one process (hello.topologyVersion.processId); a replica set is its name and members; a
 * sharded cluster is its clusterId (readable only with access to config).
 */
export async function deploymentOf(client: MongoClient): Promise<DeploymentId> {
  const hello = await client.db('admin').command({ hello: 1 })
  if (hello.msg === 'isdbgrid') {
    let clusterId: string | undefined
    try {
      const version = await client
        .db('config')
        .collection('version')
        .findOne({}, { projection: { clusterId: 1 } })
      if (version?.clusterId) clusterId = String(version.clusterId)
    } catch {
      // No access to config: the cluster stays unknown.
    }
    return { kind: 'mongos', ...(clusterId ? { clusterId } : {}) }
  }
  if (typeof hello.setName === 'string') {
    let replicaSetId: string | undefined
    try {
      const reply = await client.db('admin').command({ replSetGetConfig: 1 })
      const id = (reply.config as { settings?: { replicaSetId?: unknown } } | undefined)?.settings
        ?.replicaSetId
      if (id) replicaSetId = String(id)
    } catch {
      // Without the right to read the set's config: its name and members only.
    }
    return {
      kind: 'replicaSet',
      setName: hello.setName,
      hosts: [...lower(hello.hosts), ...lower(hello.passives), ...lower(hello.arbiters)],
      ...(replicaSetId ? { replicaSetId } : {}),
    }
  }
  const pid = (hello.topologyVersion as { processId?: unknown } | undefined)?.processId
  return { kind: 'standalone', ...(pid ? { processId: String(pid) } : {}) }
}

export function compareDeployments(a: DeploymentId, b: DeploymentId): Deployment {
  if (a.kind === 'standalone' && b.kind === 'standalone')
    return a.processId && b.processId ? (a.processId === b.processId ? 'same' : 'different') : 'unknown'
  if (a.kind === 'replicaSet' && b.kind === 'replicaSet') {
    // Phase 3e-2: the set's own id decides; two sets both named "rs0" are told apart by it.
    if (a.replicaSetId && b.replicaSetId) return a.replicaSetId === b.replicaSetId ? 'same' : 'different'
    if (a.setName !== b.setName) return 'different'
    return (a.hosts ?? []).some((h) => (b.hosts ?? []).includes(h)) ? 'same' : 'unknown'
  }
  if (a.kind === 'mongos' && b.kind === 'mongos')
    return a.clusterId && b.clusterId ? (a.clusterId === b.clusterId ? 'same' : 'different') : 'unknown'
  // A standalone server is never a member of a replica set; a mongos may front one.
  if (
    (a.kind === 'standalone' && b.kind === 'replicaSet') ||
    (a.kind === 'replicaSet' && b.kind === 'standalone')
  )
    return 'different'
  return 'unknown'
}
