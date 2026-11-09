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
  describeValue,
  emptyState,
  formatNumber,
  h,
  langTag,
  type Language,
  pick,
  pluralOf,
  shown,
  pageHeader,
  segmented,
  setBusy,
  skeleton,
  statusLine,
  switchControl,
  valueView,
} from '../../kit/src/ui'
import {
  ALL,
  MAX_LIMIT,
  filterOf,
  highlightParts,
  scoreOf,
  searchPipeline,
  textPaths,
  vectorOf,
  vectorPaths,
  vectorPipeline,
  valueAt,
  type SearchIndex,
  type SearchIndexList,
} from './search'

/**
 * Plugins wave 4 (spec §5): a playground for the collection's search indexes — a full-text search
 * (a field or all, fuzzy, highlights) or a vector search (a pasted vector, or one of the
 * collection's documents to find those like it) — results with their score, the pipeline handed to
 * Aggregations. The app runs it as the user, read-only, the search stage first.
 */
const SAMPLES = 20
const PREVIEW_FIELDS = 8
const MAX_CANDIDATES = 10_000

/** The Russian form of a noun for a count: one, few, many (other counts as many). */
const ruWord = (n: number, [one, few, many]: [string, string, string]): string => {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}

/** A count in the shown language's digits. */
const num = (n: number, lang: Language): string => formatNumber(n, lang, 0)

const EN = {
  title: 'Search',
  description: (coll: string) => `Full-text and vector search on the search indexes of ${coll}.`,
  reading: 'Reading the search indexes…',
  noPlace: 'Open a collection to search it.',
  failed: 'The search indexes could not be read: ',
  notEnabled:
    'Search is not enabled here: it needs Atlas, or a self-managed MongoDB with MongoDB Search (mongot) set up.',
  unsupported: 'This server does not support search indexes.',
  none: 'No search index on this collection: create one on its Indexes page, then come back.',
  index: 'Index',
  kinds: { search: 'Full text', vectorSearch: 'Vector' },
  notQueryable: (status: string) => `This index is not queryable yet (${status}): wait until it is READY.`,
  query: 'Search for',
  path: 'In',
  all: 'All fields',
  fuzzy: 'Typos allowed',
  fuzzies: ['None', '1 letter', '2 letters'],
  highlight: 'Highlights',
  limit: 'Results',
  vectorPath: 'Vector field',
  source: 'Vector',
  sources: { paste: 'Pasted', document: 'Like a document' },
  vector: 'Query vector (numbers)',
  fromDoc: 'Document',
  reading20: 'Reading documents…',
  noDocs: 'The collection has no document to start from.',
  candidates: 'Candidates',
  filter: 'Filter (JSON, on filter fields)',
  run: 'Search',
  use: 'Use in Aggregations',
  handed: 'The pipeline is in Aggregations.',
  noQuery: 'Type what to search for.',
  badLimit: `Results are 1 to ${MAX_LIMIT}.`,
  badCandidates: `Candidates are at least the results and at most ${formatNumber(MAX_CANDIDATES, 'en', 0)}.`,
  badVector: 'Give the query vector as numbers: [0.1, 0.2, …] or 0.1, 0.2, …',
  dimensions: (n: number) =>
    `This index’s vectors have ${num(n, 'en')} ${pluralOf(n, 'en') === 'one' ? 'dimension' : 'dimensions'}.`,
  noDocVector: (path: string) => `This document holds no list of numbers at ${path}.`,
  badFilter: 'The filter is a JSON object, such as { "year": { "$gte": 2000 } }.',
  noText: 'This index maps no text field: there is nothing to search in.',
  restricted:
    'Personal data rules hide values from you in this collection: the app refuses a search here, as it could tell hidden values by what it finds.',
  found: (n: number) => `${num(n, 'en')} ${pluralOf(n, 'en') === 'one' ? 'result' : 'results'}`,
  nothing: 'Nothing found.',
  cut: 'The results are large: only those that fit in one answer to the page are shown.',
  score: 'Score',
  more: (n: number) => `${num(n, 'en')} more ${pluralOf(n, 'en') === 'one' ? 'field' : 'fields'}`,
}
type Text = typeof EN

