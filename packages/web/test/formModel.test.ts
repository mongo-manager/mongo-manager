import { describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, SECRET_MASK, type ConnectionSettings } from '@mongo-manager/shared'
import {
  applySettings,
  emptyForm,
  fieldErrors,
  formFromDto,
  inputFromForm,
  patchFromForm,
  sectionOf,
  settingsFromForm,
} from '../src/connections/formModel'
import { passwordFromUri } from '../src/connections/uriFill'
import type { ConnectionDto } from '../src/api/connections'

const FULL: ConnectionSettings = {
  scheme: 'mongodb',
  hosts: [{ host: 'db1', port: 27017 }, { host: 'db2' }],
  defaultDatabase: 'shop',
  replicaSet: 'rs0',
  directConnection: true,
  auth: { mechanism: 'SCRAM-SHA-256', username: 'ada', password: 'pw', authSource: 'admin' },
  tls: {
    enabled: true,
    caPem: 'CA',
    certificateKeyPem: 'KEY',
    certificateKeyPassword: 'kp',
    allowInvalidHostnames: true,
    allowInvalidCertificates: false,
  },
  ssh: {
    enabled: true,
    host: 'jump',
    port: 2222,
    username: 'u',
    method: 'privateKey',
    privateKey: 'PK',
    passphrase: 'pp',
    hostFingerprint: 'SHA256:abc',
  },
  readPreference: 'secondary',
  appName: 'mm',
  connectTimeoutMS: 5000,
  serverSelectionTimeoutMS: 7000,
  options: { retryWrites: 'false', maxPoolSize: '20' },
}

const dto = (settings: ConnectionSettings, extra: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  group: 'Team',
  color: 'red',
  favorite: true,
  readOnly: false,
  settings,
  uri: 'mongodb://db1',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [],
  ...extra,
})

