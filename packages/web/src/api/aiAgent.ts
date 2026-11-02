import type { AiAgentPolicy, AiAgentPreference, AiAgentTurnBody, AiChatLine } from '@mongo-manager/shared'
import { readNdjson } from '@/aggregation/ndjson'
import { api, path } from './client'

export const aiAgentKeys = {
  preference: ['ai', 'agent', 'preference'] as const,
  policy: ['ai', 'agent', 'policy'] as const,
}

/** The person's answer to a change, and how the change ended. */
export interface AgentDecisionBody {
  call: string
  decision: 'confirm' | 'decline' | 'backup'
  confirm?: string
  password?: string
  /** C4: the password of the backup the card makes first. */
  backupPassword?: string
}
export type AgentDecisionResult =
  | { state: 'done'; summary: Record<string, number | string | boolean> }
  /** C4: the backup the card asked for is being made, as this job (or was made already). */
  | { state: 'backing_up' | 'backed_up'; job: string }
  | { state: 'declined' | 'expired' | 'cancelled' }
  | { state: 'error'; reason: string }

/** W6.3: the agentic assistant. */
export const aiAgentApi = {
  preference: () => api.get<AiAgentPreference>('me/ai-agent'),
  setPreference: (on: boolean) => api.put<AiAgentPreference>('me/ai-agent', { on }),
  /** Design 2026-10-25 (A2): what an administrator allows the agent on this server. */
  policy: () => api.get<AiAgentPolicy>('ai/agent-policy'),
  setPolicy: (policy: AiAgentPolicy['policy']) => api.put<AiAgentPolicy>('ai/agent-policy', { policy }),
  /** One agent turn; its lines handed over a network chunk at a time (it waits for each change's answer). */
  async send(body: AiAgentTurnBody, onLine: (line: AiChatLine) => void, signal: AbortSignal): Promise<void> {
    const stream = await api.stream('ai/agent', body, { signal })
    await readNdjson(stream, (lines) => lines.forEach((l) => onLine(l as AiChatLine)), undefined, signal)
  },
  decide: (run: string, body: AgentDecisionBody) =>
    api.post<AgentDecisionResult>(path`ai/agent/runs/${run}/decide`, body),
}