export const TEXT = {
  en: EN,
  tr: {
    title: 'Arama',
    description: (coll: string) => `${coll} koleksiyonunun arama indekslerinde tam metin ve vektör araması.`,
    reading: 'Arama indeksleri okunuyor…',
    noPlace: 'Aramak için bir koleksiyon aç.',
    failed: 'Arama indeksleri okunamadı: ',
    notEnabled:
      'Arama burada etkin değil: Atlas’ı ya da MongoDB Search (mongot) kurulu kendi MongoDB sunucunuzu ister.',
    unsupported: 'Bu sunucu arama indekslerini desteklemiyor.',
    none: 'Bu koleksiyonda arama indeksi yok: İndeksler sayfasında bir tane oluşturup geri gel.',
    index: 'İndeks',
    kinds: { search: 'Tam metin', vectorSearch: 'Vektör' },
    notQueryable: (status: string) => `Bu indeks henüz sorgulanamıyor (${status}): READY olmasını bekle.`,
    query: 'Aranan',
    path: 'Nerede',
    all: 'Tüm alanlar',
    fuzzy: 'İzin verilen yazım hatası',
    fuzzies: ['Yok', '1 harf', '2 harf'],
    highlight: 'Vurgular',
    limit: 'Sonuç',
    vectorPath: 'Vektör alanı',
    source: 'Vektör',
    sources: { paste: 'Yapıştırılan', document: 'Bir belgeye benzer' },
    vector: 'Sorgu vektörü (sayılar)',
    fromDoc: 'Belge',
    reading20: 'Belgeler okunuyor…',
    noDocs: 'Koleksiyonda başlanacak belge yok.',
    candidates: 'Aday',
    filter: 'Filtre (JSON, filtre alanlarında)',
    run: 'Ara',
    use: "Aggregations'da kullan",
    handed: "Boru hattı Aggregations'da.",
    noQuery: 'Ne aranacağını yaz.',
    badLimit: `Sonuç 1 ile ${MAX_LIMIT} arasındadır.`,
    badCandidates: `Aday en az sonuç kadar, en fazla ${formatNumber(MAX_CANDIDATES, 'tr', 0)} olur.`,
    badVector: 'Sorgu vektörünü sayılar olarak ver: [0.1, 0.2, …] ya da 0.1, 0.2, …',
    dimensions: (n: number) => `Bu indeksin vektörleri ${n} boyutlu.`,
    noDocVector: (path: string) => `Bu belgede ${path} yolunda bir sayı listesi yok.`,
    badFilter: 'Filtre bir JSON nesnesidir, örneğin { "year": { "$gte": 2000 } }.',
    noText: 'Bu indeks hiçbir metin alanını eşlemiyor: aranacak bir şey yok.',
    restricted:
      'Kişisel veri kuralları bu koleksiyonda değerleri senden gizliyor: uygulama burada aramayı reddeder, çünkü bulduklarından gizli değerler anlaşılabilirdi.',
    found: (n: number) => `${n} sonuç`,
    nothing: 'Hiçbir şey bulunamadı.',
    cut: 'Sonuçlar büyük: yalnızca sayfaya giden tek bir cevaba sığanlar gösteriliyor.',
    score: 'Skor',
    more: (n: number) => `${n} alan daha`,
  },
  zh: {
    title: '搜索',
    description: (coll: string) => `在 ${coll} 的搜索索引上进行全文搜索和向量搜索。`,
    reading: '正在读取搜索索引…',
    noPlace: '请打开一个集合后再搜索。',
    failed: '无法读取搜索索引：',
    notEnabled: '此处未启用搜索：需要 Atlas，或配置了 MongoDB Search（mongot）的自行管理 MongoDB。',
    unsupported: '此服务器不支持搜索索引。',
    none: '此集合没有搜索索引：请在其“索引”页面创建一个，然后再回来。',
    index: '索引',
    kinds: { search: '全文', vectorSearch: '向量' },
    notQueryable: (status: string) => `此索引尚不可查询（${status}）：请等待其变为 READY。`,
    query: '搜索内容',
    path: '范围',
    all: '所有字段',
    fuzzy: '允许的拼写错误',
    fuzzies: ['无', '1 个字符', '2 个字符'],
    highlight: '高亮',
    limit: '结果数',
    vectorPath: '向量字段',
    source: '向量',
    sources: { paste: '粘贴', document: '类似某个文档' },
    vector: '查询向量（数字）',
    fromDoc: '文档',
    reading20: '正在读取文档…',
    noDocs: '集合中没有可用作起点的文档。',
    candidates: '候选数',
    filter: '筛选（JSON，作用于筛选字段）',
    run: '搜索',
    use: '在聚合中使用',
    handed: '管道已发送到聚合。',
    noQuery: '请输入要搜索的内容。',
    badLimit: `结果数为 1 到 ${MAX_LIMIT}。`,
    badCandidates: `候选数不得少于结果数，且最多为 ${formatNumber(MAX_CANDIDATES, 'zh', 0)}。`,
    badVector: '请以数字形式提供查询向量：[0.1, 0.2, …] 或 0.1, 0.2, …',
    dimensions: (n: number) => `此索引的向量有 ${n} 个维度。`,
    noDocVector: (path: string) => `此文档的 ${path} 处没有数字列表。`,
    badFilter: '筛选必须是 JSON 对象，例如 { "year": { "$gte": 2000 } }。',
    noText: '此索引未映射任何文本字段：没有可搜索的内容。',
    restricted: '个人数据规则对您隐藏了此集合中的部分值：应用在此拒绝搜索，因为搜索结果可能泄露被隐藏的值。',
    found: (n: number) => `${n} 条结果`,
    nothing: '未找到任何内容。',
    cut: '结果较大：只显示页面一次应答能容纳的结果。',
    score: '得分',
    more: (n: number) => `另有 ${n} 个字段`,
  },
  ja: {
    title: '検索',
    description: (coll: string) => `${coll} の検索インデックスでの全文検索とベクトル検索。`,
    reading: '検索インデックスを読み込み中…',
    noPlace: '検索するにはコレクションを開いてください。',
    failed: '検索インデックスを読み込めませんでした: ',
    notEnabled:
      'ここでは検索が有効になっていません。Atlas、または MongoDB Search（mongot）を設定した自己管理の MongoDB が必要です。',
    unsupported: 'このサーバーは検索インデックスをサポートしていません。',
    none: 'このコレクションには検索インデックスがありません。インデックスページで作成してから戻ってください。',
    index: 'インデックス',
    kinds: { search: '全文', vectorSearch: 'ベクトル' },
    notQueryable: (status: string) =>
      `このインデックスはまだクエリできません（${status}）。READY になるまでお待ちください。`,
    query: '検索語',
    path: '対象',
    all: 'すべてのフィールド',
    fuzzy: '許容する誤字',
    fuzzies: ['なし', '1 文字', '2 文字'],
    highlight: 'ハイライト',
    limit: '結果数',
    vectorPath: 'ベクトルフィールド',
    source: 'ベクトル',
    sources: { paste: '貼り付け', document: 'ドキュメントに類似' },
    vector: 'クエリベクトル（数値）',
    fromDoc: 'ドキュメント',
    reading20: 'ドキュメントを読み込み中…',
    noDocs: '起点にできるドキュメントがコレクションにありません。',
    candidates: '候補数',
    filter: 'フィルター（JSON、フィルターフィールド対象）',
    run: '検索',
    use: '集計で使用',
    handed: 'パイプラインを集計に渡しました。',
    noQuery: '検索する語を入力してください。',
    badLimit: `結果数は 1 から ${MAX_LIMIT} までです。`,
    badCandidates: `候補数は結果数以上、最大 ${formatNumber(MAX_CANDIDATES, 'ja', 0)} までです。`,
    badVector: 'クエリベクトルは数値で指定してください: [0.1, 0.2, …] または 0.1, 0.2, …',
    dimensions: (n: number) => `このインデックスのベクトルは ${n} 次元です。`,
    noDocVector: (path: string) => `このドキュメントの ${path} には数値のリストがありません。`,
    badFilter: 'フィルターは JSON オブジェクトで指定してください。例: { "year": { "$gte": 2000 } }。',
    noText: 'このインデックスはテキストフィールドをマッピングしていません。検索対象がありません。',
    restricted:
      '個人データのルールにより、このコレクションの一部の値は非表示になっています。検索結果から非表示の値が推測される可能性があるため、アプリはここでの検索を拒否します。',
    found: (n: number) => `${n} 件の結果`,
    nothing: '見つかりませんでした。',
    cut: '結果が大きいため、ページへの 1 回の応答に収まる分だけを表示しています。',
    score: 'スコア',
    more: (n: number) => `ほか ${n} フィールド`,
  },
  es: {
    title: 'Búsqueda',
    description: (coll: string) =>
      `Búsqueda de texto completo y búsqueda vectorial en los índices de búsqueda de ${coll}.`,
    reading: 'Leyendo los índices de búsqueda…',
    noPlace: 'Abre una colección para buscar en ella.',
    failed: 'No se pudieron leer los índices de búsqueda: ',
    notEnabled:
      'La búsqueda no está habilitada aquí: requiere Atlas, o un MongoDB autogestionado con MongoDB Search (mongot) configurado.',
    unsupported: 'Este servidor no admite índices de búsqueda.',
    none: 'Esta colección no tiene ningún índice de búsqueda: crea uno en su página de Índices y vuelve.',
    index: 'Índice',
    kinds: { search: 'Texto completo', vectorSearch: 'Vectorial' },
    notQueryable: (status: string) =>
      `Este índice aún no se puede consultar (${status}): espera a que esté en READY.`,
    query: 'Buscar',
    path: 'En',
    all: 'Todos los campos',
    fuzzy: 'Errores tipográficos permitidos',
    fuzzies: ['Ninguno', '1 letra', '2 letras'],
    highlight: 'Resaltados',
    limit: 'Resultados',
    vectorPath: 'Campo vectorial',
    source: 'Vector',
    sources: { paste: 'Pegado', document: 'Como un documento' },
    vector: 'Vector de consulta (números)',
    fromDoc: 'Documento',
    reading20: 'Leyendo documentos…',
    noDocs: 'La colección no tiene ningún documento del que partir.',
    candidates: 'Candidatos',
    filter: 'Filtro (JSON, sobre campos de filtro)',
    run: 'Buscar',
    use: 'Usar en Agregaciones',
    handed: 'El pipeline está en Agregaciones.',
    noQuery: 'Escribe qué quieres buscar.',
    badLimit: `Los resultados van de 1 a ${MAX_LIMIT}.`,
    badCandidates: `Los candidatos son al menos tantos como los resultados y como máximo ${formatNumber(MAX_CANDIDATES, 'es', 0)}.`,
    badVector: 'Indica el vector de consulta como números: [0.1, 0.2, …] o 0.1, 0.2, …',
    dimensions: (n: number) =>
      `Los vectores de este índice tienen ${num(n, 'es')} ${pluralOf(n, 'es') === 'one' ? 'dimensión' : 'dimensiones'}.`,
    noDocVector: (path: string) => `Este documento no contiene una lista de números en ${path}.`,
    badFilter: 'El filtro es un objeto JSON, como { "year": { "$gte": 2000 } }.',
    noText: 'Este índice no asigna ningún campo de texto: no hay nada en lo que buscar.',
    restricted:
      'Las reglas de datos personales te ocultan valores en esta colección: la aplicación rechaza aquí la búsqueda, ya que podría revelar los valores ocultos por lo que encuentre.',
    found: (n: number) => `${num(n, 'es')} ${pluralOf(n, 'es') === 'one' ? 'resultado' : 'resultados'}`,
    nothing: 'No se encontró nada.',
    cut: 'Los resultados son grandes: solo se muestran los que caben en una respuesta a la página.',
    score: 'Puntuación',
    more: (n: number) => `${num(n, 'es')} ${pluralOf(n, 'es') === 'one' ? 'campo' : 'campos'} más`,
  },
  pt: {
    title: 'Busca',
    description: (coll: string) =>
      `Busca de texto completo e busca vetorial nos índices de busca de ${coll}.`,
    reading: 'Lendo os índices de busca…',
    noPlace: 'Abra uma coleção para pesquisar nela.',
    failed: 'Não foi possível ler os índices de busca: ',
    notEnabled:
      'A busca não está habilitada aqui: ela exige o Atlas, ou um MongoDB autogerenciado com o MongoDB Search (mongot) configurado.',
    unsupported: 'Este servidor não oferece suporte a índices de busca.',
    none: 'Esta coleção não tem índice de busca: crie um na página de Índices e volte.',
    index: 'Índice',
    kinds: { search: 'Texto completo', vectorSearch: 'Vetorial' },
    notQueryable: (status: string) =>
      `Este índice ainda não pode ser consultado (${status}): aguarde até que esteja READY.`,
    query: 'Buscar por',
    path: 'Em',
    all: 'Todos os campos',
    fuzzy: 'Erros de digitação permitidos',
    fuzzies: ['Nenhum', '1 letra', '2 letras'],
    highlight: 'Destaques',
    limit: 'Resultados',
    vectorPath: 'Campo vetorial',
    source: 'Vetor',
    sources: { paste: 'Colado', document: 'Como um documento' },
    vector: 'Vetor de consulta (números)',
    fromDoc: 'Documento',
    reading20: 'Lendo documentos…',
    noDocs: 'A coleção não tem nenhum documento para usar como ponto de partida.',
    candidates: 'Candidatos',
    filter: 'Filtro (JSON, em campos de filtro)',
    run: 'Buscar',
    use: 'Usar em Agregações',
    handed: 'O pipeline está em Agregações.',
    noQuery: 'Digite o que deseja buscar.',
    badLimit: `Os resultados vão de 1 a ${MAX_LIMIT}.`,
    badCandidates: `Os candidatos são no mínimo o número de resultados e no máximo ${formatNumber(MAX_CANDIDATES, 'pt', 0)}.`,
    badVector: 'Informe o vetor de consulta como números: [0.1, 0.2, …] ou 0.1, 0.2, …',
    dimensions: (n: number) =>
      `Os vetores deste índice têm ${num(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'dimensão' : 'dimensões'}.`,
    noDocVector: (path: string) => `Este documento não contém uma lista de números em ${path}.`,
    badFilter: 'O filtro é um objeto JSON, como { "year": { "$gte": 2000 } }.',
    noText: 'Este índice não mapeia nenhum campo de texto: não há nada para buscar.',
    restricted:
      'As regras de dados pessoais ocultam valores de você nesta coleção: o app recusa a busca aqui, pois ela poderia revelar os valores ocultos pelo que encontrasse.',
    found: (n: number) => `${num(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'resultado' : 'resultados'}`,
    nothing: 'Nada encontrado.',
    cut: 'Os resultados são grandes: só aparecem os que cabem em uma resposta à página.',
    score: 'Pontuação',
    more: (n: number) => `mais ${num(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'campo' : 'campos'}`,
  },
  ko: {
    title: '검색',
    description: (coll: string) => `${coll}의 검색 인덱스에서 전체 텍스트 검색과 벡터 검색을 실행합니다.`,
    reading: '검색 인덱스를 읽는 중…',
    noPlace: '검색하려면 컬렉션을 여세요.',
    failed: '검색 인덱스를 읽을 수 없습니다: ',
    notEnabled:
      '여기에서는 검색이 활성화되어 있지 않습니다. Atlas 또는 MongoDB Search(mongot)를 설정한 자체 관리 MongoDB가 필요합니다.',
    unsupported: '이 서버는 검색 인덱스를 지원하지 않습니다.',
    none: '이 컬렉션에는 검색 인덱스가 없습니다. 인덱스 페이지에서 만든 뒤 다시 돌아오세요.',
    index: '인덱스',
    kinds: { search: '전체 텍스트', vectorSearch: '벡터' },
    notQueryable: (status: string) =>
      `이 인덱스는 아직 쿼리할 수 없습니다(${status}). READY 상태가 될 때까지 기다리세요.`,
    query: '검색어',
    path: '검색 대상',
    all: '모든 필드',
    fuzzy: '허용할 오타',
    fuzzies: ['없음', '1글자', '2글자'],
    highlight: '강조 표시',
    limit: '결과 수',
    vectorPath: '벡터 필드',
    source: '벡터',
    sources: { paste: '붙여넣기', document: '도큐먼트와 유사' },
    vector: '쿼리 벡터(숫자)',
    fromDoc: '도큐먼트',
    reading20: '도큐먼트를 읽는 중…',
    noDocs: '기준으로 삼을 도큐먼트가 컬렉션에 없습니다.',
    candidates: '후보 수',
    filter: '필터(JSON, 필터 필드 대상)',
    run: '검색',
    use: '집계에서 사용',
    handed: '파이프라인을 집계로 보냈습니다.',
    noQuery: '검색할 내용을 입력하세요.',
    badLimit: `결과 수는 1에서 ${MAX_LIMIT} 사이여야 합니다.`,
    badCandidates: `후보 수는 결과 수 이상, 최대 ${formatNumber(MAX_CANDIDATES, 'ko', 0)}까지입니다.`,
    badVector: '쿼리 벡터를 숫자로 입력하세요: [0.1, 0.2, …] 또는 0.1, 0.2, …',
    dimensions: (n: number) => `이 인덱스의 벡터는 ${n}차원입니다.`,
    noDocVector: (path: string) => `이 도큐먼트의 ${path}에는 숫자 목록이 없습니다.`,
    badFilter: '필터는 JSON 객체여야 합니다. 예: { "year": { "$gte": 2000 } }.',
    noText: '이 인덱스에는 매핑된 텍스트 필드가 없습니다. 검색할 대상이 없습니다.',
    restricted:
      '개인 데이터 규칙에 따라 이 컬렉션의 일부 값이 숨겨져 있습니다. 검색 결과로 숨겨진 값을 유추할 수 있으므로 앱은 여기서 검색을 거부합니다.',
    found: (n: number) => `결과 ${n}개`,
    nothing: '찾은 항목이 없습니다.',
    cut: '결과가 커서 페이지로 가는 한 번의 응답에 담기는 결과만 보여 줍니다.',
    score: '점수',
    more: (n: number) => `필드 ${n}개 더`,
  },
  de: {
    title: 'Suche',
    description: (coll: string) => `Volltext- und Vektorsuche in den Suchindizes von ${coll}.`,
    reading: 'Suchindizes werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um darin zu suchen.',
    failed: 'Die Suchindizes konnten nicht gelesen werden: ',
    notEnabled:
      'Die Suche ist hier nicht aktiviert: Sie erfordert Atlas oder ein selbst betriebenes MongoDB mit eingerichtetem MongoDB Search (mongot).',
    unsupported: 'Dieser Server unterstützt keine Suchindizes.',
    none: 'Diese Collection hat keinen Suchindex: Erstellen Sie auf der Seite „Indizes“ einen und kehren Sie dann zurück.',
    index: 'Index',
    kinds: { search: 'Volltext', vectorSearch: 'Vektor' },
    notQueryable: (status: string) =>
      `Dieser Index kann noch nicht abgefragt werden (${status}): Warten Sie, bis er READY ist.`,
    query: 'Suchbegriff',
    path: 'In',
    all: 'Alle Felder',
    fuzzy: 'Erlaubte Tippfehler',
    fuzzies: ['Keine', '1 Buchstabe', '2 Buchstaben'],
    highlight: 'Hervorhebungen',
    limit: 'Ergebnisse',
    vectorPath: 'Vektorfeld',
    source: 'Vektor',
    sources: { paste: 'Eingefügt', document: 'Wie ein Dokument' },
    vector: 'Abfragevektor (Zahlen)',
    fromDoc: 'Dokument',
    reading20: 'Dokumente werden gelesen…',
    noDocs: 'Die Collection enthält kein Dokument als Ausgangspunkt.',
    candidates: 'Kandidaten',
    filter: 'Filter (JSON, auf Filterfeldern)',
    run: 'Suchen',
    use: 'In Aggregationen verwenden',
    handed: 'Die Pipeline ist in Aggregationen.',
    noQuery: 'Geben Sie einen Suchbegriff ein.',
    badLimit: `Die Anzahl der Ergebnisse liegt zwischen 1 und ${MAX_LIMIT}.`,
    badCandidates: `Die Anzahl der Kandidaten beträgt mindestens so viele wie Ergebnisse und höchstens ${formatNumber(MAX_CANDIDATES, 'de', 0)}.`,
    badVector: 'Geben Sie den Abfragevektor als Zahlen an: [0.1, 0.2, …] oder 0.1, 0.2, …',
    dimensions: (n: number) =>
      `Die Vektoren dieses Index haben ${num(n, 'de')} ${pluralOf(n, 'de') === 'one' ? 'Dimension' : 'Dimensionen'}.`,
    noDocVector: (path: string) => `Dieses Dokument enthält unter ${path} keine Zahlenliste.`,
    badFilter: 'Der Filter ist ein JSON-Objekt, zum Beispiel { "year": { "$gte": 2000 } }.',
    noText: 'Dieser Index bildet kein Textfeld ab: Es gibt nichts zu durchsuchen.',
    restricted:
      'Regeln für personenbezogene Daten verbergen in dieser Collection Werte vor Ihnen: Die App lehnt hier eine Suche ab, da sich verborgene Werte aus den Treffern erschließen ließen.',
    found: (n: number) => `${num(n, 'de')} ${pluralOf(n, 'de') === 'one' ? 'Ergebnis' : 'Ergebnisse'}`,
    nothing: 'Nichts gefunden.',
    cut: 'Die Ergebnisse sind groß: Gezeigt werden nur die, die in eine Antwort an die Seite passen.',
    score: 'Score',
    more: (n: number) =>
      pluralOf(n, 'de') === 'one' ? `${num(n, 'de')} weiteres Feld` : `${num(n, 'de')} weitere Felder`,
  },
  fr: {
    title: 'Recherche',
    description: (coll: string) =>
      `Recherche en texte intégral et recherche vectorielle dans les index de recherche de ${coll}.`,
    reading: 'Lecture des index de recherche…',
    noPlace: 'Ouvrez une collection pour y effectuer une recherche.',
    failed: 'Impossible de lire les index de recherche : ',
    notEnabled:
      'La recherche n’est pas activée ici : elle nécessite Atlas, ou un MongoDB autogéré avec MongoDB Search (mongot) configuré.',
    unsupported: 'Ce serveur ne prend pas en charge les index de recherche.',
    none: 'Cette collection n’a aucun index de recherche : créez-en un sur sa page Index, puis revenez.',
    index: 'Index',
    kinds: { search: 'Texte intégral', vectorSearch: 'Vectoriel' },
    notQueryable: (status: string) =>
      `Cet index ne peut pas encore être interrogé (${status}) : attendez qu’il soit READY.`,
    query: 'Rechercher',
    path: 'Dans',
    all: 'Tous les champs',
    fuzzy: 'Fautes de frappe tolérées',
    fuzzies: ['Aucune', '1 lettre', '2 lettres'],
    highlight: 'Surlignages',
    limit: 'Résultats',
    vectorPath: 'Champ vectoriel',
    source: 'Vecteur',
    sources: { paste: 'Collé', document: 'Comme un document' },
    vector: 'Vecteur de requête (nombres)',
    fromDoc: 'Document',
    reading20: 'Lecture des documents…',
    noDocs: 'La collection ne contient aucun document de départ.',
    candidates: 'Candidats',
    filter: 'Filtre (JSON, sur les champs de filtre)',
    run: 'Rechercher',
    use: 'Utiliser dans Agrégations',
    handed: 'Le pipeline est dans Agrégations.',
    noQuery: 'Saisissez ce qu’il faut rechercher.',
    badLimit: `Le nombre de résultats est compris entre 1 et ${MAX_LIMIT}.`,
    badCandidates: `Le nombre de candidats est au moins égal à celui des résultats et au plus de ${formatNumber(MAX_CANDIDATES, 'fr', 0)}.`,
    badVector: 'Indiquez le vecteur de requête sous forme de nombres : [0.1, 0.2, …] ou 0.1, 0.2, …',
    dimensions: (n: number) =>
      `Les vecteurs de cet index ont ${num(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'dimension' : 'dimensions'}.`,
    noDocVector: (path: string) => `Ce document ne contient aucune liste de nombres à ${path}.`,
    badFilter: 'Le filtre est un objet JSON, par exemple { "year": { "$gte": 2000 } }.',
    noText: 'Cet index ne mappe aucun champ texte : il n’y a rien à rechercher.',
    restricted:
      'Les règles relatives aux données personnelles vous masquent des valeurs dans cette collection : l’application refuse ici la recherche, car elle pourrait révéler les valeurs masquées d’après ce qu’elle trouve.',
    found: (n: number) => `${num(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'résultat' : 'résultats'}`,
    nothing: 'Aucun résultat.',
    cut: 'Les résultats sont volumineux : seuls ceux qui tiennent dans une réponse à la page sont affichés.',
    score: 'Score',
    more: (n: number) => `${num(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'champ' : 'champs'} de plus`,
  },
  ru: {
    title: 'Поиск',
    description: (coll: string) =>
      `Полнотекстовый и векторный поиск по поисковым индексам коллекции ${coll}.`,
    reading: 'Чтение поисковых индексов…',
    noPlace: 'Откройте коллекцию, чтобы искать в ней.',
    failed: 'Не удалось прочитать поисковые индексы: ',
    notEnabled:
      'Поиск здесь не включен: нужен Atlas или самостоятельно развернутая MongoDB с настроенным MongoDB Search (mongot).',
    unsupported: 'Этот сервер не поддерживает поисковые индексы.',
    none: 'В этой коллекции нет поискового индекса: создайте его на странице «Индексы» и вернитесь.',
    index: 'Индекс',
    kinds: { search: 'Полнотекстовый', vectorSearch: 'Векторный' },
    notQueryable: (status: string) =>
      `Этот индекс пока нельзя использовать для запросов (${status}): дождитесь состояния READY.`,
    query: 'Что искать',
    path: 'Где',
    all: 'Все поля',
    fuzzy: 'Допустимые опечатки',
    fuzzies: ['Нет', '1 буква', '2 буквы'],
    highlight: 'Подсветка',
    limit: 'Результатов',
    vectorPath: 'Векторное поле',
    source: 'Вектор',
    sources: { paste: 'Вставленный', document: 'Как у документа' },
    vector: 'Вектор запроса (числа)',
    fromDoc: 'Документ',
    reading20: 'Чтение документов…',
    noDocs: 'В коллекции нет документа, от которого можно отталкиваться.',
    candidates: 'Кандидатов',
    filter: 'Фильтр (JSON, по полям фильтра)',
    run: 'Искать',
    use: 'Использовать в агрегациях',
    handed: 'Конвейер передан в агрегации.',
    noQuery: 'Введите, что искать.',
    badLimit: `Количество результатов — от 1 до ${MAX_LIMIT}.`,
    badCandidates: `Количество кандидатов — не меньше числа результатов и не больше ${formatNumber(MAX_CANDIDATES, 'ru', 0)}.`,
    badVector: 'Укажите вектор запроса в виде чисел: [0.1, 0.2, …] или 0.1, 0.2, …',
    dimensions: (n: number) =>
      `Векторы этого индекса имеют ${num(n, 'ru')} ${ruWord(n, ['измерение', 'измерения', 'измерений'])}.`,
    noDocVector: (path: string) => `В этом документе по пути ${path} нет списка чисел.`,
    badFilter: 'Фильтр — это JSON-объект, например { "year": { "$gte": 2000 } }.',
    noText: 'Этот индекс не сопоставляет ни одного текстового поля: искать не в чем.',
    restricted:
      'Правила защиты персональных данных скрывают от вас значения в этой коллекции: приложение отклоняет здесь поиск, так как по найденному можно было бы определить скрытые значения.',
    found: (n: number) => `${num(n, 'ru')} ${ruWord(n, ['результат', 'результата', 'результатов'])}`,
    nothing: 'Ничего не найдено.',
    cut: 'Результаты большие: показаны только те, что помещаются в один ответ странице.',
    score: 'Оценка',
    more: (n: number) => `еще ${num(n, 'ru')} ${ruWord(n, ['поле', 'поля', 'полей'])}`,
  },
} satisfies Record<Language, Text>

