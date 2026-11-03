import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  icon,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  setBusy,
  setLabel,
  shown,
  skeleton,
  statusLine,
  type IconName,
  type Language,
  type Tone,
} from '../../kit/src/ui'
import {
  LIMITS,
  indexFindings,
  numberOf,
  showFilter,
  sizeFindings,
  sizePipeline,
  sortFindings,
  surveyFindings,
  surveySample,
  typeShares,
  type Doc,
  type Finding,
  type IndexInfo,
  type Severity,
  type Survey,
} from './checks'

/**
 * Schema health (plugins wave 2; redesigned 2026-10-10, spec plugin-tabs-redesign §2.7): a random
 * sample of the collection, its documents' sizes (measured by the server) and its indexes, checked
 * for the anti-patterns MongoDB's documentation names. It runs on opening — every read is bounded —
 * and each finding says what was found, why it matters, what to do, and where it can, shows the
 * documents it is about in Documents.
 */
export const SAMPLE = 1000
export const SIZE_SAMPLE = 10_000
const SEVERITIES: Severity[] = ['high', 'warning', 'info']
const TONE: Record<Severity, Tone> = { high: 'danger', warning: 'warning', info: 'info' }
const SEVERITY_ICON: Record<Severity, IconName> = { high: 'error', warning: 'warning', info: 'info' }

type V = Record<string, string | number>
interface Words {
  title: string
  /** What was found; `shares` are the types a mixed field holds, the most common first. */
  found: (v: V, extra: { shares: Array<{ type: string; count: number }>; severity: Severity }) => string
  why: (v: V) => string
  fix: (v: V) => string
}
/** A number in the language of the text that shows it. */
const f = (n: number | string | undefined, lang: Language) => formatNumber(Number(n), lang)
/** Whether the language writes a count in its singular form (French: 0 and 1; Russian: 1, 21…). */
const isOne = (n: number | string | undefined, lang: Language) => pluralOf(Number(n), lang) === 'one'
/** A size in MB, as the app writes it in every language, the number in that language. */
const MB = (n: number, lang: Language) => `${formatNumber(Math.round((n / 1024 / 1024) * 10) / 10, lang)} MB`
const sizeLimit = (s: Severity, lang: Language) => MB(s === 'high' ? LIMITS.docHigh : LIMITS.docWarn, lang)
/** A date the server sent, in the user's language; the text as sent if it is not one. */
const when = (since: string | number, locale: string) => {
  const d = new Date(String(since))
  return Number.isNaN(d.getTime()) ? String(since) : d.toLocaleString(langTag(locale))
}

type WordId =
  | 'largeDocuments'
  | 'largeArray'
  | 'deepNesting'
  | 'manyFields'
  | 'mixedTypes'
  | 'manyIndexes'
  | 'unusedIndex'
  | 'redundantIndex'
interface Text {
  title: string
  description: (coll: string) => string
  descriptionView: (coll: string) => string
  check: string
  sampling: string
  measuring: string
  readingIndexes: string
  noPlace: string
  failed: string
  tryAgain: string
  sizesFailed: string
  sizesHint: string
  indexesFailed: string
  severity: Record<Severity, string>
  count: (n: number, s: Severity) => string
  noProblems: string
  clean: (docs: number) => string
  cleanHint: string
  cleanHintView: string
  emptyTitle: string
  emptyHint: string
  emptyHintView: string
  checked: (docs: number, sized: number | null, indexes: number | null) => string
  why: string
  fix: string
  show: string
  showHint: string
  showFailed: string
  limitsTitle: string
  limitsNote: string
  limits: string[]
  words: Record<WordId, Words>
}

/** Russian plural forms: one (1, 21…), few (2–4, 22–24…), many (0, 5–20, 11–14…). */
const ruPlural = (n: number, one: string, few: string, many: string) => {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}

