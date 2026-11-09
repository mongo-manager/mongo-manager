// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { AskError, askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  button,
  callout,
  dataImage,
  emptyState,
  h,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  shown as shownLanguage,
  skeleton,
  type Language,
  statusLine,
} from '../../kit/src/ui'
import { idText, imageFields, imagesIn, pageFilter, type ImageEntry } from './images'
import { sizeText } from './sniff'

/**
 * Plugins wave 3 (spec §8): the images in a collection's documents (a gallery, 12 at a time, within
 * the Documents filter) and in one document (its action). Each is drawn from the value's own bytes
 * as a data: address — the frame's policy lets nothing else in — and opens large; its document
 * opens in the app.
 */
export const PAGE = 12
/** Images this small or smaller (in pixels a side) are drawn to fill their box, pixels kept sharp. */
const SMALL = 64
/** Documents read to find which fields hold images; fewer where they are over 1 MB together. */
const SAMPLE = 50
const SMALLER_SAMPLE = 10

type Doc = Record<string, unknown>
interface Text {
  title: string
  description: (coll: string) => string
  documentTitle: string
  documentDescription: string
  reading: string
  noPlace: string
  noneTitle: string
  noneHint: (n: number, filtered: boolean) => string
  noneInDocument: string
  emptyTitle: string
  empty: (filtered: boolean) => string
  unreadTitle: string
  more: (n: number) => string
  shown: (n: number) => string
  tooLarge: (n: number) => string
  open: string
  close: string
  imageOf: (path: string, id: string) => string
  failed: string
  documentTooLarge: string
}
/** Russian forms by the kit's plural category (one, few, else many). */
const russian = <T>(n: number, one: T, few: T, many: T): T => {
  const c = pluralOf(n, 'ru')
  return c === 'one' ? one : c === 'few' ? few : many
}
export const TEXT = {
  en: {
    title: 'Images',
    description: (coll: string) =>
      `The images stored in the documents of ${coll}, drawn from their own bytes.`,
    documentTitle: 'Images in this document',
    documentDescription: 'Every image the document holds, drawn from its own bytes.',
    reading: 'Looking for images…',
    noPlace: 'Open a collection to see its images.',
    noneTitle: 'No image found',
    noneHint: (n: number, filtered: boolean) =>
      `No field of the first ${n} ${pluralOf(n, 'en') === 'one' ? 'document' : 'documents'}${filtered ? ' the Documents filter keeps' : ''} holds an image (PNG, JPEG, GIF, WebP, AVIF, BMP or SVG).`,
    noneInDocument: 'This document holds no image (PNG, JPEG, GIF, WebP, AVIF, BMP or SVG).',
    emptyTitle: 'No document',
    empty: (filtered: boolean): string =>
      filtered ? 'The Documents filter keeps no document.' : 'The collection holds no document.',
    unreadTitle: 'No document could be looked at',
    more: (n: number) => `Show ${n} more`,
    shown: (n: number) => `${n} ${pluralOf(n, 'en') === 'one' ? 'image' : 'images'}`,
    tooLarge: (n: number) =>
      `${n} ${pluralOf(n, 'en') === 'one' ? 'document is' : 'documents are'} too large to show here (over 1 MB); open ${pluralOf(n, 'en') === 'one' ? 'it' : 'them'} in Documents.`,
    open: 'Open document',
    close: 'Close',
    imageOf: (path: string, id: string) => `${path} of ${id}`,
    failed: 'The images could not be read: ',
    documentTooLarge:
      'This document is over 1 MB: too large to show here. Open it in Documents to see its fields.',
  },
  tr: {
    title: 'Görseller',
    description: (coll: string) =>
      `${coll} koleksiyonunun belgelerinde saklanan görseller, kendi baytlarından çizilir.`,
    documentTitle: 'Bu belgedeki görseller',
    documentDescription: 'Belgenin taşıdığı her görsel, kendi baytlarından çizilir.',
    reading: 'Görseller aranıyor…',
    noPlace: 'Görsellerini görmek için bir koleksiyon açın.',
    noneTitle: 'Görsel bulunamadı',
    noneHint: (n: number, filtered: boolean) =>
      `${filtered ? 'Belgeler filtresine uyan ' : ''}ilk ${n} belgenin hiçbir alanı görsel (PNG, JPEG, GIF, WebP, AVIF, BMP ya da SVG) taşımıyor.`,
    noneInDocument: 'Bu belge görsel (PNG, JPEG, GIF, WebP, AVIF, BMP ya da SVG) taşımıyor.',
    emptyTitle: 'Belge yok',
    empty: (filtered: boolean): string =>
      filtered ? 'Belgeler filtresine uyan hiç belge yok.' : 'Koleksiyonda hiç belge yok.',
    unreadTitle: 'Hiçbir belgeye bakılamadı',
    more: (n: number) => `${n} tane daha göster`,
    shown: (n: number) => `${n} görsel`,
    tooLarge: (n: number) =>
      `${n} belge burada gösterilemeyecek kadar büyük (1 MB'tan fazla); Belgeler'de açın.`,
    open: 'Belgeyi aç',
    close: 'Kapat',
    imageOf: (path: string, id: string) => `${id} belgesinin ${path} alanı`,
    failed: 'Görseller okunamadı: ',
    documentTooLarge:
      "Bu belge 1 MB'tan büyük: burada gösterilemiyor. Alanlarını görmek için Belgeler'de açın.",
  },
  zh: {
    title: '图片',
    description: (coll: string) => `${coll} 的文档中存储的图片，直接由其字节绘制。`,
    documentTitle: '此文档中的图片',
    documentDescription: '文档包含的每张图片，直接由其字节绘制。',
    reading: '正在查找图片…',
    noPlace: '打开一个集合以查看其图片。',
    noneTitle: '未找到图片',
    noneHint: (n: number, filtered: boolean) =>
      `${filtered ? '符合“文档”筛选的' : ''}前 ${n} 个文档中没有任何字段包含图片（PNG、JPEG、GIF、WebP、AVIF、BMP 或 SVG）。`,
    noneInDocument: '此文档不包含图片（PNG、JPEG、GIF、WebP、AVIF、BMP 或 SVG）。',
    emptyTitle: '没有文档',
    empty: (filtered: boolean): string => (filtered ? '“文档”筛选没有保留任何文档。' : '该集合中没有文档。'),
    unreadTitle: '无法查看任何文档',
    more: (n: number) => `再显示 ${n} 个`,
    shown: (n: number) => `${n} 张图片`,
    tooLarge: (n: number) => `有 ${n} 个文档过大（超过 1 MB），无法在此显示；请在“文档”中打开。`,
    open: '打开文档',
    close: '关闭',
    imageOf: (path: string, id: string) => `${id} 的 ${path}`,
    failed: '无法读取图片：',
    documentTooLarge: '此文档超过 1 MB，过大，无法在此显示。请在“文档”中打开以查看其字段。',
  },
  ja: {
    title: '画像',
    description: (coll: string) =>
      `${coll} のドキュメントに保存されている画像を、そのバイト列から描画します。`,
    documentTitle: 'このドキュメントの画像',
    documentDescription: 'ドキュメントに含まれるすべての画像を、そのバイト列から描画します。',
    reading: '画像を検索しています…',
    noPlace: 'コレクションを開くと、その画像が表示されます。',
    noneTitle: '画像が見つかりません',
    noneHint: (n: number, filtered: boolean) =>
      `${filtered ? 'ドキュメントのフィルターに一致する' : ''}最初の ${n} 件のドキュメントに、画像(PNG、JPEG、GIF、WebP、AVIF、BMP、SVG)を含むフィールドはありません。`,
    noneInDocument: 'このドキュメントには画像(PNG、JPEG、GIF、WebP、AVIF、BMP、SVG)がありません。',
    emptyTitle: 'ドキュメントがありません',
    empty: (filtered: boolean): string =>
      filtered
        ? 'ドキュメントのフィルターに一致するドキュメントがありません。'
        : 'このコレクションにはドキュメントがありません。',
    unreadTitle: '確認できたドキュメントがありません',
    more: (n: number) => `さらに ${n} 件表示`,
    shown: (n: number) => `${n} 件の画像`,
    tooLarge: (n: number) =>
      `${n} 件のドキュメントは大きすぎる(1 MB 超)ためここには表示できません。ドキュメントで開いてください。`,
    open: 'ドキュメントを開く',
    close: '閉じる',
    imageOf: (path: string, id: string) => `${id} の ${path}`,
    failed: '画像を読み込めませんでした: ',
    documentTooLarge:
      'このドキュメントは 1 MB を超えており、大きすぎるためここには表示できません。フィールドを見るには、ドキュメントで開いてください。',
  },
  es: {
    title: 'Imágenes',
    description: (coll: string) =>
      `Las imágenes almacenadas en los documentos de ${coll}, dibujadas a partir de sus propios bytes.`,
    documentTitle: 'Imágenes de este documento',
    documentDescription:
      'Todas las imágenes que contiene el documento, dibujadas a partir de sus propios bytes.',
    reading: 'Buscando imágenes…',
    noPlace: 'Abre una colección para ver sus imágenes.',
    noneTitle: 'No se encontró ninguna imagen',
    noneHint: (n: number, filtered: boolean) =>
      `Ningún campo ${pluralOf(n, 'es') === 'one' ? 'del primer documento' : `de los primeros ${n} documentos`}${filtered ? ' que deja el filtro de Documentos' : ''} contiene una imagen (PNG, JPEG, GIF, WebP, AVIF, BMP o SVG).`,
    noneInDocument: 'Este documento no contiene ninguna imagen (PNG, JPEG, GIF, WebP, AVIF, BMP o SVG).',
    emptyTitle: 'Ningún documento',
    empty: (filtered: boolean): string =>
      filtered
        ? 'El filtro de Documentos no deja ningún documento.'
        : 'La colección no contiene ningún documento.',
    unreadTitle: 'No se pudo ver ningún documento',
    more: (n: number) => `Mostrar ${n} más`,
    shown: (n: number) => `${n} ${pluralOf(n, 'es') === 'one' ? 'imagen' : 'imágenes'}`,
    tooLarge: (n: number) =>
      `${pluralOf(n, 'es') === 'one' ? `${n} documento es demasiado grande` : `${n} documentos son demasiado grandes`} para mostrarse aquí (más de 1 MB); ábre${pluralOf(n, 'es') === 'one' ? 'lo' : 'los'} en Documentos.`,
    open: 'Abrir documento',
    close: 'Cerrar',
    imageOf: (path: string, id: string) => `${path} de ${id}`,
    failed: 'No se pudieron leer las imágenes: ',
    documentTooLarge:
      'Este documento supera 1 MB: es demasiado grande para mostrarse aquí. Ábrelo en Documentos para ver sus campos.',
  },
  pt: {
    title: 'Imagens',
    description: (coll: string) =>
      `As imagens armazenadas nos documentos de ${coll}, desenhadas a partir dos próprios bytes.`,
    documentTitle: 'Imagens deste documento',
    documentDescription: 'Todas as imagens que o documento contém, desenhadas a partir dos próprios bytes.',
    reading: 'Procurando imagens…',
    noPlace: 'Abra uma coleção para ver suas imagens.',
    noneTitle: 'Nenhuma imagem encontrada',
    noneHint: (n: number, filtered: boolean) =>
      `Nenhum campo ${pluralOf(n, 'pt') === 'one' ? 'do primeiro documento' : `dos primeiros ${n} documentos`}${filtered ? ` mantido${pluralOf(n, 'pt') === 'one' ? '' : 's'} pelo filtro de Documentos` : ''} contém uma imagem (PNG, JPEG, GIF, WebP, AVIF, BMP ou SVG).`,
    noneInDocument: 'Este documento não contém nenhuma imagem (PNG, JPEG, GIF, WebP, AVIF, BMP ou SVG).',
    emptyTitle: 'Nenhum documento',
    empty: (filtered: boolean): string =>
      filtered
        ? 'O filtro de Documentos não mantém nenhum documento.'
        : 'A coleção não contém nenhum documento.',
    unreadTitle: 'Nenhum documento pôde ser examinado',
    more: (n: number) => `Mostrar mais ${n}`,
    shown: (n: number) => `${n} ${pluralOf(n, 'pt') === 'one' ? 'imagem' : 'imagens'}`,
    tooLarge: (n: number) =>
      `${pluralOf(n, 'pt') === 'one' ? `${n} documento é grande demais` : `${n} documentos são grandes demais`} para ser exibido aqui (mais de 1 MB); abra-${pluralOf(n, 'pt') === 'one' ? 'o' : 'os'} em Documentos.`,
    open: 'Abrir documento',
    close: 'Fechar',
    imageOf: (path: string, id: string) => `${path} de ${id}`,
    failed: 'Não foi possível ler as imagens: ',
    documentTooLarge:
      'Este documento tem mais de 1 MB: é grande demais para ser exibido aqui. Abra-o em Documentos para ver seus campos.',
  },
  ko: {
    title: '이미지',
    description: (coll: string) =>
      `${coll} 컬렉션의 도큐먼트에 저장된 이미지를 자체 바이트에서 직접 그려 표시합니다.`,
    documentTitle: '이 도큐먼트의 이미지',
    documentDescription: '도큐먼트에 포함된 모든 이미지를 자체 바이트에서 직접 그려 표시합니다.',
    reading: '이미지를 찾는 중…',
    noPlace: '컬렉션을 열면 해당 이미지를 볼 수 있습니다.',
    noneTitle: '이미지를 찾을 수 없습니다',
    noneHint: (n: number, filtered: boolean) =>
      `${filtered ? '도큐먼트 필터에 해당하는 ' : ''}처음 ${n}개 도큐먼트의 어떤 필드에도 이미지(PNG, JPEG, GIF, WebP, AVIF, BMP, SVG)가 없습니다.`,
    noneInDocument: '이 도큐먼트에는 이미지(PNG, JPEG, GIF, WebP, AVIF, BMP, SVG)가 없습니다.',
    emptyTitle: '도큐먼트 없음',
    empty: (filtered: boolean): string =>
      filtered ? '도큐먼트 필터에 해당하는 도큐먼트가 없습니다.' : '컬렉션에 도큐먼트가 없습니다.',
    unreadTitle: '확인할 수 있는 도큐먼트가 없습니다',
    more: (n: number) => `${n}개 더 보기`,
    shown: (n: number) => `이미지 ${n}개`,
    tooLarge: (n: number) =>
      `도큐먼트 ${n}개가 너무 커서(1 MB 초과) 여기에 표시할 수 없습니다. 도큐먼트에서 여세요.`,
    open: '도큐먼트 열기',
    close: '닫기',
    imageOf: (path: string, id: string) => `${id} 도큐먼트의 ${path}`,
    failed: '이미지를 읽을 수 없습니다: ',
    documentTooLarge:
      '이 도큐먼트는 1 MB를 초과하여 너무 커서 여기에 표시할 수 없습니다. 필드를 보려면 도큐먼트에서 여세요.',
  },
  de: {
    title: 'Bilder',
    description: (coll: string) =>
      `Die in den Dokumenten von ${coll} gespeicherten Bilder, gezeichnet aus ihren eigenen Bytes.`,
    documentTitle: 'Bilder in diesem Dokument',
    documentDescription: 'Alle Bilder des Dokuments, gezeichnet aus ihren eigenen Bytes.',
    reading: 'Bilder werden gesucht …',
    noPlace: 'Öffnen Sie eine Collection, um ihre Bilder zu sehen.',
    noneTitle: 'Kein Bild gefunden',
    noneHint: (n: number, filtered: boolean) =>
      `Kein Feld ${pluralOf(n, 'de') === 'one' ? 'des ersten Dokuments' : `der ersten ${n} Dokumente`}${filtered ? ' (nach dem Filter unter „Dokumente“)' : ''} enthält ein Bild (PNG, JPEG, GIF, WebP, AVIF, BMP oder SVG).`,
    noneInDocument: 'Dieses Dokument enthält kein Bild (PNG, JPEG, GIF, WebP, AVIF, BMP oder SVG).',
    emptyTitle: 'Kein Dokument',
    empty: (filtered: boolean): string =>
      filtered
        ? 'Der Filter unter „Dokumente“ lässt kein Dokument durch.'
        : 'Die Collection enthält kein Dokument.',
    unreadTitle: 'Es konnte kein Dokument angesehen werden',
    more: (n: number) => `${n} weitere anzeigen`,
    shown: (n: number) => `${n} ${pluralOf(n, 'de') === 'one' ? 'Bild' : 'Bilder'}`,
    tooLarge: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? `${n} Dokument ist zu groß, um hier angezeigt zu werden (über 1 MB); öffnen Sie es unter „Dokumente“.`
        : `${n} Dokumente sind zu groß, um hier angezeigt zu werden (über 1 MB); öffnen Sie sie unter „Dokumente“.`,
    open: 'Dokument öffnen',
    close: 'Schließen',
    imageOf: (path: string, id: string) => `${path} von ${id}`,
    failed: 'Die Bilder konnten nicht gelesen werden: ',
    documentTooLarge:
      'Dieses Dokument ist größer als 1 MB und daher zu groß für die Anzeige hier. Öffnen Sie es unter „Dokumente“, um seine Felder zu sehen.',
  },
  fr: {
    title: 'Images',
    description: (coll: string) =>
      `Les images stockées dans les documents de ${coll}, dessinées à partir de leurs propres octets.`,
    documentTitle: 'Images de ce document',
    documentDescription:
      'Toutes les images que contient le document, dessinées à partir de leurs propres octets.',
    reading: 'Recherche des images…',
    noPlace: 'Ouvrez une collection pour voir ses images.',
    noneTitle: 'Aucune image trouvée',
    noneHint: (n: number, filtered: boolean) =>
      `Aucun champ ${pluralOf(n, 'fr') === 'one' ? 'du premier document' : `des ${n} premiers documents`}${filtered ? ` retenu${pluralOf(n, 'fr') === 'one' ? '' : 's'} par le filtre de Documents` : ''} ne contient d’image (PNG, JPEG, GIF, WebP, AVIF, BMP ou SVG).`,
    noneInDocument: 'Ce document ne contient aucune image (PNG, JPEG, GIF, WebP, AVIF, BMP ou SVG).',
    emptyTitle: 'Aucun document',
    empty: (filtered: boolean): string =>
      filtered
        ? 'Le filtre de Documents ne retient aucun document.'
        : 'La collection ne contient aucun document.',
    unreadTitle: 'Aucun document n’a pu être consulté',
    more: (n: number) => `Afficher ${n} de plus`,
    shown: (n: number) => `${n} ${pluralOf(n, 'fr') === 'one' ? 'image' : 'images'}`,
    tooLarge: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `${n} document est trop volumineux pour être affiché ici (plus de 1 MB) ; ouvrez-le dans Documents.`
        : `${n} documents sont trop volumineux pour être affichés ici (plus de 1 MB) ; ouvrez-les dans Documents.`,
    open: 'Ouvrir le document',
    close: 'Fermer',
    imageOf: (path: string, id: string) => `${path} de ${id}`,
    failed: 'Impossible de lire les images : ',
    documentTooLarge:
      'Ce document dépasse 1 MB : il est trop volumineux pour être affiché ici. Ouvrez-le dans Documents pour voir ses champs.',
  },
  ru: {
    title: 'Изображения',
    description: (coll: string) =>
      `Изображения, хранящиеся в документах коллекции ${coll}, отрисованные из их собственных байтов.`,
    documentTitle: 'Изображения в этом документе',
    documentDescription: 'Все изображения документа, отрисованные из их собственных байтов.',
    reading: 'Поиск изображений…',
    noPlace: 'Откройте коллекцию, чтобы увидеть ее изображения.',
    noneTitle: 'Изображения не найдены',
    noneHint: (n: number, filtered: boolean) =>
      `Просмотрено документов: ${n}${filtered ? ' (с учетом фильтра «Документы»)' : ''}. Ни в одном поле нет изображения (PNG, JPEG, GIF, WebP, AVIF, BMP или SVG).`,
    noneInDocument: 'В этом документе нет изображений (PNG, JPEG, GIF, WebP, AVIF, BMP или SVG).',
    emptyTitle: 'Нет документов',
    empty: (filtered: boolean): string =>
      filtered ? 'Фильтр «Документы» не пропускает ни одного документа.' : 'В коллекции нет документов.',
    unreadTitle: 'Не удалось просмотреть ни один документ',
    more: (n: number) => `Показать еще ${n}`,
    shown: (n: number) => `${n} ${russian(n, 'изображение', 'изображения', 'изображений')}`,
    tooLarge: (n: number) =>
      russian(
        n,
        `${n} документ слишком велик для показа здесь (больше 1 MB); откройте его в разделе «Документы».`,
        `${n} документа слишком велики для показа здесь (больше 1 MB); откройте их в разделе «Документы».`,
        `${n} документов слишком велики для показа здесь (больше 1 MB); откройте их в разделе «Документы».`,
      ),
    open: 'Открыть документ',
    close: 'Закрыть',
    imageOf: (path: string, id: string) => `${path} (документ ${id})`,
    failed: 'Не удалось прочитать изображения: ',
    documentTooLarge:
      'Этот документ больше 1 MB и слишком велик для показа здесь. Откройте его в разделе «Документы», чтобы увидеть его поля.',
  },
} satisfies Record<Language, Text>
const textOf = (locale: string): Text => pick<Text>(TEXT, locale)

