// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach } from 'vitest'
import { overLimit, resetWaits, waitsOf } from './wait-budget'

// Review of the wait budget (minor 2): counted per try, so a retry starts at nothing.
beforeEach(({ task }) => resetWaits(task))

// Every test's job waits fit in its limit, so a wait that runs out can say why (wait-budget.ts).
afterEach(({ task }) => {
  const why = overLimit(waitsOf(task), task.timeout)
  if (why) throw new Error(`This test ${why}.`)
})
