// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Security audit 2026-10-16: how long the app's confirmation keeps its Confirm from being pressed
 * once it shows. A plugin's page could put a button where Confirm appears: the second click of a
 * double-click begun there would answer the app's question. Every confirmation waits this long, and
 * takes a pointer's click only from a press that began after the wait. The unit tests set it to 0
 * (test/support/setup.ts); the guard's own tests set it back.
 */
export const confirmGuard = { armMs: 600 }
