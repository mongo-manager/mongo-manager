/**
 * Phase 3a-1 spec §10.1: xterm creates <style> elements at run time and sets their textContent. The
 * app's CSP is style-src 'self', which blocks such inline stylesheets. The Vite plugin (vite/
 * xterm-csp.ts) rewrites xterm's `X.createElement("style")` calls to `mmXtermStyle(X)`, which
 * returns a stand-in whose textContent is routed to a constructable stylesheet adopted on the
 * document — not subject to style-src — so the CSP is never relaxed.
 *
 * The stand-in is a hidden <span> (a real Node, so xterm's appendChild works) that carries no CSS
 * itself; the CSS lives in the adopted sheet, removed when the span is removed.
 */
export function mmXtermStyle(doc: Document): HTMLStyleElement {
  const span = doc.createElement('span')
  span.style.display = 'none'
  const supportsAdopted =
    typeof (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet === 'function' &&
    'adoptedStyleSheets' in doc &&
    'replaceSync' in CSSStyleSheet.prototype
  const sheet = supportsAdopted ? new CSSStyleSheet() : null
  const attach = () => {
    if (sheet && !doc.adoptedStyleSheets.includes(sheet))
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  }
  const detach = () => {
    if (sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet)
  }
  Object.defineProperty(span, 'textContent', {
    configurable: true,
    get: () => sheet?.cssRules.length ?? 0,
    set: (css: string) => {
      if (sheet) {
        sheet.replaceSync(String(css))
        attach()
      }
    },
  })
  const realRemove = span.remove.bind(span)
  span.remove = () => {
    detach()
    realRemove()
  }
  return span as unknown as HTMLStyleElement
}

// The Vite plugin injects `import { mmXtermStyle }` and rewrites calls to it, so xterm uses it.