export const TEXT = {
  en: {
    title: 'Schema health',
    description: (coll: string) =>
      `Looks for MongoDB’s documented schema anti-patterns in ${coll}: a random sample, its documents’ sizes and its indexes. Changes nothing.`,
    descriptionView: (coll: string) =>
      `Looks for MongoDB’s documented schema anti-patterns in the view ${coll}: a random sample and its documents’ sizes. Changes nothing.`,
    check: 'Check',
    sampling: 'Sampling documents…',
    measuring: 'Measuring document sizes…',
    readingIndexes: 'Reading indexes…',
    noPlace: 'Open a collection to check it.',
    failed: 'The check could not run',
    tryAgain: 'Try again',
    sizesFailed: 'The sizes could not be measured',
    sizesHint: 'MongoDB 4.4 or later measures them. ',
    indexesFailed: 'The indexes could not be read',
    severity: { high: 'High risk', warning: 'Warning', info: 'Info' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'en')} high risk`
        : s === 'warning'
          ? `${f(n, 'en')} ${isOne(n, 'en') ? 'warning' : 'warnings'}`
          : `${f(n, 'en')} info`,
    noProblems: 'No problems',
    clean: (docs: number) =>
      `No problems found in ${f(docs, 'en')} sampled ${isOne(docs, 'en') ? 'document' : 'documents'}`,
    cleanHint: 'Sizes, nesting, arrays, field types and indexes all look fine.',
    cleanHintView: 'Sizes, nesting, arrays and field types all look fine.',
    emptyTitle: 'No documents to sample',
    emptyHint: 'This collection is empty; its indexes were checked.',
    emptyHintView: 'This view shows no documents.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'en')} ${isOne(docs, 'en') ? 'document' : 'documents'} sampled`,
        sized === null ? null : `${f(sized, 'en')} measured for size`,
        indexes === null ? null : `${f(indexes, 'en')} ${isOne(indexes, 'en') ? 'index' : 'indexes'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Why it matters',
    fix: 'What to do',
    show: 'Show in Documents',
    showHint: 'Puts a filter selecting these documents in the Documents query',
    showFailed: 'Could not open Documents: ',
    limitsTitle: 'What is checked',
    limitsNote: 'These are this plugin’s own thresholds; MongoDB’s own limits are named beside them.',
    limits: [
      `Documents larger than ${MB(LIMITS.docWarn, 'en')} (warning) or ${MB(LIMITS.docHigh, 'en')} (high risk), over a sample of ${formatNumber(SIZE_SAMPLE, 'en')}; MongoDB refuses 16 MB.`,
      `Arrays of more than ${f(LIMITS.arrayWarn, 'en')} elements (warning) or ${f(LIMITS.arrayHigh, 'en')} (high risk).`,
      `Nesting deeper than ${f(LIMITS.depthWarn, 'en')} levels; MongoDB’s limit is 100.`,
      `Documents with more than ${f(LIMITS.fieldsWarn, 'en')} fields.`,
      'A field holding more than one type, null aside.',
      `More than ${f(LIMITS.indexesWarn, 'en')} indexes (MongoDB’s limit is 64), unused indexes, and indexes whose keys begin another’s.`,
    ],
    words: {
      largeDocuments: {
        title: 'Large documents',
        found: (v, x) =>
          `${f(v.count, 'en')} measured ${isOne(v.count, 'en') ? 'document is' : 'documents are'} over ${sizeLimit(x.severity, 'en')}; the largest is ${MB(Number(v.max), 'en')}.`,
        why: () =>
          'Every read and update moves the whole document: large ones fill the cache and slow the server. MongoDB refuses a document over 16 MB.',
        fix: () =>
          'Move the parts that grow, or are rarely read, to their own collection (the subset and outlier patterns).',
      },
      largeArray: {
        title: 'Large array',
        found: (v) => `Up to ${f(v.length, 'en')} elements in one sampled document.`,
        why: () =>
          'An array that keeps growing makes its document heavier with every change, and an index on it grows with each element.',
        fix: () => 'Keep the array bounded, or give its elements their own collection with a reference back.',
      },
      deepNesting: {
        title: 'Deep nesting',
        found: (v) => `Documents nest ${f(v.depth, 'en')} levels deep.`,
        why: () => 'Deeply nested fields are hard to query, update and index.',
        fix: () => 'Flatten the levels you query on.',
      },
      manyFields: {
        title: 'Documents with very many fields',
        found: (v) => `A sampled document has ${f(v.fields, 'en')} fields.`,
        why: () => 'Wide documents are slow to read, and each field you query on needs an index of its own.',
        fix: () =>
          'Keep together what is read together. For many similar fields, the attribute pattern (an array of key–value pairs) is indexed once.',
      },
      mixedTypes: {
        title: 'Mixed types',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${s.type} in ${f(s.count, 'en')}${i === 0 ? ` sampled ${isOne(s.count, 'en') ? 'document' : 'documents'}` : ''}`).join(', ')}.`
            : `This field holds ${v.types}.`,
        why: () =>
          'Queries, sorts and indexes treat each type apart: a filter on a number misses the same value stored as text.',
        fix: () => 'Store one type, and keep it that way with a validation rule.',
      },
      manyIndexes: {
        title: 'Many indexes',
        found: (v) => `This collection has ${f(v.count, 'en')} indexes; MongoDB allows 64.`,
        why: () => 'Every index slows down writes and takes memory.',
        fix: () => 'Remove the indexes no query needs.',
      },
      unusedIndex: {
        title: 'Unused index',
        found: (v) => `Not used since ${when(v.since!, 'en')}, when the server began counting.`,
        why: () =>
          'An unused index still slows every write and takes memory. The count starts again when the server restarts.',
        fix: () => 'If no query needs it, drop it — hide it first to be sure nothing slows down.',
      },
      redundantIndex: {
        title: 'Redundant index',
        found: (v) => `Its keys are the start of ${v.covered}’s keys.`,
        why: (v) => `The queries it serves can use ${v.covered}; keeping both slows writes.`,
        fix: () => 'Drop it, unless something else needs it (a hint, or an index option).',
      },
    },
  },
  tr: {
    title: 'Şema sağlığı',
    description: (coll: string) =>
      `${coll} koleksiyonunda MongoDB belgelerinde tanımlanan şema hatalarını arar: rastgele bir örnek, belge boyutları ve indeksler. Hiçbir şeyi değiştirmez.`,
    descriptionView: (coll: string) =>
      `${coll} görünümünde MongoDB belgelerinde tanımlanan şema hatalarını arar: rastgele bir örnek ve belge boyutları. Hiçbir şeyi değiştirmez.`,
    check: 'Denetle',
    sampling: 'Belgelerden örnek alınıyor…',
    measuring: 'Belge boyutları ölçülüyor…',
    readingIndexes: 'İndeksler okunuyor…',
    noPlace: 'Denetlemek için bir koleksiyon açın.',
    failed: 'Denetim yapılamadı',
    tryAgain: 'Yeniden dene',
    sizesFailed: 'Boyutlar ölçülemedi',
    sizesHint: 'Boyutları MongoDB 4.4 ve sonrası ölçebilir. ',
    indexesFailed: 'İndeksler okunamadı',
    severity: { high: 'Yüksek risk', warning: 'Uyarı', info: 'Bilgi' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'tr')} yüksek risk`
        : s === 'warning'
          ? `${f(n, 'tr')} uyarı`
          : `${f(n, 'tr')} bilgi`,
    noProblems: 'Sorun yok',
    clean: (docs: number) => `Örneklenen ${f(docs, 'tr')} belgede sorun bulunmadı`,
    cleanHint: 'Boyutlar, iç içelik, diziler, alan tipleri ve indeksler sorunsuz görünüyor.',
    cleanHintView: 'Boyutlar, iç içelik, diziler ve alan tipleri sorunsuz görünüyor.',
    emptyTitle: 'Örneklenecek belge yok',
    emptyHint: 'Bu koleksiyon boş; indeksleri denetlendi.',
    emptyHintView: 'Bu görünüm hiç belge göstermiyor.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'tr')} belge örneklendi`,
        sized === null ? null : `${f(sized, 'tr')} belgenin boyutu ölçüldü`,
        indexes === null ? null : `${f(indexes, 'tr')} indeks`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Neden önemli',
    fix: 'Ne yapmalı',
    show: 'Belgelerde göster',
    showHint: 'Bu belgeleri seçen bir filtreyi Belgeler sorgusuna koyar',
    showFailed: 'Belgeler açılamadı: ',
    limitsTitle: 'Neler denetlenir',
    limitsNote:
      'Eşikler bu eklentinin kendi seçimidir; MongoDB’nin kendi sınırları yanlarında belirtilmiştir.',
    limits: [
      `${formatNumber(SIZE_SAMPLE, 'tr')} belgelik bir örnekte ${MB(LIMITS.docWarn, 'tr')} (uyarı) ya da ${MB(LIMITS.docHigh, 'tr')} (yüksek risk) üstü belgeler; MongoDB 16 MB üstünü reddeder.`,
      `${f(LIMITS.arrayWarn, 'tr')} (uyarı) ya da ${f(LIMITS.arrayHigh, 'tr')} (yüksek risk) öğeden büyük diziler.`,
      `${f(LIMITS.depthWarn, 'tr')} düzeyden derin iç içelik; MongoDB’nin sınırı 100’dür.`,
      `${f(LIMITS.fieldsWarn, 'tr')} alandan fazlasını taşıyan belgeler.`,
      'Null dışında birden fazla tip taşıyan alanlar.',
      `${f(LIMITS.indexesWarn, 'tr')} indeksten fazlası (MongoDB’nin sınırı 64’tür), kullanılmayan indeksler ve anahtarları başka bir indeksin başı olan indeksler.`,
    ],
    words: {
      largeDocuments: {
        title: 'Büyük belgeler',
        found: (v, x) =>
          `Ölçülen belgelerden ${f(v.count, 'tr')} tanesi ${sizeLimit(x.severity, 'tr')} üstünde; en büyüğü ${MB(Number(v.max), 'tr')}.`,
        why: () =>
          'Her okuma ve güncelleme belgenin tamamını taşır: büyük belgeler önbelleği doldurur ve sunucuyu yavaşlatır. MongoDB 16 MB üstü bir belgeyi reddeder.',
        fix: () =>
          'Büyüyen ya da seyrek okunan kısımları kendi koleksiyonlarına taşıyın (subset ve outlier kalıpları).',
      },
      largeArray: {
        title: 'Büyük dizi',
        found: (v) => `Örnekteki bir belgede ${f(v.length, 'tr')} öğeye kadar.`,
        why: () =>
          'Sürekli büyüyen bir dizi belgeyi her değişiklikte ağırlaştırır; üzerindeki bir indeks de her öğeyle büyür.',
        fix: () => 'Diziyi sınırlı tutun ya da öğelerini, geri referansla kendi koleksiyonlarına taşıyın.',
      },
      deepNesting: {
        title: 'Derin iç içelik',
        found: (v) => `Belgeler ${f(v.depth, 'tr')} düzey iç içe.`,
        why: () => 'Çok iç içe alanları sorgulamak, güncellemek ve indekslemek zordur.',
        fix: () => 'Sorguladığınız düzeyleri düzleştirin.',
      },
      manyFields: {
        title: 'Çok fazla alanlı belgeler',
        found: (v) => `Örnekteki bir belgede ${f(v.fields, 'tr')} alan var.`,
        why: () => 'Geniş belgeler yavaş okunur; sorguladığınız her alan için ayrı bir indeks gerekir.',
        fix: () =>
          'Birlikte okunanları birlikte tutun. Çok sayıda benzer alan için attribute kalıbı (anahtar–değer dizisi) tek indeksle indekslenir.',
      },
      mixedTypes: {
        title: 'Karışık tipler',
        found: (v, x) =>
          x.shares.length > 1
            ? `Örnekte ${x.shares.map((s) => `${f(s.count, 'tr')} belgede ${s.type}`).join(', ')}.`
            : `Bu alan şunları taşıyor: ${v.types}.`,
        why: () =>
          'Sorgular, sıralamalar ve indeksler her tipi ayrı ele alır: sayı arayan bir filtre, metin olarak saklanmış aynı değeri bulamaz.',
        fix: () => 'Tek bir tip saklayın ve bunu bir doğrulama kuralıyla koruyun.',
      },
      manyIndexes: {
        title: 'Çok fazla indeks',
        found: (v) => `Bu koleksiyonda ${f(v.count, 'tr')} indeks var; MongoDB en fazla 64’e izin verir.`,
        why: () => 'Her indeks yazmaları yavaşlatır ve bellek kullanır.',
        fix: () => 'Hiçbir sorgunun ihtiyaç duymadığı indeksleri kaldırın.',
      },
      unusedIndex: {
        title: 'Kullanılmayan indeks',
        found: (v) => `Sunucunun saymaya başladığı ${when(v.since!, 'tr')} tarihinden beri kullanılmadı.`,
        why: () =>
          'Kullanılmayan bir indeks de her yazmayı yavaşlatır ve bellek kullanır. Sayım, sunucu yeniden başlayınca sıfırlanır.',
        fix: () =>
          'Hiçbir sorgu ihtiyaç duymuyorsa kaldırın; hiçbir şeyin yavaşlamadığından emin olmak için önce gizleyin.',
      },
      redundantIndex: {
        title: 'Gereksiz indeks',
        found: (v) => `Anahtarları, ${v.covered} indeksinin anahtarlarının başı.`,
        why: (v) =>
          `Hizmet ettiği sorgular ${v.covered} indeksini kullanabilir; ikisini birden tutmak yazmaları yavaşlatır.`,
        fix: () => 'Başka bir şey (bir hint ya da bir indeks seçeneği) gerektirmiyorsa kaldırın.',
      },
    },
  },
  zh: {
    title: '模式健康度',
    description: (coll: string) =>
      `在集合 ${coll} 中查找 MongoDB 文档所述的模式反模式：随机采样、文档大小和索引。不会更改任何内容。`,
    descriptionView: (coll: string) =>
      `在视图 ${coll} 中查找 MongoDB 文档所述的模式反模式：随机采样和文档大小。不会更改任何内容。`,
    check: '检查',
    sampling: '正在采样文档…',
    measuring: '正在测量文档大小…',
    readingIndexes: '正在读取索引…',
    noPlace: '打开一个集合后即可检查。',
    failed: '无法运行检查',
    tryAgain: '重试',
    sizesFailed: '无法测量大小',
    sizesHint: 'MongoDB 4.4 或更高版本才能测量大小。',
    indexesFailed: '无法读取索引',
    severity: { high: '高风险', warning: '警告', info: '信息' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'zh')} 项高风险`
        : s === 'warning'
          ? `${f(n, 'zh')} 项警告`
          : `${f(n, 'zh')} 项信息`,
    noProblems: '没有问题',
    clean: (docs: number) => `在采样的 ${f(docs, 'zh')} 个文档中未发现问题`,
    cleanHint: '大小、嵌套、数组、字段类型和索引均正常。',
    cleanHintView: '大小、嵌套、数组和字段类型均正常。',
    emptyTitle: '没有可采样的文档',
    emptyHint: '此集合为空；已检查其索引。',
    emptyHintView: '此视图不显示任何文档。',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `已采样 ${f(docs, 'zh')} 个文档`,
        sized === null ? null : `已测量 ${f(sized, 'zh')} 个文档的大小`,
        indexes === null ? null : `${f(indexes, 'zh')} 个索引`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: '为什么重要',
    fix: '建议操作',
    show: '在文档中显示',
    showHint: '将选中这些文档的筛选条件放入“文档”查询',
    showFailed: '无法打开“文档”：',
    limitsTitle: '检查内容',
    limitsNote: '这些是此插件自己的阈值；MongoDB 自身的限制标注在旁边。',
    limits: [
      `在 ${formatNumber(SIZE_SAMPLE, 'zh')} 个文档的采样中，大于 ${MB(LIMITS.docWarn, 'zh')}（警告）或 ${MB(LIMITS.docHigh, 'zh')}（高风险）的文档；MongoDB 拒绝超过 16 MB 的文档。`,
      `元素超过 ${f(LIMITS.arrayWarn, 'zh')} 个（警告）或 ${f(LIMITS.arrayHigh, 'zh')} 个（高风险）的数组。`,
      `嵌套深度超过 ${f(LIMITS.depthWarn, 'zh')} 层；MongoDB 的限制是 100 层。`,
      `字段超过 ${f(LIMITS.fieldsWarn, 'zh')} 个的文档。`,
      '除 null 外包含多种类型的字段。',
      `索引超过 ${f(LIMITS.indexesWarn, 'zh')} 个（MongoDB 的限制是 64 个）、未使用的索引，以及键是另一索引键前缀的索引。`,
    ],
    words: {
      largeDocuments: {
        title: '大文档',
        found: (v, x) =>
          `在已测量的文档中，有 ${f(v.count, 'zh')} 个超过 ${sizeLimit(x.severity, 'zh')}；最大的为 ${MB(Number(v.max), 'zh')}。`,
        why: () =>
          '每次读取和更新都会处理整个文档：大文档会占满缓存并拖慢服务器。MongoDB 拒绝超过 16 MB 的文档。',
        fix: () => '将持续增长或很少读取的部分移到单独的集合（子集模式和异常值模式）。',
      },
      largeArray: {
        title: '大数组',
        found: (v) => `某个采样文档中的数组多达 ${f(v.length, 'zh')} 个元素。`,
        why: () => '不断增长的数组会使其所在文档随每次更改而变重，其上的索引也会随元素增多而变大。',
        fix: () => '限制数组的大小，或将其元素放入单独的集合并通过引用关联。',
      },
      deepNesting: {
        title: '嵌套过深',
        found: (v) => `文档嵌套了 ${f(v.depth, 'zh')} 层。`,
        why: () => '嵌套很深的字段难以查询、更新和建立索引。',
        fix: () => '将用于查询的层级展平。',
      },
      manyFields: {
        title: '字段过多的文档',
        found: (v) => `某个采样文档有 ${f(v.fields, 'zh')} 个字段。`,
        why: () => '字段很多的文档读取较慢，而且每个用于查询的字段都需要单独的索引。',
        fix: () => '将一起读取的内容放在一起。对于大量相似字段，属性模式（键值对数组）只需建立一个索引。',
      },
      mixedTypes: {
        title: '混合类型',
        found: (v, x) =>
          x.shares.length > 1
            ? `采样中${x.shares.map((s) => `${f(s.count, 'zh')} 个文档为 ${s.type}`).join('，')}。`
            : `此字段包含：${v.types}。`,
        why: () => '查询、排序和索引会分别处理每种类型：针对数字的筛选找不到以文本形式存储的相同值。',
        fix: () => '只存储一种类型，并通过验证规则保持如此。',
      },
      manyIndexes: {
        title: '索引过多',
        found: (v) => `此集合有 ${f(v.count, 'zh')} 个索引；MongoDB 最多允许 64 个。`,
        why: () => '每个索引都会拖慢写入并占用内存。',
        fix: () => '删除没有任何查询需要的索引。',
      },
      unusedIndex: {
        title: '未使用的索引',
        found: (v) => `自服务器开始计数的 ${when(v.since!, 'zh')} 起未被使用。`,
        why: () => '未使用的索引仍会拖慢每次写入并占用内存。服务器重启后，计数会重新开始。',
        fix: () => '如果没有查询需要它，就删除它；为确保不会出现变慢，请先将其隐藏。',
      },
      redundantIndex: {
        title: '冗余索引',
        found: (v) => `其键是 ${v.covered} 的键的前缀。`,
        why: (v) => `它所服务的查询可以使用 ${v.covered}；同时保留两者会拖慢写入。`,
        fix: () => '将其删除，除非其他地方需要它（提示 hint 或索引选项）。',
      },
    },
  },
  ja: {
    title: 'スキーマの健全性',
    description: (coll: string) =>
      `${coll} コレクションで、MongoDB のドキュメントに挙げられているスキーマのアンチパターンを調べます。対象はランダムなサンプル、ドキュメントのサイズ、インデックスです。何も変更しません。`,
    descriptionView: (coll: string) =>
      `${coll} ビューで、MongoDB のドキュメントに挙げられているスキーマのアンチパターンを調べます。対象はランダムなサンプルとドキュメントのサイズです。何も変更しません。`,
    check: 'チェック',
    sampling: 'ドキュメントをサンプリングしています…',
    measuring: 'ドキュメントのサイズを測定しています…',
    readingIndexes: 'インデックスを読み取っています…',
    noPlace: 'チェックするにはコレクションを開いてください。',
    failed: 'チェックを実行できませんでした',
    tryAgain: '再試行',
    sizesFailed: 'サイズを測定できませんでした',
    sizesHint: 'サイズの測定には MongoDB 4.4 以降が必要です。',
    indexesFailed: 'インデックスを読み取れませんでした',
    severity: { high: '高リスク', warning: '警告', info: '情報' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `高リスク ${f(n, 'ja')} 件`
        : s === 'warning'
          ? `警告 ${f(n, 'ja')} 件`
          : `情報 ${f(n, 'ja')} 件`,
    noProblems: '問題なし',
    clean: (docs: number) => `サンプリングした ${f(docs, 'ja')} 件のドキュメントに問題は見つかりませんでした`,
    cleanHint: 'サイズ、ネスト、配列、フィールドの型、インデックスに問題は見られません。',
    cleanHintView: 'サイズ、ネスト、配列、フィールドの型に問題は見られません。',
    emptyTitle: 'サンプリングするドキュメントがありません',
    emptyHint: 'このコレクションは空です。インデックスはチェックしました。',
    emptyHintView: 'このビューにはドキュメントがありません。',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'ja')} 件のドキュメントをサンプリング`,
        sized === null ? null : `${f(sized, 'ja')} 件のサイズを測定`,
        indexes === null ? null : `インデックス ${f(indexes, 'ja')} 件`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: '重要な理由',
    fix: '対処方法',
    show: 'ドキュメントで表示',
    showHint: 'これらのドキュメントを選択するフィルターを「ドキュメント」のクエリに設定します',
    showFailed: '「ドキュメント」を開けませんでした: ',
    limitsTitle: 'チェック内容',
    limitsNote: 'これらはこのプラグイン独自のしきい値です。MongoDB 自体の制限を併記しています。',
    limits: [
      `${formatNumber(SIZE_SAMPLE, 'ja')} 件のサンプルのうち、${MB(LIMITS.docWarn, 'ja')} を超える（警告）または ${MB(LIMITS.docHigh, 'ja')} を超える（高リスク）ドキュメント。MongoDB は 16 MB を超えるドキュメントを拒否します。`,
      `要素が ${f(LIMITS.arrayWarn, 'ja')} 個を超える（警告）または ${f(LIMITS.arrayHigh, 'ja')} 個を超える（高リスク）配列。`,
      `ネストが ${f(LIMITS.depthWarn, 'ja')} 階層より深いもの。MongoDB の上限は 100 です。`,
      `フィールドが ${f(LIMITS.fieldsWarn, 'ja')} 個を超えるドキュメント。`,
      'null を除き、複数の型を持つフィールド。',
      `インデックスが ${f(LIMITS.indexesWarn, 'ja')} 個を超える場合（MongoDB の上限は 64）、未使用のインデックス、およびキーが別のインデックスのキーの先頭部分になっているインデックス。`,
    ],
    words: {
      largeDocuments: {
        title: '大きなドキュメント',
        found: (v, x) =>
          `測定したドキュメントのうち ${f(v.count, 'ja')} 件が ${sizeLimit(x.severity, 'ja')} を超えています。最大は ${MB(Number(v.max), 'ja')} です。`,
        why: () =>
          '読み取りや更新のたびにドキュメント全体が処理されるため、大きなドキュメントはキャッシュを圧迫し、サーバーを遅くします。MongoDB は 16 MB を超えるドキュメントを拒否します。',
        fix: () =>
          '増え続ける部分や、ほとんど読まれない部分を別のコレクションに移します（サブセットパターンとアウトライアーパターン）。',
      },
      largeArray: {
        title: '大きな配列',
        found: (v) => `サンプルの 1 件のドキュメントに、最大 ${f(v.length, 'ja')} 個の要素があります。`,
        why: () =>
          '増え続ける配列は、変更のたびにドキュメントを重くし、その配列上のインデックスも要素ごとに大きくなります。',
        fix: () => '配列のサイズに上限を設けるか、要素を別のコレクションに移して参照で結び付けます。',
      },
      deepNesting: {
        title: '深いネスト',
        found: (v) => `ドキュメントが ${f(v.depth, 'ja')} 階層までネストしています。`,
        why: () => '深くネストしたフィールドは、クエリ、更新、インデックス作成が困難です。',
        fix: () => 'クエリに使う階層をフラットにします。',
      },
      manyFields: {
        title: 'フィールドが非常に多いドキュメント',
        found: (v) => `サンプルの 1 件のドキュメントに ${f(v.fields, 'ja')} 個のフィールドがあります。`,
        why: () =>
          '幅の広いドキュメントは読み取りが遅く、クエリに使うフィールドごとに専用のインデックスが必要です。',
        fix: () =>
          '一緒に読まれるものはまとめて保持します。似たフィールドが多数ある場合は、アトリビュートパターン（キーと値のペアの配列）なら 1 つのインデックスで済みます。',
      },
      mixedTypes: {
        title: '型の混在',
        found: (v, x) =>
          x.shares.length > 1
            ? `サンプルでは、${x.shares.map((s) => `${f(s.count, 'ja')} 件のドキュメントが ${s.type}`).join('、')}です。`
            : `このフィールドには次が含まれます: ${v.types}。`,
        why: () =>
          'クエリ、並べ替え、インデックスは型ごとに別々に扱われるため、数値に対するフィルターでは、テキストとして保存された同じ値は見つかりません。',
        fix: () => '1 つの型だけを保存し、検証ルールでそれを維持します。',
      },
      manyIndexes: {
        title: 'インデックスが多すぎる',
        found: (v) =>
          `このコレクションには ${f(v.count, 'ja')} 個のインデックスがあります。MongoDB が許可するのは 64 個までです。`,
        why: () => 'インデックスは、1 つ増えるごとに書き込みを遅くし、メモリを消費します。',
        fix: () => 'どのクエリにも必要とされないインデックスを削除します。',
      },
      unusedIndex: {
        title: '未使用のインデックス',
        found: (v) => `サーバーがカウントを開始した ${when(v.since!, 'ja')} 以降、使用されていません。`,
        why: () =>
          '未使用のインデックスでも、書き込みのたびに遅くなり、メモリを消費します。カウントはサーバーの再起動で最初からやり直しになります。',
        fix: () =>
          'どのクエリにも必要なければ削除します。遅くならないことを確かめるため、先に非表示にしてください。',
      },
      redundantIndex: {
        title: '冗長なインデックス',
        found: (v) => `このインデックスのキーは、${v.covered} のキーの先頭部分です。`,
        why: (v) =>
          `このインデックスが対応するクエリは ${v.covered} でも処理できます。両方を残すと書き込みが遅くなります。`,
        fix: () => '他に必要とするもの（ヒントやインデックスのオプション）がなければ削除します。',
      },
    },
  },
  es: {
    title: 'Salud del esquema',
    description: (coll: string) =>
      `Busca en ${coll} los antipatrones de esquema que describe la documentación de MongoDB: una muestra aleatoria, el tamaño de los documentos y los índices. No cambia nada.`,
    descriptionView: (coll: string) =>
      `Busca en la vista ${coll} los antipatrones de esquema que describe la documentación de MongoDB: una muestra aleatoria y el tamaño de los documentos. No cambia nada.`,
    check: 'Comprobar',
    sampling: 'Tomando una muestra de documentos…',
    measuring: 'Midiendo el tamaño de los documentos…',
    readingIndexes: 'Leyendo los índices…',
    noPlace: 'Abre una colección para comprobarla.',
    failed: 'No se pudo ejecutar la comprobación',
    tryAgain: 'Reintentar',
    sizesFailed: 'No se pudieron medir los tamaños',
    sizesHint: 'MongoDB 4.4 o posterior puede medirlos. ',
    indexesFailed: 'No se pudieron leer los índices',
    severity: { high: 'Riesgo alto', warning: 'Advertencia', info: 'Información' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'es')} de riesgo alto`
        : s === 'warning'
          ? `${f(n, 'es')} ${isOne(n, 'es') ? 'advertencia' : 'advertencias'}`
          : `${f(n, 'es')} de información`,
    noProblems: 'Sin problemas',
    clean: (docs: number) =>
      `No se encontraron problemas en ${f(docs, 'es')} ${isOne(docs, 'es') ? 'documento muestreado' : 'documentos muestreados'}`,
    cleanHint:
      'Los tamaños, el anidamiento, los arreglos, los tipos de campo y los índices parecen correctos.',
    cleanHintView: 'Los tamaños, el anidamiento, los arreglos y los tipos de campo parecen correctos.',
    emptyTitle: 'No hay documentos de los que tomar muestra',
    emptyHint: 'Esta colección está vacía; se comprobaron sus índices.',
    emptyHintView: 'Esta vista no muestra ningún documento.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'es')} ${isOne(docs, 'es') ? 'documento muestreado' : 'documentos muestreados'}`,
        sized === null ? null : `${f(sized, 'es')} con el tamaño medido`,
        indexes === null ? null : `${f(indexes, 'es')} ${isOne(indexes, 'es') ? 'índice' : 'índices'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Por qué importa',
    fix: 'Qué hacer',
    show: 'Mostrar en Documentos',
    showHint: 'Pone un filtro que selecciona estos documentos en la consulta de Documentos',
    showFailed: 'No se pudo abrir Documentos: ',
    limitsTitle: 'Qué se comprueba',
    limitsNote:
      'Estos son los umbrales propios del complemento; junto a ellos se indican los límites de MongoDB.',
    limits: [
      `Documentos de más de ${MB(LIMITS.docWarn, 'es')} (advertencia) o de más de ${MB(LIMITS.docHigh, 'es')} (riesgo alto), en una muestra de ${formatNumber(SIZE_SAMPLE, 'es')}; MongoDB rechaza los de más de 16 MB.`,
      `Arreglos de más de ${f(LIMITS.arrayWarn, 'es')} elementos (advertencia) o de más de ${f(LIMITS.arrayHigh, 'es')} (riesgo alto).`,
      `Anidamiento de más de ${f(LIMITS.depthWarn, 'es')} niveles; el límite de MongoDB es 100.`,
      `Documentos con más de ${f(LIMITS.fieldsWarn, 'es')} campos.`,
      'Un campo que contiene más de un tipo, sin contar null.',
      `Más de ${f(LIMITS.indexesWarn, 'es')} índices (el límite de MongoDB es 64), índices sin usar e índices cuyas claves son el comienzo de las de otro.`,
    ],
    words: {
      largeDocuments: {
        title: 'Documentos grandes',
        found: (v, x) =>
          `${f(v.count, 'es')} ${isOne(v.count, 'es') ? 'documento medido supera' : 'documentos medidos superan'} ${sizeLimit(x.severity, 'es')}; el mayor es de ${MB(Number(v.max), 'es')}.`,
        why: () =>
          'Cada lectura y actualización mueve el documento completo: los grandes llenan la caché y ralentizan el servidor. MongoDB rechaza los documentos de más de 16 MB.',
        fix: () =>
          'Mueve las partes que crecen, o que se leen poco, a su propia colección (los patrones de subconjunto y de valores atípicos).',
      },
      largeArray: {
        title: 'Arreglo grande',
        found: (v) => `Hasta ${f(v.length, 'es')} elementos en un documento de la muestra.`,
        why: () =>
          'Un arreglo que no deja de crecer hace más pesado su documento con cada cambio, y un índice sobre él crece con cada elemento.',
        fix: () =>
          'Mantén el arreglo acotado, o da a sus elementos su propia colección con una referencia de vuelta.',
      },
      deepNesting: {
        title: 'Anidamiento profundo',
        found: (v) => `Los documentos se anidan hasta ${f(v.depth, 'es')} niveles.`,
        why: () => 'Los campos muy anidados son difíciles de consultar, actualizar e indexar.',
        fix: () => 'Aplana los niveles por los que consultas.',
      },
      manyFields: {
        title: 'Documentos con muchísimos campos',
        found: (v) => `Un documento de la muestra tiene ${f(v.fields, 'es')} campos.`,
        why: () =>
          'Los documentos anchos son lentos de leer, y cada campo por el que consultas necesita un índice propio.',
        fix: () =>
          'Mantén juntos los datos que se leen juntos. Para muchos campos similares, el patrón de atributos (un arreglo de pares clave-valor) se indexa una sola vez.',
      },
      mixedTypes: {
        title: 'Tipos mezclados',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${s.type} en ${f(s.count, 'es')}${i === 0 ? ` ${isOne(s.count, 'es') ? 'documento muestreado' : 'documentos muestreados'}` : ''}`).join(', ')}.`
            : `Este campo contiene ${v.types}.`,
        why: () =>
          'Las consultas, las ordenaciones y los índices tratan cada tipo por separado: un filtro sobre un número no encuentra el mismo valor guardado como texto.',
        fix: () => 'Guarda un solo tipo y mantenlo así con una regla de validación.',
      },
      manyIndexes: {
        title: 'Muchos índices',
        found: (v) => `Esta colección tiene ${f(v.count, 'es')} índices; MongoDB permite 64.`,
        why: () => 'Cada índice ralentiza las escrituras y ocupa memoria.',
        fix: () => 'Elimina los índices que ninguna consulta necesita.',
      },
      unusedIndex: {
        title: 'Índice sin usar',
        found: (v) => `No se ha usado desde el ${when(v.since!, 'es')}, cuando el servidor empezó a contar.`,
        why: () =>
          'Un índice sin usar sigue ralentizando cada escritura y ocupando memoria. El recuento vuelve a empezar cuando se reinicia el servidor.',
        fix: () =>
          'Si ninguna consulta lo necesita, elimínalo; antes, ocúltalo para asegurarte de que nada se ralentiza.',
      },
      redundantIndex: {
        title: 'Índice redundante',
        found: (v) => `Sus claves son el comienzo de las claves de ${v.covered}.`,
        why: (v) =>
          `Las consultas a las que da servicio pueden usar ${v.covered}; mantener ambos ralentiza las escrituras.`,
        fix: () => 'Elimínalo, salvo que algo más lo necesite (una sugerencia hint o una opción de índice).',
      },
    },
  },
  pt: {
    title: 'Integridade do esquema',
    description: (coll: string) =>
      `Procura em ${coll} os antipadrões de esquema descritos na documentação do MongoDB: uma amostra aleatória, o tamanho dos documentos e os índices. Não altera nada.`,
    descriptionView: (coll: string) =>
      `Procura na visualização ${coll} os antipadrões de esquema descritos na documentação do MongoDB: uma amostra aleatória e o tamanho dos documentos. Não altera nada.`,
    check: 'Verificar',
    sampling: 'Coletando uma amostra dos documentos…',
    measuring: 'Medindo o tamanho dos documentos…',
    readingIndexes: 'Lendo os índices…',
    noPlace: 'Abra uma coleção para verificá-la.',
    failed: 'Não foi possível executar a verificação',
    tryAgain: 'Tentar novamente',
    sizesFailed: 'Não foi possível medir os tamanhos',
    sizesHint: 'O MongoDB 4.4 ou posterior consegue medi-los. ',
    indexesFailed: 'Não foi possível ler os índices',
    severity: { high: 'Risco alto', warning: 'Aviso', info: 'Informação' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'pt')} de risco alto`
        : s === 'warning'
          ? `${f(n, 'pt')} ${isOne(n, 'pt') ? 'aviso' : 'avisos'}`
          : `${f(n, 'pt')} de informação`,
    noProblems: 'Nenhum problema',
    clean: (docs: number) =>
      `Nenhum problema encontrado em ${f(docs, 'pt')} ${isOne(docs, 'pt') ? 'documento amostrado' : 'documentos amostrados'}`,
    cleanHint: 'Tamanhos, aninhamento, arrays, tipos de campo e índices parecem corretos.',
    cleanHintView: 'Tamanhos, aninhamento, arrays e tipos de campo parecem corretos.',
    emptyTitle: 'Nenhum documento para amostrar',
    emptyHint: 'Esta coleção está vazia; os índices dela foram verificados.',
    emptyHintView: 'Esta visualização não mostra nenhum documento.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'pt')} ${isOne(docs, 'pt') ? 'documento amostrado' : 'documentos amostrados'}`,
        sized === null ? null : `${f(sized, 'pt')} com o tamanho medido`,
        indexes === null ? null : `${f(indexes, 'pt')} ${isOne(indexes, 'pt') ? 'índice' : 'índices'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Por que isso importa',
    fix: 'O que fazer',
    show: 'Mostrar em Documentos',
    showHint: 'Coloca na consulta de Documentos um filtro que seleciona estes documentos',
    showFailed: 'Não foi possível abrir Documentos: ',
    limitsTitle: 'O que é verificado',
    limitsNote: 'Estes são os limites próprios do plugin; os limites do MongoDB aparecem ao lado.',
    limits: [
      `Documentos maiores que ${MB(LIMITS.docWarn, 'pt')} (aviso) ou ${MB(LIMITS.docHigh, 'pt')} (risco alto), em uma amostra de ${formatNumber(SIZE_SAMPLE, 'pt')}; o MongoDB recusa mais de 16 MB.`,
      `Arrays com mais de ${f(LIMITS.arrayWarn, 'pt')} elementos (aviso) ou ${f(LIMITS.arrayHigh, 'pt')} (risco alto).`,
      `Aninhamento com mais de ${f(LIMITS.depthWarn, 'pt')} níveis; o limite do MongoDB é 100.`,
      `Documentos com mais de ${f(LIMITS.fieldsWarn, 'pt')} campos.`,
      'Um campo que contém mais de um tipo, exceto null.',
      `Mais de ${f(LIMITS.indexesWarn, 'pt')} índices (o limite do MongoDB é 64), índices sem uso e índices cujas chaves são o início das chaves de outro.`,
    ],
    words: {
      largeDocuments: {
        title: 'Documentos grandes',
        found: (v, x) =>
          `${f(v.count, 'pt')} ${isOne(v.count, 'pt') ? 'documento medido está' : 'documentos medidos estão'} acima de ${sizeLimit(x.severity, 'pt')}; o maior tem ${MB(Number(v.max), 'pt')}.`,
        why: () =>
          'Cada leitura e atualização move o documento inteiro: os grandes enchem o cache e deixam o servidor lento. O MongoDB recusa um documento com mais de 16 MB.',
        fix: () =>
          'Mova as partes que crescem, ou que raramente são lidas, para uma coleção própria (os padrões de subconjunto e de valores atípicos).',
      },
      largeArray: {
        title: 'Array grande',
        found: (v) => `Até ${f(v.length, 'pt')} elementos em um documento da amostra.`,
        why: () =>
          'Um array que não para de crescer deixa seu documento mais pesado a cada alteração, e um índice sobre ele cresce a cada elemento.',
        fix: () =>
          'Mantenha o array limitado, ou dê aos elementos uma coleção própria com uma referência de volta.',
      },
      deepNesting: {
        title: 'Aninhamento profundo',
        found: (v) => `Os documentos têm ${f(v.depth, 'pt')} níveis de aninhamento.`,
        why: () => 'Campos muito aninhados são difíceis de consultar, atualizar e indexar.',
        fix: () => 'Nivele os níveis que você consulta.',
      },
      manyFields: {
        title: 'Documentos com muitíssimos campos',
        found: (v) => `Um documento da amostra tem ${f(v.fields, 'pt')} campos.`,
        why: () =>
          'Documentos largos são lentos de ler, e cada campo consultado precisa de um índice próprio.',
        fix: () =>
          'Mantenha juntos os dados lidos juntos. Para muitos campos parecidos, o padrão de atributos (um array de pares chave-valor) é indexado uma única vez.',
      },
      mixedTypes: {
        title: 'Tipos mistos',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${s.type} em ${f(s.count, 'pt')}${i === 0 ? ` ${isOne(s.count, 'pt') ? 'documento amostrado' : 'documentos amostrados'}` : ''}`).join(', ')}.`
            : `Este campo contém ${v.types}.`,
        why: () =>
          'Consultas, ordenações e índices tratam cada tipo separadamente: um filtro sobre um número não encontra o mesmo valor guardado como texto.',
        fix: () => 'Armazene um único tipo e mantenha-o assim com uma regra de validação.',
      },
      manyIndexes: {
        title: 'Muitos índices',
        found: (v) => `Esta coleção tem ${f(v.count, 'pt')} índices; o MongoDB permite 64.`,
        why: () => 'Cada índice deixa as gravações mais lentas e ocupa memória.',
        fix: () => 'Remova os índices de que nenhuma consulta precisa.',
      },
      unusedIndex: {
        title: 'Índice sem uso',
        found: (v) => `Não é usado desde ${when(v.since!, 'pt')}, quando o servidor começou a contar.`,
        why: () =>
          'Um índice sem uso ainda deixa cada gravação mais lenta e ocupa memória. A contagem recomeça quando o servidor é reiniciado.',
        fix: () =>
          'Se nenhuma consulta precisa dele, exclua-o; antes, oculte-o para ter certeza de que nada fica lento.',
      },
      redundantIndex: {
        title: 'Índice redundante',
        found: (v) => `Suas chaves são o início das chaves de ${v.covered}.`,
        why: (v) =>
          `As consultas que ele atende podem usar ${v.covered}; manter os dois deixa as gravações mais lentas.`,
        fix: () => 'Exclua-o, a menos que outra coisa precise dele (uma dica hint ou uma opção de índice).',
      },
    },
  },
  ko: {
    title: '스키마 상태',
    description: (coll: string) =>
      `${coll} 컬렉션에서 MongoDB 문서에 정의된 스키마 안티패턴을 찾습니다: 무작위 샘플, 도큐먼트 크기, 인덱스. 아무것도 변경하지 않습니다.`,
    descriptionView: (coll: string) =>
      `${coll} 뷰에서 MongoDB 문서에 정의된 스키마 안티패턴을 찾습니다: 무작위 샘플과 도큐먼트 크기. 아무것도 변경하지 않습니다.`,
    check: '점검',
    sampling: '도큐먼트 샘플링 중…',
    measuring: '도큐먼트 크기 측정 중…',
    readingIndexes: '인덱스 읽는 중…',
    noPlace: '점검할 컬렉션을 여세요.',
    failed: '점검을 실행할 수 없습니다',
    tryAgain: '다시 시도',
    sizesFailed: '크기를 측정할 수 없습니다',
    sizesHint: 'MongoDB 4.4 이상에서 측정할 수 있습니다. ',
    indexesFailed: '인덱스를 읽을 수 없습니다',
    severity: { high: '높은 위험', warning: '경고', info: '정보' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `높은 위험 ${f(n, 'ko')}건`
        : s === 'warning'
          ? `경고 ${f(n, 'ko')}건`
          : `정보 ${f(n, 'ko')}건`,
    noProblems: '문제 없음',
    clean: (docs: number) => `샘플링한 도큐먼트 ${f(docs, 'ko')}개에서 문제를 찾지 못했습니다`,
    cleanHint: '크기, 중첩, 배열, 필드 유형, 인덱스 모두 이상 없습니다.',
    cleanHintView: '크기, 중첩, 배열, 필드 유형 모두 이상 없습니다.',
    emptyTitle: '샘플링할 도큐먼트가 없습니다',
    emptyHint: '이 컬렉션은 비어 있습니다. 인덱스는 점검했습니다.',
    emptyHintView: '이 뷰에는 표시할 도큐먼트가 없습니다.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `도큐먼트 ${f(docs, 'ko')}개 샘플링`,
        sized === null ? null : `도큐먼트 ${f(sized, 'ko')}개 크기 측정`,
        indexes === null ? null : `인덱스 ${f(indexes, 'ko')}개`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: '중요한 이유',
    fix: '권장 조치',
    show: '도큐먼트에서 보기',
    showHint: '이 도큐먼트를 선택하는 필터를 도큐먼트 쿼리에 넣습니다',
    showFailed: '도큐먼트를 열 수 없습니다: ',
    limitsTitle: '점검 항목',
    limitsNote: '이 임계값은 이 플러그인 고유의 기준이며, MongoDB 자체 제한은 옆에 함께 표시합니다.',
    limits: [
      `샘플 ${formatNumber(SIZE_SAMPLE, 'ko')}개 중 ${MB(LIMITS.docWarn, 'ko')}(경고) 또는 ${MB(LIMITS.docHigh, 'ko')}(높은 위험)를 넘는 도큐먼트. MongoDB는 16 MB를 넘는 도큐먼트를 거부합니다.`,
      `요소가 ${f(LIMITS.arrayWarn, 'ko')}개(경고) 또는 ${f(LIMITS.arrayHigh, 'ko')}개(높은 위험)를 넘는 배열.`,
      `${f(LIMITS.depthWarn, 'ko')}단계를 넘는 중첩. MongoDB의 제한은 100단계입니다.`,
      `필드가 ${f(LIMITS.fieldsWarn, 'ko')}개를 넘는 도큐먼트.`,
      'null을 제외하고 둘 이상의 유형을 가진 필드.',
      `인덱스가 ${f(LIMITS.indexesWarn, 'ko')}개를 넘는 경우(MongoDB의 제한은 64개), 사용되지 않는 인덱스, 키가 다른 인덱스 키의 앞부분인 인덱스.`,
    ],
    words: {
      largeDocuments: {
        title: '큰 도큐먼트',
        found: (v, x) =>
          `측정한 도큐먼트 중 ${f(v.count, 'ko')}개가 ${sizeLimit(x.severity, 'ko')}를 넘습니다. 가장 큰 도큐먼트는 ${MB(Number(v.max), 'ko')}입니다.`,
        why: () =>
          '모든 읽기와 업데이트는 도큐먼트 전체를 옮깁니다. 큰 도큐먼트는 캐시를 채우고 서버를 느리게 합니다. MongoDB는 16 MB를 넘는 도큐먼트를 거부합니다.',
        fix: () =>
          '계속 커지거나 거의 읽지 않는 부분을 별도 컬렉션으로 옮기세요(서브셋 패턴과 아웃라이어 패턴).',
      },
      largeArray: {
        title: '큰 배열',
        found: (v) => `샘플 도큐먼트 하나에 요소가 최대 ${f(v.length, 'ko')}개 있습니다.`,
        why: () =>
          '계속 커지는 배열은 변경할 때마다 도큐먼트를 무겁게 하고, 배열에 걸린 인덱스도 요소마다 커집니다.',
        fix: () => '배열의 크기를 제한하거나, 요소를 별도 컬렉션으로 옮기고 참조로 연결하세요.',
      },
      deepNesting: {
        title: '깊은 중첩',
        found: (v) => `도큐먼트가 ${f(v.depth, 'ko')}단계까지 중첩되어 있습니다.`,
        why: () => '깊게 중첩된 필드는 쿼리, 업데이트, 인덱싱이 어렵습니다.',
        fix: () => '쿼리에 사용하는 단계를 평탄화하세요.',
      },
      manyFields: {
        title: '필드가 매우 많은 도큐먼트',
        found: (v) => `샘플 도큐먼트 하나에 필드가 ${f(v.fields, 'ko')}개 있습니다.`,
        why: () => '넓은 도큐먼트는 읽기가 느리고, 쿼리에 쓰는 필드마다 별도의 인덱스가 필요합니다.',
        fix: () =>
          '함께 읽는 데이터는 함께 두세요. 비슷한 필드가 많다면 속성 패턴(키-값 쌍의 배열)을 쓰면 인덱스 하나로 충분합니다.',
      },
      mixedTypes: {
        title: '혼합 유형',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${i === 0 ? '샘플 도큐먼트 ' : ''}${f(s.count, 'ko')}개에서 ${s.type}`).join(', ')}.`
            : `이 필드가 가진 유형: ${v.types}.`,
        why: () =>
          '쿼리, 정렬, 인덱스는 유형별로 따로 처리합니다. 숫자로 거는 필터는 텍스트로 저장된 같은 값을 찾지 못합니다.',
        fix: () => '한 가지 유형만 저장하고, 유효성 검사 규칙으로 유지하세요.',
      },
      manyIndexes: {
        title: '인덱스 과다',
        found: (v) =>
          `이 컬렉션에는 인덱스가 ${f(v.count, 'ko')}개 있습니다. MongoDB는 최대 64개까지 허용합니다.`,
        why: () => '인덱스는 모두 쓰기를 느리게 하고 메모리를 차지합니다.',
        fix: () => '어떤 쿼리에도 필요하지 않은 인덱스를 제거하세요.',
      },
      unusedIndex: {
        title: '사용되지 않는 인덱스',
        found: (v) => `서버가 사용 횟수를 세기 시작한 ${when(v.since!, 'ko')} 이후 사용되지 않았습니다.`,
        why: () =>
          '사용되지 않는 인덱스도 모든 쓰기를 느리게 하고 메모리를 차지합니다. 서버를 다시 시작하면 횟수가 처음부터 다시 계산됩니다.',
        fix: () =>
          '어떤 쿼리에도 필요하지 않다면 삭제하세요. 삭제하기 전에 먼저 숨겨서 느려지는 것이 없는지 확인하세요.',
      },
      redundantIndex: {
        title: '중복 인덱스',
        found: (v) => `이 인덱스의 키는 다음 인덱스 키의 앞부분입니다: ${v.covered}.`,
        why: (v) =>
          `이 인덱스가 처리하는 쿼리는 다음 인덱스로도 처리할 수 있습니다: ${v.covered}. 둘 다 유지하면 쓰기가 느려집니다.`,
        fix: () => '다른 용도(hint 또는 인덱스 옵션)에 필요하지 않다면 삭제하세요.',
      },
    },
  },
  de: {
    title: 'Schema-Zustand',
    description: (coll: string) =>
      `Sucht in ${coll} nach den in der MongoDB-Dokumentation beschriebenen Schema-Antipatterns: einer zufälligen Stichprobe, den Dokumentgrößen und den Indizes. Ändert nichts.`,
    descriptionView: (coll: string) =>
      `Sucht in der View ${coll} nach den in der MongoDB-Dokumentation beschriebenen Schema-Antipatterns: einer zufälligen Stichprobe und den Dokumentgrößen. Ändert nichts.`,
    check: 'Prüfen',
    sampling: 'Stichprobe wird gezogen…',
    measuring: 'Dokumentgrößen werden gemessen…',
    readingIndexes: 'Indizes werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um sie zu prüfen.',
    failed: 'Die Prüfung konnte nicht ausgeführt werden',
    tryAgain: 'Erneut versuchen',
    sizesFailed: 'Die Größen konnten nicht gemessen werden',
    sizesHint: 'MongoDB 4.4 oder neuer kann sie messen. ',
    indexesFailed: 'Die Indizes konnten nicht gelesen werden',
    severity: { high: 'Hohes Risiko', warning: 'Warnung', info: 'Info' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'de')} mit hohem Risiko`
        : s === 'warning'
          ? `${f(n, 'de')} ${isOne(n, 'de') ? 'Warnung' : 'Warnungen'}`
          : `${f(n, 'de')} ${isOne(n, 'de') ? 'Info' : 'Infos'}`,
    noProblems: 'Keine Probleme',
    clean: (docs: number) =>
      `Keine Probleme in ${f(docs, 'de')} untersuchten ${isOne(docs, 'de') ? 'Dokument' : 'Dokumenten'} gefunden`,
    cleanHint: 'Größen, Verschachtelung, Arrays, Feldtypen und Indizes sehen gut aus.',
    cleanHintView: 'Größen, Verschachtelung, Arrays und Feldtypen sehen gut aus.',
    emptyTitle: 'Keine Dokumente für die Stichprobe',
    emptyHint: 'Diese Collection ist leer; ihre Indizes wurden geprüft.',
    emptyHintView: 'Diese View zeigt keine Dokumente.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'de')} ${isOne(docs, 'de') ? 'Dokument' : 'Dokumente'} in der Stichprobe`,
        sized === null
          ? null
          : `Größe von ${f(sized, 'de')} ${isOne(sized, 'de') ? 'Dokument' : 'Dokumenten'} gemessen`,
        indexes === null ? null : `${f(indexes, 'de')} ${isOne(indexes, 'de') ? 'Index' : 'Indizes'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Warum das wichtig ist',
    fix: 'Was zu tun ist',
    show: 'In Dokumenten anzeigen',
    showHint: 'Setzt einen Filter, der diese Dokumente auswählt, in die Abfrage von Dokumente',
    showFailed: 'Dokumente konnten nicht geöffnet werden: ',
    limitsTitle: 'Was geprüft wird',
    limitsNote: 'Dies sind die eigenen Schwellenwerte dieses Plugins; die Limits von MongoDB stehen daneben.',
    limits: [
      `Dokumente größer als ${MB(LIMITS.docWarn, 'de')} (Warnung) oder ${MB(LIMITS.docHigh, 'de')} (hohes Risiko), in einer Stichprobe von ${formatNumber(SIZE_SAMPLE, 'de')}; MongoDB lehnt Dokumente über 16 MB ab.`,
      `Arrays mit mehr als ${f(LIMITS.arrayWarn, 'de')} Elementen (Warnung) oder ${f(LIMITS.arrayHigh, 'de')} (hohes Risiko).`,
      `Verschachtelung tiefer als ${f(LIMITS.depthWarn, 'de')} Ebenen; das Limit von MongoDB liegt bei 100.`,
      `Dokumente mit mehr als ${f(LIMITS.fieldsWarn, 'de')} Feldern.`,
      'Ein Feld mit mehr als einem Typ, null ausgenommen.',
      `Mehr als ${f(LIMITS.indexesWarn, 'de')} Indizes (das Limit von MongoDB liegt bei 64), ungenutzte Indizes und Indizes, deren Schlüssel mit denen eines anderen beginnen.`,
    ],
    words: {
      largeDocuments: {
        title: 'Große Dokumente',
        found: (v, x) =>
          `${f(v.count, 'de')} gemessene${isOne(v.count, 'de') ? 's Dokument ist' : ' Dokumente sind'} größer als ${sizeLimit(x.severity, 'de')}; das größte hat ${MB(Number(v.max), 'de')}.`,
        why: () =>
          'Jedes Lesen und Aktualisieren bewegt das gesamte Dokument: Große Dokumente füllen den Cache und verlangsamen den Server. MongoDB lehnt Dokumente über 16 MB ab.',
        fix: () =>
          'Verschieben Sie Teile, die wachsen oder selten gelesen werden, in eine eigene Collection (Subset- und Outlier-Pattern).',
      },
      largeArray: {
        title: 'Großes Array',
        found: (v) => `Bis zu ${f(v.length, 'de')} Elemente in einem Dokument der Stichprobe.`,
        why: () =>
          'Ein Array, das immer weiter wächst, macht sein Dokument mit jeder Änderung schwerer, und ein Index darauf wächst mit jedem Element.',
        fix: () =>
          'Begrenzen Sie das Array, oder legen Sie seine Elemente in einer eigenen Collection mit Rückverweis ab.',
      },
      deepNesting: {
        title: 'Tiefe Verschachtelung',
        found: (v) => `Dokumente sind ${f(v.depth, 'de')} Ebenen tief verschachtelt.`,
        why: () => 'Tief verschachtelte Felder sind schwer abzufragen, zu aktualisieren und zu indizieren.',
        fix: () => 'Flachen Sie die Ebenen ab, nach denen Sie abfragen.',
      },
      manyFields: {
        title: 'Dokumente mit sehr vielen Feldern',
        found: (v) => `Ein Dokument der Stichprobe hat ${f(v.fields, 'de')} Felder.`,
        why: () =>
          'Breite Dokumente sind langsam zu lesen, und jedes Feld, nach dem Sie abfragen, braucht einen eigenen Index.',
        fix: () =>
          'Halten Sie zusammen, was zusammen gelesen wird. Bei vielen ähnlichen Feldern wird das Attribute-Pattern (ein Array aus Schlüssel-Wert-Paaren) nur einmal indiziert.',
      },
      mixedTypes: {
        title: 'Gemischte Typen',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${s.type} in ${f(s.count, 'de')}${i === 0 ? ` ${isOne(s.count, 'de') ? 'Dokument' : 'Dokumenten'} der Stichprobe` : ''}`).join(', ')}.`
            : `Dieses Feld enthält ${v.types}.`,
        why: () =>
          'Abfragen, Sortierungen und Indizes behandeln jeden Typ getrennt: Ein Filter auf eine Zahl übersieht denselben Wert, der als Text gespeichert ist.',
        fix: () => 'Speichern Sie einen einzigen Typ und sichern Sie das mit einer Validierungsregel ab.',
      },
      manyIndexes: {
        title: 'Viele Indizes',
        found: (v) => `Diese Collection hat ${f(v.count, 'de')} Indizes; MongoDB erlaubt 64.`,
        why: () => 'Jeder Index verlangsamt Schreibvorgänge und belegt Speicher.',
        fix: () => 'Entfernen Sie die Indizes, die keine Abfrage benötigt.',
      },
      unusedIndex: {
        title: 'Ungenutzter Index',
        found: (v) => `Nicht verwendet seit ${when(v.since!, 'de')}, als der Server begann zu zählen.`,
        why: () =>
          'Auch ein ungenutzter Index verlangsamt jeden Schreibvorgang und belegt Speicher. Die Zählung beginnt neu, wenn der Server neu startet.',
        fix: () =>
          'Wenn keine Abfrage ihn benötigt, verwerfen Sie ihn; blenden Sie ihn zuvor aus, um sicherzugehen, dass nichts langsamer wird.',
      },
      redundantIndex: {
        title: 'Redundanter Index',
        found: (v) => `Seine Schlüssel sind der Anfang der Schlüssel von ${v.covered}.`,
        why: (v) =>
          `Die Abfragen, die er bedient, können ${v.covered} verwenden; beide zu behalten verlangsamt Schreibvorgänge.`,
        fix: () =>
          'Verwerfen Sie ihn, es sei denn, etwas anderes braucht ihn (ein Hint oder eine Indexoption).',
      },
    },
  },
  fr: {
    title: 'Santé du schéma',
    description: (coll: string) =>
      `Recherche dans ${coll} les antipatrons de schéma décrits dans la documentation de MongoDB : un échantillon aléatoire, la taille des documents et les index. Ne modifie rien.`,
    descriptionView: (coll: string) =>
      `Recherche dans la vue ${coll} les antipatrons de schéma décrits dans la documentation de MongoDB : un échantillon aléatoire et la taille des documents. Ne modifie rien.`,
    check: 'Vérifier',
    sampling: 'Échantillonnage des documents…',
    measuring: 'Mesure de la taille des documents…',
    readingIndexes: 'Lecture des index…',
    noPlace: 'Ouvrez une collection pour la vérifier.',
    failed: 'La vérification n’a pas pu s’exécuter',
    tryAgain: 'Réessayer',
    sizesFailed: 'Les tailles n’ont pas pu être mesurées',
    sizesHint: 'MongoDB 4.4 ou une version ultérieure peut les mesurer. ',
    indexesFailed: 'Les index n’ont pas pu être lus',
    severity: { high: 'Risque élevé', warning: 'Avertissement', info: 'Info' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `${f(n, 'fr')} à risque élevé`
        : s === 'warning'
          ? `${f(n, 'fr')} ${isOne(n, 'fr') ? 'avertissement' : 'avertissements'}`
          : `${f(n, 'fr')} info`,
    noProblems: 'Aucun problème',
    clean: (docs: number) =>
      `Aucun problème trouvé dans ${f(docs, 'fr')} ${isOne(docs, 'fr') ? 'document échantillonné' : 'documents échantillonnés'}`,
    cleanHint: 'Les tailles, l’imbrication, les tableaux, les types de champ et les index semblent corrects.',
    cleanHintView: 'Les tailles, l’imbrication, les tableaux et les types de champ semblent corrects.',
    emptyTitle: 'Aucun document à échantillonner',
    emptyHint: 'Cette collection est vide ; ses index ont été vérifiés.',
    emptyHintView: 'Cette vue n’affiche aucun document.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `${f(docs, 'fr')} ${isOne(docs, 'fr') ? 'document échantillonné' : 'documents échantillonnés'}`,
        sized === null
          ? null
          : `taille mesurée pour ${f(sized, 'fr')} ${isOne(sized, 'fr') ? 'document' : 'documents'}`,
        indexes === null ? null : `${f(indexes, 'fr')} index`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Pourquoi c’est important',
    fix: 'Que faire',
    show: 'Afficher dans Documents',
    showHint: 'Place dans la requête de Documents un filtre qui sélectionne ces documents',
    showFailed: 'Impossible d’ouvrir Documents : ',
    limitsTitle: 'Ce qui est vérifié',
    limitsNote: 'Ces seuils sont propres à ce plugin ; les limites de MongoDB sont indiquées à côté.',
    limits: [
      `Documents de plus de ${MB(LIMITS.docWarn, 'fr')} (avertissement) ou de plus de ${MB(LIMITS.docHigh, 'fr')} (risque élevé), sur un échantillon de ${formatNumber(SIZE_SAMPLE, 'fr')} ; MongoDB refuse les documents de plus de 16 MB.`,
      `Tableaux de plus de ${f(LIMITS.arrayWarn, 'fr')} éléments (avertissement) ou de plus de ${f(LIMITS.arrayHigh, 'fr')} (risque élevé).`,
      `Imbrication de plus de ${f(LIMITS.depthWarn, 'fr')} niveaux ; la limite de MongoDB est de 100.`,
      `Documents de plus de ${f(LIMITS.fieldsWarn, 'fr')} champs.`,
      'Champ contenant plus d’un type, null mis à part.',
      `Plus de ${f(LIMITS.indexesWarn, 'fr')} index (la limite de MongoDB est de 64), index inutilisés et index dont les clés commencent celles d’un autre.`,
    ],
    words: {
      largeDocuments: {
        title: 'Documents volumineux',
        found: (v, x) =>
          `${f(v.count, 'fr')} ${isOne(v.count, 'fr') ? 'document mesuré dépasse' : 'documents mesurés dépassent'} ${sizeLimit(x.severity, 'fr')} ; le plus volumineux fait ${MB(Number(v.max), 'fr')}.`,
        why: () =>
          'Chaque lecture et chaque mise à jour déplace le document entier : les gros documents remplissent le cache et ralentissent le serveur. MongoDB refuse un document de plus de 16 MB.',
        fix: () =>
          'Déplacez les parties qui grossissent, ou qui sont rarement lues, vers leur propre collection (les modèles subset et outlier).',
      },
      largeArray: {
        title: 'Grand tableau',
        found: (v) => `Jusqu’à ${f(v.length, 'fr')} éléments dans un document de l’échantillon.`,
        why: () =>
          'Un tableau qui ne cesse de grossir alourdit son document à chaque modification, et un index sur ce tableau grossit avec chaque élément.',
        fix: () =>
          'Gardez le tableau borné, ou donnez à ses éléments leur propre collection avec une référence en retour.',
      },
      deepNesting: {
        title: 'Imbrication profonde',
        found: (v) => `Les documents sont imbriqués sur ${f(v.depth, 'fr')} niveaux.`,
        why: () => 'Les champs très imbriqués sont difficiles à interroger, à mettre à jour et à indexer.',
        fix: () => 'Aplatissez les niveaux sur lesquels vous faites vos requêtes.',
      },
      manyFields: {
        title: 'Documents comptant de très nombreux champs',
        found: (v) => `Un document de l’échantillon compte ${f(v.fields, 'fr')} champs.`,
        why: () =>
          'Les documents larges sont lents à lire, et chaque champ interrogé a besoin de son propre index.',
        fix: () =>
          'Gardez ensemble ce qui est lu ensemble. Pour de nombreux champs similaires, le modèle attribute (un tableau de paires clé-valeur) s’indexe une seule fois.',
      },
      mixedTypes: {
        title: 'Types mélangés',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s, i) => `${s.type} dans ${f(s.count, 'fr')}${i === 0 ? ` ${isOne(s.count, 'fr') ? 'document échantillonné' : 'documents échantillonnés'}` : ''}`).join(', ')}.`
            : `Ce champ contient ${v.types}.`,
        why: () =>
          'Les requêtes, les tris et les index traitent chaque type séparément : un filtre sur un nombre manque la même valeur stockée sous forme de texte.',
        fix: () => 'Stockez un seul type et maintenez-le avec une règle de validation.',
      },
      manyIndexes: {
        title: 'Trop d’index',
        found: (v) => `Cette collection compte ${f(v.count, 'fr')} index ; MongoDB en autorise 64.`,
        why: () => 'Chaque index ralentit les écritures et occupe de la mémoire.',
        fix: () => 'Supprimez les index dont aucune requête n’a besoin.',
      },
      unusedIndex: {
        title: 'Index inutilisé',
        found: (v) =>
          `Inutilisé depuis le ${when(v.since!, 'fr')}, date à laquelle le serveur a commencé à compter.`,
        why: () =>
          'Un index inutilisé ralentit tout de même chaque écriture et occupe de la mémoire. Le décompte repart de zéro au redémarrage du serveur.',
        fix: () =>
          'Si aucune requête n’en a besoin, supprimez-le ; masquez-le d’abord pour vous assurer que rien ne ralentit.',
      },
      redundantIndex: {
        title: 'Index redondant',
        found: (v) => `Ses clés sont le début des clés de ${v.covered}.`,
        why: (v) =>
          `Les requêtes qu’il dessert peuvent utiliser ${v.covered} ; garder les deux ralentit les écritures.`,
        fix: () => 'Supprimez-le, sauf si autre chose en a besoin (un hint ou une option d’index).',
      },
    },
  },
  ru: {
    title: 'Состояние схемы',
    description: (coll: string) =>
      `Ищет в коллекции ${coll} антипаттерны схемы, описанные в документации MongoDB: случайная выборка, размеры документов и индексы. Ничего не изменяет.`,
    descriptionView: (coll: string) =>
      `Ищет в представлении ${coll} антипаттерны схемы, описанные в документации MongoDB: случайная выборка и размеры документов. Ничего не изменяет.`,
    check: 'Проверить',
    sampling: 'Формирование выборки документов…',
    measuring: 'Измерение размеров документов…',
    readingIndexes: 'Чтение индексов…',
    noPlace: 'Откройте коллекцию, чтобы проверить ее.',
    failed: 'Не удалось выполнить проверку',
    tryAgain: 'Повторить',
    sizesFailed: 'Не удалось измерить размеры',
    sizesHint: 'Измерить их может MongoDB 4.4 или новее. ',
    indexesFailed: 'Не удалось прочитать индексы',
    severity: { high: 'Высокий риск', warning: 'Предупреждение', info: 'Информация' },
    count: (n: number, s: Severity) =>
      s === 'high'
        ? `Высокий риск: ${f(n, 'ru')}`
        : s === 'warning'
          ? `Предупреждения: ${f(n, 'ru')}`
          : `Информация: ${f(n, 'ru')}`,
    noProblems: 'Проблем нет',
    clean: (docs: number) =>
      `Проблем не найдено в выборке из ${f(docs, 'ru')} ${ruPlural(docs, 'документа', 'документов', 'документов')}`,
    cleanHint: 'Размеры, вложенность, массивы, типы полей и индексы в порядке.',
    cleanHintView: 'Размеры, вложенность, массивы и типы полей в порядке.',
    emptyTitle: 'Нет документов для выборки',
    emptyHint: 'Эта коллекция пуста; ее индексы проверены.',
    emptyHintView: 'Это представление не содержит документов.',
    checked: (docs: number, sized: number | null, indexes: number | null) =>
      [
        `в выборке ${f(docs, 'ru')} ${ruPlural(docs, 'документ', 'документа', 'документов')}`,
        sized === null
          ? null
          : `размер измерен у ${f(sized, 'ru')} ${ruPlural(sized, 'документа', 'документов', 'документов')}`,
        indexes === null ? null : `${f(indexes, 'ru')} ${ruPlural(indexes, 'индекс', 'индекса', 'индексов')}`,
      ]
        .filter(Boolean)
        .join(' · '),
    why: 'Почему это важно',
    fix: 'Что делать',
    show: 'Показать в «Документах»',
    showHint: 'Помещает в запрос на вкладке «Документы» фильтр, выбирающий эти документы',
    showFailed: 'Не удалось открыть «Документы»: ',
    limitsTitle: 'Что проверяется',
    limitsNote: 'Это собственные пороги плагина; рядом указаны ограничения самой MongoDB.',
    limits: [
      `Документы больше ${MB(LIMITS.docWarn, 'ru')} (предупреждение) или ${MB(LIMITS.docHigh, 'ru')} (высокий риск) в выборке из ${formatNumber(SIZE_SAMPLE, 'ru')} ${ruPlural(SIZE_SAMPLE, 'документа', 'документов', 'документов')}; MongoDB отклоняет документы больше 16 MB.`,
      `Массивы из более чем ${f(LIMITS.arrayWarn, 'ru')} ${ruPlural(LIMITS.arrayWarn, 'элемента', 'элементов', 'элементов')} (предупреждение) или ${f(LIMITS.arrayHigh, 'ru')} (высокий риск).`,
      `Вложенность глубже ${f(LIMITS.depthWarn, 'ru')} ${ruPlural(LIMITS.depthWarn, 'уровня', 'уровней', 'уровней')}; ограничение MongoDB — 100.`,
      `Документы с более чем ${f(LIMITS.fieldsWarn, 'ru')} ${ruPlural(LIMITS.fieldsWarn, 'поля', 'полей', 'полей')}.`,
      'Поле, содержащее более одного типа, не считая null.',
      `Более ${f(LIMITS.indexesWarn, 'ru')} ${ruPlural(LIMITS.indexesWarn, 'индекса', 'индексов', 'индексов')} (ограничение MongoDB — 64), неиспользуемые индексы и индексы, ключи которых начинаются с ключей другого.`,
    ],
    words: {
      largeDocuments: {
        title: 'Большие документы',
        found: (v, x) =>
          `${f(v.count, 'ru')} ${ruPlural(Number(v.count), 'измеренный документ превышает', 'измеренных документа превышают', 'измеренных документов превышают')} ${sizeLimit(x.severity, 'ru')}; самый большой — ${MB(Number(v.max), 'ru')}.`,
        why: () =>
          'Каждое чтение и обновление перемещает документ целиком: большие документы заполняют кэш и замедляют сервер. MongoDB отклоняет документы больше 16 MB.',
        fix: () =>
          'Вынесите части, которые растут или редко читаются, в отдельную коллекцию (шаблоны subset и outlier).',
      },
      largeArray: {
        title: 'Большой массив',
        found: (v) =>
          `До ${f(v.length, 'ru')} ${ruPlural(Number(v.length), 'элемента', 'элементов', 'элементов')} в одном документе выборки.`,
        why: () =>
          'Постоянно растущий массив делает документ тяжелее с каждым изменением, а индекс по нему растет с каждым элементом.',
        fix: () =>
          'Ограничьте размер массива или вынесите его элементы в отдельную коллекцию со ссылкой обратно.',
      },
      deepNesting: {
        title: 'Глубокая вложенность',
        found: (v) =>
          `Документы вложены на ${f(v.depth, 'ru')} ${ruPlural(Number(v.depth), 'уровень', 'уровня', 'уровней')}.`,
        why: () => 'Глубоко вложенные поля трудно запрашивать, обновлять и индексировать.',
        fix: () => 'Сделайте плоскими уровни, по которым вы выполняете запросы.',
      },
      manyFields: {
        title: 'Документы с очень большим числом полей',
        found: (v) =>
          `В одном документе выборки ${f(v.fields, 'ru')} ${ruPlural(Number(v.fields), 'поле', 'поля', 'полей')}.`,
        why: () =>
          'Широкие документы медленно читаются, а каждому полю, по которому выполняются запросы, нужен отдельный индекс.',
        fix: () =>
          'Храните вместе то, что читается вместе. Для множества похожих полей шаблон attribute (массив пар «ключ — значение») индексируется один раз.',
      },
      mixedTypes: {
        title: 'Смешанные типы',
        found: (v, x) =>
          x.shares.length > 1
            ? `${x.shares.map((s) => `${s.type} в ${f(s.count, 'ru')} ${ruPlural(s.count, 'документе', 'документах', 'документах')}`).join(', ')}.`
            : `Это поле содержит: ${v.types}.`,
        why: () =>
          'Запросы, сортировки и индексы обрабатывают каждый тип отдельно: фильтр по числу не найдет то же значение, сохраненное как текст.',
        fix: () => 'Храните один тип и поддерживайте это правилом валидации.',
      },
      manyIndexes: {
        title: 'Слишком много индексов',
        found: (v) =>
          `В этой коллекции ${f(v.count, 'ru')} ${ruPlural(Number(v.count), 'индекс', 'индекса', 'индексов')}; MongoDB допускает 64.`,
        why: () => 'Каждый индекс замедляет запись и занимает память.',
        fix: () => 'Удалите индексы, которые не нужны ни одному запросу.',
      },
      unusedIndex: {
        title: 'Неиспользуемый индекс',
        found: (v) => `Не использовался с ${when(v.since!, 'ru')}, когда сервер начал вести подсчет.`,
        why: () =>
          'Неиспользуемый индекс все равно замедляет каждую запись и занимает память. Подсчет начинается заново при перезапуске сервера.',
        fix: () =>
          'Если он не нужен ни одному запросу, удалите его; сначала скройте его, чтобы убедиться, что ничего не замедлится.',
      },
      redundantIndex: {
        title: 'Избыточный индекс',
        found: (v) => `Его ключи — начало ключей индекса ${v.covered}.`,
        why: (v) =>
          `Запросы, которые он обслуживает, могут использовать ${v.covered}; хранение обоих замедляет запись.`,
        fix: () => 'Удалите его, если он не нужен для чего-то еще (подсказка hint или параметр индекса).',
      },
    },
  },
} satisfies Record<Language, Text>

