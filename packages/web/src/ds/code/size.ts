// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER

/** The size of a text in UTF-8, as people read it: "54 KB", "1.2 MB". */
export function byteSize(text: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let n = new TextEncoder().encode(text).length
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} ${units[unit]}`
}