interface Shown extends ImageEntry {
  id: unknown
}

export function mount(root: HTMLElement, client: PluginClient): void {
  const forDocument = client.contribution.kind === 'documentAction'
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let fields: string[] = []
  let shown: Shown[] = []
  // The last _id shown; undefined before the first page (a null _id is a value).
  let after: unknown = undefined
  let hasMore = false
  let tooLarge = 0
  /** Documents the search for image fields looked at, and those it left out as over 1 MB. */
  let looked = 0
  let unread = 0
  let phase: 'reading' | 'none' | 'ready' | 'failed' | 'noPlace' | 'documentTooLarge' = 'reading'
  let failure: unknown = null
  let large: Shown | null = null
  /** The image whose thumbnail gets the focus once the page is drawn (wave 3 review). */
  let focusOn: Shown | null = null
  /** "Show more" added no image: the focus stays on the page. */
  let keepFocus = false

  const header = pageHeader({ icon: 'image', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body bp-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  const base = (): Doc => (ctx?.place?.filter as Doc | undefined) ?? {}
  const filtered = () => Object.keys(base()).length > 0
  const find = (params: Doc) => client.ask<{ documents: Doc[]; hasMore?: boolean }>('documents.find', params)
  const projection = () => Object.fromEntries([['_id', 1], ...fields.map((f) => [f, 1])])
  const isTooLarge = (e: unknown) => e instanceof AskError && e.code === 'too_large'
  /**
   * One document, its _id matched as a value with $eq — never as a pattern or an operator (an _id is
   * never a regular expression: MongoDB refuses one; wave 3 second review).
   */
  const byId = (_id: unknown): Doc => ({ _id: { $eq: _id } })

  /**
   * The documents read to find the image fields (wave 3 review: 50 documents of large images were
   * over 1 MB and the tab failed). User report 2026-11-07: up to 50, as many as one answer holds;
   * only when the first alone is over 1 MB, the first ten one at a time — one over 1 MB left out.
   */
  async function sampleDocs(): Promise<Doc[]> {
    unread = 0
    try {
      return (await find({ filter: base(), limit: SAMPLE, fit: true })).documents
    } catch (e) {
      if (!isTooLarge(e)) throw e
    }
    const ids = (await find({ filter: base(), projection: { _id: 1 }, limit: SMALLER_SAMPLE })).documents.map(
      (d) => d._id,
    )
    const docs: Doc[] = []
    for (const _id of ids) {
      try {
        docs.push(...(await find({ filter: byId(_id), limit: 1 })).documents)
      } catch (e) {
        if (!isTooLarge(e)) throw e
        // Counted, and said (wave 3 second review: they read as "no image found").
        unread++
      }
    }
    return docs
  }

  /**
   * One page: the documents after the last shown. User report 2026-11-07: as many as one answer holds —
   * a page cut to fit goes on after its last document; read one by one only when the first alone is
   * over 1 MB.
   */
  async function readPage(): Promise<void> {
    const filter = pageFilter(base(), after)
    let docs: Doc[]
    // The page's _ids, in order: what it went through, whatever could be shown of it.
    let ids: unknown[]
    let cut = false
    try {
      const answer = await client.ask<{ documents: Doc[]; cut?: boolean }>('documents.find', {
        filter,
        projection: projection(),
        sort: { _id: 1 },
        limit: PAGE,
        fit: true,
      })
      docs = answer.documents
      ids = docs.map((d) => d._id)
      cut = answer.cut === true && ids.length > 0
    } catch (e) {
      if (!(e instanceof AskError) || e.code !== 'too_large') throw e
      ids = (await find({ filter, projection: { _id: 1 }, sort: { _id: 1 }, limit: PAGE })).documents.map(
        (d) => d._id,
      )
      docs = []
      for (const _id of ids) {
        try {
          docs.push(...(await find({ filter: byId(_id), projection: projection(), limit: 1 })).documents)
        } catch (inner) {
          if (!(inner instanceof AskError) || inner.code !== 'too_large') throw inner
          tooLarge++
        }
      }
    }
    for (const doc of docs) shown.push(...imagesIn(doc).map((image) => ({ ...image, id: doc._id })))
    if (ids.length) after = ids[ids.length - 1]
    hasMore = ids.length === PAGE || cut
  }

  async function start(): Promise<void> {
    phase = 'reading'
    render()
    try {
      if (forDocument) {
        const id = ctx?.place?.documentId
        let doc: Doc | null = null
        try {
          doc = id === null || id === undefined ? null : await client.ask<Doc | null>('documents.get', { id })
        } catch (e) {
          // A document over 1 MB is said so in words (wave 3 review: the generic error was shown).
          if (!isTooLarge(e)) throw e
          phase = 'documentTooLarge'
          return render()
        }
        shown = doc ? imagesIn(doc).map((image) => ({ ...image, id: doc._id })) : []
        phase = shown.length ? 'ready' : 'none'
      } else {
        const sample = await sampleDocs()
        looked = sample.length
        fields = imageFields(sample)
        if (!fields.length) phase = 'none'
        else {
          await readPage()
          phase = 'ready'
        }
      }
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  }

  async function showMore(b: HTMLButtonElement): Promise<void> {
    b.disabled = true
    const before = shown.length
    try {
      await readPage()
      // The focus goes to the first image added (wave 3 review: it was lost with the button); when
      // none was added, to "Show more" again, else to the last image (wave 3 second review).
      focusOn = shown[before] ?? null
      keepFocus = !focusOn
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  }

  /** Closes the large image; the focus goes back to its thumbnail. */
  function closeLarge(): void {
    focusOn = large
    large = null
    render()
  }
  // Escape closes the large image wherever the focus is.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && large) closeLarge()
  })

  function open(image: Shown): void {
    void client.ask('ui.openDocument', { id: image.id }).catch(() => undefined)
  }

  function figure(image: Shown): HTMLElement {
    const label = text.imageOf(image.path, idText(image.id))
    const img = dataImage(image.mime, image.base64, label)
    // An icon-sized image is drawn larger with its pixels kept sharp (wave 3 review).
    const small = !!image.width && !!image.height && Math.max(image.width, image.height) <= SMALL
    const zoom = h(
      'button',
      { class: small ? 'bp-thumb bp-small' : 'bp-thumb', attrs: { type: 'button', 'aria-label': label } },
      img,
    )
    zoom.addEventListener('click', () => {
      large = image
      render()
    })
    const meta = [
      image.width && image.height ? `${image.width} × ${image.height}` : null,
      sizeText(image.length, locale),
    ]
      .filter(Boolean)
      .join(' · ')
    return h(
      'figure',
      { class: 'mm-card bp-figure', data: { image: image.path } },
      zoom,
      h(
        'figcaption',
        { class: 'bp-caption' },
        h('span', { class: 'mm-mono bp-path', text: image.path, title: image.path }),
        h('span', { class: 'mm-mono mm-subtle bp-id', text: idText(image.id) }),
        h('span', { class: 'mm-subtle', text: `${image.kind.toUpperCase()} · ${meta}` }),
        forDocument
          ? null
          : button({
              label: text.open,
              icon: 'external',
              size: 'sm',
              variant: 'ghost',
              onClick: () => open(image),
            }),
      ),
    )
  }

  function lightbox(image: Shown): HTMLElement {
    const close = button({
      label: text.close,
      icon: 'x',
      id: 'close',
      onClick: () => closeLarge(),
    })
    const box = h(
      'div',
      {
        class: 'bp-large',
        id: 'large',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': text.imageOf(image.path, idText(image.id)),
        },
      },
      dataImage(image.mime, image.base64, text.imageOf(image.path, idText(image.id))),
      h(
        'div',
        { class: 'bp-large-bar' },
        h('span', { class: 'mm-mono', text: `${image.path} · ${idText(image.id)}` }),
        h('span', { class: 'mm-spacer' }),
        forDocument ? null : button({ label: text.open, icon: 'external', onClick: () => open(image) }),
        close,
      ),
    )
    // The focus stays in the large image: Tab from its last control goes to its first, and back.
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return
      const controls = [...box.querySelectorAll<HTMLElement>('button')]
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    })
    queueMicrotask(() => close.focus())
    return box
  }

  function render(): void {
    text = textOf(locale)
    document.documentElement.lang = langTag(shownLanguage(TEXT, locale))
    header.setText(
      forDocument ? text.documentTitle : text.title,
      forDocument ? text.documentDescription : text.description(ctx?.place?.coll ?? ''),
    )
    body.replaceChildren()
    header.removeAttribute('inert')
    status.textContent = ''
    if (phase === 'documentTooLarge') return void body.append(callout('info', text.documentTooLarge))
    if (phase === 'noPlace')
      return void body.append(emptyState({ icon: 'image', title: text.noPlace, hint: '' }))
    if (phase === 'reading') {
      status.textContent = text.reading
      return void body.append(skeleton(4))
    }
    if (phase === 'failed')
      return void body.append(callout('danger', `${text.failed}${askMessage(failure, locale)}`))
    if (phase === 'none') {
      if (!forDocument && !looked && unread)
        return void body.append(
          emptyState({ icon: 'image', title: text.unreadTitle, hint: text.tooLarge(unread) }),
        )
      // Wave 3 third review: nothing to look at is said as that, never "the first 0 documents".
      if (!forDocument && !looked)
        return void body.append(
          emptyState({ icon: 'image', title: text.emptyTitle, hint: text.empty(filtered()) }),
        )
      body.append(
        emptyState({
          icon: 'image',
          title: text.noneTitle,
          hint: forDocument ? text.noneInDocument : text.noneHint(looked, filtered()),
        }),
      )
      if (!forDocument && unread) body.append(callout('info', text.tooLarge(unread)))
      return
    }
    status.textContent = text.shown(shown.length)
    body.append(h('div', { class: 'bp-grid', id: 'gallery' }, ...shown.map(figure)))
    if (tooLarge) body.append(callout('info', text.tooLarge(tooLarge)))
    if (hasMore && !forDocument) {
      const more: HTMLButtonElement = button({
        label: text.more(PAGE),
        id: 'more',
        onClick: () => void showMore(more),
      })
      body.append(h('div', { class: 'bp-more' }, more))
    }
    if (large) {
      // While the large image shows, the rest of the page cannot be reached (wave 3 review).
      header.setAttribute('inert', '')
      for (const child of body.children) child.setAttribute('inert', '')
      body.append(lightbox(large))
    }
    if (focusOn) {
      const i = shown.indexOf(focusOn)
      focusOn = null
      body.querySelectorAll<HTMLButtonElement>('.bp-thumb')[i]?.focus()
    } else if (keepFocus) {
      keepFocus = false
      const target =
        body.querySelector<HTMLButtonElement>('#more') ??
        [...body.querySelectorAll<HTMLButtonElement>('.bp-thumb')].at(-1)
      target?.focus()
    }
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } catch (e) {
      failure = e
      phase = 'failed'
      return render()
    }
    locale = ctx.locale
    applyLook(ctx.theme, ctx.accent)
    if (!ctx.place) {
      phase = 'noPlace'
      return render()
    }
    await start()
  })
  render()
}
