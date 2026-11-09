// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { tgz, type TarSpec } from '../../../shared/test/tarFixture'

// The archive builder is shared with the updater's tests (2026-11-03).
export { pax, tar, tgz, type TarSpec } from '../../../shared/test/tarFixture'

/** A valid plugin's manifest. */
export const manifestOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'hello',
    name: { en: 'Hello', tr: 'Merhaba' },
    version: '1.0.0',
    entry: 'index.html',
    permissions: ['documents:read'],
    contributes: { collectionTabs: [{ id: 'hi', title: { en: 'Hi' } }] },
    ...over,
  })

/** A small valid plugin archive. */
export const helloPlugin = (over: Record<string, unknown> = {}, extra: TarSpec[] = []) =>
  tgz([
    { name: 'mongo-manager-plugin.json', data: manifestOf(over) },
    { name: 'index.html', data: '<!doctype html><script src="app.js"></script>' },
    { name: 'app.js', data: 'parent.postMessage({ id: 1, method: "context.get" }, "*")' },
    ...extra,
  ])
