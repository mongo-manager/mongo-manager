import { describe, expect, it } from 'vitest'
import { isLoopback, withDockerHost } from '../src/connections/dockerHost'

// User report 2026-11-02: in Docker, localhost is Mongo Manager's own container (ECONNREFUSED ::1).
describe('a loopback host, in Docker', () => {
  it('is localhost, 127.x.x.x, ::1 or 0.0.0.0, and nothing else', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      ' localhost ',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      '0.0.0.0',
      // Review of 1.0.1 (M6): the other ways to write them.
      'localhost.',
      '::ffff:127.0.0.1',
      '[::FFFF:127.0.0.1]',
      '0:0:0:0:0:0:0:1',
      '[0000:0000:0000:0000:0000:0000:0000:0001]',
    ])
      expect(isLoopback(host), host).toBe(true)
    for (const host of [
      '',
      'db',
      'localhost.example.com',
      'my-localhost',
      '10.0.0.1',
      '127.0.0',
      'host.docker.internal',
      '::ffff:10.0.0.1',
      '0:0:0:0:0:0:0:2',
      'localhost..',
    ])
      expect(isLoopback(host), host).toBe(false)
  })

  it('becomes host.docker.internal in a connection string, every other part as typed', () => {
    expect(withDockerHost('mongodb://localhost:27021')).toBe('mongodb://host.docker.internal:27021')
    expect(withDockerHost('mongodb://ada:p%40ss@127.0.0.1:27017,db2:27018/shop?replicaSet=rs0')).toBe(
      'mongodb://ada:p%40ss@host.docker.internal:27017,db2:27018/shop?replicaSet=rs0',
    )
    expect(withDockerHost('mongodb://[::1]:27017/?directConnection=true')).toBe(
      'mongodb://host.docker.internal:27017/?directConnection=true',
    )
    expect(withDockerHost('localhost:27017')).toBe('host.docker.internal:27017')
    expect(withDockerHost('mongodb://[::ffff:127.0.0.1]:27017')).toBe('mongodb://host.docker.internal:27017')
  })

  it('never touches a user, a password, a path or an option that only looks like one', () => {
    expect(withDockerHost('mongodb://localhost:pw@db:27017/localhost?appName=localhost')).toBe(
      'mongodb://localhost:pw@db:27017/localhost?appName=localhost',
    )
    expect(withDockerHost('mongodb+srv://cluster0.example.mongodb.net/')).toBe(
      'mongodb+srv://cluster0.example.mongodb.net/',
    )
  })
})
