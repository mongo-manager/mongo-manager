// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { langTag, pick, pluralOf, shown, type Language } from '../../kit/src/i18n'

/**
 * Plugins wave 3 (spec §8, NoSQLBooster's "Binary Image Preview Tooltip"): what a binary value holds,
 * told from its first bytes — an image's kind and size in pixels, a document, an archive, audio or
 * video — as a cell's text. The app sends a renderer the value's head only (2,048 bytes), its
 * subtype and its length.
 */

export interface Sniffed {
  kind: Kind
  /** The type an image is drawn as (only what a browser draws). */
  mime?: string
  /** A browser draws it in an <img>. */
  image: boolean
  width?: number
  height?: number
}
export type Kind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'svg'
  | 'tiff'
  | 'pdf'
  | 'zip'
  | 'gzip'
  | 'mp3'
  | 'mp4'
  | 'avif'
  | 'heic'
  | 'mov'
  | '3gp'
  | 'm4a'
  | 'unknown'

type Names = Record<Exclude<Kind, 'unknown'>, string>
export const NAMES = {
  en: {
    png: 'PNG image',
    jpeg: 'JPEG image',
    gif: 'GIF image',
    webp: 'WebP image',
    bmp: 'BMP image',
    svg: 'SVG image',
    tiff: 'TIFF image',
    pdf: 'PDF document',
    zip: 'ZIP archive',
    gzip: 'gzip data',
    mp3: 'MP3 audio',
    mp4: 'MP4 video',
    avif: 'AVIF image',
    heic: 'HEIC image',
    mov: 'QuickTime video',
    '3gp': '3GP video',
    m4a: 'M4A audio',
  },
  tr: {
    png: 'PNG görseli',
    jpeg: 'JPEG görseli',
    gif: 'GIF görseli',
    webp: 'WebP görseli',
    bmp: 'BMP görseli',
    svg: 'SVG görseli',
    tiff: 'TIFF görseli',
    pdf: 'PDF belgesi',
    zip: 'ZIP arşivi',
    gzip: 'gzip verisi',
    mp3: 'MP3 sesi',
    mp4: 'MP4 videosu',
    avif: 'AVIF görseli',
    heic: 'HEIC görseli',
    mov: 'QuickTime videosu',
    '3gp': '3GP videosu',
    m4a: 'M4A sesi',
  },
  zh: {
    png: 'PNG 图片',
    jpeg: 'JPEG 图片',
    gif: 'GIF 图片',
    webp: 'WebP 图片',
    bmp: 'BMP 图片',
    svg: 'SVG 图片',
    tiff: 'TIFF 图片',
    pdf: 'PDF 文档',
    zip: 'ZIP 压缩包',
    gzip: 'gzip 数据',
    mp3: 'MP3 音频',
    mp4: 'MP4 视频',
    avif: 'AVIF 图片',
    heic: 'HEIC 图片',
    mov: 'QuickTime 视频',
    '3gp': '3GP 视频',
    m4a: 'M4A 音频',
  },
  ja: {
    png: 'PNG 画像',
    jpeg: 'JPEG 画像',
    gif: 'GIF 画像',
    webp: 'WebP 画像',
    bmp: 'BMP 画像',
    svg: 'SVG 画像',
    tiff: 'TIFF 画像',
    pdf: 'PDF ドキュメント',
    zip: 'ZIP アーカイブ',
    gzip: 'gzip データ',
    mp3: 'MP3 音声',
    mp4: 'MP4 動画',
    avif: 'AVIF 画像',
    heic: 'HEIC 画像',
    mov: 'QuickTime 動画',
    '3gp': '3GP 動画',
    m4a: 'M4A 音声',
  },
  es: {
    png: 'Imagen PNG',
    jpeg: 'Imagen JPEG',
    gif: 'Imagen GIF',
    webp: 'Imagen WebP',
    bmp: 'Imagen BMP',
    svg: 'Imagen SVG',
    tiff: 'Imagen TIFF',
    pdf: 'Documento PDF',
    zip: 'Archivo ZIP',
    gzip: 'Datos gzip',
    mp3: 'Audio MP3',
    mp4: 'Vídeo MP4',
    avif: 'Imagen AVIF',
    heic: 'Imagen HEIC',
    mov: 'Vídeo QuickTime',
    '3gp': 'Vídeo 3GP',
    m4a: 'Audio M4A',
  },
  pt: {
    png: 'Imagem PNG',
    jpeg: 'Imagem JPEG',
    gif: 'Imagem GIF',
    webp: 'Imagem WebP',
    bmp: 'Imagem BMP',
    svg: 'Imagem SVG',
    tiff: 'Imagem TIFF',
    pdf: 'Documento PDF',
    zip: 'Arquivo ZIP',
    gzip: 'Dados gzip',
    mp3: 'Áudio MP3',
    mp4: 'Vídeo MP4',
    avif: 'Imagem AVIF',
    heic: 'Imagem HEIC',
    mov: 'Vídeo QuickTime',
    '3gp': 'Vídeo 3GP',
    m4a: 'Áudio M4A',
  },
  ko: {
    png: 'PNG 이미지',
    jpeg: 'JPEG 이미지',
    gif: 'GIF 이미지',
    webp: 'WebP 이미지',
    bmp: 'BMP 이미지',
    svg: 'SVG 이미지',
    tiff: 'TIFF 이미지',
    pdf: 'PDF 문서',
    zip: 'ZIP 압축 파일',
    gzip: 'gzip 데이터',
    mp3: 'MP3 오디오',
    mp4: 'MP4 동영상',
    avif: 'AVIF 이미지',
    heic: 'HEIC 이미지',
    mov: 'QuickTime 동영상',
    '3gp': '3GP 동영상',
    m4a: 'M4A 오디오',
  },
  de: {
    png: 'PNG-Bild',
    jpeg: 'JPEG-Bild',
    gif: 'GIF-Bild',
    webp: 'WebP-Bild',
    bmp: 'BMP-Bild',
    svg: 'SVG-Bild',
    tiff: 'TIFF-Bild',
    pdf: 'PDF-Dokument',
    zip: 'ZIP-Archiv',
    gzip: 'gzip-Daten',
    mp3: 'MP3-Audio',
    mp4: 'MP4-Video',
    avif: 'AVIF-Bild',
    heic: 'HEIC-Bild',
    mov: 'QuickTime-Video',
    '3gp': '3GP-Video',
    m4a: 'M4A-Audio',
  },
  fr: {
    png: 'Image PNG',
    jpeg: 'Image JPEG',
    gif: 'Image GIF',
    webp: 'Image WebP',
    bmp: 'Image BMP',
    svg: 'Image SVG',
    tiff: 'Image TIFF',
    pdf: 'Document PDF',
    zip: 'Archive ZIP',
    gzip: 'Données gzip',
    mp3: 'Audio MP3',
    mp4: 'Vidéo MP4',
    avif: 'Image AVIF',
    heic: 'Image HEIC',
    mov: 'Vidéo QuickTime',
    '3gp': 'Vidéo 3GP',
    m4a: 'Audio M4A',
  },
  ru: {
    png: 'Изображение PNG',
    jpeg: 'Изображение JPEG',
    gif: 'Изображение GIF',
    webp: 'Изображение WebP',
    bmp: 'Изображение BMP',
    svg: 'Изображение SVG',
    tiff: 'Изображение TIFF',
    pdf: 'Документ PDF',
    zip: 'Архив ZIP',
    gzip: 'Данные gzip',
    mp3: 'Аудио MP3',
    mp4: 'Видео MP4',
    avif: 'Изображение AVIF',
    heic: 'Изображение HEIC',
    mov: 'Видео QuickTime',
    '3gp': 'Видео 3GP',
    m4a: 'Аудио M4A',
  },
} satisfies Record<Language, Names>

