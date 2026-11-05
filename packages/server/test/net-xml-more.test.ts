// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { XmlError, child, childrenOf, parseXml, textOf } from '../src/net/xml'

const refuses = (text: string, why: RegExp, opts?: Parameters<typeof parseXml>[1]) =>
  expect(() => parseXml(text, opts)).toThrow(why)

describe('safe XML: entity and DTD attacks (phase 3d-3b spec §2.3, D2)', () => {
  it('refuses a billion-laughs document at its DOCTYPE, before expanding anything', () => {
    const lol =
      '<?xml version="1.0"?>\n<!DOCTYPE lolz [\n <!ENTITY lol "lol">\n' +
      Array.from({ length: 9 }, (_, i) => ` <!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`).join(
        '\n',
      ) +
      '\n]>\n<lolz>&lol9;</lolz>'
    const t0 = performance.now()
    refuses(lol, /DOCTYPE/)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  it.each([
    ['an external entity (XXE)', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'],
    ['a parameter entity', '<!DOCTYPE r [<!ENTITY % p SYSTEM "http://evil.example/x.dtd"> %p;]><r/>'],
    ['an external DTD', '<!DOCTYPE r SYSTEM "http://evil.example/r.dtd"><r/>'],
    ['a DOCTYPE after the XML declaration and a comment', '<?xml version="1.0"?><!-- hi --><!DOCTYPE r><r/>'],
    ['a DOCTYPE inside the root', '<r><!DOCTYPE r></r>'],
    ['a lower-case doctype', '<!doctype r><r/>'],
    ['an ELEMENT declaration', '<!ELEMENT r ANY><r/>'],
  ])('refuses %s', (_what, text) => {
    refuses(text, /DOCTYPE or declaration/)
  })

  it('refuses a reference to an entity no DTD declared, whatever its name', () => {
    refuses('<r>&lol9;</r>', /Unknown entity &lol9;/)
    refuses('<r>&xxe;</r>', /Unknown entity/)
    refuses('<r>&copy;</r>', /Unknown entity/)
  })

  it('refuses a bare ampersand and an unterminated reference', () => {
    refuses('<r>Tom & Jerry</r>', /bare "&"/)
    refuses('<r>a&b</r>', /bare "&"/)
    refuses('<r>&amp</r>', /bare "&"/)
    refuses('<r>&verylongentityname;</r>', /bare "&"/)
    refuses('<r>&;</r>', /bare "&"/)
  })

  it.each([
    ['a lone high surrogate', '&#xD800;'],
    ['a lone low surrogate', '&#57343;'],
    ['a code point past Unicode', '&#1114112;'],
    ['a hex reference with no digits', '&#x;'],
    ['a decimal reference with no digits', '&#;'],
    ['a non-hex reference', '&#xZZ;'],
    ['a negative reference', '&#-65;'],
  ])('refuses %s', (_what, ref) => {
    refuses(`<r>${ref}</r>`, /Invalid character reference/)
  })

  it('decodes the five predefined entities and character references, upper- and lower-case hex', () => {
    const doc = parseXml('<r>&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#X43; &#x1F600;</r>')
    expect(doc.text).toBe(`<>&"' ABC \u{1F600}`)
    // Decoded once: an escaped reference stays text, it is not decoded again.
    expect(parseXml('<r>&amp;lt;</r>').text).toBe('&lt;')
  })

  it('refuses a processing instruction anywhere but the leading declaration', () => {
    refuses('<r/><?xml-stylesheet href="x"?>', /processing instruction/)
    refuses('<r><?php echo 1 ?></r>', /processing instruction/)
    // The XML declaration only counts at the very start, and only once.
    refuses(' <?xml version="1.0"?><r/>', /processing instruction/)
    refuses('<r/><?xml version="1.0"?>', /processing instruction/)
    refuses('<?xml version="1.0"?><?xml version="1.0"?><r/>', /processing instruction/)
    refuses('<?xml version="1.0"', /Unterminated XML declaration/)
  })

  it('does not take a leading processing instruction whose target starts with "xml" for the declaration', () => {
    // <?xml-stylesheet?> is a processing instruction, not the XML declaration (target "xml" exactly).
    refuses('<?xml-stylesheet href="x"?><r/>', /processing instruction/)
    refuses('<?xmlfoo bar?><r/>', /processing instruction/)
  })
})

describe('safe XML: structure (phase 3d-3b spec §2.3, D2)', () => {
  it('reads a document with a BOM, a declaration, comments and surrounding whitespace', () => {
    const doc = parseXml(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- a -->\n<r><!-- b --><k>v</k></r>\n  \n',
    )
    expect(doc.name).toBe('r')
    expect(textOf(doc, 'k')).toBe('v')
    // A BOM without a declaration.
    expect(parseXml('\uFEFF<r>x</r>').text).toBe('x')
  })

  it('keeps comments out of the text, and refuses an unterminated one', () => {
    expect(parseXml('<r>a<!-- <b>&bogus; <!DOCTYPE x> -->b</r>').text).toBe('ab')
    // A comment ends at the first "-->": what follows is markup again.
    refuses('<r><!-- x --> </b> --></r>', /Mismatched closing tag/)
    refuses('<r><!-- never closed </r>', /Unterminated comment/)
  })

  it('reads CDATA as is, without decoding or parsing it', () => {
    const doc = parseXml('<r><k><![CDATA[<x>&notAnEntity; & ]] >]]></k></r>')
    expect(textOf(doc, 'k')).toBe('<x>&notAnEntity; & ]] >')
    refuses('<r><![CDATA[never closed</r>', /Misplaced CDATA/)
    refuses('<![CDATA[x]]><r/>', /Misplaced CDATA/)
  })

  it('reads past attributes, a ">" inside a quoted value included, and drops them', () => {
    const doc = parseXml(`<r a="1>2" b='x"y'><k c="/">t</k><e z="1"/></r>`)
    expect(doc.children.map((c) => c.name)).toEqual(['k', 'e'])
    expect(textOf(doc, 'k')).toBe('t')
    expect(child(doc, 'e')!.children).toEqual([])
    // An entity inside an attribute is never expanded: attributes are not read at all.
    expect(parseXml('<r a="&xxe;">ok</r>').text).toBe('ok')
  })

  it.each([
    ['a tag without a name', '<r>< k>v</k></r>', /Malformed tag/],
    ['a tag name starting with a digit', '<1r/>', /Malformed tag/],
    ['a "<" inside a tag', '<r a="1" <k>v</k></r>', /Malformed tag/],
    ['a tag cut off', '<r><k a="1"', /Unterminated tag/],
    ['a quoted value cut off', '<r a="1>', /Unterminated tag/],
    ['a closing tag without a name', '<r></ ></r>', /Mismatched closing tag/],
    ['a closing tag cut off', '<r></r', /Mismatched closing tag/],
    ['a closing tag for nothing', '</r>', /Mismatched closing tag/],
    ['a prefix mismatch', '<a:r></b:r>', /Mismatched closing tag/],
    ['text before the root', 'junk<r/>', /Text outside the root/],
    ['an empty document', '', /Unterminated document/],
    ['only a declaration', '<?xml version="1.0"?>  ', /Unterminated document/],
    ['an unclosed root', '<r>', /Unterminated document/],
  ])('refuses %s', (_what, text, why) => {
    refuses(text, why)
  })

  it('every refusal is an XmlError', () => {
    expect(() => parseXml('<r>&bogus;</r>')).toThrow(XmlError)
    try {
      parseXml('<!DOCTYPE r><r/>')
    } catch (e) {
      expect((e as Error).name).toBe('XmlError')
    }
  })

  it('bounds depth exactly, by default at 32 and as configured', () => {
    const nest = (n: number) => `${'<a>'.repeat(n)}${'</a>'.repeat(n)}`
    expect(() => parseXml(nest(32))).not.toThrow()
    refuses(nest(33), /too deep/)
    expect(() => parseXml(nest(4), { maxDepth: 4 })).not.toThrow()
    refuses(nest(5), /too deep/, { maxDepth: 4 })
    // Self-closing elements do not count as an open level.
    expect(() => parseXml(`${'<a>'.repeat(4)}<b/>${'</a>'.repeat(4)}`, { maxDepth: 4 })).not.toThrow()
  })

  it('refuses a deeply nested document quickly, without reading it all', () => {
    const deep = '<a>'.repeat(500_000)
    const t0 = performance.now()
    refuses(deep, /too deep/)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('bounds the element count exactly, by default at 200 000', () => {
    expect(parseXml(`<r>${'<i/>'.repeat(9)}</r>`, { maxNodes: 10 }).children).toHaveLength(9)
    refuses(`<r>${'<i/>'.repeat(10)}</r>`, /Too many elements/, { maxNodes: 10 })
    refuses(`<r>${'<i/>'.repeat(200_000)}</r>`, /Too many elements/)
  })

  it('finds children by local name across prefixes, and answers null for a missing one', () => {
    const doc = parseXml('<d:r xmlns:d="DAV:"><d:k>1</d:k><k>2</k><x:k>3</x:k></d:r>')
    expect(doc.local).toBe('r')
    expect(childrenOf(doc, 'k').map((c) => c.text)).toEqual(['1', '2', '3'])
    expect(child(doc, 'missing')).toBeUndefined()
    expect(textOf(doc, 'missing')).toBeNull()
    expect(textOf(parseXml('<r><k/></r>'), 'k')).toBe('')
  })
})

describe('safe XML: character references are read strictly (phase 3d-3b final gate)', () => {
  it('refuses a reference with trailing or signed digits instead of guessing', () => {
    for (const ref of ['&#65x;', '&#+65;', '&#x41g;', '&#-1;', '&#x;', '&#;'])
      expect(() => parseXml(`<a>${ref}</a>`), ref).toThrow(XmlError)
    expect(textOf(parseXml('<r><a>&#65;&#x42;</a></r>'), 'a')).toBe('AB')
  })
})
