// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount, reactive, type MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AiLine, AiRequestBody, AiSent, AiStatus } from '@mongo-manager/shared'
import { ApiError } from '@/api/client'
import { aiApi, aiKeys } from '@/api/ai'
import type { CollectionTarget } from '@/api/documents'
import type { ConnectionDto } from '@/api/connections'

export function useAiStatus(enabled: MaybeRef<boolean> = true) {
  return useQuery({ queryKey: aiKeys.status, queryFn: aiApi.status, staleTime: 60_000, enabled })
}

/** Spec §6: Ask AI is offered where the server has a provider, the caller ai:use, the connection a policy. */
export function aiOffered(status: AiStatus | undefined, connection: ConnectionDto | undefined): boolean {
  return (
    !!status?.enabled &&
    !!connection &&
    connection.aiPolicy !== 'off' &&
    connection.permissions.includes('ai:use') &&
    connection.permissions.includes('documents:read')
  )
}

type Done = Extract<AiLine, { type: 'done' }>
export interface AiRun {
  state: 'idle' | 'sending' | 'streaming' | 'done' | 'error' | 'stopped'
  text: string
  sent: AiSent | null
  provider: Extract<AiLine, { type: 'context' }>['provider'] | null
  done: Done | null
  error: { reason: string; retryAfterMs?: number; nothingSent?: boolean } | null
}

/** Spec §1.2: one request at a time; Stop (or leaving) aborts it, and keeps what came. */
export function useAiRequest() {
  const run = reactive<AiRun>({
    state: 'idle',
    text: '',
    sent: null,
    provider: null,
    done: null,
    error: null,
  })
  let controller: AbortController | null = null

  function apply(line: AiLine): void {
    if (line.type === 'context') {
      run.sent = line.sent
      run.provider = line.provider
      run.state = 'streaming'
    } else if (line.type === 'text') run.text += line.delta
    else if (line.type === 'done') {
      run.done = line
      run.state = 'done'
    } else {
      run.error = {
        reason: line.reason,
        ...(line.retryAfterMs !== undefined ? { retryAfterMs: line.retryAfterMs } : {}),
        ...(line.nothingSent ? { nothingSent: true } : {}),
      }
      run.state = 'error'
    }
  }

  async function send(target: CollectionTarget, body: AiRequestBody): Promise<void> {
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    Object.assign(run, { state: 'sending', text: '', sent: null, provider: null, done: null, error: null })
    try {
      await aiApi.ask(target, body, (line) => controller === mine && apply(line), mine.signal)
      if (controller === mine && (run.state === 'sending' || run.state === 'streaming')) {
        run.error = { reason: 'provider_error' }
        run.state = 'error'
      }
    } catch (e) {
      if (mine.signal.aborted || controller !== mine) return
      const d = (e instanceof ApiError ? e.details : undefined) as
        { reason?: string; retryAfterMs?: number } | undefined
      run.error = {
        // A refusal without a reason of its own (the request's shape): most often a page older or newer
        // than the server after an update — said as such, not as the provider's failure.
        reason:
          d?.reason ??
          (e instanceof ApiError
            ? e.code === 'VALIDATION_ERROR'
              ? 'invalid_request'
              : e.code
            : 'unreachable'),
        ...(d?.retryAfterMs !== undefined ? { retryAfterMs: d.retryAfterMs } : {}),
      }
      run.state = 'error'
    }
  }

  function stop(): void {
    if (!controller) return
    controller.abort()
    controller = null
    if (run.state === 'sending' || run.state === 'streaming') run.state = 'stopped'
  }

  /** Forgets the last answer (another task was chosen: that answer was not for it). */
  function reset(): void {
    stop()
    Object.assign(run, { state: 'idle', text: '', sent: null, provider: null, done: null, error: null })
  }

  onBeforeUnmount(stop)
  return { run, send, stop, reset }
}
