import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { AppError } from '../src/errors'
import { decodeXmlText, localName, xmlEscape, xmlEvents } from '../src/transfer/formats/xml'
import { fuzz } from './support/fuzz'

async function events(text: string | string[], maxToken?: number) {
  const out = []
  for await (const e of xmlEvents(Readable.from(Array.isArray(text) ? text : [text]), maxToken)) out.push(e)
  return out
}
async function reason(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

describe('XML reading (spec §7 T7)', () => {
  it('reads elements, attributes, text, CDATA and character references, across chunks', async () => {
    const xml =
      '<?xml version="1.0"?><!-- c --><x:a k="1 &amp; 2" j=\'q\'><b/>t&lt;&#x41;&#66;<![CDATA[<raw>]]></x:a>'
    for (let cut = 1; cut < xml.length; cut++)
      expect(await events([xml.slice(0, cut), xml.slice(cut)])).toEqual([
        { type: 'open', name: 'x:a', attrs: { k: '1 & 2', j: 'q' }, empty: false },
        { type: 'open', name: 'b', attrs: {}, empty: true },
        { type: 'close', name: 'b' },
        { type: 'text', text: 't<AB' },
        { type: 'text', text: '<raw>' },
        { type: 'close', name: 'x:a' },
      ])
    expect(localName('x:a')).toBe('a')
  })

  it('refuses DTDs, entity declarations, unknown entities and bad character references', async () => {
    expect(await reason(events('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'))).toBe('xml_dtd')
    expect(await reason(events('<x>&a;</x>'))).toBe('xml')
    expect(await reason(events('<x>&#0;</x>'))).toBe('xml')
    expect(await reason(events('<x>&#xD800;</x>'))).toBe('xml')
    expect(await reason(events('<x a="<">'))).toBe('xml')
    expect(await reason(events('<x a="1" junk>'))).toBe('xml')
  })

  it('bounds a token that never ends', async () => {
    expect(await reason(events(['<a b="', 'x'.repeat(200)], 100))).toBe('xml')
    expect(await reason(events(['<a>', 'x'.repeat(200)], 100))).toBe('xml')
  })

  it('escapes text for OOXML, control characters included', () => {
    expect(xmlEscape('a<b & "c"\u0001_x0041_')).toBe('a&lt;b &amp; &quot;c&quot;_x0001__x005F_x0041_')
    expect(decodeXmlText('&lt;&#x41;')).toBe('<A')
  })

  it('survives fuzzing', async () => {
    await fuzz(6201, 400, Buffer.from('<a x="1"><b>t&amp;</b><![CDATA[z]]><!-- c --></a>'), async (input) => {
      for await (const _ of xmlEvents(Readable.from([input.toString('latin1')])));
    })
  })
})
