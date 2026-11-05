// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Where a text position of a textarea is drawn, relative to the textarea's box: a hidden copy of
 * it with the same font, padding and wrapping, its text up to the position, then a marker.
 */
const COPIED = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'textTransform',
  'textIndent',
] as const

export function caretPoint(
  area: HTMLTextAreaElement,
  position: number,
): { left: number; top: number; height: number } {
  const style = getComputedStyle(area)
  const copy = document.createElement('div')
  for (const name of COPIED) copy.style[name] = style[name]
  copy.style.position = 'absolute'
  copy.style.visibility = 'hidden'
  copy.style.whiteSpace = 'pre-wrap'
  copy.style.overflowWrap = 'break-word'
  copy.style.overflow = 'hidden'
  copy.style.top = '0'
  copy.style.left = '-9999px'
  copy.textContent = area.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = area.value.slice(position) || '.'
  copy.append(marker)
  document.body.append(copy)
  const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 18
  const point = { left: marker.offsetLeft - area.scrollLeft, top: marker.offsetTop - area.scrollTop, height }
  copy.remove()
  return point
}
