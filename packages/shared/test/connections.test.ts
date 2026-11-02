import { describe, expect, it } from 'vitest'
import {
  ConnectionSettingsSchema,
  ConnectionUriError,
  SECRET_MASK,
  buildConnectionUri,
  maskSecrets,
  mergeSecrets,
  parseConnectionUri,
  withoutRefusedOptions,
  withoutRefusedUriOptions,
} from '../src/connections'
import { EXTRA_URI_OPTIONS } from '../src/connection-constants'

// An Atlas connection string as Atlas shows it, with an invented user and password; built from parts
// so secret scanning does not take it for a real credential.
const ATLAS_URI = [
  'mongodb+srv://user',
  'p%40ss@cluster0.x.mongodb.net/db?retryWrites=true&w=majority&appName=Cluster0',
].join(':')

describe('parseConnectionUri', () => {
  it('parses a replica set URI with credentials and options', () => {
    const s = parseConnectionUri(
      'mongodb://us%40er:p%3Ass@h1:27017,h2,[::1]:27018/shop?replicaSet=rs0&authSource=admin&readPreference=secondaryPreferred&appName=demo&retryWrites=false&w=majority',
    )
    expect(s).toMatchObject({
      scheme: 'mongodb',
      hosts: [{ host: 'h1', port: 27017 }, { host: 'h2' }, { host: '::1', port: 27018 }],
      defaultDatabase: 'shop',
      replicaSet: 'rs0',
      auth: { mechanism: 'DEFAULT', username: 'us@er', password: 'p:ss', authSource: 'admin' },
      tls: { enabled: false },
      readPreference: 'secondaryPreferred',
      appName: 'demo',
      options: { retryWrites: 'false', w: 'majority' },
    })
  })

  it('parses a pasted Atlas URI (Review Focus 1)', () => {
    const s = parseConnectionUri(ATLAS_URI)
    expect(s).toMatchObject({
      scheme: 'mongodb+srv',
      hosts: [{ host: 'cluster0.x.mongodb.net' }],
      defaultDatabase: 'db',
      tls: { enabled: true },
      auth: { mechanism: 'DEFAULT', username: 'user', password: 'p@ss' },
      appName: 'Cluster0',
      options: { retryWrites: 'true', w: 'majority' },
    })
  })

  it('reads explicit mechanisms and option names case-insensitively', () => {
    const s = parseConnectionUri(
      'mongodb+srv://cluster0.example.net/?authMechanism=mongodb-x509&AUTHSOURCE=$external',
    )
    expect(s).toMatchObject({
      auth: { mechanism: 'MONGODB-X509', authSource: '$external' },
      tls: { enabled: true },
    })
  })

  it('rejects file-based TLS options, unknown options and malformed URIs with clear messages', () => {
    expect(() => parseConnectionUri('mongodb://h/?tlsCAFile=/etc/passwd')).toThrow(
      /File-based TLS options \(tlsCAFile\)/,
    )
    expect(() => parseConnectionUri('mongodb://h/?tlsCertificateKeyFile=/k.pem')).toThrow(ConnectionUriError)
    expect(() => parseConnectionUri('mongodb://h/?frobnicate=1')).toThrow(
      /Unsupported connection string options: frobnicate/,
    )
    expect(() => parseConnectionUri('http://h')).toThrow(ConnectionUriError)
    expect(() => parseConnectionUri('mongodb+srv://a:1/')).toThrow(ConnectionUriError)
    expect(() => parseConnectionUri('mongodb://h/?readPreference=sometimes')).toThrow(ConnectionUriError)
    expect(() => parseConnectionUri('mongodb://h/?authMechanism=MAGIC')).toThrow(/Unsupported authMechanism/)
  })
})

