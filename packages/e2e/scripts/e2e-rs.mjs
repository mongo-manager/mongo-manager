// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// W5 (completion §2 W5.4): the replica-set end-to-end tests — Watch and Live sync — on the memory
// server's replica set, as CI runs them, and failing (never skipping) without one. Build first
// (`pnpm build`: the server serves the built web app), then, from the repository root:
//
//   pnpm --filter @mongo-manager/e2e e2e:rs
//
// MM_E2E_PORT picks the server's port (default 43219; the local-mode server takes the next one).
// Arguments are passed on to Playwright (e.g. --headed).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specs = ['tests/01-first-run.spec.ts', 'tests/21-watch.spec.ts', 'tests/22-live-sync.spec.ts']
// W5 review: Playwright's own CLI under this Node, no shell between — arguments arrive as given
// (quoted ones too, on Windows).
const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli')
const result = spawnSync(
  process.execPath,
  [cli, 'test', ...specs, '--project=chrome', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: { ...process.env, MM_E2E_REQUIRE_RS: '1' } },
)
process.exit(result.status ?? 1)
