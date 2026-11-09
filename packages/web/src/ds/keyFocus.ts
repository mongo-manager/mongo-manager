// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER

/**
 * When a key was last pressed anywhere in the page: a focus that follows one is the keyboard's, one
 * that comes without (a script, a dialog opening) is not (user report 2026-11-07).
 */
let last = Number.NEGATIVE_INFINITY
if (typeof document !== 'undefined')
  document.addEventListener('keydown', () => (last = Date.now()), { capture: true, passive: true })

export const lastKeyAt = (): number => last