describe('buildConnectionUri', () => {
  it('round-trips through parse', () => {
    for (const uri of [
      'mongodb://u:p%40ss@h1:27017,h2/shop?replicaSet=rs0&authSource=admin&tls=true&appName=x',
      'mongodb+srv://ann@c.example.net/?authMechanism=SCRAM-SHA-256',
      'mongodb://[::1]:27017/?directConnection=true&serverSelectionTimeoutMS=5000&maxPoolSize=5',
      ATLAS_URI,
    ]) {
      const settings = parseConnectionUri(uri)
      expect(parseConnectionUri(buildConnectionUri(settings, { includeCredentials: true })), uri).toEqual(
        settings,
      )
    }
  })

  it('leaves credentials and mechanism properties out unless asked', () => {
    const s = parseConnectionUri('mongodb://u:secret@h/?authMechanismProperties=SERVICE_NAME:x')
    const uri = buildConnectionUri(s)
    expect(uri).not.toContain('secret')
    expect(uri).not.toContain('u@')
    expect(uri).not.toContain('SERVICE_NAME')
  })
})

describe('ConnectionSettingsSchema', () => {
  const base = { hosts: [{ host: 'h' }] }

  it('applies defaults', () => {
    expect(ConnectionSettingsSchema.parse(base)).toMatchObject({
      scheme: 'mongodb',
      auth: { mechanism: 'none' },
      tls: { enabled: false, allowInvalidHostnames: false, allowInvalidCertificates: false },
      options: {},
    })
  })

  it('enforces SRV, SSH, username and option rules', () => {
    const bad = [
      { scheme: 'mongodb+srv', hosts: [{ host: 'a' }, { host: 'b' }] },
      { scheme: 'mongodb+srv', hosts: [{ host: 'a', port: 1 }] },
      { scheme: 'mongodb+srv', hosts: [{ host: 'a' }], directConnection: true },
      {
        hosts: [{ host: 'a' }, { host: 'b' }],
        ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p' },
      },
      { ...base, auth: { mechanism: 'SCRAM-SHA-256' } },
      { ...base, options: { tlsCAFile: '/etc/passwd' } },
      { hosts: [{ host: 'bad host' }] },
      { hosts: [] },
    ]
    for (const b of bad) expect(ConnectionSettingsSchema.safeParse(b).success, JSON.stringify(b)).toBe(false)
  })
})

describe('secret masking', () => {
  const full = ConnectionSettingsSchema.parse({
    hosts: [{ host: 'h' }],
    auth: { mechanism: 'DEFAULT', username: 'u', password: 'pw', mechanismProperties: 'A:B' },
    tls: { enabled: true, certificateKeyPem: 'PEM', certificateKeyPassword: 'kp', caPem: 'CA' },
    ssh: {
      enabled: true,
      host: 's',
      username: 'su',
      method: 'privateKey',
      privateKey: 'KEY',
      passphrase: 'pp',
    },
  })

  it('masks every secret and nothing else, without mutating the input', () => {
    const m = maskSecrets(full)
    expect(m.auth).toMatchObject({ username: 'u', password: SECRET_MASK, mechanismProperties: 'A:B' })
    expect(m.tls).toMatchObject({
      caPem: 'CA',
      certificateKeyPem: SECRET_MASK,
      certificateKeyPassword: SECRET_MASK,
    })
    expect(m.ssh).toMatchObject({ username: 'su', privateKey: SECRET_MASK, passphrase: SECRET_MASK })
    expect(full.auth.password).toBe('pw')
  })

  it('restores masked values from stored settings, and drops them when nothing is stored', () => {
    expect(mergeSecrets({ ...maskSecrets(full), appName: 'renamed' }, full)).toEqual({
      ...full,
      appName: 'renamed',
    })
    expect(mergeSecrets(maskSecrets(full), undefined).auth.password).toBeUndefined()
    const changed = maskSecrets(full)
    changed.auth.password = 'new'
    expect(mergeSecrets(changed, full).auth.password).toBe('new')
  })
})

