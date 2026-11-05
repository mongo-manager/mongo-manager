// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Review of wave 2 (I1): a user has two aggregation runs at a time (the server's run slots). The
 * Overview's data KPIs run one after another, so one is always left for the user's own run; a KPI that
 * goes away before its turn (its signal aborted) does not run at all.
 */
let tail: Promise<unknown> = Promise.resolve()

export function oneAtATime<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const turn = tail.then(() => {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    return work()
  })
  tail = turn.catch(() => undefined)
  return turn
}
