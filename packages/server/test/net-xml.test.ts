import { describe, expect, it } from 'vitest'
import { XmlError, child, childrenOf, parseXml, textOf } from '../src/net/xml'

describe('safe XML (phase 3d-3b spec §2.3, D2)', () => {
  it('reads an S3 listing with numeric character references', () => {
    const doc = parseXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>mmtest</Name><IsTruncated>false</IsTruncated><Contents><Key>a/b.txt</Key><ETag>&#34;5d41&#x22;</ETag><Size>5</Size></Contents><Contents><Key>a &amp; c</Key><Size>7</Size></Contents></ListBucketResult>',
    )
    expect(doc.local).toBe('ListBucketResult')
    expect(textOf(doc, 'Name')).toBe('mmtest')
    const items = childrenOf(doc, 'Contents')
    expect(items.map((c) => textOf(c, 'Key'))).toEqual(['a/b.txt', 'a & c'])
    expect(textOf(items[0]!, 'ETag')).toBe('"5d41"')
  })

  it('reads WebDAV multistatus with prefixes and CDATA', () => {
    const doc = parseXml(
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href><d:propstat><d:prop><d:getcontentlength><![CDATA[42]]></d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>',
    )
    const prop = child(child(child(doc, 'response')!, 'propstat')!, 'prop')!
    expect(textOf(prop, 'getcontentlength')).toBe('42')
    expect(doc.name).toBe('d:multistatus')
  })

  it.each([
    ['a DOCTYPE', '<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>'],
    ['an entity declaration', '<!ENTITY e SYSTEM "file:///etc/passwd"><x/>'],
    ['an unknown entity', '<x>&nbsp;</x>'],
    ['a processing instruction', '<x><?php echo 1 ?></x>'],
    ['mismatched tags', '<a><b></a></b>'],
    ['text after the root', '<a/>junk'],
    ['two roots', '<a/><b/>'],
    ['an unterminated tag', '<a><b>'],
    ['a code point out of range', '<a>&#x110000;</a>'],
    ['a NUL reference', '<a>&#0;</a>'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseXml(text)).toThrow(XmlError)
  })

  it('bounds depth and size', () => {
    expect(() => parseXml(`${'<a>'.repeat(40)}${'</a>'.repeat(40)}`)).toThrow(/deep/)
    expect(() => parseXml(`<r>${'<i/>'.repeat(50)}</r>`, { maxNodes: 10 })).toThrow(/many/)
  })
})