/** Bytes from base64 — one cut short too (a head): only whole groups of four are read. */
export function bytesOfBase64(base64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null
  const whole = base64.slice(0, base64.length - (base64.length % 4))
  try {
    const raw = atob(whole)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const starts = (b: Uint8Array, sig: Array<number | string>, at = 0): boolean => {
  const want = sig.flatMap((s) => (typeof s === 'string' ? [...s].map((c) => c.charCodeAt(0)) : [s]))
  return b.length >= at + want.length && want.every((v, i) => b[at + i] === v)
}
const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const be32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const le32 = (b: Uint8Array, i: number) =>
  b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24) | 0

const sized = (s: Sniffed, width: number, height: number): Sniffed =>
  width > 0 && height > 0 ? { ...s, width, height } : s

/** A JPEG's size: from its first start-of-frame marker, if the head reaches it. */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2
  while (i + 9 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return [be16(b, i + 7), be16(b, i + 5)]
    i += 2 + be16(b, i + 2)
  }
  return null
}

/** A WebP's size, from its VP8X, VP8 or VP8L header. */
function webpSize(b: Uint8Array): [number, number] | null {
  if (starts(b, ['VP8X'], 12) && b.length >= 30) return [le24(b, 24) + 1, le24(b, 27) + 1]
  if (starts(b, ['VP8 '], 12) && b.length >= 30 && starts(b, [0x9d, 0x01, 0x2a], 23))
    return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff]
  if (starts(b, ['VP8L'], 12) && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  return null
}

