// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { workerEnv } from '../src/shell/spawn'

/**
 * Security audit 2026-10-16 (dependencies): basic-ftp (<= 6.2.0, a CPU DoS in its listing parser)
 * comes in through @mongosh/service-provider-node-driver > devtools-connect > devtools-proxy-support
 * > pac-proxy-agent > get-uri, which wants basic-ftp ^5. That path loads only for a proxy option
 * (`proxy: 'pac+ftp://…'`) or, with useEnvironmentVariableProxies, a proxy in the environment. The
 * shell worker passes neither, its environment holds no proxy variable, and its network allows only
 * the session proxy: these tests keep it so.
 */
const seen = vi.hoisted(() => ({ args: [] as unknown[] }))
vi.mock('@mongosh/service-provider-node-driver', () => ({
  NodeDriverServiceProvider: {
    connect: (...args: unknown[]) => {
      seen.args = args
      return Promise.reject(new Error('stop here'))
    },
  },
}))

const { ShellRuntime } = await import('../src/shell/worker/runtime')

describe('security audit 2026-10-16: the shell never reaches the PAC/FTP proxy path', () => {
  it('connects with no proxy option of any kind', async () => {
    await expect(new ShellRuntime().connect('mongodb://127.0.0.1:1/', 'mm-shell')).rejects.toThrow(
      'stop here',
    )
    const [, driverOptions, cliOptions] = seen.args as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    for (const options of [driverOptions, cliOptions]) {
      for (const key of [
        'proxy',
        'applyProxyToOIDC',
        'useEnvironmentVariableProxies',
        'proxyHost',
        'proxyPort',
      ])
        expect(options).not.toHaveProperty(key)
    }
  })

  it('gives the worker no proxy variable, whatever the server has', () => {
    const parent = {
      HTTP_PROXY: 'pac+ftp://evil/proxy.pac',
      HTTPS_PROXY: 'x',
      ALL_PROXY: 'x',
      http_proxy: 'x',
      MONGODB_PROXY: 'x',
      SystemRoot: 'C:\\Windows',
    }
    for (const platform of ['linux', 'win32'] as const)
      expect(Object.keys(workerEnv(parent, platform)).filter((k) => /proxy/i.test(k))).toEqual([])
  })
})
