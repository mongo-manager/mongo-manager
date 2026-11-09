// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { staticUnits } from '../../scripts/deploy-files.mjs'

const root = join(import.meta.dirname, '..', '..', '..', '..')

describe('deploy/ static service files', () => {
  it('are exactly what service install writes (regenerate with scripts/deploy-files.mjs)', async () => {
    for (const [path, text] of Object.entries(await staticUnits())) {
      expect(readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n'), path).toBe(text)
    }
  })

  it('reverse proxy examples trust only the local proxy and keep WebSocket upgrades', () => {
    const nginx = readFileSync(join(root, 'deploy', 'nginx', 'mongo-manager.conf'), 'utf8')
    for (const line of [
      'proxy_set_header X-Forwarded-Proto $scheme;',
      'proxy_set_header Upgrade $http_upgrade;',
      'proxy_http_version 1.1;',
    ]) {
      expect(nginx).toContain(line)
    }
    expect(nginx).toMatch(/--trusted-proxies 127\.0\.0\.1/)
    // Security review 2026-10-13 (ops): 16m refused every larger import, GridFS file and backup the
    // server itself accepts (MM_TRANSFER_MAX_UPLOAD, 1024 MiB by default); the server holds each
    // request to its own limit. Uploads stream through, so its progress and idle checks see them.
    const limit = /client_max_body_size (\d+)m;/.exec(nginx)
    expect(Number(limit?.[1])).toBeGreaterThanOrEqual(1024)
    expect(nginx).toContain('proxy_request_buffering off;')
    // Review of the ops fixes (M5): frame tickets stay out of nginx's access log too.
    expect(nginx).toMatch(/location \^~ \/plugin-frame\/ \{\s+access_log off;/)
    expect(readFileSync(join(root, 'deploy', 'README.md'), 'utf8')).toMatch(/--allowed-hosts/)
  })
})
