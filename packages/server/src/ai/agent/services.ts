// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AgentCalls } from './calls'
import { AgentRuns, CallWindow } from './runs'

/** W6.3: what the agentic assistant keeps in the server's memory. */
export interface AgentServices {
  calls: AgentCalls
  runs: AgentRuns
  /** Tool calls a minute, per person. */
  window: CallWindow
  /** "provider id|model" of models found unable to call tools, and when (their turns fall back at once). */
  unsupported: Map<string, number>
}

export function createAgentServices(now: () => number): AgentServices {
  return {
    calls: new AgentCalls(now),
    runs: new AgentRuns(),
    window: new CallWindow(now),
    unsupported: new Map(),
  }
}