/**
 * The header sizes a BMP's DIB header may have, with 32-bit sizes: Windows' (40 and on) and OS/2
 * 2.x's short (16) and full (64) ones (wave 3 second review). OS/2 1.x's 12 has 16-bit sizes.
 */
const BMP_HEADERS = [16, 40, 52, 56, 64, 108, 124]

/**
 * Whether the text is an SVG document: its root element is <svg>, after an optional byte order mark,
 * XML declaration, comments and doctype (wave 3 review: a web page holding an <svg> was taken for one).
 */
function svgRoot(b: Uint8Array): boolean {
  let t = String.fromCharCode(...b.subarray(0, 1024))
  if (t.startsWith(String.fromCharCode(0xef, 0xbb, 0xbf))) t = t.slice(3)
  for (let guard = 0; guard < 50; guard++) {
    t = t.trimStart()
    const lower = t.slice(0, 9).toLowerCase()
    if (lower.startsWith('<?xml')) {
      const end = t.indexOf('?>')
      if (end < 0) return false
      t = t.slice(end + 2)
    } else if (t.startsWith('<!--')) {
      const end = t.indexOf('-->')
      if (end < 0) return false
      t = t.slice(end + 3)
    } else if (lower === '<!doctype') {
      // A doctype may hold an internal subset in brackets, with ">" inside it.
      const bracket = t.indexOf('[')
      const close = t.indexOf('>')
      if (close < 0) return false
      if (bracket >= 0 && bracket < close) {
        // It ends with "]", then any space, then ">" (wave 3 second review: "] >" was refused).
        const end = /\]\s*>/.exec(t.slice(bracket))
        if (!end) return false
        t = t.slice(bracket + end.index + end[0].length)
      } else t = t.slice(close + 1)
    } else return /^<svg[\s/>]/i.test(t)
  }
  return false
}

/**
 * A file of the ISO family by its brands (wave 3 review: an AVIF or HEIC picture was called an MP4
 * video): the major brand, then the compatible ones the head holds.
 */
function isoKind(b: Uint8Array): Sniffed {
  const brand = (i: number) => String.fromCharCode(...b.subarray(i, i + 4))
  const brands = b.length >= 12 ? [brand(8)] : []
  const end = Math.min(be32(b, 0), b.length, 128)
  for (let i = 16; i + 4 <= end; i += 4) brands.push(brand(i))
  const has = (...names: string[]) => brands.some((x) => names.includes(x))
  const major = brands[0] ?? ''
  if (has('avif', 'avis')) return { kind: 'avif', mime: 'image/avif', image: true }
  if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'msf1') || major === 'mif1')
    return { kind: 'heic', image: false }
  if (major === 'qt  ') return { kind: 'mov', image: false }
  if (major.startsWith('3g')) return { kind: '3gp', image: false }
  if (major === 'M4A ' || major === 'M4B ') return { kind: 'm4a', image: false }
  return { kind: 'mp4', image: false }
}

