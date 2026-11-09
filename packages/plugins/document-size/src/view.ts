// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { AskError, askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  describeValue,
  emptyState,
  formatNumber,
  h,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  segmented,
  shown,
  serialAsk,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
  table,
  valueView,
  type Language,
} from '../../kit/src/ui'
import {
  BSON_LIMIT,
  bytesText,
  enterable,
  nameBytes,
  namesShare,
  outOfMemory,
  readMeasured,
  sizePipeline,
  type Measured,
} from './size'

/**
 * Document size (research 2026-10-28): how big a collection's documents are and where their bytes
 * go, from a random sample or all of them, measured on the server — field by field, into an object
 * field too. It only reads; no document comes to the page but the largest ones' _id.
 */
type Scope = 'sample' | 'all'
/** Documents measured at random. */
export const SAMPLE = 1000
/** Object fields gone into, at most. */
export const MAX_DEPTH = 8

/**
 * Russian's forms by the Unicode plural category (Intl): one (1, 21, 31…), few (2–4, 22–24…), many
 * (0, 5–20, 25–30…, 11–14); a decimal (other) takes `fraction`, the genitive singular.
 */
const ruPlural = (n: number, one: string, few: string, many: string, fraction = many): string => {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : category === 'many' ? many : fraction
}

const TEXT = {
  en: {
    title: 'Document size',
    description: (coll: string) =>
      `How big the documents of ${coll} are, and which fields make them so. Nothing is changed.`,
    scope: 'Measure',
    scopes: { sample: `${formatNumber(SAMPLE, 'en')} at random`, all: 'All' } satisfies Record<Scope, string>,
    again: 'Measure again',
    reading: 'Measuring the documents…',
    level: 'Measuring',
    top: 'Documents',
    up: (name: string) => `Back to ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'en')} ${n === 1 ? 'document' : 'documents'} · ${avg} on average · ${max} the largest · ${total} in all`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} in ${formatNumber(n, 'en')} ${n === 1 ? 'document' : 'documents'} · ${avg} on average · ${max} the largest`,
    spread: 'Sizes',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'en')} ${n === 1 ? 'document' : 'documents'}`,
    fields: 'Where the bytes go',
    fieldsHint: 'A field’s bytes are its type, its name and its value, in each document that holds it.',
    columns: {
      field: 'Field',
      types: 'Type',
      share: 'Share',
      avg: 'Average',
      max: 'Largest',
      in: 'In',
      name: 'Its name',
      size: 'Size',
      ofLimit: 'Of 16 MB',
      id: '_id',
      actions: 'Actions',
    },
    into: (name: string) => `Measure the fields of ${name}`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${pluralOf(n, 'en') === 'one' ? 'element' : 'elements'}`,
    each: (b: string) => `${b} each`,
    moreFields: (n: number) => `The ${n} fields taking the most are listed.`,
    largest: 'Largest documents',
    largestIn: (field: string) => `Largest ${field}`,
    open: 'Open',
    openOne: (id: string) => `Open the document ${id}`,
    openTitle: 'Opens the document in Documents',
    names: (share: string) => `Field names take ${share} of these bytes`,
    namesHint:
      'Each name (with its type’s byte) is stored in every document that holds the field: shorter names make every document smaller.',
    nearLimit: (size: string, share: string) =>
      `The largest document is ${size}: ${share} of MongoDB’s 16 MB limit`,
    nearLimitHint:
      'A document cannot grow past 16 MB: an array that keeps growing belongs in a collection of its own.',
    sampleNote: (n: number) =>
      `A random sample of ${formatNumber(n, 'en')} ${n === 1 ? 'document' : 'documents'}: the largest of all may not be in it.`,
    allNote: (n: number) =>
      `All ${formatNumber(n, 'en')} ${n === 1 ? 'document is' : 'documents are'} measured.`,
    sampleIn: (n: number, field: string) =>
      `In a random sample of ${formatNumber(SAMPLE, 'en')} documents, ${formatNumber(n, 'en')} hold ${field} as an object.`,
    sampleOfThose: (n: number, field: string) =>
      `${formatNumber(n, 'en')} of the documents that hold ${field} as an object, at random.`,
    allSlow: 'Measuring all documents took too long: measure a random sample instead.',
    slow: 'Measuring took too long: try again when the server is less busy.',
    hidden: 'The sizes of these documents are not measured for you',
    hiddenHint:
      'Personal data is hidden from you in this collection: its documents’ sizes would tell how long the hidden values are.',
    hiddenMaybe:
      'Whether personal data is hidden from you here could not be told in time; where it is, the server measures nothing.',
    failed: 'The documents could not be measured',
    tryAgain: 'Try again',
    noPlace: 'Open a collection to measure its documents.',
    empty: 'This collection has no documents',
    emptyIn: (field: string) => `No document holds ${field} as an object`,
    emptyInSample: (field: string) => `No document of the sample holds ${field} as an object`,
    openFailed: 'Could not open the document: ',
  },
  tr: {
    title: 'Belge boyutu',
    description: (coll: string) =>
      `${coll} koleksiyonunun belgelerinin ne kadar büyük olduğu ve onları hangi alanların büyüttüğü. Hiçbir şey değiştirilmez.`,
    scope: 'Ölç',
    scopes: { sample: `Rastgele ${formatNumber(SAMPLE, 'tr')}`, all: 'Tümü' } satisfies Record<Scope, string>,
    again: 'Yeniden ölç',
    reading: 'Belgeler ölçülüyor…',
    level: 'Ölçülen',
    top: 'Belgeler',
    up: (name: string) => `${name} düzeyine dön`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'tr')} belge · ortalama ${avg} · en büyüğü ${max} · toplam ${total}`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${formatNumber(n, 'tr')} belgede ${field} · ortalama ${avg} · en büyüğü ${max}`,
    spread: 'Boyutlar',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'tr')} belge`,
    fields: 'Baytlar nereye gidiyor',
    fieldsHint: 'Bir alanın baytları, onu taşıyan her belgede türü, adı ve değeridir.',
    columns: {
      field: 'Alan',
      types: 'Tür',
      share: 'Pay',
      avg: 'Ortalama',
      max: 'En büyük',
      in: 'Bulunma oranı',
      name: 'Adı',
      size: 'Boyut',
      ofLimit: '16 MB’a oranı',
      id: '_id',
      actions: 'Eylemler',
    },
    into: (name: string) => `${name} alanının alanlarını ölç`,
    elements: (written: string) => `≈ ${written} öğe`,
    each: (b: string) => `her biri ${b}`,
    moreFields: (n: number) => `En çok yer kaplayan ${n} alan listelenir.`,
    largest: 'En büyük belgeler',
    largestIn: (field: string) => `En büyük ${field} değerleri`,
    open: 'Aç',
    openOne: (id: string) => `${id} belgesini aç`,
    openTitle: 'Belgeyi Belgeler’de açar',
    names: (share: string) => `Alan adları bu baytların ${share} kadarını kaplıyor`,
    namesHint:
      'Her ad (türünün baytıyla), alanı taşıyan her belgede saklanır: daha kısa adlar her belgeyi küçültür.',
    nearLimit: (size: string, share: string) =>
      `En büyük belge ${size}: MongoDB’nin 16 MB sınırının ${share} kadarı`,
    nearLimitHint:
      'Bir belge 16 MB’ın ötesine büyüyemez: büyümeyi sürdüren bir dizi kendi koleksiyonunda olmalı.',
    sampleNote: (n: number) =>
      `Rastgele ${formatNumber(n, 'tr')} belgelik bir örneklem: tüm belgelerin en büyüğü onun içinde olmayabilir.`,
    allNote: (n: number) => `${formatNumber(n, 'tr')} belgenin tümü ölçüldü.`,
    sampleIn: (n: number, field: string) =>
      `Rastgele ${formatNumber(SAMPLE, 'tr')} belgelik bir örneklemde ${formatNumber(n, 'tr')} belge ${field} alanını nesne olarak taşıyor.`,
    sampleOfThose: (n: number, field: string) =>
      `${field} alanını nesne olarak taşıyan belgelerden rastgele ${formatNumber(n, 'tr')} tanesi.`,
    allSlow: 'Tüm belgeleri ölçmek çok uzun sürdü: bunun yerine rastgele bir örneklemi ölçün.',
    slow: 'Ölçmek çok uzun sürdü: sunucu daha az yoğunken yeniden deneyin.',
    hidden: 'Bu belgelerin boyutları sizin için ölçülmez',
    hiddenHint:
      'Bu koleksiyonda kişisel veriler sizden gizleniyor: belgelerin boyutları gizli değerlerin uzunluğunu ele verirdi.',
    hiddenMaybe:
      'Burada kişisel verilerin sizden gizlenip gizlenmediği zamanında öğrenilemedi; gizleniyorsa sunucu hiçbir şey ölçmez.',
    failed: 'Belgeler ölçülemedi',
    tryAgain: 'Yeniden dene',
    noPlace: 'Belgelerini ölçmek için bir koleksiyon açın.',
    empty: 'Bu koleksiyonda belge yok',
    emptyIn: (field: string) => `Hiçbir belge ${field} alanını nesne olarak taşımıyor`,
    emptyInSample: (field: string) => `Örneklemdeki hiçbir belge ${field} alanını nesne olarak taşımıyor`,
    openFailed: 'Belge açılamadı: ',
  },
  zh: {
    title: '文档大小',
    description: (coll: string) => `${coll} 中的文档有多大，以及哪些字段让它们变大。不会更改任何内容。`,
    scope: '测量',
    scopes: { sample: `随机 ${formatNumber(SAMPLE, 'zh')} 个`, all: '全部' } satisfies Record<Scope, string>,
    again: '重新测量',
    reading: '正在测量文档…',
    level: '测量范围',
    top: '文档',
    up: (name: string) => `返回 ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'zh')} 个文档 · 平均 ${avg} · 最大 ${max} · 共 ${total}`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${formatNumber(n, 'zh')} 个文档中的 ${field} · 平均 ${avg} · 最大 ${max}`,
    spread: '大小分布',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'zh')} 个文档`,
    fields: '字节去了哪里',
    fieldsHint: '字段的字节包括其类型、名称和值，在每个包含该字段的文档中都有一份。',
    columns: {
      field: '字段',
      types: '类型',
      share: '占比',
      avg: '平均',
      max: '最大',
      in: '出现于',
      name: '名称占用',
      size: '大小',
      ofLimit: '占 16 MB 的比例',
      id: '_id',
      actions: '操作',
    },
    into: (name: string) => `测量 ${name} 的字段`,
    elements: (written: string) => `≈ ${written} 个元素`,
    each: (b: string) => `每个 ${b}`,
    moreFields: (n: number) => `列出占用最多的 ${n} 个字段。`,
    largest: '最大的文档',
    largestIn: (field: string) => `最大的 ${field}`,
    open: '打开',
    openOne: (id: string) => `打开文档 ${id}`,
    openTitle: '在“文档”中打开该文档',
    names: (share: string) => `字段名称占这些字节的 ${share}`,
    namesHint: '每个名称（连同其类型字节）都存储在每个包含该字段的文档中：名称越短，每个文档越小。',
    nearLimit: (size: string, share: string) => `最大的文档为 ${size}：占 MongoDB 16 MB 限制的 ${share}`,
    nearLimitHint: '文档不能超过 16 MB：持续增长的数组应放在单独的集合中。',
    sampleNote: (n: number) => `随机抽样 ${formatNumber(n, 'zh')} 个文档：其中可能不包含最大的文档。`,
    allNote: (n: number) => `已测量全部 ${formatNumber(n, 'zh')} 个文档。`,
    sampleIn: (n: number, field: string) =>
      `在随机抽取的 ${formatNumber(SAMPLE, 'zh')} 个文档中，有 ${formatNumber(n, 'zh')} 个文档的 ${field} 是对象。`,
    sampleOfThose: (n: number, field: string) =>
      `在 ${field} 为对象的文档中随机抽取 ${formatNumber(n, 'zh')} 个。`,
    allSlow: '测量全部文档耗时过长：请改为测量随机样本。',
    slow: '测量耗时过长：请在服务器不太忙时重试。',
    hidden: '这些文档的大小不会为你测量',
    hiddenHint: '此集合中的个人数据对你隐藏：文档大小会暴露被隐藏值的长度。',
    hiddenMaybe: '无法及时判断此处的个人数据是否对你隐藏；若已隐藏，服务器不会测量任何内容。',
    failed: '无法测量文档',
    tryAgain: '重试',
    noPlace: '请打开一个集合以测量其文档。',
    empty: '此集合中没有文档',
    emptyIn: (field: string) => `没有文档的 ${field} 是对象`,
    emptyInSample: (field: string) => `样本中没有文档的 ${field} 是对象`,
    openFailed: '无法打开文档：',
  },
  ja: {
    title: 'ドキュメントサイズ',
    description: (coll: string) =>
      `${coll} のドキュメントの大きさと、どのフィールドが大きくしているかを表示します。何も変更されません。`,
    scope: '測定対象',
    scopes: { sample: `ランダム ${formatNumber(SAMPLE, 'ja')} 件`, all: 'すべて' } satisfies Record<
      Scope,
      string
    >,
    again: '再測定',
    reading: 'ドキュメントを測定しています…',
    level: '測定中',
    top: 'ドキュメント',
    up: (name: string) => `${name} に戻る`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'ja')} 件のドキュメント · 平均 ${avg} · 最大 ${max} · 合計 ${total}`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${formatNumber(n, 'ja')} 件のドキュメントの ${field} · 平均 ${avg} · 最大 ${max}`,
    spread: 'サイズ',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'ja')} 件のドキュメント`,
    fields: 'バイトの内訳',
    fieldsHint: 'フィールドのバイト数は、そのフィールドを持つ各ドキュメントでの型、名前、値の合計です。',
    columns: {
      field: 'フィールド',
      types: '型',
      share: '割合',
      avg: '平均',
      max: '最大',
      in: '含まれる割合',
      name: '名前',
      size: 'サイズ',
      ofLimit: '16 MB に対する割合',
      id: '_id',
      actions: '操作',
    },
    into: (name: string) => `${name} のフィールドを測定`,
    elements: (written: string) => `≈ ${written} 個の要素`,
    each: (b: string) => `各 ${b}`,
    moreFields: (n: number) => `占有量の大きい ${n} 個のフィールドを表示しています。`,
    largest: '最大のドキュメント',
    largestIn: (field: string) => `最大の ${field}`,
    open: '開く',
    openOne: (id: string) => `ドキュメント ${id} を開く`,
    openTitle: 'このドキュメントを「ドキュメント」で開きます',
    names: (share: string) => `フィールド名がこれらのバイトの ${share} を占めています`,
    namesHint:
      '各名前（型の 1 バイトを含む）は、そのフィールドを持つすべてのドキュメントに保存されます。名前を短くすると、すべてのドキュメントが小さくなります。',
    nearLimit: (size: string, share: string) =>
      `最大のドキュメントは ${size} で、MongoDB の 16 MB 上限の ${share} です`,
    nearLimitHint:
      'ドキュメントは 16 MB を超えて大きくなれません。増え続ける配列は、別のコレクションに分けてください。',
    sampleNote: (n: number) =>
      `ランダムに抽出した ${formatNumber(n, 'ja')} 件のドキュメントです。最大のドキュメントは含まれていない可能性があります。`,
    allNote: (n: number) => `${formatNumber(n, 'ja')} 件すべてのドキュメントを測定しました。`,
    sampleIn: (n: number, field: string) =>
      `ランダムに抽出した ${formatNumber(SAMPLE, 'ja')} 件のドキュメントのうち、${formatNumber(n, 'ja')} 件で ${field} がオブジェクトです。`,
    sampleOfThose: (n: number, field: string) =>
      `${field} がオブジェクトのドキュメントから、ランダムに ${formatNumber(n, 'ja')} 件。`,
    allSlow:
      'すべてのドキュメントの測定に時間がかかりすぎました。代わりにランダムサンプルを測定してください。',
    slow: '測定に時間がかかりすぎました。サーバーの負荷が下がってから再試行してください。',
    hidden: 'これらのドキュメントのサイズは測定されません',
    hiddenHint:
      'このコレクションでは個人データが非表示になっています。ドキュメントのサイズから、非表示の値の長さが分かってしまうためです。',
    hiddenMaybe:
      'ここで個人データが非表示かどうかを時間内に判定できませんでした。非表示の場合、サーバーは何も測定しません。',
    failed: 'ドキュメントを測定できませんでした',
    tryAgain: '再試行',
    noPlace: 'コレクションを開くと、そのドキュメントを測定できます。',
    empty: 'このコレクションにはドキュメントがありません',
    emptyIn: (field: string) => `${field} がオブジェクトのドキュメントはありません`,
    emptyInSample: (field: string) => `サンプルに ${field} がオブジェクトのドキュメントはありません`,
    openFailed: 'ドキュメントを開けませんでした: ',
  },
  es: {
    title: 'Tamaño del documento',
    description: (coll: string) =>
      `Qué tamaño tienen los documentos de ${coll} y qué campos los hacen grandes. No se cambia nada.`,
    scope: 'Medir',
    scopes: { sample: `${formatNumber(SAMPLE, 'es')} al azar`, all: 'Todos' } satisfies Record<Scope, string>,
    again: 'Medir de nuevo',
    reading: 'Midiendo los documentos…',
    level: 'Midiendo',
    top: 'Documentos',
    up: (name: string) => `Volver a ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'es')} ${n === 1 ? 'documento' : 'documentos'} · ${avg} de media · ${max} el mayor · ${total} en total`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} en ${formatNumber(n, 'es')} ${n === 1 ? 'documento' : 'documentos'} · ${avg} de media · ${max} el mayor`,
    spread: 'Tamaños',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'es')} ${n === 1 ? 'documento' : 'documentos'}`,
    fields: 'Adónde van los bytes',
    fieldsHint: 'Los bytes de un campo son su tipo, su nombre y su valor, en cada documento que lo contiene.',
    columns: {
      field: 'Campo',
      types: 'Tipo',
      share: 'Proporción',
      avg: 'Media',
      max: 'Mayor',
      in: 'Presente en',
      name: 'Su nombre',
      size: 'Tamaño',
      ofLimit: 'De 16 MB',
      id: '_id',
      actions: 'Acciones',
    },
    into: (name: string) => `Medir los campos de ${name}`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${pluralOf(n, 'es') === 'one' ? 'elemento' : 'elementos'}`,
    each: (b: string) => `${b} cada uno`,
    moreFields: (n: number) => `Se muestran los ${n} campos que más ocupan.`,
    largest: 'Documentos más grandes',
    largestIn: (field: string) => `Mayores valores de ${field}`,
    open: 'Abrir',
    openOne: (id: string) => `Abrir el documento ${id}`,
    openTitle: 'Abre el documento en Documentos',
    names: (share: string) => `Los nombres de campo ocupan ${share} de estos bytes`,
    namesHint:
      'Cada nombre (con el byte de su tipo) se guarda en todos los documentos que contienen el campo: con nombres más cortos, cada documento es más pequeño.',
    nearLimit: (size: string, share: string) =>
      `El documento más grande pesa ${size}: ${share} del límite de 16 MB de MongoDB`,
    nearLimitHint:
      'Un documento no puede superar los 16 MB: un array que no deja de crecer debe ir en su propia colección.',
    sampleNote: (n: number) =>
      `Una muestra aleatoria de ${formatNumber(n, 'es')} ${n === 1 ? 'documento' : 'documentos'}: puede que no incluya el más grande de todos.`,
    allNote: (n: number) =>
      n === 1 ? 'Se ha medido el único documento.' : `Se han medido los ${formatNumber(n, 'es')} documentos.`,
    sampleIn: (n: number, field: string) =>
      `En una muestra aleatoria de ${formatNumber(SAMPLE, 'es')} documentos, ${formatNumber(n, 'es')} ${n === 1 ? 'contiene' : 'contienen'} ${field} como objeto.`,
    sampleOfThose: (n: number, field: string) =>
      `${formatNumber(n, 'es')} de los documentos que contienen ${field} como objeto, al azar.`,
    allSlow: 'Medir todos los documentos ha tardado demasiado: mide una muestra aleatoria en su lugar.',
    slow: 'La medición ha tardado demasiado: inténtalo de nuevo cuando el servidor esté menos ocupado.',
    hidden: 'No se miden los tamaños de estos documentos para ti',
    hiddenHint:
      'En esta colección se te ocultan datos personales: los tamaños de sus documentos revelarían la longitud de los valores ocultos.',
    hiddenMaybe:
      'No se pudo saber a tiempo si aquí se te ocultan datos personales; si es así, el servidor no mide nada.',
    failed: 'No se pudieron medir los documentos',
    tryAgain: 'Reintentar',
    noPlace: 'Abre una colección para medir sus documentos.',
    empty: 'Esta colección no tiene documentos',
    emptyIn: (field: string) => `Ningún documento contiene ${field} como objeto`,
    emptyInSample: (field: string) => `Ningún documento de la muestra contiene ${field} como objeto`,
    openFailed: 'No se pudo abrir el documento: ',
  },
  pt: {
    title: 'Tamanho do documento',
    description: (coll: string) =>
      `Qual o tamanho dos documentos de ${coll} e quais campos os tornam grandes. Nada é alterado.`,
    scope: 'Medir',
    scopes: { sample: `${formatNumber(SAMPLE, 'pt')} aleatórios`, all: 'Todos' } satisfies Record<
      Scope,
      string
    >,
    again: 'Medir novamente',
    reading: 'Medindo os documentos…',
    level: 'Medindo',
    top: 'Documentos',
    up: (name: string) => `Voltar para ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'} · ${avg} em média · ${max} o maior · ${total} no total`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} em ${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'} · ${avg} em média · ${max} o maior`,
    spread: 'Tamanhos',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) =>
      `${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'}`,
    fields: 'Para onde vão os bytes',
    fieldsHint: 'Os bytes de um campo são seu tipo, seu nome e seu valor, em cada documento que o contém.',
    columns: {
      field: 'Campo',
      types: 'Tipo',
      share: 'Participação',
      avg: 'Média',
      max: 'Maior',
      in: 'Presente em',
      name: 'Nome',
      size: 'Tamanho',
      ofLimit: 'Do limite de 16 MB',
      id: '_id',
      actions: 'Ações',
    },
    into: (name: string) => `Medir os campos de ${name}`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${pluralOf(n, 'pt') === 'one' ? 'elemento' : 'elementos'}`,
    each: (b: string) => `${b} cada`,
    moreFields: (n: number) => `Os ${n} campos que mais ocupam espaço são listados.`,
    largest: 'Maiores documentos',
    largestIn: (field: string) => `Maiores valores de ${field}`,
    open: 'Abrir',
    openOne: (id: string) => `Abrir o documento ${id}`,
    openTitle: 'Abre o documento em Documentos',
    names: (share: string) => `Os nomes dos campos ocupam ${share} desses bytes`,
    namesHint:
      'Cada nome (com o byte do seu tipo) é armazenado em todo documento que contém o campo: nomes mais curtos deixam cada documento menor.',
    nearLimit: (size: string, share: string) =>
      `O maior documento tem ${size}: ${share} do limite de 16 MB do MongoDB`,
    nearLimitHint:
      'Um documento não pode passar de 16 MB: um array que não para de crescer deve ficar em uma coleção própria.',
    sampleNote: (n: number) =>
      `Uma amostra aleatória de ${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'}: o maior de todos pode não estar nela.`,
    allNote: (n: number) =>
      pluralOf(n, 'pt') === 'one'
        ? 'O único documento foi medido.'
        : `Todos os ${formatNumber(n, 'pt')} documentos foram medidos.`,
    sampleIn: (n: number, field: string) =>
      `Em uma amostra aleatória de ${formatNumber(SAMPLE, 'pt')} documentos, ${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'contém' : 'contêm'} ${field} como objeto.`,
    sampleOfThose: (n: number, field: string) =>
      `${formatNumber(n, 'pt')} dos documentos que contêm ${field} como objeto, aleatoriamente.`,
    allSlow: 'Medir todos os documentos demorou demais: meça uma amostra aleatória.',
    slow: 'A medição demorou demais: tente novamente quando o servidor estiver menos ocupado.',
    hidden: 'Os tamanhos destes documentos não são medidos para você',
    hiddenHint:
      'Nesta coleção, dados pessoais ficam ocultos para você: o tamanho dos documentos revelaria o comprimento dos valores ocultos.',
    hiddenMaybe:
      'Não foi possível saber a tempo se dados pessoais ficam ocultos para você aqui; se ficam, o servidor não mede nada.',
    failed: 'Não foi possível medir os documentos',
    tryAgain: 'Tentar novamente',
    noPlace: 'Abra uma coleção para medir seus documentos.',
    empty: 'Esta coleção não tem documentos',
    emptyIn: (field: string) => `Nenhum documento contém ${field} como objeto`,
    emptyInSample: (field: string) => `Nenhum documento da amostra contém ${field} como objeto`,
    openFailed: 'Não foi possível abrir o documento: ',
  },
  ko: {
    title: '도큐먼트 크기',
    description: (coll: string) =>
      `${coll} 컬렉션의 도큐먼트가 얼마나 큰지, 그리고 어떤 필드가 크게 만드는지 보여 줍니다. 아무것도 변경하지 않습니다.`,
    scope: '측정 대상',
    scopes: { sample: `무작위 ${formatNumber(SAMPLE, 'ko')}개`, all: '전체' } satisfies Record<Scope, string>,
    again: '다시 측정',
    reading: '도큐먼트를 측정하는 중…',
    level: '측정 중',
    top: '도큐먼트',
    up: (name: string) => `${name}(으)로 돌아가기`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `도큐먼트 ${formatNumber(n, 'ko')}개 · 평균 ${avg} · 최대 ${max} · 합계 ${total}`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `도큐먼트 ${formatNumber(n, 'ko')}개의 ${field} · 평균 ${avg} · 최대 ${max}`,
    spread: '크기 분포',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `도큐먼트 ${formatNumber(n, 'ko')}개`,
    fields: '바이트 사용 내역',
    fieldsHint: '필드의 바이트는 해당 필드를 포함하는 각 도큐먼트에서 유형, 이름, 값이 차지하는 크기입니다.',
    columns: {
      field: '필드',
      types: '유형',
      share: '비율',
      avg: '평균',
      max: '최대',
      in: '포함 비율',
      name: '이름',
      size: '크기',
      ofLimit: '16 MB 대비',
      id: '_id',
      actions: '작업',
    },
    into: (name: string) => `${name}의 필드 측정`,
    elements: (written: string) => `≈ 요소 ${written}개`,
    each: (b: string) => `각 ${b}`,
    moreFields: (n: number) => `가장 많이 차지하는 필드 ${n}개를 표시합니다.`,
    largest: '가장 큰 도큐먼트',
    largestIn: (field: string) => `가장 큰 ${field}`,
    open: '열기',
    openOne: (id: string) => `도큐먼트 ${id} 열기`,
    openTitle: '도큐먼트 탭에서 이 도큐먼트를 엽니다',
    names: (share: string) => `필드 이름이 이 바이트의 ${share}를 차지합니다`,
    namesHint:
      '각 이름(유형의 1바이트 포함)은 해당 필드를 포함하는 모든 도큐먼트에 저장됩니다. 이름이 짧을수록 모든 도큐먼트가 작아집니다.',
    nearLimit: (size: string, share: string) => `가장 큰 도큐먼트: ${size} (MongoDB 16 MB 제한의 ${share})`,
    nearLimitHint: '도큐먼트는 16 MB를 넘을 수 없습니다. 계속 커지는 배열은 별도의 컬렉션에 두세요.',
    sampleNote: (n: number) =>
      `무작위로 추출한 도큐먼트 ${formatNumber(n, 'ko')}개의 샘플입니다. 가장 큰 도큐먼트는 포함되지 않았을 수 있습니다.`,
    allNote: (n: number) => `도큐먼트 ${formatNumber(n, 'ko')}개를 모두 측정했습니다.`,
    sampleIn: (n: number, field: string) =>
      `무작위로 추출한 ${formatNumber(SAMPLE, 'ko')}개 도큐먼트 중 ${formatNumber(n, 'ko')}개에서 ${field} 필드가 객체입니다.`,
    sampleOfThose: (n: number, field: string) =>
      `${field} 필드가 객체인 도큐먼트 중 무작위 ${formatNumber(n, 'ko')}개입니다.`,
    allSlow: '모든 도큐먼트를 측정하는 데 시간이 너무 오래 걸렸습니다. 대신 무작위 샘플을 측정하세요.',
    slow: '측정하는 데 시간이 너무 오래 걸렸습니다. 서버가 덜 바쁠 때 다시 시도하세요.',
    hidden: '이 도큐먼트의 크기는 측정되지 않습니다',
    hiddenHint:
      '이 컬렉션에서는 개인 데이터가 숨겨져 있습니다. 도큐먼트 크기로 숨겨진 값의 길이를 알 수 있기 때문입니다.',
    hiddenMaybe:
      '여기서 개인 데이터가 숨겨져 있는지 제때 확인하지 못했습니다. 숨겨져 있다면 서버는 아무것도 측정하지 않습니다.',
    failed: '도큐먼트를 측정할 수 없습니다',
    tryAgain: '다시 시도',
    noPlace: '컬렉션을 열면 도큐먼트를 측정할 수 있습니다.',
    empty: '이 컬렉션에 도큐먼트가 없습니다',
    emptyIn: (field: string) => `${field} 필드가 객체인 도큐먼트가 없습니다`,
    emptyInSample: (field: string) => `샘플에 ${field} 필드가 객체인 도큐먼트가 없습니다`,
    openFailed: '도큐먼트를 열 수 없습니다: ',
  },
  de: {
    title: 'Dokumentgröße',
    description: (coll: string) =>
      `Wie groß die Dokumente von ${coll} sind und welche Felder sie groß machen. Es wird nichts geändert.`,
    scope: 'Messen',
    scopes: { sample: `${formatNumber(SAMPLE, 'de')} zufällige`, all: 'Alle' } satisfies Record<
      Scope,
      string
    >,
    again: 'Erneut messen',
    reading: 'Dokumente werden gemessen…',
    level: 'Gemessen',
    top: 'Dokumente',
    up: (name: string) => `Zurück zu ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'de')} ${n === 1 ? 'Dokument' : 'Dokumente'} · ${avg} im Durchschnitt · ${max} das größte · ${total} insgesamt`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} in ${formatNumber(n, 'de')} ${n === 1 ? 'Dokument' : 'Dokumenten'} · ${avg} im Durchschnitt · ${max} das größte`,
    spread: 'Größen',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'de')} ${n === 1 ? 'Dokument' : 'Dokumente'}`,
    fields: 'Wohin die Bytes gehen',
    fieldsHint:
      'Die Bytes eines Felds sind sein Typ, sein Name und sein Wert – in jedem Dokument, das es enthält.',
    columns: {
      field: 'Feld',
      types: 'Typ',
      share: 'Anteil',
      avg: 'Durchschnitt',
      max: 'Größtes',
      in: 'Enthalten in',
      name: 'Sein Name',
      size: 'Größe',
      ofLimit: 'Von 16 MB',
      id: '_id',
      actions: 'Aktionen',
    },
    into: (name: string) => `Felder von ${name} messen`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${pluralOf(n, 'de') === 'one' ? 'Element' : 'Elemente'}`,
    each: (b: string) => `je ${b}`,
    moreFields: (n: number) => `Aufgelistet werden die ${n} Felder mit dem größten Anteil.`,
    largest: 'Größte Dokumente',
    largestIn: (field: string) => `Größte Werte von ${field}`,
    open: 'Öffnen',
    openOne: (id: string) => `Dokument ${id} öffnen`,
    openTitle: 'Öffnet das Dokument unter „Dokumente“',
    names: (share: string) => `Feldnamen belegen ${share} dieser Bytes`,
    namesHint:
      'Jeder Name (mit dem Byte seines Typs) wird in jedem Dokument gespeichert, das das Feld enthält: Kürzere Namen machen jedes Dokument kleiner.',
    nearLimit: (size: string, share: string) =>
      `Das größte Dokument ist ${size} groß: ${share} des 16-MB-Limits von MongoDB`,
    nearLimitHint:
      'Ein Dokument kann nicht über 16 MB hinauswachsen: Ein Array, das immer weiterwächst, gehört in eine eigene Collection.',
    sampleNote: (n: number) =>
      `Eine Zufallsstichprobe von ${formatNumber(n, 'de')} ${n === 1 ? 'Dokument' : 'Dokumenten'}: Das größte von allen ist möglicherweise nicht enthalten.`,
    allNote: (n: number) =>
      n === 1
        ? 'Das einzige Dokument wurde gemessen.'
        : `Alle ${formatNumber(n, 'de')} Dokumente wurden gemessen.`,
    sampleIn: (n: number, field: string) =>
      `In einer Zufallsstichprobe von ${formatNumber(SAMPLE, 'de')} Dokumenten ist ${field} in ${formatNumber(n, 'de')} ${n === 1 ? 'Dokument' : 'Dokumenten'} ein Objekt.`,
    sampleOfThose: (n: number, field: string) =>
      `Zufällig ausgewählt: ${formatNumber(n, 'de')} der Dokumente, in denen ${field} ein Objekt ist.`,
    allSlow:
      'Das Messen aller Dokumente hat zu lange gedauert: Messen Sie stattdessen eine Zufallsstichprobe.',
    slow: 'Das Messen hat zu lange gedauert: Versuchen Sie es erneut, wenn der Server weniger ausgelastet ist.',
    hidden: 'Die Größen dieser Dokumente werden für Sie nicht gemessen',
    hiddenHint:
      'Personenbezogene Daten sind in dieser Collection für Sie ausgeblendet: Die Dokumentgrößen würden die Länge der ausgeblendeten Werte verraten.',
    hiddenMaybe:
      'Ob personenbezogene Daten hier für Sie ausgeblendet sind, ließ sich nicht rechtzeitig feststellen; falls ja, misst der Server nichts.',
    failed: 'Die Dokumente konnten nicht gemessen werden',
    tryAgain: 'Erneut versuchen',
    noPlace: 'Öffnen Sie eine Collection, um ihre Dokumente zu messen.',
    empty: 'Diese Collection enthält keine Dokumente',
    emptyIn: (field: string) => `Kein Dokument enthält ${field} als Objekt`,
    emptyInSample: (field: string) => `Kein Dokument der Stichprobe enthält ${field} als Objekt`,
    openFailed: 'Das Dokument konnte nicht geöffnet werden: ',
  },
  fr: {
    title: 'Taille des documents',
    description: (coll: string) =>
      `Quelle est la taille des documents de ${coll} et quels champs les alourdissent. Rien n’est modifié.`,
    scope: 'Mesurer',
    scopes: { sample: `${formatNumber(SAMPLE, 'fr')} au hasard`, all: 'Tous' } satisfies Record<
      Scope,
      string
    >,
    again: 'Mesurer à nouveau',
    reading: 'Mesure des documents…',
    level: 'Mesure',
    top: 'Documents',
    up: (name: string) => `Retour à ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document' : 'documents'} · ${avg} en moyenne · ${max} le plus grand · ${total} au total`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} dans ${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document' : 'documents'} · ${avg} en moyenne · ${max} le plus grand`,
    spread: 'Tailles',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) =>
      `${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document' : 'documents'}`,
    fields: 'Où vont les octets',
    fieldsHint:
      'Les octets d’un champ sont son type, son nom et sa valeur, dans chaque document qui le contient.',
    columns: {
      field: 'Champ',
      types: 'Type',
      share: 'Part',
      avg: 'Moyenne',
      max: 'Maximum',
      in: 'Présent dans',
      name: 'Son nom',
      size: 'Taille',
      ofLimit: 'Sur 16 MB',
      id: '_id',
      actions: 'Actions',
    },
    into: (name: string) => `Mesurer les champs de ${name}`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${pluralOf(n, 'fr') === 'one' ? 'élément' : 'éléments'}`,
    each: (b: string) => `${b} chacun`,
    moreFields: (n: number) => `Les ${n} champs qui occupent le plus de place sont listés.`,
    largest: 'Plus gros documents',
    largestIn: (field: string) => `Plus grandes valeurs de ${field}`,
    open: 'Ouvrir',
    openOne: (id: string) => `Ouvrir le document ${id}`,
    openTitle: 'Ouvre le document dans Documents',
    names: (share: string) => `Les noms de champs occupent ${share} de ces octets`,
    namesHint:
      'Chaque nom (avec l’octet de son type) est stocké dans chaque document qui contient le champ : des noms plus courts rendent chaque document plus petit.',
    nearLimit: (size: string, share: string) =>
      `Le plus gros document fait ${size} : ${share} de la limite de 16 MB de MongoDB`,
    nearLimitHint:
      'Un document ne peut pas dépasser 16 MB : un tableau qui ne cesse de grandir doit aller dans sa propre collection.',
    sampleNote: (n: number) =>
      `Un échantillon aléatoire de ${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document' : 'documents'} : le plus gros de tous n’y figure peut-être pas.`,
    allNote: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? 'Le seul document a été mesuré.'
        : `Les ${formatNumber(n, 'fr')} documents ont été mesurés.`,
    sampleIn: (n: number, field: string) =>
      `Dans un échantillon aléatoire de ${formatNumber(SAMPLE, 'fr')} documents, ${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document contient' : 'documents contiennent'} ${field} comme objet.`,
    sampleOfThose: (n: number, field: string) =>
      `${formatNumber(n, 'fr')} au hasard parmi les documents qui contiennent ${field} comme objet.`,
    allSlow:
      'La mesure de tous les documents a pris trop de temps : mesurez plutôt un échantillon aléatoire.',
    slow: 'La mesure a pris trop de temps : réessayez quand le serveur sera moins sollicité.',
    hidden: 'Les tailles de ces documents ne sont pas mesurées pour vous',
    hiddenHint:
      'Dans cette collection, les données personnelles vous sont masquées : la taille des documents révélerait la longueur des valeurs masquées.',
    hiddenMaybe:
      'Il n’a pas été possible de savoir à temps si les données personnelles vous sont masquées ici ; si elles le sont, le serveur ne mesure rien.',
    failed: 'Impossible de mesurer les documents',
    tryAgain: 'Réessayer',
    noPlace: 'Ouvrez une collection pour mesurer ses documents.',
    empty: 'Cette collection ne contient aucun document',
    emptyIn: (field: string) => `Aucun document ne contient ${field} comme objet`,
    emptyInSample: (field: string) => `Aucun document de l’échantillon ne contient ${field} comme objet`,
    openFailed: 'Impossible d’ouvrir le document : ',
  },
  ru: {
    title: 'Размер документов',
    description: (coll: string) =>
      `Насколько велики документы коллекции ${coll} и какие поля делают их такими. Ничего не изменяется.`,
    scope: 'Измерять',
    scopes: { sample: `${formatNumber(SAMPLE, 'ru')} случайных`, all: 'Все' } satisfies Record<Scope, string>,
    again: 'Измерить снова',
    reading: 'Измерение документов…',
    level: 'Измеряется',
    top: 'Документы',
    up: (name: string) => `Назад к ${name}`,
    summary: (n: number, avg: string, max: string, total: string) =>
      `${formatNumber(n, 'ru')} ${ruPlural(n, 'документ', 'документа', 'документов')} · в среднем ${avg} · наибольший ${max} · всего ${total}`,
    summaryIn: (n: number, field: string, avg: string, max: string) =>
      `${field} в ${formatNumber(n, 'ru')} ${ruPlural(n, 'документе', 'документах', 'документах')} · в среднем ${avg} · наибольший ${max}`,
    spread: 'Размеры',
    ranges: ['< 1 KB', '1–4 KB', '4–16 KB', '16–64 KB', '64–256 KB', '256 KB–1 MB', '1–4 MB', '4–16 MB'],
    count: (n: number) => `${formatNumber(n, 'ru')} ${ruPlural(n, 'документ', 'документа', 'документов')}`,
    fields: 'Куда уходят байты',
    fieldsHint: 'Байты поля — это его тип, имя и значение в каждом документе, где оно есть.',
    columns: {
      field: 'Поле',
      types: 'Тип',
      share: 'Доля',
      avg: 'В среднем',
      max: 'Наибольший',
      in: 'Встречается в',
      name: 'Его имя',
      size: 'Размер',
      ofLimit: 'От 16 MB',
      id: '_id',
      actions: 'Действия',
    },
    into: (name: string) => `Измерить поля ${name}`,
    elements: (written: string, n: number) =>
      `≈ ${written} ${ruPlural(n, 'элемент', 'элемента', 'элементов', 'элемента')}`,
    each: (b: string) => `по ${b}`,
    moreFields: (n: number) => `Показаны поля, занимающие больше всего места (${n}).`,
    largest: 'Самые большие документы',
    largestIn: (field: string) => `Наибольшие значения ${field}`,
    open: 'Открыть',
    openOne: (id: string) => `Открыть документ ${id}`,
    openTitle: 'Открывает документ в разделе «Документы»',
    names: (share: string) => `Имена полей занимают ${share} этих байтов`,
    namesHint:
      'Каждое имя (вместе с байтом его типа) хранится в каждом документе, где есть это поле: чем короче имена, тем меньше каждый документ.',
    nearLimit: (size: string, share: string) =>
      `Самый большой документ — ${size}: ${share} от лимита MongoDB в 16 MB`,
    nearLimitHint:
      'Документ не может быть больше 16 MB: постоянно растущий массив лучше вынести в отдельную коллекцию.',
    sampleNote: (n: number) =>
      `Случайная выборка из ${formatNumber(n, 'ru')} ${ruPlural(n, 'документа', 'документов', 'документов')}: самого большого документа в ней может не быть.`,
    allNote: (n: number) =>
      n === 1
        ? 'Измерен единственный документ.'
        : `Измерены все ${formatNumber(n, 'ru')} ${ruPlural(n, 'документ', 'документа', 'документов')}.`,
    sampleIn: (n: number, field: string) =>
      `В случайной выборке из ${formatNumber(SAMPLE, 'ru')} документов поле ${field} является объектом в ${formatNumber(n, 'ru')} ${ruPlural(n, 'документе', 'документах', 'документах')}.`,
    sampleOfThose: (n: number, field: string) =>
      `Случайная выборка (${formatNumber(n, 'ru')}) из документов, где ${field} является объектом.`,
    allSlow: 'Измерение всех документов заняло слишком много времени: измерьте случайную выборку.',
    slow: 'Измерение заняло слишком много времени: повторите попытку, когда сервер будет менее загружен.',
    hidden: 'Размеры этих документов для вас не измеряются',
    hiddenHint:
      'В этой коллекции персональные данные скрыты от вас: размеры документов выдали бы длину скрытых значений.',
    hiddenMaybe:
      'Не удалось вовремя определить, скрыты ли здесь от вас персональные данные; если скрыты, сервер ничего не измеряет.',
    failed: 'Не удалось измерить документы',
    tryAgain: 'Повторить',
    noPlace: 'Откройте коллекцию, чтобы измерить ее документы.',
    empty: 'В этой коллекции нет документов',
    emptyIn: (field: string) => `Ни в одном документе поле ${field} не является объектом`,
    emptyInSample: (field: string) => `Ни в одном документе выборки поле ${field} не является объектом`,
    openFailed: 'Не удалось открыть документ: ',
  },
}
type Text = (typeof TEXT)['en']
/** Every language's block, English the fallback; the kit's `pick` reads it. */
export const TEXTS: { en: Text } & Record<Language, Text> = TEXT

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; error: unknown; all: boolean }
  | { kind: 'done'; measured: Measured; sampled: boolean; late: boolean }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  /** The language the words are really in: what formats the numbers and marks the page. */
  let language: Language = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  /** The object field measured: [] for the documents themselves. */
  let level: string[] = []
  let openError: { error: unknown; at: number } | null = null
  /** Each level and scope measured, kept until Measure again: going back shows the same numbers. */
  const measures = new Map<string, { measured: Measured; late: boolean }>()
  /** Where the focus goes once the page is drawn again (it was on what drew it). */
  let focusAfter: 'level' | { open: number } | null = null
  // The app runs one pipeline of a plugin at a time ("busy", review I1): each measure waits for the
  // one before, and one already replaced by a later one is not sent at all.
  const aggregate = serialAsk(async (mine: number, pipeline: unknown[]) =>
    mine !== running
      ? null
      : client.ask<{ documents: unknown[] }>('documents.aggregate', { pipeline, limit: 1 }),
  )

  const again = button({ label: text.again, icon: 'refresh', id: 'again' })
  const scope = segmented<Scope>({
    label: text.scope,
    id: 'scope',
    value: 'sample',
    options: (['sample', 'all'] as Scope[]).map((value) => ({ value, label: text.scopes[value] })),
    onChange: () => void measure(true),
  })
  const header = pageHeader({ icon: 'ruler', title: text.title, description: '', actions: [scope.el, again] })
  const crumbs = h('nav', { id: 'level', class: 'ds-crumbs' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'ds-notes' })
  const results = h('div', { id: 'results', class: 'ds-results', attrs: { tabindex: '-1' } })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, crumbs, h('div', { class: 'mm-summary' }, status), notes, results),
    ),
  )

  const bytes = (n: number) => bytesText(n, language)
  const percent = (share: number) =>
    new Intl.NumberFormat(langTag(language), {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(share)
  const key = () => JSON.stringify([scope.value(), level])
  /** Personal data hidden from the user here: the server measures nothing, so nothing is asked. */
  const hidden = () => (ctx?.place?.hidden?.length ?? 0) > 0

  function applyText(): void {
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    setLabel(again, text.again)
    scope.relabel(text.scopes)
    scope.el.setAttribute('aria-label', text.scope)
    crumbs.setAttribute('aria-label', text.level)
  }

  function go(next: string[]): void {
    level = next
    focusAfter = 'level'
    void measure(true)
  }

  function renderCrumbs(): void {
    if (!level.length) return void crumbs.replaceChildren()
    const parts: HTMLElement[] = [
      h('button', {
        class: 'ds-link ds-crumb',
        attrs: { type: 'button' },
        text: text.top,
        title: text.up(text.top),
        on: { click: () => go([]) },
      }),
    ]
    level.forEach((name, i) => {
      parts.push(h('span', { class: 'ds-sep', attrs: { 'aria-hidden': 'true' }, text: '›' }))
      parts.push(
        i === level.length - 1
          ? h('span', { class: 'mm-key', text: name, attrs: { 'aria-current': 'location', tabindex: '-1' } })
          : h('button', {
              class: 'ds-link ds-crumb mm-key',
              attrs: { type: 'button' },
              text: name,
              title: text.up(name),
              on: { click: () => go(level.slice(0, i + 1)) },
            }),
      )
    })
    crumbs.replaceChildren(...parts)
  }

  function spreadSection(m: Measured): HTMLElement {
    const most = Math.max(1, ...m.spread)
    return h(
      'section',
      { class: 'mm-card ds-section', attrs: { 'aria-labelledby': 'spread-title' } },
      h('h2', { id: 'spread-title', class: 'ds-title', text: text.spread }),
      h(
        'ul',
        { class: 'ds-spread', id: 'spread' },
        ...m.spread.map((n, i) => {
          const fill = h('span', { class: 'ds-bar-fill' })
          fill.style.width = `${(n / most) * 100}%`
          return h(
            'li',
            { class: 'ds-spread-row', data: { range: String(i) } },
            h('span', { class: 'ds-range', text: text.ranges[i]! }),
            h('span', { class: 'ds-bar', attrs: { 'aria-hidden': 'true' } }, fill),
            h('span', { class: 'ds-count', text: text.count(n) }),
          )
        }),
      ),
    )
  }

  function fieldsSection(m: Measured): HTMLElement {
    const t = table([
      { label: text.columns.field },
      { label: text.columns.types },
      { label: text.columns.share },
      { label: text.columns.avg, numeric: true },
      { label: text.columns.max, numeric: true },
      { label: text.columns.in, numeric: true },
      { label: text.columns.name, numeric: true },
    ])
    for (const f of m.fields) {
      const share = m.total ? f.total / m.total : 0
      const fill = h('span', { class: 'ds-bar-fill' })
      fill.style.width = `${Math.min(100, share * 100)}%`
      const object = f.types.includes('object') && enterable(f.name) && level.length < MAX_DEPTH
      const row = t.row(
        object
          ? h('button', {
              class: 'ds-link mm-key',
              attrs: { type: 'button', 'aria-label': text.into(f.name) },
              text: f.name,
              title: text.into(f.name),
              on: { click: () => go([...level, f.name]) },
            })
          : h('span', { class: 'mm-key', text: f.name, title: f.name }),
        h(
          'span',
          { class: 'ds-types' },
          ...f.types.map((type) => badge(type)),
          f.elements !== null
            ? h('span', {
                class: 'mm-subtle',
                text: text.elements(formatNumber(f.elements, language, 1), Math.round(f.elements * 10) / 10),
              })
            : null,
        ),
        h(
          'span',
          { class: 'ds-share' },
          h('span', { class: 'ds-bar', attrs: { 'aria-hidden': 'true' } }, fill),
          h('span', { text: percent(share) }),
        ),
        { node: bytes(f.docs ? f.total / f.docs : 0), numeric: true },
        { node: bytes(f.max), numeric: true },
        { node: percent(m.documents ? f.docs / m.documents : 0), numeric: true },
        { node: text.each(bytes(nameBytes(f.name))), numeric: true },
      )
      row.dataset.field = f.name
    }
    return h(
      'section',
      { class: 'mm-card ds-section', attrs: { 'aria-labelledby': 'fields-title' } },
      h('h2', { id: 'fields-title', class: 'ds-title', text: text.fields, attrs: { tabindex: '-1' } }),
      h('p', { class: 'mm-subtle', text: text.fieldsHint }),
      h('div', { class: 'mm-table-wrap', id: 'fields' }, t.el),
      m.moreFields ? h('p', { class: 'mm-subtle', text: text.moreFields(m.fields.length) }) : null,
    )
  }

  function largestSection(m: Measured): HTMLElement {
    // At a field's level, an object's share of 16 MB says nothing: the column is left out.
    const top = !level.length
    const t = table([
      { label: text.columns.id },
      { label: text.columns.size, numeric: true },
      ...(top ? [{ label: text.columns.ofLimit, numeric: true }] : []),
      { label: text.columns.actions, width: '1%' },
    ])
    m.largest.forEach((d, i) => {
      const id = describeValue(d.id).text
      t.row(
        valueView(d.id, 48),
        { node: bytes(d.size), numeric: true },
        ...(top ? [{ node: percent(d.size / BSON_LIMIT), numeric: true }] : []),
        h(
          'div',
          { class: 'mm-row-actions' },
          // A view's documents may have no _id: there is nothing to open.
          d.id === undefined
            ? null
            : (() => {
                const b = button({
                  label: text.open,
                  icon: 'external',
                  size: 'sm',
                  variant: 'ghost',
                  title: text.openTitle,
                  onClick: () => open(d.id, i),
                })
                b.setAttribute('aria-label', text.openOne(id))
                b.dataset.open = String(i)
                return b
              })(),
        ),
      )
    })
    const name = level.join('.')
    return h(
      'section',
      { class: 'mm-card ds-section', attrs: { 'aria-labelledby': 'largest-title' } },
      h('h2', {
        id: 'largest-title',
        class: 'ds-title',
        text: level.length ? text.largestIn(name) : text.largest,
      }),
      h('div', { class: 'mm-table-wrap', id: 'largest' }, t.el),
    )
  }

  function open(id: unknown, at: number): void {
    void client.ask('ui.openDocument', { id }).then(
      () => {
        if (openError === null) return
        openError = null
        render()
      },
      (error: unknown) => {
        openError = { error, at }
        focusAfter = { open: at }
        render()
      },
    )
  }

  /** The focus back where the user was: the level measured, or the Open that failed. */
  function placeFocus(): void {
    const where = focusAfter
    focusAfter = null
    if (!where) return
    const el =
      where === 'level'
        ? ((crumbs.querySelector('[aria-current]') as HTMLElement | null) ??
          (results.querySelector('#fields-title') as HTMLElement | null) ??
          results)
        : (results.querySelector(`[data-open="${where.open}"]`) as HTMLElement | null)
    el?.focus({ preventScroll: true })
  }

  function render(): void {
    draw()
    // Once measured (or not): what the page shows while it runs is redrawn after.
    if (state.kind !== 'running') placeFocus()
  }
  function draw(): void {
    notes.replaceChildren()
    status.textContent = ''
    renderCrumbs()
    const off = !ctx?.place || hidden()
    // Busy only while a measure runs: one kept, or one replaced, is no wait (review I3).
    setBusy(again, state.kind === 'running')
    again.disabled = off || state.kind === 'running'
    for (const b of scope.el.querySelectorAll('button')) b.disabled = off
    if (!ctx) return
    if (ctx.place && hidden())
      return void results.replaceChildren(
        emptyState({ icon: 'info', tone: 'neutral', title: text.hidden, hint: text.hiddenHint }),
      )
    if (state.kind === 'failed') {
      const reason = askMessage(state.error, locale)
      const code = state.error instanceof AskError ? state.error.code : ''
      const slow = /maxtimems|timeout|time limit|took too long/i.test(`${code} ${reason}`)
      // A failure is said in the status line too, so it is read out.
      status.textContent = text.failed
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: slow
            ? state.all
              ? text.allSlow
              : text.slow
            : ctx.place?.hidden === null
              ? `${text.hiddenMaybe} ${reason}`
              : reason,
          action: !ctx.place
            ? undefined
            : button({ label: text.tryAgain, icon: 'refresh', onClick: () => void measure() }),
        }),
      )
    }
    if (!ctx.place) return void results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = text.reading
      return void results.replaceChildren(skeleton(5))
    }
    const { measured: m, sampled, late } = state
    const name = level.join('.')
    if (openError !== null)
      notes.append(callout('danger', `${text.openFailed}${askMessage(openError.error, locale)}`))
    if (!m.documents)
      return void results.replaceChildren(
        emptyState({
          icon: 'database',
          title: level.length
            ? sampled && !late
              ? text.emptyInSample(name)
              : text.emptyIn(name)
            : text.empty,
        }),
      )
    const avg = m.total / m.documents
    status.textContent = level.length
      ? text.summaryIn(m.documents, name, bytes(avg), bytes(m.max))
      : text.summary(m.documents, bytes(avg), bytes(m.max), bytes(m.total))
    if (!level.length && m.max >= BSON_LIMIT / 2)
      notes.append(
        callout(
          m.max >= BSON_LIMIT * 0.9 ? 'danger' : 'warning',
          text.nearLimit(bytes(m.max), percent(m.max / BSON_LIMIT)),
          text.nearLimitHint,
        ),
      )
    const names = namesShare(m)
    if (names >= 0.2) notes.append(callout('info', text.names(percent(names)), text.namesHint))
    // A sample of fewer than SAMPLE documents is the whole collection.
    const note = level.length
      ? sampled
        ? late
          ? text.sampleOfThose(m.documents, name)
          : text.sampleIn(m.documents, name)
        : ''
      : sampled && m.documents >= SAMPLE
        ? text.sampleNote(m.documents)
        : text.allNote(m.documents)
    if (note) notes.append(h('p', { class: 'mm-subtle', text: note }))
    results.replaceChildren(spreadSection(m), fieldsSection(m), largestSection(m))
  }

  /** Measures the level in the scope chosen — kept from before unless asked again. */
  async function measure(kept = false): Promise<void> {
    if (!ctx?.place || hidden()) return render()
    const run = ++running
    const all = scope.value() === 'all'
    const known = kept ? measures.get(key()) : undefined
    openError = null
    if (known) {
      state = { kind: 'done', measured: known.measured, sampled: !all, late: known.late }
      return render()
    }
    state = { kind: 'running' }
    render()
    try {
      const sample = all ? null : SAMPLE
      let answer: { documents: unknown[] } | null
      let late = false
      try {
        answer = await aggregate(run, sizePipeline(level, sample))
      } catch (error) {
        // Large documents: their random sort is past MongoDB's memory; the sizes are sorted instead.
        if (!sample || !(error instanceof AskError) || !outOfMemory(error.message)) throw error
        late = true
        answer = await aggregate(run, sizePipeline(level, sample, true))
      }
      if (run !== running || answer === null) return
      const measured = readMeasured(answer.documents[0])
      measures.set(key(), { measured, late })
      state = { kind: 'done', measured, sampled: !all, late }
    } catch (error) {
      if (run !== running) return
      state = { kind: 'failed', error, all }
    }
    render()
  }

  // Measured anew, what was kept for this level replaced.
  again.addEventListener('click', () => void measure())

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXTS, locale)
    language = shown(TEXTS, locale)
    document.documentElement.lang = langTag(language)
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } catch (error) {
      ctx = { place: null } as unknown as PluginContext
      state = { kind: 'failed', error, all: false }
      return render()
    }
    locale = ctx.locale
    text = pick<Text>(TEXTS, locale)
    language = shown(TEXTS, locale)
    document.documentElement.lang = langTag(language)
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) return render()
    // Kept while Documents shows a document opened from here: the measures are there on coming back.
    void client.ask('ui.keepOpen').catch(() => {})
    void measure()
  })
  applyText()
  render()
}
