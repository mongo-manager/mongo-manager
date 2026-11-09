// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { buildDownload, fileName, htmlPage, sanitizeHtml } from '../src/plugins/download'
import { BridgeError } from '../src/plugins/bridge'

/**
 * Plugins wave 3 (spec §1.1): a file a plugin hands the app to save — its name made safe, its kind
 * known, an HTML page assembled by the app (never taken whole), a PNG that is one.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

const refused = (run: () => unknown, code = 'bad_params') => {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError)
    expect((e as BridgeError).code).toBe(code)
    return
  }
  throw new Error('not refused')
}

describe('a downloaded file’s name', () => {
  it('keeps a plain name and adds the extension of its kind, once', () => {
    expect(fileName('shop dictionary', '.md', 'data-dictionary')).toBe('shop dictionary.md')
    expect(fileName('notes.md', '.md', 'x')).toBe('notes.md')
    expect(fileName('Veri sözlüğü', '.html', 'x')).toBe('Veri sözlüğü.html')
  })

  it('never carries a path, a reserved name, a hidden or reversing character, or another kind', () => {
    expect(fileName('../../etc/passwd', '.md', 'x')).toBe('etc passwd.md')
    expect(fileName('a\\b:c*d?e"f<g>h|i', '.txt', 'x')).toBe('a b c d e f g h i.txt')
    expect(fileName('CON', '.md', 'x')).toBe('_CON.md')
    expect(fileName('lpt1.txt', '.md', 'x')).toBe('lpt1_txt.md')
    expect(fileName('invoice\u202egpj.exe', '.md', 'x')).toBe('invoicegpj_exe.md')
    expect(fileName('a\u0000b\u200bc', '.md', 'x')).toBe('abc.md')
    expect(fileName('  ...  ', '.md', 'mock-data')).toBe('mock-data.md')
    expect(fileName(42, '.md', 'mock-data')).toBe('mock-data.md')
    expect([...fileName('x'.repeat(300), '.md', 'p')].length).toBe(103)
  })

  // Wave 3 review: Windows' other device names, and a name that reads as another kind of file.
  it('refuses every device name Windows keeps, and never shows another extension', () => {
    const devices = ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']
    for (const name of [...devices, 'CONIN$', 'conout$', 'COM0', 'LPT0'])
      expect(fileName(name, '.md', 'x')).toBe(`_${name}.md`)
    // "invoice.pdf" saved as HTML would show as invoice.pdf where extensions are hidden.
    expect(fileName('invoice.pdf', '.html', 'x')).toBe('invoice_pdf.html')
    expect(fileName('orders.next dictionary', '.md', 'x')).toBe('orders_next dictionary.md')
    expect(fileName('notes.md', '.md', 'x')).toBe('notes.md')
  })
})

describe('an HTML page a plugin hands over', () => {
  // Review of the languages (minor 19): the page says its language, so a Japanese dictionary shows
  // Japanese glyphs — the plugin's, when it names a plain tag, the app's otherwise; never markup.
  it('says its language: the plugin’s plain tag, or the app’s', async () => {
    const page = (html: object, lang?: string) =>
      buildDownload(
        { name: 'd', type: 'html', html: { title: 't', css: '', body: '<p>x</p>', ...html } },
        'p',
        lang,
      ).blob.text()
    expect(await page({ lang: 'ja' }, 'zh-CN')).toContain('<html lang="ja">')
    expect(await page({}, 'zh-CN')).toContain('<html lang="zh-CN">')
    expect(await page({})).toContain('<html lang="en">')
    for (const bad of ['"><script>', 'ja"', 'x'.repeat(40), 'en us', 1])
      expect(await page({ lang: bad }, 'ko'), String(bad)).toContain('<html lang="ko">')
    expect(htmlPage('t', '', '<p>x</p>', 'pt-BR')).toContain('<html lang="pt-BR">')
  })

  it('is assembled by the app: its policy first, the title as text, the plugin’s style and body', () => {
    const page = htmlPage('Shop <dictionary>', 'h1 { color: red }', '<h1 class="t">Shop</h1>')
    expect(page.startsWith('<!doctype html>')).toBe(true)
    const head = page.slice(0, page.indexOf('</head>'))
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<title>'))
    expect(head).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`)
    expect(head).toContain('<title>Shop &lt;dictionary&gt;</title>')
    expect(head).toContain('<style>h1 { color: red }</style>')
    expect(page).toContain('<h1 class="t">Shop</h1>')
  })

  it('keeps structure and text, and drops every script, handler, address and foreign element', () => {
    const out = [
      '<p>before<script>alert(1)</script>after</p>',
      '<img src=x onerror="alert(1)">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<a href="javascript:alert(1)">link</a>',
      '<a href="#orders">Orders</a>',
      '<a href="https://evil.example">out</a>',
      '<svg><script>alert(1)</script></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<table><tr><td colspan="2" onclick="x()" style="color:red">cell</td></tr></table>',
      '<form action="https://evil.example"><input name="a"></form>',
      '<custom-tag>kept text</custom-tag>',
      '<style>body{display:none}</style>',
    ]
      // Each on its own: a parser that swallows what follows a foreign element hides nothing here.
      .map((part) => sanitizeHtml(part))
      .join('')
    expect(out).not.toMatch(
      /script|onerror|onclick|javascript|evil|<meta|<base|<svg|<iframe|<form|<input|<img|<style|style=/i,
    )
    expect(out).toContain('<p>beforeafter</p>')
    expect(out).toContain('<a href="#orders">Orders</a>')
    expect(out).toContain('<a>link</a>')
    expect(out).toContain('<td colspan="2">cell</td>')
    expect(out).toContain('kept text')
  })

  // Wave 3 review: the rest of what runs, hides markup or reparses.
  it('drops MathML, noscript, templates and comments, and keeps raw text as text', () => {
    const out = [
      '<math><mi xlink:href="#x">x</mi><maction actiontype="statusline">y</maction></math>',
      '<noscript><p title="</noscript><img src=x>"></p></noscript>',
      '<template><img src=x></template>',
      '<xmp><b>raw</b></xmp>',
      '<!--<img src=x>-->',
      '<p>a<!-- hidden --></p>',
      '<p>b<!--><img src=x>--></p>',
    ]
      .map((part) => sanitizeHtml(part))
      .join('')
    expect(out).not.toMatch(/<math|<mi|<maction|<noscript|<template|<img|<xmp|<!--/i)
    expect(out).toContain('<p>a</p>')
  })
  it('refuses a style that could end its element or fetch anything', () => {
    refused(() => htmlPage('t', 'p{}</style><script>alert(1)</script>', '<p>x</p>'))
    refused(() => htmlPage('t', '@import "https://evil.example/a.css";', '<p>x</p>'))
    refused(() => htmlPage('t', 'p { background: url(https://evil.example/a.png) }', '<p>x</p>'))
    expect(htmlPage('t', 'p { background: url(data:image/png;base64,AAAA) }', '<p>x</p>')).toContain(
      'url(data:image/png',
    )
    // Wave 3 review: escapes, image-set, src() and fonts — a renderer without the page's policy
    // (a mail preview, a word processor) would load them.
    for (const css of [
      'p { background: u\\72l(https://example.org/a.png) }',
      '@\\69mport "https://example.org/a.css";',
      'p { background-image: image-set("https://example.org/a.png" 1x) }',
      'p { background-image: -webkit-image-set(url(data:image/png;base64,AA) 1x) }',
      '@font-face { font-family: x; src: local(Arial) }',
      'p { background: src("https://example.org/a.png") }',
      'p { width: expression(1) }',
      'p { behavior: url(#default#x) }',
    ])
      refused(() => htmlPage('t', css, '<p>x</p>'))
  })
})

describe('what a plugin asks to save', () => {
  it('takes the text kinds as text, with their extension and type', async () => {
    const md = buildDownload({ name: 'shop', type: 'markdown', text: '# Shop' }, 'data-dictionary')
    expect(md.name).toBe('shop.md')
    expect(md.blob.type).toBe('text/markdown;charset=utf-8')
    expect(await md.blob.text()).toBe('# Shop')
    expect(buildDownload({ name: 'model', type: 'mermaid', text: 'erDiagram' }, 'p').name).toBe('model.mmd')
    expect(buildDownload({ name: 'q', type: 'csv', text: 'a,b' }, 'p').blob.type).toBe(
      'text/csv;charset=utf-8',
    )
    // Plugins wave 4: documents, one per line (an anonymised copy).
    const lines = buildDownload({ name: 'orders', type: 'ndjson', text: '{"a":1}\n' }, 'p')
    expect(lines.name).toBe('orders.ndjson')
    expect(lines.blob.type).toBe('application/x-ndjson;charset=utf-8')
  })

  // Wave 3 review: a CSV a plugin made never carries a formula a spreadsheet would run.
  it('writes a CSV cell that starts like a formula as text', async () => {
    const text = [
      'a,b',
      '"=HYPERLINK(""https://example.org"",""x"")",-2',
      '"@SUM(A1)",+SUM(A1:A2)',
      '"x, ""y""",\tz',
      '3.5,ok',
    ].join('\r\n')
    const csv = buildDownload({ name: 'q', type: 'csv', text }, 'p')
    expect(await csv.blob.text()).toBe(
      [
        'a,b',
        `"'=HYPERLINK(""https://example.org"",""x"")",-2`,
        `"'@SUM(A1)",'+SUM(A1:A2)`,
        `"x, ""y""","'\tz"`,
        '3.5,ok',
      ].join('\r\n'),
    )
    // Plain line ends kept; a number is never guarded.
    expect(await buildDownload({ name: 'q', type: 'csv', text: 'a\n-1e5\n=1+1\n' }, 'p').blob.text()).toBe(
      "a\n-1e5\n'=1+1\n",
    )
  })

  // Wave 3 second review: a spreadsheet that splits on ; (a Turkish Excel, or a "sep=" line), a
  // byte-order mark, old Mac line ends, and a decimal comma.
  it('guards a CSV read with another separator, after a BOM, and with bare CR line ends', async () => {
    const text = async (t: string) => buildDownload({ name: 'q', type: 'csv', text: t }, 'p').blob.text()
    // One cell holding ; is quoted: never split into a formula by a ;-separated reader.
    expect(await text('a;=1+1,b')).toBe('"a;=1+1",b')
    expect(await text('a\t=1+1,b')).toBe('"a\t=1+1",b')
    // A "sep=" line: the file is read with that separator.
    expect(await text('sep=;\nx;=1+1\n')).toBe("sep=;\nx;'=1+1\n")
    // A BOM stays first, and the first cell is still guarded.
    const bom = String.fromCharCode(0xfeff)
    expect(await text(`${bom}=1+1,b`)).toBe(`${bom}'=1+1,b`)
    // Bare CR line ends are line ends.
    expect(await text('a\r=1+1\rb')).toBe("a\r'=1+1\rb")
    // Third review: a first line that only looks like a directive is quoted, never read as one.
    expect(await text('sep=| \na|=1+1')).toBe('"sep=| "\n"a|=1+1"')
    // A decimal comma is a number, never guarded.
    expect(await text('"-1,5",x')).toBe('"-1,5",x')
  })

  it('takes a PNG only when it is one', async () => {
    const png = buildDownload({ name: 'model', type: 'png', base64: PNG }, 'p')
    expect(png.name).toBe('model.png')
    expect(png.blob.type).toBe('image/png')
    expect(new Uint8Array(await png.blob.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    )
    refused(() => buildDownload({ name: 'x', type: 'png', base64: btoa('<html>not a png</html>') }, 'p'))
    refused(() => buildDownload({ name: 'x', type: 'png', base64: '%%%' }, 'p'))
  })

  it('assembles an HTML page from its parts, never a page of its own', async () => {
    const html = buildDownload(
      {
        name: 'shop',
        type: 'html',
        html: { title: 'Shop', css: 'p{}', body: '<p>x</p><script>x()</script>' },
      },
      'p',
    )
    expect(html.name).toBe('shop.html')
    const text = await html.blob.text()
    expect(text.startsWith('<!doctype html>')).toBe(true)
    expect(text).not.toContain('<script>')
    refused(() => buildDownload({ name: 'x', type: 'html', text: '<script>x()</script>' }, 'p'))
  })

  it('refuses an unknown kind, a missing or wrong body, and text past its bound', () => {
    refused(() => buildDownload({ name: 'x', type: 'exe', text: 'MZ' }, 'p'))
    refused(() => buildDownload({ name: 'x', type: 'markdown' }, 'p'))
    refused(() => buildDownload({ name: 'x', type: 'markdown', text: 42 }, 'p'))
    refused(() => buildDownload({ name: 'x', type: 'markdown', text: 'x'.repeat(1_000_001) }, 'p'))
    refused(() => buildDownload(null, 'p'))
  })
})
