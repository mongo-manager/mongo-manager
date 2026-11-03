import { deserializeValue, formatShell, type QueryOrigin } from '@mongo-manager/shared/browser'

/**
 * Phase 3a-1 spec §6: render a worker result part as mongosh-like text. The worker sends canonical
 * EJSON; the browser turns it into shell text with the shared formatter. The caller passes each
 * line through writeSafe before writing it to the terminal.
 */
export interface ResultPart {
  type: 'print' | 'result' | 'error' | 'reset'
  text?: string
  value?: unknown
  resultType?: string | null
  message?: string
  /** Phase 3a-2: the query a cursor result came from, and whether the cursor has more. */
  origin?: QueryOrigin
  hasMore?: boolean
}

export function formatResult(part: ResultPart): string {
  if (part.type === 'print') return part.text ?? ''
  if (part.type === 'error') return part.message ?? 'Error'
  if (part.type === 'reset') return part.message ?? 'The shell was reset'
  // A result value: EJSON → shell text. undefined prints nothing (mongosh shows a blank line).
  if (part.value === undefined || part.value === null) return part.value === null ? 'null' : ''
  // A string is written as it is, as mongosh writes one ("switched to db shop", not in quotes).
  if (typeof part.value === 'string') return part.value
  let text: string
  try {
    text = formatShell(deserializeValue(part.value), { indent: 2 })
  } catch {
    text = String(part.value)
  }
  // Phase 3a-2: like mongosh, a cursor batch with more says how to see the rest.
  return part.hasMore ? `${text}\nType "it" for more` : text
}