type Doc = Record<string, unknown>
type Source = 'paste' | 'document'

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' = 'reading'
  let failure: unknown = null
  let list: SearchIndexList | null = null
  let chosen = ''
  // The form, kept across redraws.
  let query = ''
  let path = ALL
  let fuzzy: 0 | 1 | 2 = 0
  let highlight = true
  let limit = '20'
  let vectorPath = ''
  let source: Source = 'paste'
  let pasted = ''
  let samples: Doc[] | null = null
  let sampleAt = 0
  let candidates = '200'
  let filter = ''
  let problem: string | null = null
  let running = false
  let results: Doc[] | null = null
  /** Fewer results than asked came, to fit one answer to the page (user report 2026-11-07). */
  let resultsCut = false

  const header = pageHeader({ icon: 'search', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body sp-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  const index = (): SearchIndex | undefined =>
    list?.supported ? list.indexes.find((i) => i.name === chosen) : undefined

  /** The pipeline the form asks for, or why it is not one. */
  function pipeline(): { stages: Array<Record<string, unknown>>; limit: number } | { problem: string } {
    const i = index()
    if (!i) return { problem: text.none }
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { problem: text.badLimit }
    if (i.type === 'search') {
      if (!query.trim()) return { problem: text.noQuery }
      const paths = textPaths(i).filter((p) => p !== ALL)
      // Final review Minor 15: an index mapping no text field has nothing to search in.
      if (!i.dynamic && !paths.length) return { problem: text.noText }
      const where = path !== ALL ? path : i.dynamic ? ALL : paths
      return {
        stages: searchPipeline({ index: i.name, query, path: where, fuzzy, highlight, limit: n }),
        limit: n,
      }
    }
    const field = vectorPaths(i).find((v) => v.path === vectorPath) ?? vectorPaths(i)[0]
    if (!field) return { problem: text.none }
    let vector: number[] | null
    if (source === 'document') {
      const doc = samples?.[sampleAt]
      if (!doc) return { problem: text.noDocs }
      vector = vectorOf(valueAt(doc, field.path))
      if (!vector) return { problem: text.noDocVector(field.path) }
    } else {
      vector = vectorOf(pasted)
      if (!vector) return { problem: text.badVector }
    }
    if (field.numDimensions !== null && vector.length !== field.numDimensions)
      return { problem: text.dimensions(field.numDimensions) }
    const c = Number(candidates)
    if (!Number.isInteger(c) || c < n || c > MAX_CANDIDATES) return { problem: text.badCandidates }
    const f = filterOf(filter)
    if (!f.ok) return { problem: text.badFilter }
    return {
      stages: vectorPipeline({
        index: i.name,
        path: field.path,
        vector,
        numCandidates: c,
        limit: n,
        filter: f.filter,
      }),
      limit: n,
    }
  }

  async function run(): Promise<void> {
    status.textContent = ''
    const asked = pipeline()
    if ('problem' in asked) return void ((problem = asked.problem), render())
    problem = null
    running = true
    render()
    try {
      // User report 2026-11-07: large documents (API logs) come as many as one answer holds, and the
      // page says the rest were left out — asked for all, they were refused.
      const answer = await client.ask<{ documents: Doc[]; cut?: boolean }>('documents.aggregate', {
        pipeline: asked.stages,
        limit: asked.limit,
        fit: true,
      })
      results = answer.documents
      resultsCut = answer.cut === true
    } catch (e) {
      status.textContent = askMessage(e, locale)
    } finally {
      running = false
    }
    render('run')
  }

  async function use(): Promise<void> {
    status.textContent = ''
    const asked = pipeline()
    if ('problem' in asked) return void ((problem = asked.problem), render())
    problem = null
    render()
    try {
      await client.ask('ui.useAggregation', { stages: asked.stages })
      status.textContent = text.handed
    } catch (e) {
      status.textContent = askMessage(e, locale)
    }
  }

  async function readSamples(): Promise<void> {
    if (samples) return
    try {
      // User report 2026-11-07: of large documents, as many as one answer holds.
      samples = (await client.ask<{ documents: Doc[] }>('documents.find', { limit: SAMPLES, fit: true }))
        .documents
    } catch (e) {
      samples = []
      status.textContent = askMessage(e, locale)
    }
    render()
  }

  const labelled = (label: string, control: HTMLElement) =>
    h('label', { class: 'sp-label' }, h('span', { text: label }), control)
  const input = (id: string, value: string, on: (v: string) => void, attrs: Record<string, string> = {}) => {
    const el = h('input', {
      id,
      class: 'mm-input',
      attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs },
    })
    el.value = value
    el.addEventListener('input', () => on(el.value))
    return el
  }
  const area = (id: string, value: string, on: (v: string) => void) => {
    const el = h('textarea', {
      id,
      class: 'mm-input mm-mono sp-area',
      attrs: { rows: '3', spellcheck: 'false' },
    })
    el.value = value
    el.addEventListener('input', () => on(el.value))
    return el
  }
  const select = (id: string, options: Array<[string, string]>, value: string, on: (v: string) => void) => {
    const el = h('select', { id, class: 'mm-select' })
    for (const [v, label] of options) el.append(h('option', { attrs: { value: v }, text: label }))
    el.value = value
    el.addEventListener('change', () => on(el.value))
    return el
  }

  function form(i: SearchIndex): HTMLElement {
    const fields: HTMLElement[] = []
    if (i.type === 'search') {
      const paths = textPaths(i).filter((p) => p !== ALL)
      fields.push(
        labelled(
          text.query,
          input('query', query, (v) => (query = v), { type: 'search' }),
        ),
        labelled(
          text.path,
          select(
            'path',
            [[ALL, text.all], ...paths.map((p): [string, string] => [p, p])],
            path,
            (v) => (path = v),
          ),
        ),
        labelled(
          text.fuzzy,
          select(
            'fuzzy',
            text.fuzzies.map((label, n): [string, string] => [String(n), label]),
            String(fuzzy),
            (v) => {
              fuzzy = Number(v) as 0 | 1 | 2
            },
          ),
        ),
        switchControl({
          label: text.highlight,
          checked: highlight,
          id: 'highlight',
          onChange: (v) => (highlight = v),
        }).el,
      )
    } else {
      const vectors = vectorPaths(i)
      if (!vectors.some((v) => v.path === vectorPath)) vectorPath = vectors[0]?.path ?? ''
      fields.push(
        labelled(
          text.vectorPath,
          select(
            'vector-path',
            vectors.map((v): [string, string] => [
              v.path,
              v.numDimensions ? `${v.path} (${v.numDimensions})` : v.path,
            ]),
            vectorPath,
            (v) => (vectorPath = v),
          ),
        ),
        h(
          'div',
          { class: 'sp-label' },
          h('span', { text: text.source }),
          segmented<Source>({
            label: text.source,
            id: 'source',
            options: [
              { value: 'paste', label: text.sources.paste },
              { value: 'document', label: text.sources.document },
            ],
            value: source,
            onChange: (v) => {
              source = v
              render()
              if (v === 'document') void readSamples()
            },
          }).el,
        ),
      )
      if (source === 'paste')
        fields.push(
          labelled(
            text.vector,
            area('vector', pasted, (v) => (pasted = v)),
          ),
        )
      else if (!samples) fields.push(h('p', { class: 'sp-muted', text: text.reading20 }))
      else if (!samples.length) fields.push(h('p', { class: 'sp-muted', text: text.noDocs }))
      else
        fields.push(
          labelled(
            text.fromDoc,
            select(
              'from-doc',
              samples.map((d, n): [string, string] => [String(n), describeValue(d._id).text.slice(0, 60)]),
              String(sampleAt),
              (v) => (sampleAt = Number(v)),
            ),
          ),
        )
      fields.push(
        labelled(
          text.candidates,
          input('candidates', candidates, (v) => (candidates = v), { inputmode: 'numeric' }),
        ),
        labelled(
          text.filter,
          area('filter', filter, (v) => (filter = v)),
        ),
      )
    }
    fields.push(
      labelled(
        text.limit,
        input('limit', limit, (v) => (limit = v), { inputmode: 'numeric' }),
      ),
    )
    const go = button({
      label: text.run,
      icon: 'search',
      variant: 'primary',
      id: 'run',
      onClick: () => void run(),
    })
    setBusy(go, running)
    if (!i.queryable) go.disabled = true
    const hand = button({ label: text.use, icon: 'external', id: 'use', onClick: () => void use() })
    if (!i.queryable) hand.disabled = true
    return h(
      'section',
      { class: 'sp-form' },
      h('div', { class: 'sp-grid' }, ...fields),
      h('div', { class: 'sp-actions' }, go, hand),
      h(
        'p',
        { id: 'form-error', class: 'sp-error', attrs: { role: 'alert' }, hidden: !problem },
        problem ?? '',
      ),
    )
  }

  function resultView(doc: Doc): HTMLElement {
    const score = scoreOf(doc._score)
    const marks = highlightParts(doc._highlights)
    const keys = Object.keys(doc).filter((k) => k !== '_score' && k !== '_highlights')
    const visible = keys.slice(0, PREVIEW_FIELDS)
    const el = h(
      'article',
      { class: 'sp-result' },
      h(
        'div',
        { class: 'sp-result-head' },
        score === null
          ? null
          : badge(`${text.score} ${formatNumber(score, shown(TEXT, locale), 3)}`, 'accent'),
        doc._id === undefined ? null : valueView(doc._id, 40),
      ),
      ...marks.map((m) =>
        h(
          'p',
          { class: 'sp-highlight' },
          h('span', { class: 'sp-muted mm-mono', text: `${m.path}: ` }),
          ...m.parts.map((p) => (p.hit ? h('mark', { text: p.text }) : document.createTextNode(p.text))),
        ),
      ),
      h(
        'dl',
        { class: 'sp-fields' },
        ...visible
          .filter((k) => k !== '_id')
          .flatMap((k) => [h('dt', { class: 'mm-mono', text: k }), h('dd', {}, valueView(doc[k], 120))]),
      ),
      keys.length > PREVIEW_FIELDS
        ? h('p', { class: 'sp-muted', text: text.more(keys.length - PREVIEW_FIELDS) })
        : null,
    )
    el.dataset.result = ''
    return el
  }

  function render(next?: string): void {
    // Final review Minor 15: the focus given back after a redraw (by id), or to `next` where that
    // had none (a button busy meanwhile).
    const had = (document.activeElement as HTMLElement | null)?.id || next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    body.replaceChildren()
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'search', title: text.noPlace }))
    if (phase === 'failed')
      return void body.append(callout('danger', text.failed + askMessage(failure, locale)))
    if (phase === 'reading' || !list)
      return void body.append(h('p', { class: 'sp-muted', text: text.reading }), skeleton(4))
    if (!list.supported)
      return void body.append(
        emptyState({
          icon: 'search',
          title: list.reason === 'not_enabled' ? text.notEnabled : text.unsupported,
          tone: 'warning',
        }),
      )
    if (!list.indexes.length) return void body.append(emptyState({ icon: 'search', title: text.none }))
    const i = index() ?? list.indexes[0]!
    chosen = i.name
    const picker = select(
      'index',
      list.indexes.map((x): [string, string] => [
        x.name,
        `${x.name} · ${text.kinds[x.type]}${x.queryable ? '' : ` · ${x.status}`}`,
      ]),
      chosen,
      (v) => {
        chosen = v
        problem = null
        results = null
        render()
      },
    )
    // Final review Minor 15: where personal data rules reach the user, MongoDB is never asked.
    if (ctx?.place?.hidden?.length) body.append(callout('info', text.restricted))
    body.append(
      h(
        'div',
        { class: 'sp-row' },
        labelled(text.index, picker),
        badge(text.kinds[i.type], 'info'),
        badge(i.status, i.queryable ? 'success' : 'warning'),
      ),
      ...(i.queryable ? [] : [callout('warning', text.notQueryable(i.status))]),
      form(i),
    )
    if (results)
      body.append(
        h(
          'section',
          { id: 'results', class: 'sp-results', attrs: { 'aria-label': text.found(results.length) } },
          h('p', { class: 'sp-muted', text: results.length ? text.found(results.length) : text.nothing }),
          ...(resultsCut ? [callout('info', text.cut)] : []),
          ...results.map(resultView),
        ),
      )
    if (had) body.querySelector<HTMLElement>(`#${CSS.escape(had)}`)?.focus()
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
      else {
        render()
        list = await client.ask<SearchIndexList>('searchIndexes.list')
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
