import { describe, expect, it } from 'vitest'
import { classifyAddress, embeddedIPv4, ipBytes, parseCidr, privateNetworkProblem } from '../src/net/cidr'

const none: ReturnType<typeof parseCidr>[] = []
const reason = (a: string, allowed = none) => {
  const v = classifyAddress(a, allowed)
  return v.ok ? (v.allowedNetwork ? 'allowed' : 'public') : v.reason
}

describe('egress address policy (phase 3d-3b spec §3, D1)', () => {
  it('lets public addresses through', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '52.95.110.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])
      expect(reason(a), a).toBe('public')
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fc00::1', 'private'],
    ['169.254.10.10', 'link_local'],
    ['fe80::1', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['0.0.0.0', 'reserved'],
    ['::', 'reserved'],
    ['224.0.0.1', 'reserved'],
    ['ff02::1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.5', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['2002:c0a8:0101::1', 'reserved'],
    ['64:ff9b:1::a00:1', 'reserved'],
  ])('refuses %s (%s)', (address, why) => {
    expect(reason(address)).toBe(why)
  })

  it('judges IPv4 inside IPv6 by the IPv4 address', () => {
    expect(reason('::ffff:127.0.0.1')).toBe('loopback')
    expect(reason('::ffff:7f00:1')).toBe('loopback')
    expect(reason('::ffff:169.254.169.254')).toBe('metadata')
    expect(reason('::10.0.0.1')).toBe('private')
    expect(reason('64:ff9b::a9fe:a9fe')).toBe('metadata')
    expect(reason('64:ff9b::808:808')).toBe('public')
    expect(Array.from(embeddedIPv4(ipBytes('::ffff:1.2.3.4')!)!)).toEqual([1, 2, 3, 4])
  })

  it('allows listed networks, but never metadata or link-local', () => {
    const lan = [parseCidr('10.0.0.0/8'), parseCidr('fd12:3456::/48'), parseCidr('100.64.0.0/10')]
    expect(reason('10.9.8.7', lan)).toBe('allowed')
    expect(reason('::ffff:10.9.8.7', lan)).toBe('allowed')
    expect(reason('fd12:3456:0:1::5', lan)).toBe('allowed')
    expect(reason('192.168.1.1', lan)).toBe('private')
    expect(reason('100.100.100.200', lan)).toBe('metadata')
    expect(reason('203.0.113.9', [parseCidr('203.0.113.0/24')])).toBe('allowed')
  })

  it('refuses malformed addresses and zone ids', () => {
    expect(ipBytes('fe80::1%eth0')).toBeNull()
    expect(ipBytes('1.2.3')).toBeNull()
    expect(ipBytes('1.2.3.256')).toBeNull()
    expect(ipBytes('1::2::3')).toBeNull()
    expect(reason('not-an-ip')).toBe('reserved')
  })

  it('parses CIDRs and refuses never-allowed ones as settings', () => {
    expect(parseCidr('10.0.0.0/8').prefix).toBe(8)
    expect(() => parseCidr('10.0.0.0/33')).toThrow()
    expect(() => parseCidr('10.0.0.0')).toThrow()
    expect(privateNetworkProblem('10.0.0.0/8')).toBeNull()
    // Phase 3d-3b final review (A17): a range holding never-allowed addresses is refused as public.
    expect(privateNetworkProblem('0.0.0.0/0')).toMatch(/not a private network/)
    expect(privateNetworkProblem('169.0.0.0/8')).toMatch(/not a private network/)
    expect(privateNetworkProblem('169.254.169.254/32')).toMatch(/never/)
    expect(privateNetworkProblem('fe80::/16')).toMatch(/never/)
    expect(privateNetworkProblem('::/0')).toMatch(/not a private network/)
    expect(privateNetworkProblem('nope')).toMatch(/CIDR/)
  })
})
