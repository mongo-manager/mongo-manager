import type { Config } from '../config'
import { createEgress, type Egress, type LookupFn } from '../net/egress'

/** Loopback, allowed to the assistant in local mode (one user on a loopback bind): a local Ollama. */
export const LOOPBACK_NETWORKS = ['127.0.0.0/8', '::1/128'] as const

/** Phase 4a-1 spec §2.2: connect 10 s, nothing for 60 s ends it, the whole answer within 3 min. */
export const AI_NET = { connectMs: 10_000, idleMs: 60_000, totalMs: 180_000 } as const

export function aiNetworks(config: Config): string[] {
  return config.auth ? [...config.ai.privateNetworks] : [...config.ai.privateNetworks, ...LOOPBACK_NETWORKS]
}

/** The assistant's own outbound client (never the backup destinations'). */
export function createAiEgress(config: Config, lookup?: LookupFn): Egress {
  return createEgress({
    networks: aiNetworks(config),
    networksSetting: 'MM_AI_PRIVATE_NETWORKS',
    connectTimeoutMs: AI_NET.connectMs,
    idleTimeoutMs: AI_NET.idleMs,
    ...(lookup ? { lookup } : {}),
  })
}
