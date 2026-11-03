import type tls from 'node:tls'
import type { MongoClient } from 'mongodb'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { AppError } from '../errors'
import { clientSpec } from '../connections/client-spec'
import { supportedMechanism } from './proxy/upstream'
import type { OpenTunnel } from '../connections/manager'
import type { UpstreamPlan } from './manager'

/**
 * Phase 3a-1 spec §5: build a session's upstream plan from the connection. The allow-list follows
 * the connection's declared hosts and the topology the driver has discovered (so a replica-set
 * member or a +srv seed is reachable). TLS options come from clientSpec. An SSH connection dials a
 * per-session tunnel. GSSAPI, MONGODB-AWS and MONGODB-OIDC get no shell.
 */

export interface PlanDeps {
  settings: ConnectionSettings
  readOnly: boolean
  admin: boolean
  /** The manager's live client, to read the discovered topology for the allow-list. */
  client?: MongoClient
  openTunnel?: OpenTunnel
}

/**
 * The worker may reach the declared hosts plus any the driver's topology currently reports. The
 * topology is read live on every check (not snapshotted at open), so a replica-set member added
 * after the shell opened — or a new primary — becomes reachable as soon as the driver discovers it,
 * while an unrelated host is still refused (spec §5, Review Focus 1).
 */
function makeAllowHost(
  settings: ConnectionSettings,
  client?: MongoClient,
): (host: string, port: number) => boolean {
  const declared = new Set(settings.hosts.map((h) => `${h.host}:${h.port ?? 27017}`))
  const topology = () =>
    (client as unknown as { topology?: { description?: { servers?: Map<string, unknown> } } })?.topology
      ?.description?.servers
  return (host: string, port: number): boolean => {
    const key = `${host}:${port}`
    return declared.has(key) || topology()?.has(key) === true
  }
}

export async function buildUpstreamPlan(deps: PlanDeps): Promise<UpstreamPlan> {
  const { settings } = deps
  if (!supportedMechanism(settings)) {
    throw new AppError(
      'SHELL_UNSUPPORTED_AUTH',
      `The shell does not support ${settings.auth?.mechanism} authentication`,
      409,
    )
  }

  // TLS options from the connection (CA, client cert), without a URI or credentials.
  const spec = clientSpec(settings)
  const tlsOptions: tls.ConnectionOptions | null = settings.tls?.enabled
    ? {
        ...(spec.options.ca ? { ca: spec.options.ca as string } : {}),
        ...(spec.options.cert ? { cert: spec.options.cert as string } : {}),
        ...(spec.options.key ? { key: spec.options.key as string } : {}),
        ...(spec.options.passphrase ? { passphrase: spec.options.passphrase } : {}),
        ...(settings.tls.allowInvalidCertificates ? { rejectUnauthorized: false } : {}),
        servername: settings.hosts[0]!.host,
      }
    : null

  const allowHost = makeAllowHost(settings, deps.client)

  // SSH: open a per-session tunnel and dial its local endpoint for every target.
  if (settings.ssh?.enabled) {
    if (!deps.openTunnel)
      throw new AppError('SHELL_UNSUPPORTED_AUTH', 'SSH tunnels are not available for the shell', 409)
    const target = settings.hosts[0]!
    const tunnel = await deps.openTunnel(settings.ssh, { host: target.host, port: target.port ?? 27017 })
    return {
      settings,
      readOnly: deps.readOnly,
      admin: deps.admin,
      allowHost, // the worker still names the declared host
      tls: tlsOptions,
      dial: () => ({ host: '127.0.0.1', port: tunnel.localPort, socks: tunnel.credentials }),
      release: () => void tunnel.close().catch(() => undefined),
    }
  }

  return { settings, readOnly: deps.readOnly, admin: deps.admin, allowHost, tls: tlsOptions }
}
