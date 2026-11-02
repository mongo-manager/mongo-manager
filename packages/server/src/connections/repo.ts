import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type AiPolicy,
  buildConnectionUri,
  maskSecrets,
  withoutRefusedOptions,
  type ConnectionColor,
  type ConnectionInput,
  type ConnectionPatch,
  type ConnectionSettings,
  type SshSettings,
  AI_AGENT_CONNECTION_TOOLS,
  type AiAgentTool,
} from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'

export interface ConnectionRecord {
  id: string
  name: string
  group: string | null
  color: ConnectionColor | null
  favorite: boolean
  readOnly: boolean
  /** Phase 4a-1 spec §2.4: the AI assistant on this connection. */
  aiPolicy: AiPolicy
  /** W6.3: the agentic assistant may propose changes here (each one still needs the person's click). */
  aiAgentWrites: boolean
  /** C5: the agent's tools turned off here. */
  aiAgentToolsOff: AiAgentTool[]
  settings: ConnectionSettings
  createdBy: string | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export type ConnectionDto = Omit<ConnectionRecord, 'createdBy'> & { uri: string }

interface Row {
  id: string
  name: string
  grp: string | null
  color: string | null
  favorite: number
  read_only: number
  ai_policy: AiPolicy
  ai_agent_writes?: number
  ai_agent_tools_off?: string
  settings: string
  created_by: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
}

const settingsContext = (id: string) => `connection:${id}:settings`

export function toConnectionDto(r: ConnectionRecord): ConnectionDto {
  return {
    id: r.id,
    name: r.name,
    group: r.group,
    color: r.color,
    favorite: r.favorite,
    readOnly: r.readOnly,
    aiPolicy: r.aiPolicy,
    aiAgentWrites: r.aiAgentWrites,
    aiAgentToolsOff: r.aiAgentToolsOff,
    settings: maskSecrets(r.settings),
    uri: buildConnectionUri(r.settings),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
  }
}

export class ConnectionRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private toRecord(r: Row): ConnectionRecord {
    return {
      id: r.id,
      name: r.name,
      group: r.grp,
      color: r.color as ConnectionColor | null,
      favorite: r.favorite === 1,
      readOnly: r.read_only === 1,
      aiPolicy: r.ai_policy ?? 'any',
      aiAgentWrites: r.ai_agent_writes !== 0,
      aiAgentToolsOff: toolsOff(r.ai_agent_tools_off),
      // Settings stored before an option was refused (timeoutMS) open without it.
      settings: withoutRefusedOptions(
        JSON.parse(this.box.open(r.settings, settingsContext(r.id))) as ConnectionSettings,
      ),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
    }
  }

  private seal(id: string, settings: ConnectionSettings): string {
    return this.box.seal(JSON.stringify(settings), settingsContext(id))
  }

  /** Phase 4a-1: callers that predate the AI policy leave it out (any). */
  create(
    input: Omit<ConnectionInput, 'aiPolicy' | 'aiAgentWrites' | 'aiAgentToolsOff'> & {
      aiPolicy?: AiPolicy
      aiAgentWrites?: boolean
      aiAgentToolsOff?: AiAgentTool[]
    },
    createdBy: string | null,
  ): ConnectionRecord {
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO connections (id, name, grp, color, favorite, read_only, settings, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.group ?? null,
        input.color ?? null,
        input.favorite ? 1 : 0,
        input.readOnly ? 1 : 0,
        this.seal(id, input.settings),
        createdBy,
        t,
        t,
      )
    // The column's default is 'any': written only when another policy is asked (a store migrated
    // before phase 4a-1 has no column to write).
    if (input.aiPolicy && input.aiPolicy !== 'any') this.setAiPolicy(id, input.aiPolicy)
    if (input.aiAgentWrites === false) this.setAiAgentWrites(id, false)
    if (input.aiAgentToolsOff?.length) this.setAiAgentToolsOff(id, input.aiAgentToolsOff)
    this.vaults = null
    return this.get(id)!
  }