describe('timeoutMS (refused: the app bounds each operation itself)', () => {
  it('is refused in a connection string, in words and with its reason, once however often given', () => {
    expect(() => parseConnectionUri('mongodb://h/?timeoutMS=5000')).toThrow(
      'timeoutMS is not supported: the app bounds each operation itself; remove it from the connection string',
    )
    let refusal: unknown
    try {
      parseConnectionUri('mongodb://h/?TIMEOUTMS=1&timeoutMS=2')
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(ConnectionUriError)
    expect((refusal as ConnectionUriError).message).toMatch(/^timeoutMS is not supported/)
    expect((refusal as ConnectionUriError).details).toEqual({
      reason: 'option_not_supported',
      option: 'timeoutMS',
    })
    expect(EXTRA_URI_OPTIONS).not.toContain('timeoutMS')
  })

  it('is refused in settings, in words, however it is spelled and whatever its value', () => {
    for (const [key, value] of [
      ['timeoutMS', '5000'],
      ['TimeoutMs', '1'],
      ['timeoutMS', 5],
    ] as const) {
      const r = ConnectionSettingsSchema.safeParse({
        hosts: [{ host: 'h', port: 27017 }],
        options: { [key]: value, maxPoolSize: '5' },
      })
      expect(r.success, key).toBe(false)
      expect(r.error?.issues, key).toEqual([
        expect.objectContaining({
          path: ['options', key],
          message: 'timeoutMS is not supported: the app bounds each operation itself',
        }),
      ])
    }
  })

  it('takes a "__proto__" key for no option, and keeps the plain prototype', () => {
    const options = JSON.parse('{"__proto__": {"w": "1"}, "maxPoolSize": "2"}') as Record<string, string>
    const parsed = ConnectionSettingsSchema.parse({ hosts: [{ host: 'h', port: 27017 }], options })
    expect(parsed.options).toEqual({ maxPoolSize: '2' })
    expect(Object.getPrototypeOf(parsed.options)).toBe(Object.prototype)
    const read = withoutRefusedOptions({ options })
    expect(read.options).toEqual({ maxPoolSize: '2' })
    expect(Object.getPrototypeOf(read.options)).toBe(Object.prototype)
  })

  it('is never written into a connection string from settings stored with it', () => {
    const stored = {
      ...ConnectionSettingsSchema.parse({ hosts: [{ host: 'h', port: 27017 }] }),
      options: { timeoutMS: '5000', maxPoolSize: '5' },
    } as never
    expect(buildConnectionUri(stored)).toBe('mongodb://h:27017/?maxPoolSize=5')
  })

  it('reads settings stored with no options as having none, and builds their string', () => {
    const { options: _none, ...bare } = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'h', port: 27017 }],
    })
    expect(withoutRefusedOptions(bare as { options?: Record<string, string> })).toEqual({
      ...bare,
      options: {},
    })
    expect(buildConnectionUri(bare as never)).toBe('mongodb://h:27017/')
    expect(withoutRefusedOptions({ options: { TimeoutMs: '5', w: '1' } })).toEqual({ options: { w: '1' } })
  })

  it('is taken out of a connection string by name, in any case, and named once', () => {
    expect(withoutRefusedUriOptions('mongodb://h/?timeoutMS=5&maxPoolSize=5&TimeoutMs=6')).toEqual({
      uri: 'mongodb://h/?maxPoolSize=5',
      dropped: ['timeoutMS'],
    })
    expect(withoutRefusedUriOptions('mongodb://h/?maxPoolSize=5')).toEqual({
      uri: 'mongodb://h/?maxPoolSize=5',
      dropped: [],
    })
    // A string that is no connection string says so as the parser does.
    expect(() => withoutRefusedUriOptions('http://h')).toThrow(/^Invalid connection string:/)
  })

  it('says "Invalid connection string" once when the library says only that', () => {
    for (const read of [parseConnectionUri, withoutRefusedUriOptions]) {
      let message = ''
      try {
        read('mongodb://u:p@h@x/')
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toBe('Invalid connection string')
    }
  })
})
