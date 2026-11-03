import { describe, expect, it } from 'vitest'
import { scanPlugin } from '../src/plugins/scan'

// User request 2026-10-11: every plugin is scanned before it is approved ("her eklentide aa evet
// yükle olmamalı"): what in its files could run text as code, write markup, reach out or escape.
const scan = (files: Record<string, string>, permissions: string[] = []) =>
  scanPlugin(new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)])), { permissions } as never)
const rules = (files: Record<string, string>, permissions: string[] = []) =>
  scan(files, permissions).findings.map((f) => `${f.severity}:${f.rule}`)

describe('the plugin scan', () => {
  it('flags code made from text, high', () => {
    expect(rules({ 'a.js': 'const x = eval(input)' })).toEqual(['high:code-from-text'])
    expect(rules({ 'a.js': 'const f = new Function("a", body)' })).toEqual(['high:code-from-text'])
    expect(rules({ 'a.js': 'setTimeout("go()", 10)' })).toEqual(['high:code-from-text'])
    expect(rules({ 'a.js': 'setTimeout(() => go(), 10); const evaluate = 1' })).toEqual([])
  })

  it('flags markup written from text, high; textContent is fine', () => {
    expect(rules({ 'a.js': 'el.innerHTML = name' })).toEqual(['high:html-injection'])
    expect(rules({ 'a.js': 'el.outerHTML=x' })).toEqual(['high:html-injection'])
    expect(rules({ 'a.js': 'el.insertAdjacentHTML("beforeend", x)' })).toEqual(['high:html-injection'])
    expect(rules({ 'a.js': 'document.write(x)' })).toEqual(['high:html-injection'])
    expect(rules({ 'a.js': 'el.textContent = name; if (el.innerHTML === "") ok()' })).toEqual([])
  })

  it('flags code from elsewhere, attempts to leave the frame, packed code', () => {
    expect(rules({ 'index.html': '<script src="https://cdn.example.org/x.js"></script>' })).toEqual([
      'high:remote-code',
    ])
    expect(rules({ 'index.html': '<script src="//cdn.example.org/x.js"></script>' })).toEqual([
      'high:remote-code',
    ])
    expect(rules({ 'index.html': '<script type="module" src="./main.js"></script>' })).toEqual([])
    expect(rules({ 'a.js': 'import("https://x.org/m.js")' })).toEqual(['high:remote-code'])
    expect(rules({ 'a.js': 'importScripts("w.js")' })).toEqual(['high:remote-code'])
    expect(rules({ 'a.js': 'parent.document.body' })).toEqual(['high:escape-attempt'])
    expect(rules({ 'a.js': 'top.location = "x"' })).toEqual(['high:escape-attempt'])
    expect(rules({ 'a.js': 'window.opener.x' })).toEqual(['high:escape-attempt'])
    expect(rules({ 'a.js': 'const h = window.parent; h.postMessage(m, "*")' })).toEqual([])
    expect(rules({ 'a.js': 'eval(atob("ZXZpbA=="))' })).toEqual(['high:code-from-text', 'high:packed-code'])
  })

  it('flags reaching out, inline handlers, workers and the write permission, medium', () => {
    expect(rules({ 'a.js': 'fetch(url)' })).toEqual(['medium:network'])
    expect(rules({ 'a.js': 'window.fetch(url); globalThis . fetch(u)' })).toEqual(['medium:network'])
    // Another object's fetch (a Map's, Ruby's ENV in a code sample) reaches nothing.
    expect(rules({ 'a.js': "cache.fetch(k); ENV.fetch('MONGODB_URI')" })).toEqual([])
    expect(rules({ 'a.js': 'new XMLHttpRequest()' })).toEqual(['medium:network'])
    expect(rules({ 'a.js': 'new WebSocket(u)' })).toEqual(['medium:network'])
    expect(rules({ 'index.html': '<button onclick="go()">x</button>' })).toEqual(['medium:inline-handler'])
    expect(rules({ 'index.html': '<a href="javascript:go()">x</a>' })).toEqual(['medium:inline-handler'])
    expect(rules({ 'a.js': 'new Worker("w.js")' })).toEqual(['medium:workers'])
    expect(rules({ 'mongo-manager-plugin.json': '{}' }, ['documents:read', 'documents:write'])).toEqual([
      'medium:write-permission',
    ])
  })

  it('notes storage (it fails in the sandbox), minified code and big data blobs', () => {
    expect(rules({ 'a.js': 'localStorage.setItem(k, v)' })).toEqual(['low:storage'])
    expect(rules({ 'a.js': `var a=1;${'x'.repeat(3000)}` })).toEqual(['info:minified'])
    expect(rules({ 'a.js': `const img = "${'A'.repeat(14000)}"` })).toEqual([
      'info:minified',
      'info:data-blob',
    ])
  })

  it('says where: the file, the line, a short excerpt; reads only code and markup', () => {
    const { findings } = scan({
      'src/view.js': 'const a = 1\nconst b = 2\nel.innerHTML = b\n',
      'notes.md': 'eval(x)',
    })
    expect(findings).toEqual([
      { rule: 'html-injection', severity: 'high', file: 'src/view.js', line: 3, excerpt: 'el.innerHTML = b' },
    ])
  })

  it('counts by severity, most serious first, and bounds what it keeps', () => {
    const many = Array.from({ length: 50 }, () => 'eval(x)').join('\n')
    const result = scan({ 'a.js': many, 'b.js': 'fetch(u)', 'c.js': 'localStorage.x' })
    expect(result.counts).toEqual({ high: 50, medium: 1, low: 1, info: 0 })
    // At most 10 a rule in a file are listed; the counts are whole.
    expect(result.findings.filter((f) => f.file === 'a.js')).toHaveLength(10)
    expect(result.findings.map((f) => f.severity)).toEqual([...Array(10).fill('high'), 'medium', 'low'])
    expect(result.truncated).toBe(true)
  })

  it('takes linear time on hostile lines: no pattern backtracks over a long line', () => {
    // A plugin's files are its author's: the scan of 2 MB built to make a pattern backtrack
    // (an open tag never closed, base64 runs just short of a blob) ends in well under a second.
    const hostile = {
      'index.html': '<a '.repeat(700_000),
      'b.html': '<script '.repeat(250_000),
      'c.js': `${'A'.repeat(13_000)}!`.repeat(150),
    }
    const started = performance.now()
    const result = scan(hostile)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(result.findings.some((f) => f.rule === 'data-blob')).toBe(false)
    // The bounded forms still find what they look for.
    expect(rules({ 'index.html': `<div ${'x'.repeat(300)} onload="go()">` })).toEqual([
      'medium:inline-handler',
    ])
    expect(rules({ 'c.js': `"${'A'.repeat(14_000)}"` })).toEqual(['info:minified', 'info:data-blob'])
    // Text outside a tag is no attribute; decoys there hide nothing that follows them.
    expect(rules({ 'index.html': '<p>x onfoo=1 src=//x.org</p><b>y</b>' })).toEqual([])
    const decoys = `${'<p>x onfoo=1</p>'.repeat(5000)}<script src="https://x.org/a.js"></script>`
    expect(rules({ 'index.html': decoys })).toEqual(['high:remote-code'])
    expect(rules({ 'index.html': `${'<b>a onx=1</b> '.repeat(5000)}<i onclick="x()">` })).toEqual([
      'medium:inline-handler',
    ])
  })

  it('shows an excerpt as plain text: short, no control or hidden characters', () => {
    const { findings } = scan({ 'a.js': `x.innerHTML = "\u202e${'y'.repeat(500)}"` })
    expect(findings[0]!.excerpt.length).toBeLessThanOrEqual(160)
    expect(findings[0]!.excerpt).not.toContain('\u202e')
  })

  // Review 2026-10-11 (C1): `\s*["']?\s*` split a run of spaces every way — a line of spaces after
  // `src=` froze the server, at every start. Every pattern's own prefix, then a long run of blanks.
  it('takes linear time on every pattern’s hostile shape', () => {
    const prefixes = [
      '<a src=',
      '<script src=',
      '<b onx=',
      '@import ',
      'import(',
      'import x from',
      'eval',
      'Function',
      'setTimeout(',
      'parent',
      'window.',
      'document.',
      'el.innerHTML',
      "el['innerHTML']",
      'fetch',
      'new ',
      'opener',
    ]
    const started = performance.now()
    for (const prefix of prefixes)
      for (const blank of [' ', '\u00a0', '\t'])
        scan({
          'a.html': prefix + blank.repeat(150_000),
          'b.js': prefix + blank.repeat(150_000),
          'c.html': `${prefix} `.repeat(20_000),
        })
    expect(performance.now() - started).toBeLessThan(4000)
  })

  // Review 2026-10-11 (I2): the common forms of injection, each found.
  it('finds markup written by +=, by a bracketed name, and through optional calls', () => {
    for (const line of [
      'el.innerHTML += x',
      "el['innerHTML'] = x",
      'el["outerHTML"]+=x',
      'document.write?.(x)',
      "el.insertAdjacentHTML?.('beforeend', x)",
      'range.createContextualFragment(x)',
      'el.setHTMLUnsafe(x)',
    ])
      expect(rules({ 'a.js': line }), line).toEqual(['high:html-injection'])
    expect(rules({ 'a.js': "if (el['innerHTML'] === '') ok()" })).toEqual([])
  })

  it('finds code made from text however eval or Function is reached', () => {
    for (const line of [
      'Function("return this")()',
      '(0, eval)(x)',
      'eval?.(x)',
      "window['eval'](x)",
      // Review of the deferred fixes (M10): what the repository's own gate finds.
      'globalThis.Function("x")()',
      "self['Function']('x')",
      '[eval][0](x)',
      'Function.call(null, "x")',
      'Reflect.construct(Function, ["x"])',
      'Reflect.apply(eval, null, [x])',
    ])
      expect(rules({ 'a.js': line }), line).toEqual(['high:code-from-text'])
    expect(rules({ 'a.js': 'menu.Function(x); const evaluated = 1' })).toEqual([])
  })

  it('finds code imported from elsewhere, and a script tag over several lines', () => {
    expect(rules({ 'a.js': 'import x from "https://a.org/m.js"' })).toEqual(['high:remote-code'])
    expect(rules({ 'a.js': "import '//a.org/m.js'" })).toEqual(['high:remote-code'])
    expect(rules({ 'a.js': "export * from 'https://a.org/m.js'" })).toEqual(['high:remote-code'])
    expect(rules({ 'a.js': "import x from './m.js'" })).toEqual([])
    const { findings } = scan({
      'index.html': '<p>hi</p>\n<script\n  type="module"\n  src="https://x.org/a.js"></script>',
    })
    expect(findings).toMatchObject([{ rule: 'remote-code', line: 2 }])
    expect(rules({ 'index.html': '<button\n  onclick="go()">x</button>' })).toEqual(['medium:inline-handler'])
  })

  it('flags reaching for the opener, not a variable named so', () => {
    expect(rules({ 'a.js': 'const opener = menu(); opener.open()' })).toEqual([])
    expect(rules({ 'a.js': 'window.opener.postMessage(x, "*")' })).toEqual(['high:escape-attempt'])
    expect(rules({ 'a.js': 'opener.location = "x"' })).toEqual(['high:escape-attempt'])
  })

  // Review 2026-10-11 (I3): a browser obeys a byte-order mark; the scan reads what it would run.
  it('reads a file saved as UTF-16, and says so, as it says of NUL bytes', () => {
    const utf16le = Buffer.from('\ufeffel.innerHTML = x', 'utf16le')
    const utf16be = Buffer.from(utf16le).swap16()
    for (const data of [utf16le, utf16be])
      expect(
        scanPlugin(new Map([['a.js', data]]), { permissions: [] } as never).findings.map(
          (f) => `${f.severity}:${f.rule}`,
        ),
      ).toEqual(['high:html-injection', 'medium:unusual-encoding'])
    expect(rules({ 'a.js': 'a\u0000b' })).toEqual(['medium:unusual-encoding'])
  })

  // Review 2026-10-11 (I4): what is stored and sent stays small, whatever a plugin holds.
  it('lists at most 200 findings, most serious first, the counts whole', () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`f${i}.js`, Array(10).fill('eval(x)').join('\n')]),
    )
    files['net.js'] = 'fetch(u)'
    const result = scan(files)
    expect(result.counts.high).toBe(600)
    expect(result.counts.medium).toBe(1)
    expect(result.findings).toHaveLength(200)
    expect(result.findings.every((f) => f.severity === 'high')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  // Security audit 2026-10-16: connect-src 'none' does not stop WebRTC (Chromium ignores the CSP
  // webrtc directive) nor a name looked up ahead by a prefetch hint — both can carry data out.
  it('flags WebRTC and prefetch hints, high: what the frame’s policy may not stop', () => {
    for (const line of [
      'const pc = new RTCPeerConnection({ iceServers: [] })',
      'new webkitRTCPeerConnection(cfg)',
      'const C = window.mozRTCPeerConnection',
      'pc.ondatachannel = (e) => e.channel instanceof RTCDataChannel',
    ])
      expect(rules({ 'a.js': line }), line).toEqual(['high:webrtc'])
    const hints: Array<[string, string]> = [
      ['index.html', '<link rel="dns-prefetch" href="//x.example.org">'],
      ['index.html', "<link rel='preconnect' href='https://x.example.org'>"],
      ['index.html', '<link rel=prefetch href="https://x.example.org/a">'],
      ['index.html', '<link href="https://x.example.org/a" rel="prerender">'],
      ['a.js', "link.rel = 'dns-prefetch'"],
      ['a.js', 'l.rel="preconnect"'],
      ['a.js', "el.setAttribute('rel', 'prefetch')"],
      ['a.js', "link.relList.add('preconnect')"],
    ]
    for (const [file, line] of hints) expect(rules({ [file]: line }), line).toEqual(['high:prefetch-hint'])
    // Words alone, or the app's own module preload, are nothing.
    expect(rules({ 'a.js': 'const prefetch = true; const rtc = 1; link.rel = "modulepreload"' })).toEqual([])
    expect(rules({ 'index.html': '<link rel="stylesheet" href="style.css">' })).toEqual([])
  })

  it('takes linear time on the WebRTC and prefetch patterns', () => {
    const started = performance.now()
    for (const prefix of ['rel', 'rel=', '<link rel=', "setAttribute('rel',", 'RTC'])
      for (const blank of [' ', ' ', '\t', '"', "'"])
        scan({
          'a.html': prefix + blank.repeat(150_000),
          'b.js': prefix + blank.repeat(150_000),
          'c.html': `${prefix} `.repeat(20_000),
        })
    expect(performance.now() - started).toBeLessThan(4000)
  })

  // Review 2026-10-11 (minor 4): nothing in an excerpt hides, reverses or breaks the line it is in.
  it('keeps out of an excerpt every hidden, reversing or line-breaking character, and half pairs', () => {
    const hidden = '\u0085\u061c\u2028\u2029\ufeff\u2060\u200b\u{e0041}'
    // Each emoji is two code units: with one more character before them the cut falls inside one.
    for (const pad of ['', 'a']) {
      const { findings } = scan({ 'a.js': `x.innerHTML = "${hidden}${pad}${'😀'.repeat(200)}"` })
      const excerpt = findings[0]!.excerpt
      for (const c of hidden) expect(excerpt).not.toContain(c)
      expect(excerpt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
  })
})