describe('connection form model', () => {
  it('turns an empty form into minimal settings', () => {
    expect(settingsFromForm(emptyForm())).toEqual({
      scheme: 'mongodb',
      // User report 2026-10-16: a new form suggests localhost:27017 but holds nothing.
      hosts: [{ host: '' }],
      auth: { mechanism: 'none' },
      tls: { enabled: false },
      options: {},
    })
  })

  it('round-trips every setting through the form', () => {
    const form = formFromDto(dto(FULL))
    expect(settingsFromForm(form)).toEqual(FULL)
    expect(inputFromForm(form)).toMatchObject({
      name: 'Prod',
      group: 'Team',
      color: 'red',
      favorite: true,
      readOnly: false,
    })
    expect(patchFromForm({ ...form, group: '  ', color: '' })).toMatchObject({ group: null, color: null })
  })

  // Review of the open's stop (third review, nit 3): the server reconnects only for settings that
  // changed, comparing them as it stores them; the dialog's body, saved unchanged, is the same.
  it('sends the settings it was given as they were, as the server reads them', () => {
    for (const given of [
      { hosts: [{ host: 'db' }] },
      { hosts: [{ host: 'db' }], auth: { mechanism: 'DEFAULT', username: 'u', password: SECRET_MASK } },
      {
        hosts: [{ host: 'db', port: 27018 }],
        tls: { enabled: true },
        ssh: { enabled: true, host: 'b', username: 'u', method: 'password', password: SECRET_MASK },
      },
      // Every setting (one host: a tunnel reaches exactly one).
      { ...FULL, hosts: [FULL.hosts[0]!] },
    ]) {
      const stored = ConnectionSettingsSchema.parse(given)
      const sent = patchFromForm(formFromDto(dto(stored))).settings
      expect(ConnectionSettingsSchema.parse(sent)).toEqual(stored)
    }
  })

  it('keeps masks when editing and clears them when duplicating', () => {
    const masked = {
      ...FULL,
      auth: { ...FULL.auth, password: SECRET_MASK },
      ssh: { ...FULL.ssh!, privateKey: SECRET_MASK },
    }
    expect((settingsFromForm(formFromDto(dto(masked))) as ConnectionSettings).auth.password).toBe(SECRET_MASK)
    const copy = formFromDto(dto(masked), { duplicateName: (n) => `${n} (copy)` })
    expect(copy.name).toBe('Prod (copy)')
    expect(copy.auth.password).toBe('')
    expect(copy.ssh.privateKey).toBe('')
    expect(copy.ssh.passphrase).toBe('pp')
  })

  // Mechanism properties are shown, and sent, only for a method that uses them (MONGODB-AWS): a
  // Kerberos connection changed to SCRAM kept its hidden CANONICALIZE_HOST_NAME, which the driver
  // refuses for every method.
  it('sends mechanism properties only for MONGODB-AWS', () => {
    const kerberos = formFromDto(
      dto({
        ...FULL,
        auth: { mechanism: 'GSSAPI', username: 'u', mechanismProperties: 'CANONICALIZE_HOST_NAME:true' },
      }),
    )
    kerberos.auth.mechanism = 'SCRAM-SHA-256'
    kerberos.auth.password = 'pw'
    expect((settingsFromForm(kerberos) as ConnectionSettings).auth).not.toHaveProperty('mechanismProperties')
    kerberos.auth.mechanism = 'MONGODB-AWS'
    expect((settingsFromForm(kerberos) as ConnectionSettings).auth.mechanismProperties).toBe(
      'CANONICALIZE_HOST_NAME:true',
    )
  })

  it('sends unparseable numbers as null so the server names the field', () => {
    const form = emptyForm()
    form.hosts[0]!.port = 'abc'
    form.connectTimeoutMS = '12x'
    const json = JSON.parse(JSON.stringify(settingsFromForm(form)))
    expect(json.hosts[0].port).toBeNull()
    expect(json.connectTimeoutMS).toBeNull()
  })

  it('only sends the SSH secret for the chosen method and drops disabled sections', () => {
    const form = formFromDto(dto(FULL))
    form.ssh.method = 'password'
    form.ssh.password = 'sp'
    const s = settingsFromForm(form) as ConnectionSettings
    expect(s.ssh).toMatchObject({ method: 'password', password: 'sp' })
    expect(s.ssh).not.toHaveProperty('privateKey')
    form.ssh.enabled = false
    form.tls.enabled = false
    const off = settingsFromForm(form) as ConnectionSettings
    expect(off.ssh).toBeUndefined()
    expect(off.tls).toEqual({ enabled: false })
  })

  it('applies parsed URI settings without touching name or SSH', () => {
    const form = formFromDto(dto(FULL))
    applySettings(
      form,
      { ...FULL, hosts: [{ host: 'other' }], ssh: undefined, auth: { mechanism: 'none' } },
      { keepSsh: true },
    )
    expect(form.name).toBe('Prod')
    expect(form.hosts).toEqual([{ host: 'other', port: '' }])
    expect(form.ssh.host).toBe('jump')
    expect(form.auth.mechanism).toBe('none')
  })

  it('extracts the password from a URI, because parse-uri masks it (Review Focus 2)', () => {
    expect(passwordFromUri('mongodb://ada:p%40ss%3Aw@h1,h2/?replicaSet=rs')).toBe('p@ss:w')
    expect(passwordFromUri('mongodb+srv://ada@cluster.example.com')).toBeUndefined()
    expect(passwordFromUri('mongodb://h1')).toBeUndefined()
    expect(passwordFromUri('mongodb://ada:%E0%A4%A@h')).toBeUndefined()
  })

  it('maps server validation issues to fields and sections', () => {
    const { fields, general } = fieldErrors([
      { path: 'settings.hosts.0.host', message: 'Invalid host name' },
      { path: 'name', message: 'Required' },
      { path: '', message: 'Masked secrets cannot be reused for a new target' },
      { nonsense: true },
    ])
    expect(fields).toEqual({ 'hosts.0.host': 'Invalid host name', name: 'Required' })
    expect(general).toEqual(['Masked secrets cannot be reused for a new target'])
    expect(
      ['hosts.0.host', 'name', 'auth.username', 'tls.caPem', 'ssh', 'options.w', 'connectTimeoutMS'].map(
        sectionOf,
      ),
    ).toEqual(['server', 'general', 'auth', 'tls', 'ssh', 'advanced', 'advanced'])
  })
})
