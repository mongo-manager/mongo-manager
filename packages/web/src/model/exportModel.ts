// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DataModel } from '@mongo-manager/shared/browser'
import { downloadBlob, downloadJson } from '@/download'
import { HEADER_H, ROW_H, rowY, type ModelLayout } from './layout'
import { MANY_PATH, MARK_TEXT, ONE_PATH, edgeEnds, fieldMark, hasMarks, modelMermaid } from './marks'

/**
 * completion W6.4: the data model exported as an image (SVG, PNG) and as JSON. The image is drawn
 * from the layout as plain SVG with the colours of the theme in use written out, so it opens
 * anywhere; every name is escaped — collection and field names are the database's, not ours.
 */
export interface ModelPalette {
  background: string
  surface: string
  line: string
  fg: string
  muted: string
  accent: string
}

/** Review minor 11: the image's words, in the reader's language. */
export interface ModelWords {
  title(db: string): string
  viewOn(coll: string): string
  refused(reason: string): string
  more(n: number): string
  hidden: string
}
type T = (key: string, values?: Record<string, unknown>) => string
export const modelWords = (t: T): ModelWords => ({
  title: (db) => t('model.export.imageTitle', { db }),
  viewOn: (coll) => t('model.viewOn', { coll }),
  refused: (reason) => t(`model.refused.${reason}`),
  more: (n) => t('model.more', { n }),
  hidden: t('model.hidden'),
})

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const xml = (s: string): string => s.replace(/[&<>"']/g, (c) => XML[c]!)
/** A name cut to fit its box, by characters (the box is a fixed width). */
const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

export function modelSvg(model: DataModel, layout: ModelLayout, p: ModelPalette, w: ModelWords): string {
  const font = `font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"`
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<title>${xml(w.title(model.db))}</title>`,
    `<rect width="100%" height="100%" fill="${xml(p.background)}"/>`,
    // Plugins wave 3: a reference ends as many at its field, one (or many) at the collection.
    `<defs>`,
    `<marker id="many" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="${MANY_PATH}" fill="none" stroke="${xml(p.accent)}" stroke-width="1.2"/></marker>`,
    `<marker id="one" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="${ONE_PATH}" fill="none" stroke="${xml(p.accent)}" stroke-width="1.2"/></marker>`,
    `</defs>`,
  ]
  for (const e of layout.edges) {
    const dash =
      e.kind === 'view'
        ? ' stroke-dasharray="2 4"'
        : e.sources.includes('name') || e.sources.includes('values')
          ? ''
          : ' stroke-dasharray="6 4"'
    const ends = edgeEnds(e.many)
    const markers =
      e.kind === 'reference' ? ` marker-start="url(#${ends.start})" marker-end="url(#${ends.end})"` : ''
    parts.push(
      `<path data-kind="${e.kind}" d="${e.d}" fill="none" stroke="${xml(p.accent)}" stroke-width="1.5"${dash}${markers}/>`,
    )
  }
  const byName = new Map(model.collections.map((c) => [c.name, c]))
  for (const n of layout.nodes) {
    const c = byName.get(n.name)!
    // Plugins wave 3: a box with marked fields starts its names further in, for the marks' column.
    const indent = hasMarks(c) ? 30 : 12
    parts.push(
      `<g data-node="${xml(n.name)}">`,
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${xml(p.surface)}" stroke="${xml(p.line)}"/>`,
      `<line x1="${n.x}" y1="${n.y + HEADER_H}" x2="${n.x + n.w}" y2="${n.y + HEADER_H}" stroke="${xml(p.line)}"/>`,
      `<text x="${n.x + 12}" y="${n.y + HEADER_H / 2 + 5}" ${font} font-size="13" font-weight="600" fill="${xml(p.fg)}">${xml(fit(n.name, 28))}</text>`,
    )
    if (c.type === 'view' || c.refused) {
      const note = c.type === 'view' ? w.viewOn(c.viewOn ?? '?') : w.refused(c.refused ?? 'error')
      parts.push(
        `<text x="${n.x + 12}" y="${rowY(n, 0) + 4}" ${font} font-size="11" fill="${xml(p.muted)}">${xml(fit(note, 34))}</text>`,
      )
    } else {
      n.rows.forEach((path, i) => {
        const f = c.fields.find((x) => x.path === path)
        const type = f?.masked ? w.hidden : (f?.types[0] ?? '')
        const mark = fieldMark(c, path)
        if (mark)
          parts.push(
            `<text data-mark="${mark}" x="${n.x + 10}" y="${rowY(n, i) + 4}" ${font} font-size="8.5" font-weight="700" fill="${xml(p.accent)}">${MARK_TEXT[mark]}</text>`,
          )
        parts.push(
          `<text x="${n.x + indent}" y="${rowY(n, i) + 4}" ${font} font-size="11" fill="${xml(p.fg)}">${xml(fit(path, indent > 12 ? 24 : 26))}</text>`,
          `<text x="${n.x + n.w - 12}" y="${rowY(n, i) + 4}" ${font} font-size="10" text-anchor="end" fill="${xml(p.muted)}">${xml(type)}</text>`,
        )
      })
      if (n.more > 0)
        parts.push(
          `<text x="${n.x + 12}" y="${n.y + HEADER_H + n.rows.length * ROW_H + ROW_H / 2 + 4}" ${font} font-size="10" fill="${xml(p.muted)}">${xml(w.more(n.more))}</text>`,
        )
    }
    parts.push(`</g>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

/** The theme's colours as the page shows them now. */
export function paletteOfPage(): ModelPalette {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: v('--ds-canvas', '#f7f8fa'),
    surface: v('--ds-surface', '#ffffff'),
    line: v('--ds-line-strong', '#d0d5dd'),
    fg: v('--ds-fg', '#18181b'),
    muted: v('--ds-fg-subtle', '#667085'),
    accent: v('--ds-accent', '#047a4d'),
  }
}

const fileBase = (model: DataModel) => `${model.db.replace(/[^\w.-]+/g, '_')}-model`

export function exportSvg(model: DataModel, layout: ModelLayout, words: ModelWords): void {
  const svg = modelSvg(model, layout, paletteOfPage(), words)
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase(model)}.svg`)
}

export function exportJson(model: DataModel): void {
  downloadJson(model, `${fileBase(model)}.json`)
}

/** Plugins wave 3 (spec §4): the model as Mermaid's erDiagram, saved as a .mmd file. */
export function exportMermaid(model: DataModel, words: ModelWords): void {
  downloadBlob(
    new Blob([modelMermaid(model, words.hidden)], { type: 'text/plain;charset=utf-8' }),
    `${fileBase(model)}.mmd`,
  )
}

/** The largest side of the PNG, in pixels (a canvas has its limits). */
const MAX_PNG_SIDE = 8_000

/** Draws the SVG on a canvas (twice the size, for sharp text) and saves it as PNG. */
export async function exportPng(model: DataModel, layout: ModelLayout, words: ModelWords): Promise<void> {
  const svg = modelSvg(model, layout, paletteOfPage(), words)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The image could not be drawn'))
      image.src = url
    })
    const scale = Math.min(2, MAX_PNG_SIDE / Math.max(layout.width, layout.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(layout.width * scale))
    canvas.height = Math.max(1, Math.round(layout.height * scale))
    const g = canvas.getContext('2d')
    if (!g) throw new Error('The image could not be drawn')
    g.scale(scale, scale)
    g.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('The image could not be drawn')
    downloadBlob(blob, `${fileBase(model)}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
