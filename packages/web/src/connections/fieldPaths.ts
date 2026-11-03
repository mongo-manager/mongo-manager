import type { Section } from './formModel'

/** Server issues keyed by path without the "settings." prefix; issues without a path are general. */
export function fieldErrors(details: unknown): { fields: Record<string, string>; general: string[] } {
  const fields: Record<string, string> = {}
  const general: string[] = []
  if (!Array.isArray(details)) return { fields, general }
  for (const issue of details as Array<{ path?: unknown; message?: unknown }>) {
    if (typeof issue?.path !== 'string' || typeof issue.message !== 'string') continue
    const key = issue.path.replace(/^settings\.?/, '')
    if (!key) general.push(issue.message)
    else if (!(key in fields)) fields[key] = issue.message
  }
  return { fields, general }
}

const SECTION_BY_ROOT: Record<string, Section> = {
  name: 'general',
  group: 'general',
  color: 'general',
  favorite: 'general',
  readOnly: 'general',
  aiPolicy: 'general',
  aiAgentWrites: 'general',
  aiAgentToolsOff: 'general',
  scheme: 'server',
  hosts: 'server',
  defaultDatabase: 'server',
  replicaSet: 'server',
  directConnection: 'server',
  auth: 'auth',
  tls: 'tls',
  ssh: 'ssh',
  encryption: 'encryption',
}

export const sectionOf = (key: string): Section => SECTION_BY_ROOT[key.split('.')[0]!] ?? 'advanced'

/** Field keys that some section renders next to its control; anything else is listed in the alert. */
const RENDERED = [
  /^(name|group)$/,
  /^hosts(\.\d+\.(host|port))?$/,
  /^(defaultDatabase|replicaSet)$/,
  /^auth\.(mechanism|username|password|authSource|mechanismProperties)$/,
  /^auth\.oidc\.(redirectUri|expectedIssuer|allowedHosts|environment|tokenResource)(\.\d+)?$/,
  /^auth\.kerberos\.(serviceName|serviceRealm|canonicalizeHostName)$/,
  /^encryption\.(keyVaultNamespace|kms|cryptSharedLibPath|mongocryptdUri|schemaMap|encryptedFieldsMap)$/,
  /^encryption\.kms\.(local|aws|azure|gcp|kmip)\.\w+$/,
  /^tls\.(caPem|certificateKeyPem|certificateKeyPassword)$/,
  /^ssh(\.(host|port|username|password|privateKey|passphrase|hostFingerprint))?$/,
  /^(readPreference|appName|connectTimeoutMS|serverSelectionTimeoutMS)$/,
  /^options\.\w+$/,
  // Second review of C5 (M2): the agent's tools, shown in the General section's list.
  /^aiAgentToolsOff(\.\d+)?$/,
]

export const isRenderedConnectionField = (key: string): boolean => RENDERED.some((re) => re.test(key))