/** What the first bytes say a value is. */
export function sniff(b: Uint8Array): Sniffed {
  if (starts(b, [0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a])) {
    const s: Sniffed = { kind: 'png', mime: 'image/png', image: true }
    return starts(b, ['IHDR'], 12) && b.length >= 24 ? sized(s, be32(b, 16), be32(b, 20)) : s
  }
  if (starts(b, [0xff, 0xd8, 0xff])) {
    const s: Sniffed = { kind: 'jpeg', mime: 'image/jpeg', image: true }
    const size = jpegSize(b)
    return size ? sized(s, size[0], size[1]) : s
  }
  if (starts(b, ['GIF87a']) || starts(b, ['GIF89a'])) {
    const s: Sniffed = { kind: 'gif', mime: 'image/gif', image: true }
    return b.length >= 10 ? sized(s, le16(b, 6), le16(b, 8)) : s
  }
  if (starts(b, ['RIFF']) && starts(b, ['WEBP'], 8)) {
    const s: Sniffed = { kind: 'webp', mime: 'image/webp', image: true }
    const size = webpSize(b)
    return size ? sized(s, size[0], size[1]) : s
  }
  // A BMP is only what has a BMP's header (wave 3 review: anything starting "BM" was one).
  if (starts(b, ['BM']) && b.length >= 22) {
    const bmp: Sniffed = { kind: 'bmp', mime: 'image/bmp', image: true }
    const header = le32(b, 14)
    if (header === 12) return sized(bmp, le16(b, 18), le16(b, 20))
    if (BMP_HEADERS.includes(header) && b.length >= 26) return sized(bmp, le32(b, 18), Math.abs(le32(b, 22)))
  }
  if (starts(b, ['II*', 0]) || starts(b, ['MM', 0, '*'])) return { kind: 'tiff', image: false }
  if (starts(b, ['%PDF-'])) return { kind: 'pdf', image: false }
  if (starts(b, ['PK', 3, 4]) || starts(b, ['PK', 5, 6])) return { kind: 'zip', image: false }
  if (starts(b, [0x1f, 0x8b])) return { kind: 'gzip', image: false }
  if (starts(b, ['ID3']) || starts(b, [0xff, 0xfb]) || starts(b, [0xff, 0xf3]) || starts(b, [0xff, 0xf2]))
    return { kind: 'mp3', image: false }
  if (starts(b, ['ftyp'], 4)) return isoKind(b)
  if (svgRoot(b)) return { kind: 'svg', mime: 'image/svg+xml', image: true }
  return { kind: 'unknown', image: false }
}

/** A length in bytes as a person reads it: "512 bytes", "24 KB", "1,5 MB". */
export function sizeText(n: number, locale: string): string {
  const l = shown(NAMES, locale)
  const number = (v: number) => new Intl.NumberFormat(langTag(l), { maximumFractionDigits: 1 }).format(v)
  if (n < 1024) {
    const category = pluralOf(n, l)
    const one = category === 'one'
    const word = pick<string>(
      {
        en: one ? 'byte' : 'bytes',
        tr: 'bayt',
        zh: '字节',
        ja: 'バイト',
        es: one ? 'byte' : 'bytes',
        pt: one ? 'byte' : 'bytes',
        ko: '바이트',
        de: one ? 'Byte' : 'Bytes',
        fr: one ? 'octet' : 'octets',
        ru: category === 'one' ? 'байт' : category === 'few' ? 'байта' : 'байтов',
      },
      l,
    )
    return `${number(n)} ${word}`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${number(v)} ${units[u]}`
}

/** A binary value's head, as the app sends it (spec §1.4), or null. */
export function headOf(value: unknown): { bytes: Uint8Array; subType: string; length: number } | null {
  if (!value || typeof value !== 'object' || !('$binaryHead' in value)) return null
  const h = (value as { $binaryHead: unknown }).$binaryHead as Record<string, unknown> | null
  if (!h || typeof h.base64 !== 'string' || typeof h.subType !== 'string' || typeof h.length !== 'number')
    return null
  const bytes = bytesOfBase64(h.base64)
  if (!bytes) return null
  return { bytes, subType: h.subType, length: h.length }
}

/** A binary cell's text: its kind, size in pixels and length — or its subtype and length. */
export function binaryAnswer(
  value: unknown,
  locale: string,
): { text: string; tone: 'info' | 'neutral' } | null {
  const head = headOf(value)
  if (!head) return null
  const l = shown(NAMES, locale)
  const s = sniff(head.bytes)
  const size = sizeText(head.length, l)
  if (s.kind === 'unknown') {
    const subtype = /^[0-9a-fA-F]{1,2}$/.test(head.subType)
      ? head.subType.toLowerCase().padStart(2, '0')
      : '?'
    return {
      text: pick(
        {
          en: `Binary · subtype ${subtype} · ${size}`,
          tr: `İkili veri · alt tür ${subtype} · ${size}`,
          zh: `二进制 · 子类型 ${subtype} · ${size}`,
          ja: `バイナリ · サブタイプ ${subtype} · ${size}`,
          es: `Binario · subtipo ${subtype} · ${size}`,
          pt: `Binário · subtipo ${subtype} · ${size}`,
          ko: `바이너리 · 서브타입 ${subtype} · ${size}`,
          de: `Binärdaten · Subtyp ${subtype} · ${size}`,
          fr: `Binaire · sous-type ${subtype} · ${size}`,
          ru: `Двоичные данные · подтип ${subtype} · ${size}`,
        },
        l,
      ),
      tone: 'neutral',
    }
  }
  const pixels = s.width && s.height ? ` · ${s.width} × ${s.height}` : ''
  return { text: `${pick(NAMES, l)[s.kind]}${pixels} · ${size}`, tone: 'info' }
}
