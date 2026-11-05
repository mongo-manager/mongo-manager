// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  chip,
  emptyState,
  formatNumber,
  h,
  langTag,
  pick,
  pluralOf,
  shown,
  type Language,
  pageHeader,
  setBusy,
  skeleton,
  statusLine,
  valueView,
  type Tone,
} from '../../kit/src/ui'
import { shapeOf } from '../../kit/src/shape'
import {
  MAX_FIELDS,
  candidateFields,
  createIndexText,
  keyObject,
  keyProblem,
  keyText,
  topShare,
  verdictsOf,
  type Analysis,
  type KeyField,
  type KeyProblem,
  type Verdict,
} from './analysis'

/**
 * Plugins wave 4 (spec §4): candidate shard keys for the tab's collection, each analysed by
 * MongoDB's `analyzeShardKey` (7.0 and later, through the app, as the user) and set side by side
 * with what makes a key good: many distinct values, none held by many documents, not growing.
 */
const SAMPLE = 200
const MAX_CANDIDATES = 6
const COMMON_SHOWN = 5

export const TEXT = {
  en: {
    title: 'Shard key',
    description: (coll: string) =>
      `Candidate shard keys for ${coll}, compared by what MongoDB’s analyzeShardKey says of them.`,
    reading: 'Reading the fields…',
    noPlace: 'Open a collection to analyse its candidate shard keys.',
    view: 'A view cannot be sharded: open its collection.',
    failed: 'The documents could not be read: ',
    guide:
      'A good shard key has many distinct values, none of them held by a large share of the documents, and does not grow with each insert — or is hashed, which spreads a growing value. MongoDB samples up to 10,000 documents for each candidate; an index must start with the key.',
    build: 'Candidate',
    field: 'Field',
    kind: 'Order',
    kinds: { asc: 'Ascending', hashed: 'Hashed' },
    addField: 'Add field',
    removeField: (f: string) => `Remove ${f}`,
    noField: 'Add the fields of a candidate key.',
    analyze: 'Analyse',
    analyzing: 'Analysing…',
    problems: {
      empty: 'Add a field first.',
      unknown: 'A field here is not one of the collection’s.',
      twice: 'A field is in the key twice.',
      hashed: 'A shard key may hold one hashed field at most.',
      tooMany: `A candidate holds at most ${MAX_FIELDS} fields.`,
    } satisfies Record<KeyProblem, string>,
    already: 'This key is analysed already.',
    full: `At most ${MAX_CANDIDATES} candidates: remove one first.`,
    remove: (k: string) => `Remove ${k}`,
    metrics: {
      overall: 'Verdict',
      distinct: 'Distinct values',
      frequency: 'Most common value',
      monotonicity: 'Monotonicity',
      unique: 'Unique',
      sampled: 'Documents sampled',
      size: 'Average document',
      common: 'Most common values',
    },
    verdicts: { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Not known' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `held by ${p} of the documents`,
    monotonic: 'Grows with each insert',
    notMonotonic: 'Does not grow',
    hashedSpread: 'Hashed: spread evenly',
    unknown: 'Not known',
    yes: 'Yes',
    no: 'No',
    sampledOf: (n: string, of: string) => `${n} of ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) => `${n} ${plural === 'one' ? 'byte' : 'bytes'}`,
    reasons: {
      standalone: 'analyzeShardKey needs a replica set or a sharded cluster: this server is standalone.',
      version: 'analyzeShardKey needs MongoDB 7.0 or later.',
      no_index: 'No index starts with this key, and analyzeShardKey needs one. Create it first:',
    },
    copy: 'Copy',
  },
  tr: {
    title: 'Parça anahtarı',
    description: (coll: string) =>
      `${coll} için aday parça anahtarları, MongoDB’nin analyzeShardKey komutunun söylediklerine göre karşılaştırılır.`,
    reading: 'Alanlar okunuyor…',
    noPlace: 'Aday parça anahtarlarını çözümlemek için bir koleksiyon aç.',
    view: 'Bir görünüm parçalanamaz: koleksiyonunu aç.',
    failed: 'Belgeler okunamadı: ',
    guide:
      'İyi bir parça anahtarının çok sayıda farklı değeri olur, bunların hiçbiri belgelerin büyük bir payında bulunmaz ve her eklemeyle büyümez — ya da hash’lenmiştir; bu da büyüyen bir değeri dağıtır. MongoDB her aday için en fazla 10.000 belge örnekler; bir indeksin anahtarla başlaması gerekir.',
    build: 'Aday',
    field: 'Alan',
    kind: 'Sıra',
    kinds: { asc: 'Artan', hashed: 'Hash' },
    addField: 'Alan ekle',
    removeField: (f: string) => `${f} alanını kaldır`,
    noField: 'Aday anahtarın alanlarını ekle.',
    analyze: 'Çözümle',
    analyzing: 'Çözümleniyor…',
    problems: {
      empty: 'Önce bir alan ekle.',
      unknown: 'Buradaki bir alan koleksiyonun alanlarından değil.',
      twice: 'Bir alan anahtarda iki kez var.',
      hashed: 'Bir parça anahtarında en fazla bir hash alan olabilir.',
      tooMany: `Bir aday en fazla ${MAX_FIELDS} alan tutar.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Bu anahtar zaten çözümlendi.',
    full: `En fazla ${MAX_CANDIDATES} aday: önce birini kaldır.`,
    remove: (k: string) => `${k} adayını kaldır`,
    metrics: {
      overall: 'Sonuç',
      distinct: 'Farklı değerler',
      frequency: 'En sık değer',
      monotonicity: 'Monotonluk',
      unique: 'Benzersiz',
      sampled: 'Örneklenen belgeler',
      size: 'Ortalama belge',
      common: 'En sık değerler',
    },
    verdicts: { good: 'İyi', fair: 'Orta', poor: 'Zayıf', unknown: 'Bilinmiyor' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `belgelerin ${p} kadarında`,
    monotonic: 'Her eklemeyle büyüyor',
    notMonotonic: 'Büyümüyor',
    hashedSpread: 'Hash: eşit dağılır',
    unknown: 'Bilinmiyor',
    yes: 'Evet',
    no: 'Hayır',
    sampledOf: (n: string, of: string) => `${of} belgenin ${n} tanesi`,
    bytes: (n: string, _plural: Intl.LDMLPluralRule) => `${n} bayt`,
    reasons: {
      standalone: 'analyzeShardKey bir replica set ya da parçalı küme ister: bu sunucu tek başına çalışıyor.',
      version: 'analyzeShardKey MongoDB 7.0 ya da sonrasını ister.',
      no_index: 'Bu anahtarla başlayan bir indeks yok ve analyzeShardKey bir tane ister. Önce onu oluştur:',
    },
    copy: 'Kopyala',
  },
  zh: {
    title: '分片键',
    description: (coll: string) =>
      `${coll} 的候选分片键，依据 MongoDB 的 analyzeShardKey 给出的结果进行比较。`,
    reading: '正在读取字段…',
    noPlace: '打开一个集合，分析其候选分片键。',
    view: '视图无法分片：请打开其集合。',
    failed: '无法读取文档：',
    guide:
      '好的分片键具有大量不同的值，没有任何一个值被大量文档持有，并且不会随每次插入而增长——或者经过哈希处理，从而分散增长的值。MongoDB 会为每个候选键采样最多 10,000 个文档；必须有一个以该键开头的索引。',
    build: '候选键',
    field: '字段',
    kind: '顺序',
    kinds: { asc: '升序', hashed: '哈希' },
    addField: '添加字段',
    removeField: (f: string) => `移除 ${f}`,
    noField: '添加候选键的字段。',
    analyze: '分析',
    analyzing: '正在分析…',
    problems: {
      empty: '请先添加字段。',
      unknown: '此处的某个字段不属于该集合。',
      twice: '键中有字段出现了两次。',
      hashed: '分片键最多只能包含一个哈希字段。',
      tooMany: `候选键最多包含 ${MAX_FIELDS} 个字段。`,
    } satisfies Record<KeyProblem, string>,
    already: '此键已分析过。',
    full: `最多 ${MAX_CANDIDATES} 个候选键：请先移除一个。`,
    remove: (k: string) => `移除 ${k}`,
    metrics: {
      overall: '结论',
      distinct: '不同的值',
      frequency: '最常见的值',
      monotonicity: '单调性',
      unique: '唯一',
      sampled: '已采样文档',
      size: '平均文档大小',
      common: '最常见的值列表',
    },
    verdicts: { good: '良好', fair: '一般', poor: '较差', unknown: '未知' } satisfies Record<Verdict, string>,
    ofDocs: (p: string) => `被 ${p} 的文档持有`,
    monotonic: '随每次插入而增长',
    notMonotonic: '不增长',
    hashedSpread: '哈希：均匀分布',
    unknown: '未知',
    yes: '是',
    no: '否',
    sampledOf: (n: string, of: string) => `${n} / ${of}`,
    bytes: (n: string, _plural: Intl.LDMLPluralRule) => `${n} 字节`,
    reasons: {
      standalone: 'analyzeShardKey 需要副本集或分片集群：此服务器是单机部署。',
      version: 'analyzeShardKey 需要 MongoDB 7.0 或更高版本。',
      no_index: '没有以此键开头的索引，而 analyzeShardKey 需要一个。请先创建：',
    },
    copy: '复制',
  },
  ja: {
    title: 'シャードキー',
    description: (coll: string) =>
      `${coll} のシャードキー候補を、MongoDB の analyzeShardKey の結果に基づいて比較します。`,
    reading: 'フィールドを読み込み中…',
    noPlace: 'コレクションを開くと、シャードキー候補を分析できます。',
    view: 'ビューはシャーディングできません。元のコレクションを開いてください。',
    failed: 'ドキュメントを読み込めませんでした: ',
    guide:
      '優れたシャードキーは、値の種類が多く、特定の値が多くのドキュメントに偏らず、挿入のたびに増加しません。ハッシュ化すれば、増加する値も分散できます。MongoDB は候補ごとに最大 10,000 件のドキュメントをサンプリングします。キーで始まるインデックスが必要です。',
    build: '候補',
    field: 'フィールド',
    kind: '順序',
    kinds: { asc: '昇順', hashed: 'ハッシュ' },
    addField: 'フィールドを追加',
    removeField: (f: string) => `${f} を削除`,
    noField: '候補キーのフィールドを追加してください。',
    analyze: '分析',
    analyzing: '分析中…',
    problems: {
      empty: '先にフィールドを追加してください。',
      unknown: 'コレクションにないフィールドが含まれています。',
      twice: 'キーに同じフィールドが 2 回含まれています。',
      hashed: 'シャードキーに含められるハッシュフィールドは 1 つまでです。',
      tooMany: `候補に含められるフィールドは最大 ${MAX_FIELDS} 個です。`,
    } satisfies Record<KeyProblem, string>,
    already: 'このキーは分析済みです。',
    full: `候補は最大 ${MAX_CANDIDATES} 件です。先に 1 件削除してください。`,
    remove: (k: string) => `${k} を削除`,
    metrics: {
      overall: '総合評価',
      distinct: '一意な値',
      frequency: '最頻値',
      monotonicity: '単調性',
      unique: '一意',
      sampled: 'サンプリングしたドキュメント',
      size: '平均ドキュメントサイズ',
      common: '頻出する値',
    },
    verdicts: { good: '良好', fair: '普通', poor: '不良', unknown: '不明' } satisfies Record<Verdict, string>,
    ofDocs: (p: string) => `ドキュメントの ${p} が保持`,
    monotonic: '挿入のたびに増加',
    notMonotonic: '増加しない',
    hashedSpread: 'ハッシュ: 均等に分散',
    unknown: '不明',
    yes: 'はい',
    no: 'いいえ',
    sampledOf: (n: string, of: string) => `${of} 件中 ${n} 件`,
    bytes: (n: string, _plural: Intl.LDMLPluralRule) => `${n} バイト`,
    reasons: {
      standalone:
        'analyzeShardKey にはレプリカセットまたはシャーディングされたクラスターが必要です。このサーバーはスタンドアロンです。',
      version: 'analyzeShardKey には MongoDB 7.0 以降が必要です。',
      no_index:
        'このキーで始まるインデックスがなく、analyzeShardKey にはインデックスが必要です。先に作成してください:',
    },
    copy: 'コピー',
  },
  es: {
    title: 'Clave de fragmentación',
    description: (coll: string) =>
      `Claves de fragmentación candidatas para ${coll}, comparadas según lo que indica analyzeShardKey de MongoDB.`,
    reading: 'Leyendo los campos…',
    noPlace: 'Abre una colección para analizar sus claves de fragmentación candidatas.',
    view: 'Una vista no se puede fragmentar: abre su colección.',
    failed: 'No se pudieron leer los documentos: ',
    guide:
      'Una buena clave de fragmentación tiene muchos valores distintos, ninguno de ellos presente en una gran parte de los documentos, y no crece con cada inserción; o bien está hasheada, lo que reparte un valor creciente. MongoDB muestrea hasta 10 000 documentos por candidata; hace falta un índice que empiece por la clave.',
    build: 'Candidata',
    field: 'Campo',
    kind: 'Orden',
    kinds: { asc: 'Ascendente', hashed: 'Hash' },
    addField: 'Añadir campo',
    removeField: (f: string) => `Quitar ${f}`,
    noField: 'Añade los campos de una clave candidata.',
    analyze: 'Analizar',
    analyzing: 'Analizando…',
    problems: {
      empty: 'Añade primero un campo.',
      unknown: 'Un campo no pertenece a la colección.',
      twice: 'Un campo aparece dos veces en la clave.',
      hashed: 'Una clave de fragmentación solo puede tener un campo hasheado.',
      tooMany: `Una candidata admite como máximo ${MAX_FIELDS} campos.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Esta clave ya se ha analizado.',
    full: `Máximo ${MAX_CANDIDATES} candidatas: quita una primero.`,
    remove: (k: string) => `Quitar ${k}`,
    metrics: {
      overall: 'Veredicto',
      distinct: 'Valores distintos',
      frequency: 'Valor más frecuente',
      monotonicity: 'Monotonía',
      unique: 'Única',
      sampled: 'Documentos muestreados',
      size: 'Documento medio',
      common: 'Valores más frecuentes',
    },
    verdicts: {
      good: 'Buena',
      fair: 'Aceptable',
      poor: 'Deficiente',
      unknown: 'Desconocido',
    } satisfies Record<Verdict, string>,
    ofDocs: (p: string) => `presente en el ${p} de los documentos`,
    monotonic: 'Crece con cada inserción',
    notMonotonic: 'No crece',
    hashedSpread: 'Hash: reparto uniforme',
    unknown: 'Desconocido',
    yes: 'Sí',
    no: 'No',
    sampledOf: (n: string, of: string) => `${n} de ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) => `${n} ${plural === 'one' ? 'byte' : 'bytes'}`,
    reasons: {
      standalone:
        'analyzeShardKey necesita un conjunto de réplicas o un clúster particionado: este servidor es independiente.',
      version: 'analyzeShardKey necesita MongoDB 7.0 o posterior.',
      no_index: 'Ningún índice empieza por esta clave y analyzeShardKey necesita uno. Créalo primero:',
    },
    copy: 'Copiar',
  },
  pt: {
    title: 'Chave de shard',
    description: (coll: string) =>
      `Chaves de shard candidatas para ${coll}, comparadas pelo que o analyzeShardKey do MongoDB informa.`,
    reading: 'Lendo os campos…',
    noPlace: 'Abra uma coleção para analisar suas chaves de shard candidatas.',
    view: 'Uma visualização não pode ser fragmentada: abra a coleção dela.',
    failed: 'Não foi possível ler os documentos: ',
    guide:
      'Uma boa chave de shard tem muitos valores distintos, nenhum deles presente em grande parte dos documentos, e não cresce a cada inserção, ou então é hasheada, o que distribui um valor crescente. O MongoDB amostra até 10.000 documentos por candidata; é preciso um índice que comece pela chave.',
    build: 'Candidata',
    field: 'Campo',
    kind: 'Ordem',
    kinds: { asc: 'Crescente', hashed: 'Hash' },
    addField: 'Adicionar campo',
    removeField: (f: string) => `Remover ${f}`,
    noField: 'Adicione os campos de uma chave candidata.',
    analyze: 'Analisar',
    analyzing: 'Analisando…',
    problems: {
      empty: 'Adicione um campo primeiro.',
      unknown: 'Um campo não pertence à coleção.',
      twice: 'Um campo aparece duas vezes na chave.',
      hashed: 'Uma chave de shard pode ter no máximo um campo hasheado.',
      tooMany: `Uma candidata aceita no máximo ${MAX_FIELDS} campos.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Esta chave já foi analisada.',
    full: `No máximo ${MAX_CANDIDATES} candidatas: remova uma primeiro.`,
    remove: (k: string) => `Remover ${k}`,
    metrics: {
      overall: 'Veredito',
      distinct: 'Valores distintos',
      frequency: 'Valor mais frequente',
      monotonicity: 'Monotonicidade',
      unique: 'Única',
      sampled: 'Documentos amostrados',
      size: 'Documento médio',
      common: 'Valores mais frequentes',
    },
    verdicts: { good: 'Boa', fair: 'Razoável', poor: 'Ruim', unknown: 'Desconhecido' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `presente em ${p} dos documentos`,
    monotonic: 'Cresce a cada inserção',
    notMonotonic: 'Não cresce',
    hashedSpread: 'Hash: distribuição uniforme',
    unknown: 'Desconhecido',
    yes: 'Sim',
    no: 'Não',
    sampledOf: (n: string, of: string) => `${n} de ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) => `${n} ${plural === 'one' ? 'byte' : 'bytes'}`,
    reasons: {
      standalone:
        'O analyzeShardKey precisa de um conjunto de réplicas ou de um cluster fragmentado (sharded): este servidor é standalone.',
      version: 'O analyzeShardKey precisa do MongoDB 7.0 ou posterior.',
      no_index: 'Nenhum índice começa por esta chave, e o analyzeShardKey precisa de um. Crie-o primeiro:',
    },
    copy: 'Copiar',
  },
  ko: {
    title: '샤드 키',
    description: (coll: string) =>
      `컬렉션 ${coll}의 후보 샤드 키를 MongoDB의 analyzeShardKey 결과를 기준으로 비교합니다.`,
    reading: '필드를 읽는 중…',
    noPlace: '후보 샤드 키를 분석하려면 컬렉션을 여세요.',
    view: '뷰는 샤딩할 수 없습니다. 해당 컬렉션을 여세요.',
    failed: '도큐먼트를 읽을 수 없습니다: ',
    guide:
      '좋은 샤드 키는 서로 다른 값이 많고, 어느 한 값도 많은 도큐먼트가 공유하지 않으며, 삽입할 때마다 증가하지 않습니다. 해시를 사용하면 증가하는 값도 고르게 분산됩니다. MongoDB는 후보마다 최대 10,000개의 도큐먼트를 샘플링하며, 키로 시작하는 인덱스가 필요합니다.',
    build: '후보',
    field: '필드',
    kind: '순서',
    kinds: { asc: '오름차순', hashed: '해시' },
    addField: '필드 추가',
    removeField: (f: string) => `${f} 필드 제거`,
    noField: '후보 키의 필드를 추가하세요.',
    analyze: '분석',
    analyzing: '분석 중…',
    problems: {
      empty: '먼저 필드를 추가하세요.',
      unknown: '컬렉션에 없는 필드가 있습니다.',
      twice: '키에 같은 필드가 두 번 들어 있습니다.',
      hashed: '샤드 키에는 해시 필드를 최대 하나만 넣을 수 있습니다.',
      tooMany: `후보에는 필드를 최대 ${MAX_FIELDS}개까지 넣을 수 있습니다.`,
    } satisfies Record<KeyProblem, string>,
    already: '이미 분석한 키입니다.',
    full: `후보는 최대 ${MAX_CANDIDATES}개입니다. 먼저 하나를 제거하세요.`,
    remove: (k: string) => `${k} 후보 제거`,
    metrics: {
      overall: '종합 판정',
      distinct: '서로 다른 값',
      frequency: '가장 흔한 값',
      monotonicity: '단조성',
      unique: '고유',
      sampled: '샘플링한 도큐먼트',
      size: '평균 도큐먼트 크기',
      common: '가장 흔한 값 목록',
    },
    verdicts: { good: '좋음', fair: '보통', poor: '나쁨', unknown: '알 수 없음' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `도큐먼트의 ${p}에 존재`,
    monotonic: '삽입할 때마다 증가',
    notMonotonic: '증가하지 않음',
    hashedSpread: '해시: 고르게 분산',
    unknown: '알 수 없음',
    yes: '예',
    no: '아니요',
    sampledOf: (n: string, of: string) => `${of}개 중 ${n}개`,
    bytes: (n: string, _plural: Intl.LDMLPluralRule) => `${n}바이트`,
    reasons: {
      standalone:
        'analyzeShardKey에는 레플리카 세트 또는 샤드 클러스터가 필요합니다. 이 서버는 독립 실행형입니다.',
      version: 'analyzeShardKey에는 MongoDB 7.0 이상이 필요합니다.',
      no_index: '이 키로 시작하는 인덱스가 없는데 analyzeShardKey에는 인덱스가 필요합니다. 먼저 만드세요:',
    },
    copy: '복사',
  },
  de: {
    title: 'Shard-Schlüssel',
    description: (coll: string) =>
      `Kandidaten für den Shard-Schlüssel von ${coll}, verglichen anhand der Ergebnisse von analyzeShardKey in MongoDB.`,
    reading: 'Felder werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um ihre Shard-Schlüssel-Kandidaten zu analysieren.',
    view: 'Eine View kann nicht geshardet werden: Öffnen Sie die zugehörige Collection.',
    failed: 'Die Dokumente konnten nicht gelesen werden: ',
    guide:
      'Ein guter Shard-Schlüssel hat viele verschiedene Werte, von denen keiner in einem großen Teil der Dokumente vorkommt, und wächst nicht mit jedem Einfügen – oder er ist gehasht, wodurch ein wachsender Wert verteilt wird. MongoDB zieht für jeden Kandidaten eine Stichprobe von bis zu 10.000 Dokumenten; es ist ein Index erforderlich, der mit dem Schlüssel beginnt.',
    build: 'Kandidat',
    field: 'Feld',
    kind: 'Reihenfolge',
    kinds: { asc: 'Aufsteigend', hashed: 'Gehasht' },
    addField: 'Feld hinzufügen',
    removeField: (f: string) => `${f} entfernen`,
    noField: 'Felder eines Kandidatenschlüssels hinzufügen.',
    analyze: 'Analysieren',
    analyzing: 'Wird analysiert…',
    problems: {
      empty: 'Zuerst ein Feld hinzufügen.',
      unknown: 'Ein Feld gehört nicht zur Collection.',
      twice: 'Ein Feld kommt im Schlüssel zweimal vor.',
      hashed: 'Ein Shard-Schlüssel darf höchstens ein gehashtes Feld enthalten.',
      tooMany: `Ein Kandidat darf höchstens ${MAX_FIELDS} Felder enthalten.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Dieser Schlüssel wurde bereits analysiert.',
    full: `Höchstens ${MAX_CANDIDATES} Kandidaten: Zuerst einen entfernen.`,
    remove: (k: string) => `${k} entfernen`,
    metrics: {
      overall: 'Bewertung',
      distinct: 'Verschiedene Werte',
      frequency: 'Häufigster Wert',
      monotonicity: 'Monotonie',
      unique: 'Eindeutig',
      sampled: 'Dokumente in der Stichprobe',
      size: 'Durchschnittliche Dokumentgröße',
      common: 'Häufigste Werte',
    },
    verdicts: { good: 'Gut', fair: 'Mittel', poor: 'Schlecht', unknown: 'Unbekannt' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `in ${p} der Dokumente`,
    monotonic: 'Wächst mit jedem Einfügen',
    notMonotonic: 'Wächst nicht',
    hashedSpread: 'Gehasht: gleichmäßig verteilt',
    unknown: 'Unbekannt',
    yes: 'Ja',
    no: 'Nein',
    sampledOf: (n: string, of: string) => `${n} von ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) => `${n} ${plural === 'one' ? 'Byte' : 'Bytes'}`,
    reasons: {
      standalone:
        'analyzeShardKey erfordert ein Replica Set oder einen Sharded Cluster: Dieser Server ist eigenständig (Standalone).',
      version: 'analyzeShardKey erfordert MongoDB 7.0 oder neuer.',
      no_index:
        'Kein Index beginnt mit diesem Schlüssel, aber analyzeShardKey benötigt einen. Diesen zuerst erstellen:',
    },
    copy: 'Kopieren',
  },
  fr: {
    title: 'Clé de partition',
    description: (coll: string) =>
      `Clés de partition candidates pour ${coll}, comparées d’après les résultats de analyzeShardKey de MongoDB.`,
    reading: 'Lecture des champs…',
    noPlace: 'Ouvrez une collection pour analyser ses clés de partition candidates.',
    view: 'Une vue ne peut pas être partitionnée : ouvrez sa collection.',
    failed: 'Impossible de lire les documents : ',
    guide:
      'Une bonne clé de partition possède de nombreuses valeurs distinctes, dont aucune n’est portée par une grande part des documents, et ne croît pas à chaque insertion — ou est hachée, ce qui répartit une valeur croissante. MongoDB échantillonne jusqu’à 10 000 documents par candidate ; un index doit commencer par la clé.',
    build: 'Candidate',
    field: 'Champ',
    kind: 'Ordre',
    kinds: { asc: 'Croissant', hashed: 'Haché' },
    addField: 'Ajouter un champ',
    removeField: (f: string) => `Retirer ${f}`,
    noField: 'Ajoutez les champs d’une clé candidate.',
    analyze: 'Analyser',
    analyzing: 'Analyse en cours…',
    problems: {
      empty: 'Ajoutez d’abord un champ.',
      unknown: 'Un champ n’appartient pas à la collection.',
      twice: 'Un champ figure deux fois dans la clé.',
      hashed: 'Une clé de partition ne peut contenir qu’un seul champ haché.',
      tooMany: `Une candidate contient au plus ${MAX_FIELDS} champs.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Cette clé a déjà été analysée.',
    full: `${MAX_CANDIDATES} candidates au maximum : retirez-en une d’abord.`,
    remove: (k: string) => `Retirer ${k}`,
    metrics: {
      overall: 'Verdict',
      distinct: 'Valeurs distinctes',
      frequency: 'Valeur la plus fréquente',
      monotonicity: 'Monotonie',
      unique: 'Unique',
      sampled: 'Documents échantillonnés',
      size: 'Document moyen',
      common: 'Valeurs les plus fréquentes',
    },
    verdicts: { good: 'Bonne', fair: 'Correcte', poor: 'Mauvaise', unknown: 'Inconnue' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `portée par ${p} des documents`,
    monotonic: 'Croît à chaque insertion',
    notMonotonic: 'Ne croît pas',
    hashedSpread: 'Hachage : répartition uniforme',
    unknown: 'Inconnu',
    yes: 'Oui',
    no: 'Non',
    sampledOf: (n: string, of: string) => `${n} sur ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) => `${n} ${plural === 'one' ? 'octet' : 'octets'}`,
    reasons: {
      standalone:
        'analyzeShardKey nécessite un jeu de réplicas ou un cluster partitionné : ce serveur est autonome.',
      version: 'analyzeShardKey nécessite MongoDB 7.0 ou une version ultérieure.',
      no_index:
        'Aucun index ne commence par cette clé, et analyzeShardKey en nécessite un. Créez-le d’abord :',
    },
    copy: 'Copier',
  },
  ru: {
    title: 'Ключ шардирования',
    description: (coll: string) =>
      `Кандидаты в ключи шардирования для ${coll}: сравнение по результатам analyzeShardKey в MongoDB.`,
    reading: 'Чтение полей…',
    noPlace: 'Откройте коллекцию, чтобы проанализировать кандидаты в ключи шардирования.',
    view: 'Представление нельзя шардировать: откройте его коллекцию.',
    failed: 'Не удалось прочитать документы: ',
    guide:
      'У хорошего ключа шардирования много различных значений, ни одно из них не встречается в большой доле документов, и он не растет с каждой вставкой — либо он хешированный, что распределяет растущее значение. MongoDB берет выборку до 10 000 документов для каждого кандидата; нужен индекс, который начинается с ключа.',
    build: 'Кандидат',
    field: 'Поле',
    kind: 'Порядок',
    kinds: { asc: 'По возрастанию', hashed: 'Хеш' },
    addField: 'Добавить поле',
    removeField: (f: string) => `Удалить поле ${f}`,
    noField: 'Добавьте поля ключа-кандидата.',
    analyze: 'Анализировать',
    analyzing: 'Анализ…',
    problems: {
      empty: 'Сначала добавьте поле.',
      unknown: 'Одно из полей не относится к коллекции.',
      twice: 'Поле указано в ключе дважды.',
      hashed: 'В ключе шардирования может быть не более одного хешированного поля.',
      tooMany: `Максимум полей в кандидате: ${MAX_FIELDS}.`,
    } satisfies Record<KeyProblem, string>,
    already: 'Этот ключ уже проанализирован.',
    full: `Максимум кандидатов: ${MAX_CANDIDATES}. Сначала удалите одного из них.`,
    remove: (k: string) => `Удалить кандидата ${k}`,
    metrics: {
      overall: 'Вердикт',
      distinct: 'Различные значения',
      frequency: 'Самое частое значение',
      monotonicity: 'Монотонность',
      unique: 'Уникальный',
      sampled: 'Документов в выборке',
      size: 'Средний размер документа',
      common: 'Самые частые значения',
    },
    verdicts: { good: 'Хороший', fair: 'Приемлемый', poor: 'Плохой', unknown: 'Неизвестно' } satisfies Record<
      Verdict,
      string
    >,
    ofDocs: (p: string) => `встречается в ${p} документов`,
    monotonic: 'Растет с каждой вставкой',
    notMonotonic: 'Не растет',
    hashedSpread: 'Хеш: равномерное распределение',
    unknown: 'Неизвестно',
    yes: 'Да',
    no: 'Нет',
    sampledOf: (n: string, of: string) => `${n} из ${of}`,
    bytes: (n: string, plural: Intl.LDMLPluralRule) =>
      `${n} ${plural === 'one' ? 'байт' : plural === 'few' ? 'байта' : 'байт'}`,
    reasons: {
      standalone: 'analyzeShardKey требует набор реплик или шардированный кластер: этот сервер автономный.',
      version: 'analyzeShardKey требует MongoDB 7.0 или новее.',
      no_index:
        'Ни один индекс не начинается с этого ключа, а analyzeShardKey требует индекс. Сначала создайте его:',
    },
    copy: 'Копировать',
  },
}
type Text = (typeof TEXT)['en']
TEXT satisfies Record<Language, Text>
/** What the page shows in a size: the count as shown, and its plural category in the language. */
export const sizeText = (value: number, locale: string): string => {
  const language = shown(TEXT, locale)
  const rounded = Math.round(value)
  return TEXT[language].bytes(formatNumber(rounded, language, 0), pluralOf(rounded, language))
}
type Kind = 'asc' | 'hashed'
interface Candidate {
  key: KeyField[]
  text: string
  result: Analysis
}

const VERDICT_TONE: Record<Verdict, Tone> = {
  good: 'success',
  fair: 'warning',
  poor: 'danger',
  unknown: 'neutral',
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' | 'view' = 'reading'
  let failure: unknown = null
  let offered: string[] = []
  let draft: KeyField[] = []
  let field = ''
  let kind: Kind = 'asc'
  let problem: string | null = null
  let analyzing = false
  const candidates: Candidate[] = []

  const header = pageHeader({ icon: 'layers', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body sk-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))
  const fmt = (n: number) => formatNumber(n, shown(TEXT, locale), 0)
  const pct = (share: number) =>
    new Intl.NumberFormat(langTag(shown(TEXT, locale)), {
      style: 'percent',
      maximumFractionDigits: share < 0.1 ? 1 : 0,
    }).format(share)

  async function analyze(): Promise<void> {
    status.textContent = ''
    const why = keyProblem(draft, offered)
    if (why) return void ((problem = text.problems[why]), render())
    const keyLabel = keyText(draft)
    if (candidates.some((c) => c.text === keyLabel)) return void ((problem = text.already), render())
    if (candidates.length >= MAX_CANDIDATES) return void ((problem = text.full), render())
    problem = null
    analyzing = true
    render()
    const key = [...draft]
    try {
      const result = await client.ask<Analysis>('shardKey.analyze', { key: keyObject(key) })
      candidates.push({ key, text: keyLabel, result })
      draft = []
    } catch (e) {
      status.textContent = askMessage(e, locale)
    } finally {
      analyzing = false
    }
    // The button was busy (so not focusable) meanwhile: the focus goes back to it.
    render('analyze')
  }

  function builder(): HTMLElement {
    const fieldSelect = h('select', { id: 'field', class: 'mm-select' })
    for (const f of offered) fieldSelect.append(h('option', { attrs: { value: f }, text: f }))
    fieldSelect.value = field
    fieldSelect.addEventListener('change', () => (field = fieldSelect.value))
    const kindSelect = h('select', { id: 'kind', class: 'mm-select' })
    for (const k of ['asc', 'hashed'] as const)
      kindSelect.append(h('option', { attrs: { value: k }, text: text.kinds[k] }))
    kindSelect.value = kind
    kindSelect.addEventListener('change', () => (kind = kindSelect.value as Kind))
    const add = button({
      label: text.addField,
      icon: 'plus',
      id: 'add-field',
      onClick: () => {
        if (!field) return
        draft = [...draft.filter((k) => k.field !== field), { field, hashed: kind === 'hashed' }]
        problem = null
        render()
        body.querySelector<HTMLElement>('#add-field')?.focus()
      },
    })
    const go = button({
      label: analyzing ? text.analyzing : text.analyze,
      icon: 'play',
      variant: 'primary',
      id: 'analyze',
      onClick: () => void analyze(),
    })
    setBusy(go, analyzing)
    const chips = draft.length
      ? draft.map((k) =>
          chip({
            label: `${k.field}: ${k.hashed ? '"hashed"' : '1'}`,
            mono: true,
            icon: 'x',
            title: text.removeField(k.field),
            onClick: () => {
              draft = draft.filter((d) => d !== k)
              render('field')
            },
          }),
        )
      : [h('span', { class: 'sk-muted', text: text.noField })]
    return h(
      'section',
      { class: 'sk-builder', attrs: { 'aria-label': text.build } },
      h(
        'div',
        { class: 'sk-row' },
        h('label', { class: 'sk-label' }, h('span', { text: text.field }), fieldSelect),
        h('label', { class: 'sk-label' }, h('span', { text: text.kind }), kindSelect),
        add,
      ),
      h('div', { id: 'draft', class: 'sk-draft' }, ...chips),
      h('div', { class: 'sk-row' }, go),
      h(
        'p',
        { id: 'key-error', class: 'sk-error', attrs: { role: 'alert' }, hidden: !problem },
        problem ?? '',
      ),
    )
  }

  function verdictBadge(v: Verdict): HTMLElement {
    return badge(text.verdicts[v], VERDICT_TONE[v])
  }

  function cells(c: Candidate): Record<keyof Text['metrics'], HTMLElement | string> {
    const r = c.result
    if (!r.available) {
      const reason: HTMLElement = h('div', { class: 'sk-reason' }, h('p', { text: text.reasons[r.reason] }))
      if (r.reason === 'no_index' && ctx?.place) {
        const command = createIndexText(ctx.place.coll, c.key)
        const copy = button({
          label: text.copy,
          icon: 'copy',
          size: 'sm',
          onClick: () =>
            void client
              .ask('ui.copy', { text: command })
              .catch((e) => (status.textContent = askMessage(e, locale))),
        })
        copy.dataset.copyIndex = ''
        reason.append(h('code', { class: 'mm-mono sk-code', text: command }), copy)
      }
      return {
        overall: reason,
        distinct: '',
        frequency: '',
        monotonicity: '',
        unique: '',
        sampled: '',
        size: '',
        common: '',
      }
    }
    const hashed = c.key.some((k) => k.hashed)
    const v = verdictsOf(r, hashed)
    const share = topShare(r)
    const withVerdict = (value: string, verdict: Verdict) =>
      h('span', { class: 'sk-cell' }, verdictBadge(verdict), h('span', { text: value }))
    return {
      overall: verdictBadge(v.overall),
      distinct: withVerdict(
        r.numDistinctValues === null ? text.unknown : fmt(r.numDistinctValues),
        v.cardinality,
      ),
      frequency: withVerdict(share === null ? text.unknown : text.ofDocs(pct(share)), v.frequency),
      monotonicity: withVerdict(
        hashed
          ? text.hashedSpread
          : r.monotonicity === 'monotonic'
            ? text.monotonic
            : r.monotonicity === 'not monotonic'
              ? text.notMonotonic
              : text.unknown,
        v.monotonicity,
      ),
      unique: r.isUnique === null ? text.unknown : r.isUnique ? text.yes : text.no,
      sampled:
        r.numDocsSampled === null
          ? text.unknown
          : r.numDocsTotal === null
            ? fmt(r.numDocsSampled)
            : text.sampledOf(fmt(r.numDocsSampled), fmt(r.numDocsTotal)),
      size: r.avgDocSizeBytes === null ? text.unknown : sizeText(r.avgDocSizeBytes, locale),
      common: h(
        'ol',
        { class: 'sk-common' },
        ...r.mostCommonValues
          .slice(0, COMMON_SHOWN)
          .map((m) =>
            h(
              'li',
              {},
              valueView(m.value, 40),
              h('span', { class: 'sk-muted', text: ` × ${fmt(m.frequency)}` }),
            ),
          ),
      ),
    }
  }

  function results(): HTMLElement | null {
    if (!candidates.length) return null
    const all = candidates.map(cells)
    const head = h(
      'tr',
      {},
      h('th', { attrs: { scope: 'col' } }),
      ...candidates.map((c) => {
        const remove = button({
          label: text.remove(c.text),
          icon: 'x',
          iconOnly: true,
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            candidates.splice(candidates.indexOf(c), 1)
            render('analyze')
          },
        })
        return h('th', { attrs: { scope: 'col' } }, h('span', { class: 'mm-mono', text: c.text }), remove)
      }),
    )
    const metrics = Object.keys(text.metrics) as Array<keyof Text['metrics']>
    const rows = metrics.map((m) => {
      const tr = h(
        'tr',
        {},
        h('th', { attrs: { scope: 'row' }, text: text.metrics[m] }),
        ...all.map((c) => h('td', {}, c[m])),
      )
      tr.dataset.metric = m
      return tr
    })
    return h(
      'div',
      { class: 'sk-table' },
      h(
        'table',
        { id: 'results', class: 'mm-table sk-results' },
        h('thead', {}, head),
        h('tbody', {}, ...rows),
      ),
    )
  }

  /**
   * Final review Minor 14: the page is drawn again — the focus given back to what had it (by id), or
   * to `next` where that is gone.
   */
  function render(next?: string): void {
    const had = (document.activeElement as HTMLElement | null)?.id
    text = pick(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    body.replaceChildren()
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'layers', title: text.noPlace }))
    if (phase === 'view') return void body.append(emptyState({ icon: 'layers', title: text.view }))
    if (phase === 'failed')
      return void body.append(callout('danger', text.failed + askMessage(failure, locale)))
    if (phase === 'reading')
      return void body.append(h('p', { class: 'sk-muted', text: text.reading }), skeleton(4))
    body.append(callout('info', text.guide), builder(), ...[results()].filter((x): x is HTMLElement => !!x))
    const back =
      (had && body.querySelector<HTMLElement>(`#${CSS.escape(had)}`)) ||
      (next ? body.querySelector<HTMLElement>(`#${next}`) : null)
    back?.focus()
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
      locale = ctx.locale
      applyLook(ctx.theme, ctx.accent)
      if (!ctx.place) phase = 'noPlace'
      else if (ctx.place.view) phase = 'view'
      else {
        render()
        const sample = (await client.ask<{ documents: unknown[] }>('documents.find', { limit: SAMPLE }))
          .documents
        offered = candidateFields(shapeOf(sample, ctx.place.hidden ?? []))
        field = offered[0] ?? ''
        phase = 'ready'
      }
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  })
  render()
}