/** What one check found, kept to show again in another language. */
interface Result {
  findings: Finding[]
  survey: Survey
  docs: number
  sized: number | null
  indexes: number | null
  /** Kept as they came, put in words when shown: a language change re-words them. */
  sizesError: unknown
  indexesError: unknown
}
type Step = 'sampling' | 'measuring' | 'readingIndexes'
type State =
  | { kind: 'idle' }
  | { kind: 'running'; step: Step }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; result: Result }

/** The field (or index) a finding is about, as its title shows it in mono. */
function subjectOf(f: Finding): string | null {
  if (f.path) return f.path
  if (typeof f.values.index === 'string') return f.values.index
  return null
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  let showError: unknown = null

  // ---- the page
  const checkButton = button({ label: text.check, icon: 'play', variant: 'primary', id: 'check' })
  const header = pageHeader({ icon: 'activity', title: text.title, description: '', actions: [checkButton] })
  const summary = h('div', { id: 'summary', class: 'sh-counts' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'sh-notes' })
  const results = h('div', { id: 'findings', class: 'sh-findings' })
  const limitsTitle = h('span')
  const limitsNote = h('p', { class: 'mm-status' })
  const limits = h('ul', { class: 'sh-limits' })
  const details = h(
    'details',
    { class: 'mm-details sh-thresholds' },
    h('summary', {}, icon('chevronRight', 14), limitsTitle),
    h('div', { class: 'mm-details-body' }, limitsNote, limits),
  )
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h(
        'div',
        { class: 'mm-body' },
        h('div', { class: 'mm-summary' }, summary, status),
        notes,
        results,
        details,
      ),
    ),
  )

  const wordsOf = (id: string): Words | undefined =>
    Object.entries(text.words).find(([key]) => key === id)?.[1]
  const number = (n: number) => formatNumber(n, shown(TEXT, locale))

  function applyText(): void {
    // A view has no indexes of its own: nothing said about them there (review M2).
    header.setText(
      text.title,
      (ctx?.place?.view ? text.descriptionView : text.description)(ctx?.place?.coll ?? ''),
    )
    setLabel(checkButton, text.check)
    limitsTitle.textContent = text.limitsTitle
    limitsNote.textContent = text.limitsNote
    limits.replaceChildren(
      // The last line is about indexes: a view has none of its own.
      ...(ctx?.place?.view ? text.limits.slice(0, -1) : text.limits).map((l) => h('li', { text: l })),
    )
  }

  function render(): void {
    summary.replaceChildren()
    notes.replaceChildren()
    status.textContent = ''
    // Before the app has said where this is, there is nothing to say yet.
    if (!ctx) return
    if (!ctx.place) {
      results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
      return
    }
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = text[state.step]
      return void results.replaceChildren(skeleton(4))
    }
    if (state.kind === 'failed') {
      const again = button({ label: text.tryAgain, icon: 'play', onClick: () => void check() })
      results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: askMessage(state.error, locale),
          action: again,
        }),
      )
      return
    }
    const r = state.result
    status.textContent = text.checked(r.docs, r.sized, r.indexes)
    if (r.sizesError !== null)
      notes.append(
        callout('warning', text.sizesFailed, `${text.sizesHint}${askMessage(r.sizesError, locale)}`),
      )
    if (r.indexesError !== null)
      notes.append(callout('warning', text.indexesFailed, askMessage(r.indexesError, locale)))
    if (showError !== null)
      notes.append(callout('danger', `${text.showFailed}${askMessage(showError, locale)}`))
    const findings = r.findings.filter((f) => wordsOf(f.id))
    if (!findings.length) {
      summary.append(badge(text.noProblems, 'success'))
      results.replaceChildren(
        r.docs
          ? emptyState({
              icon: 'ok',
              tone: 'success',
              title: text.clean(r.docs),
              hint: ctx?.place?.view ? text.cleanHintView : text.cleanHint,
            })
          : emptyState({
              icon: 'database',
              title: text.emptyTitle,
              hint: ctx?.place?.view ? text.emptyHintView : text.emptyHint,
            }),
      )
      return
    }
    const groups: HTMLElement[] = []
    for (const severity of SEVERITIES) {
      const these = findings.filter((f) => f.severity === severity)
      if (!these.length) continue
      summary.append(badge(text.count(these.length, severity), TONE[severity]))
      groups.push(
        h(
          'section',
          {
            class: 'sh-group',
            data: { severityGroup: severity },
            attrs: { 'aria-label': text.severity[severity] },
          },
          h(
            'h2',
            { class: 'mm-section-title sh-group-title' },
            text.severity[severity],
            h('span', { class: 'sh-group-count', text: number(these.length) }),
          ),
          ...these.map((f) => card(f, r.survey)),
        ),
      )
    }
    results.replaceChildren(...groups)
  }

  function card(f: Finding, survey: Survey): HTMLElement {
    const words = wordsOf(f.id)!
    const subject = subjectOf(f)
    const filter = showFilter(f, survey)
    const shares = f.id === 'mixedTypes' && f.path ? typeShares(survey, f.path) : []
    const show = filter
      ? button({
          label: text.show,
          icon: 'filter',
          size: 'sm',
          title: text.showHint,
          onClick: () => {
            const run = running
            void client.ask('ui.useQuery', { filter }).then(
              () => {
                if (run !== running || showError === null) return
                showError = null
                render()
              },
              (e: unknown) => {
                // A failure about a check since replaced says nothing.
                if (run !== running) return
                showError = e
                render()
              },
            )
          },
        })
      : null
    show?.setAttribute('data-show', '')
    return h(
      'article',
      { class: `mm-card sh-card sh-${TONE[f.severity]}`, data: { finding: f.id, severity: f.severity } },
      h(
        'div',
        { class: 'sh-card-head' },
        h('span', { class: 'sh-sev-icon' }, icon(SEVERITY_ICON[f.severity], 16)),
        h(
          'h3',
          { class: 'sh-title' },
          h('span', { text: words.title }),
          subject ? h('code', { class: 'mm-mono sh-field', title: subject, text: subject }) : null,
        ),
        badge(text.severity[f.severity], TONE[f.severity]),
      ),
      h('p', { class: 'sh-found', text: words.found(f.values, { shares, severity: f.severity }) }),
      h(
        'dl',
        { class: 'sh-explain' },
        h('div', {}, h('dt', { text: text.why }), h('dd', { text: words.why(f.values) })),
        h('div', {}, h('dt', { text: text.fix }), h('dd', { text: words.fix(f.values) })),
      ),
      show ? h('div', { class: 'sh-card-actions' }, show) : null,
    )
  }

  async function check(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    showError = null
    setBusy(checkButton, true)
    // What it is reading, kept so a language change says it again in the new language.
    const step = (now: Step) => {
      if (run !== running) return
      state = { kind: 'running', step: now }
      render()
    }
    step('sampling')
    try {
      const sample = await client.ask<{ documents: Doc[] }>('documents.aggregate', {
        pipeline: [{ $sample: { size: { $numberInt: String(SAMPLE) } } }],
        limit: SAMPLE,
      })
      if (run !== running) return
      const survey = surveySample(sample.documents)
      const findings = surveyFindings(survey)
      let sized: number | null = null
      let sizesError: unknown = null
      step('measuring')
      try {
        const sizes = await client.ask<{ documents: Doc[] }>('documents.aggregate', {
          pipeline: sizePipeline(SIZE_SAMPLE),
          limit: 1,
        })
        const totals = sizes.documents[0] ?? null
        sized = totals ? (numberOf(totals.count) ?? 0) : 0
        findings.push(...sizeFindings(totals))
      } catch (e) {
        sizesError = e
      }
      if (run !== running) return
      let indexes: number | null = null
      let indexesError: unknown = null
      // A view has no indexes of its own (user request 2026-10-10): none read, none counted.
      if (!ctx?.place?.view) {
        step('readingIndexes')
        try {
          const found = await client.ask<IndexInfo[]>('indexes.list')
          indexes = found.length
          findings.push(...indexFindings(found))
        } catch (e) {
          indexesError = e
        }
      }
      if (run !== running) return
      state = {
        kind: 'done',
        result: {
          findings: sortFindings(findings),
          survey,
          docs: sample.documents.length,
          sized,
          indexes,
          sizesError,
          indexesError,
        },
      }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
    }
    setBusy(checkButton, false)
    render()
  }

  checkButton.addEventListener('click', () => void check())

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) {
      checkButton.disabled = true
      render()
      return
    }
    // Every read is bounded (a sample, a measured sample, the index list): it runs on opening.
    void check()
  })
  applyText()
}
