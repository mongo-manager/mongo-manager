import type { ServerContext } from '../http/context'
import { MAX_HISTORY_CONNECTIONS } from './history'

/**
 * W3 review (M1): one cap on the connections the server samples on its own, whatever asks it —
 * metric history, or an alert rule's thresholds (both read the same sample). A connection already
 * sampled always has room; a new one only while fewer than MAX_HISTORY_CONNECTIONS are.
 */
export function samplingRoom(ctx: ServerContext, connectionId: string): boolean {
  const sampled = new Set([...ctx.metricHistory.enabled(), ...ctx.alerts.repo.metricConnections()])
  return sampled.has(connectionId) || sampled.size < MAX_HISTORY_CONNECTIONS
}
