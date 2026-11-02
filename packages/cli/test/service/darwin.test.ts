import { describe, expect, it } from 'vitest'
import { parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import { fakeIo } from '../support'
import { fakeSys } from './fake-sys'

const program = { node: '/usr/local/bin/node', cli: '/tmp/pkg/dist/cli.cjs', publicDir: '/tmp/pkg/public' }
const probe = async () => true
const run = (sys: ReturnType<typeof fakeSys>, argv: string[]) => {
  const io = fakeIo()
  const { positionals, values } = parseCli(['service', ...argv])
  return serviceCommand(positionals, values, io, { sys, program, probe }).then((code) => ({ code, io }))
}

describe('service install on macOS', () => {
  it('creates a hidden service account with a free id, private data and a launch daemon', async () => {
    const sys = fakeSys('darwin')
    sys.responses.push(
      { match: /^dscl \. -read \/Users\/_mongomanager/, status: 56 },
      { match: /^dscl \. -list \/Users UniqueID/, status: 0, stdout: 'root 0\n_www 70\n_x 400\n' },
      { match: /^dscl \. -list \/Groups PrimaryGroupID/, status: 0, stdout: 'wheel 0\n_y 401\n' },
    )
    const { code, io } = await run(sys, ['install'])
    expect(code).toBe(0)
    expect(sys.commands).toContain('dseditgroup -o create -i 402 -r Mongo Manager _mongomanager')
    expect(sys.commands).toContain('dscl . -create /Users/_mongomanager UniqueID 402')
    expect(sys.commands).toContain('dscl . -create /Users/_mongomanager UserShell /usr/bin/false')
    expect(sys.commands).toContain('dscl . -create /Users/_mongomanager IsHidden 1')
    expect(sys.dirs.get('/Library/Application Support/Mongo Manager/data')).toBe(0o700)
    expect(sys.files.get('/Library/Application Support/Mongo Manager/config.json')!.mode).toBe(0o640)
    expect(sys.files.get('/Library/LaunchDaemons/com.mongo-manager.server.plist')!.mode).toBe(0o644)
    expect(sys.commands).toContain(
      'launchctl bootstrap system /Library/LaunchDaemons/com.mongo-manager.server.plist',
    )
    expect(io.out()).toMatch(/running at http:\/\/127\.0\.0\.1:4321\//)
    expect(io.out()).toContain('sudo cat "/Library/Application Support/Mongo Manager/data/setup-token"')
  })

  // Re-review of the merge (Minor 4): macOS writes the same config as Linux.
  it('writes --no-shell into the config', async () => {
    const sys = fakeSys('darwin')
    expect((await run(sys, ['install', '--no-shell'])).code).toBe(0)
    const config = sys.files.get('/Library/Application Support/Mongo Manager/config.json')!
    expect(JSON.parse(config.content).shell).toEqual({ enabled: false })
  })

  it('reuses an existing account and uninstalls without touching data', async () => {
    const sys = fakeSys('darwin')
    sys.responses.push({ match: /^dscl \. -read \/Users\/_mongomanager/, status: 0 })
    await run(sys, ['install'])
    expect(sys.commands.some((c) => c.startsWith('dseditgroup'))).toBe(false)
    // Third review of the CI fixes (minor 4): what a failed install left beside it goes too.
    const app = '/Library/Application Support/Mongo Manager/app'
    sys.files.set(`${app}.old/bin/node`, { content: 'earlier', mode: 0o755 })
    const { code } = await run(sys, ['uninstall'])
    expect(code).toBe(0)
    expect([...sys.files.keys()].filter((k) => k.startsWith(app))).toEqual([])
    expect(sys.commands).toContain('launchctl bootout system/com.mongo-manager.server')
    expect(sys.files.has('/Library/LaunchDaemons/com.mongo-manager.server.plist')).toBe(false)
    expect(sys.files.has('/Library/Application Support/Mongo Manager/config.json')).toBe(true)
  })

  it('shows status and logs', async () => {
    const sys = fakeSys('darwin')
    await run(sys, ['status'])
    await run(sys, ['logs', '-f'])
    expect(sys.commands).toEqual([
      'launchctl print system/com.mongo-manager.server',
      'tail -n 200 -f /Library/Logs/Mongo Manager/mongo-manager.log',
    ])
  })
})