  get(id: string): ConnectionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as
      Row | undefined
    return row && this.toRecord(row)
  }

  list(): ConnectionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM connections ORDER BY favorite DESC, name COLLATE NOCASE')
      .all() as unknown as Row[]
    return rows.map((r) => this.toRecord(r))
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n
  }

  update(id: string, patch: ConnectionPatch): ConnectionRecord | undefined {
    const current = this.get(id)
    if (!current) return undefined
    const next = {
      name: patch.name ?? current.name,
      group: patch.group === undefined ? current.group : patch.group,
      color: patch.color === undefined ? current.color : patch.color,
      favorite: patch.favorite ?? current.favorite,
      readOnly: patch.readOnly ?? current.readOnly,
      settings: patch.settings ?? current.settings,
    }
    this.db
      .prepare(
        'UPDATE connections SET name = ?, grp = ?, color = ?, favorite = ?, read_only = ?, settings = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.group,
        next.color,
        next.favorite ? 1 : 0,
        next.readOnly ? 1 : 0,
        this.seal(id, next.settings),
        this.now(),
        id,
      )
    this.vaults = null
    return this.get(id)
  }

  /** Phase 4a-1 spec §2.4: the AI policy is its own column (plan ruling 10). */
  setAiPolicy(id: string, policy: AiPolicy): void {
    this.db.prepare('UPDATE connections SET ai_policy = ? WHERE id = ?').run(policy, id)
  }

  /** W6.3: the agent's writes on this connection, a column of its own like the AI policy. */
  setAiAgentWrites(id: string, on: boolean): void {
    this.db.prepare('UPDATE connections SET ai_agent_writes = ? WHERE id = ?').run(on ? 1 : 0, id)
  }

  /** C5: the agent's tools turned off here, kept as the agent lists them. */
  setAiAgentToolsOff(id: string, tools: readonly AiAgentTool[]): void {
    const kept = AI_AGENT_CONNECTION_TOOLS.filter((t) => tools.includes(t))
    this.db
      .prepare('UPDATE connections SET ai_agent_tools_off = ? WHERE id = ?')
      .run(JSON.stringify(kept), id)
  }

  /**
   * Trust on first use: `dialled` is the SSH host the key came from. An open that began before an
   * edit pins nothing onto settings that point at another host, nor over a key already pinned
   * (review of the open's stop, minor 6).
   */
  setSshFingerprint(id: string, fingerprint: string, dialled: Pick<SshSettings, 'host' | 'port'>): void {
    const current = this.get(id)
    const ssh = current?.settings.ssh
    if (!current || !ssh?.enabled || ssh.hostFingerprint) return
    // The host and port, as a form keeps a pin (withStoredPin): another account sees the same key.
    if (ssh.host !== dialled.host || ssh.port !== dialled.port) return
    const settings = { ...current.settings, ssh: { ...ssh, hostFingerprint: fingerprint } }
    this.db.prepare('UPDATE connections SET settings = ? WHERE id = ?').run(this.seal(id, settings), id)
  }

  touch(id: string): void {
    this.db.prepare('UPDATE connections SET last_used_at = ? WHERE id = ?').run(this.now(), id)
  }

  delete(id: string): boolean {
    this.vaults = null
    return Number(this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes) === 1
  }

  /**
   * Security review C1: the key vault namespaces the connections name (client-side encryption on),
   * kept until a connection changes — every namespace check asks for them.
   */
  private vaults: ReadonlySet<string> | null = null
  keyVaultNamespaces(): ReadonlySet<string> {
    this.vaults ??= new Set(
      this.list()
        .map((c) => c.settings.encryption)
        .filter((e) => e?.enabled)
        .map((e) => e!.keyVaultNamespace),
    )
    return this.vaults
  }
}

/** C5: a stored list of tools off — names the agent no longer has, or not a list, dropped. */
function toolsOff(stored: string | undefined): AiAgentTool[] {
  try {
    const list: unknown = JSON.parse(stored ?? '[]')
    return Array.isArray(list) ? AI_AGENT_CONNECTION_TOOLS.filter((t) => list.includes(t)) : []
  } catch {
    return []
  }
}
