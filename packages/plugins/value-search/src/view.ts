// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import {
  askMessage,
  type PipelineDocuments,
  type PluginClient,
  type PluginContext,
} from '../../kit/src/client'
import {
  applyLook,
  langTag,
  pluralOf,
  pick as pickText,
  shown,
  type Language,
  button,
  chip,
  emptyState,
  formatNumber,
  h,
  icon,
  pageHeader,
  segmented,
  serialAsk,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
  switchControl,
  valueView,
} from '../../kit/src/ui'
import {
  buildSearch,
  facetsOf,
  matchedIn,
  matchingNames,
  previewOf,
  searchPaths,
  type Doc,
  type Mode,
  type SearchError,
} from './search'

/**
 * Value search (plugins wave 2; redesigned 2026-10-10, spec plugin-tabs-redesign §2.1): a text,
 * number, date or ObjectId looked for in every field the collection's documents hold — in the whole
 * collection unless the user picks the Documents filter; each hit says which document it is and
 * which fields matched; the fields found narrow the list; the search can go to Documents.
 */
export const LIMIT = 100
/** How many documents the fields are read from (a random sample). */
const SAMPLE = 200
/** Russian counts documents in three forms (в 1 документ, в 3 документа, в 17 документов). */
const RU_DOCUMENTS: Record<Intl.LDMLPluralRule, string> = {
  zero: 'документов',
  one: 'документ',
  two: 'документа',
  few: 'документа',
  many: 'документов',
  other: 'документа',
}
const MODES: Mode[] = ['contains', 'exact', 'regex']
type Scope = 'whole' | 'filter'
/** Where the results shown were searched: a filter since changed is an earlier one. */
type Where = Scope | 'earlier'
/** A count's plural category in the shown language (the kit's pluralOf). */
type Plural = Intl.LDMLPluralRule

const TEXT = {
  en: {
    title: 'Value search',
    description: (coll: string) => `Find a text, number, date or ObjectId in every field of ${coll}.`,
    term: 'Search for',
    placeholder: 'A text, a number, a date (2026-01-05) or an ObjectId',
    clear: 'Clear',
    modes: { contains: 'Contains', exact: 'Whole value', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'How to match',
    find: 'Search',
    ignoreCase: 'Ignore letter case',
    names: 'Also match field names',
    scopeLabel: 'Where to look',
    scopes: { whole: 'Whole collection', filter: 'Documents filter' } satisfies Record<Scope, string>,
    readingFields: 'Reading the fields…',
    searching: 'Searching…',
    emptyTitle: 'Search every field at once',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Type what you are looking for; ${scope === 'whole' ? 'every document of the collection is' : 'the documents the Documents filter keeps are'} searched, in ${paths ? `all ${paths} fields` : 'every field'}. The fields are read from a sample of ${sample} ${new Intl.PluralRules('en').select(sample) === 'one' ? 'document' : 'documents'}.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${cat === 'one' ? 'document' : 'documents'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${cat === 'one' ? 'field' : 'fields'} · ${{ whole: 'whole collection', filter: 'within the Documents filter', earlier: 'within an earlier Documents filter' }[where]}`,
    noneTitle: 'Nothing found',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const fields = `${paths} ${cat === 'one' ? 'field' : 'fields'}`
      return {
        filter: `Looked in ${fields} of the documents the Documents filter keeps. Search the whole collection, or try Contains.`,
        earlier: `Looked in ${fields} of the documents an earlier Documents filter kept. Search the whole collection, or try Contains.`,
        whole: `Looked in ${fields} of the whole collection. Try Contains, or another spelling.`,
      }[where]
    },
    searchWhole: 'Search the whole collection',
    errors: {
      empty: 'Type what to look for.',
      tooLong: 'A regular expression is at most 200 characters.',
      badRegex: 'This regular expression is not valid.',
      noPaths: 'No field was found in a sample of this collection.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Field names holding it:',
    noNames: 'No field name holds it.',
    show: 'Show in Documents',
    showHint: 'Puts this search in the Documents query',
    open: 'Open',
    allFields: 'All fields',
    columns: { document: 'Document', matched: 'Matched' },
    noPlace: 'Open a collection to search it.',
    failed: 'The search could not run: ',
    fieldsFailed: 'The fields could not be read from a sample: ',
    retry: 'Try again',
    more: (n: number) => `+${n} more`,
  },
  tr: {
    title: 'Değer arama',
    description: (coll: string) =>
      `${coll} koleksiyonunun her alanında metin, sayı, tarih ya da ObjectId bulun.`,
    term: 'Aranacak',
    placeholder: 'Bir metin, sayı, tarih (2026-01-05) ya da ObjectId',
    clear: 'Temizle',
    modes: { contains: 'İçerir', exact: 'Tam değer', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Nasıl eşleşsin',
    find: 'Ara',
    ignoreCase: 'Büyük/küçük harfi yok say',
    names: 'Alan adlarında da ara',
    scopeLabel: 'Nerede aransın',
    scopes: { whole: 'Tüm koleksiyon', filter: 'Belgeler filtresi' } satisfies Record<Scope, string>,
    readingFields: 'Alanlar okunuyor…',
    searching: 'Aranıyor…',
    emptyTitle: 'Bütün alanlarda tek seferde arayın',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Aradığınızı yazın; ${scope === 'whole' ? 'koleksiyonun bütün belgelerinde' : 'Belgeler filtresine uyan belgelerde'}, ${paths ? `${paths} alanın hepsinde` : 'bütün alanlarda'} aranır. Alanlar ${sample} belgelik bir örnekten okunur.`,
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''} belge`,
    inFields: (paths: number, where: Where) =>
      `${paths} alan · ${{ whole: 'tüm koleksiyon', filter: 'Belgeler filtresi içinde', earlier: 'önceki Belgeler filtresi içinde' }[where]}`,
    noneTitle: 'Hiçbir şey bulunamadı',
    noneHint: (paths: number, where: Where) =>
      ({
        filter: `Belgeler filtresine uyan belgelerin ${paths} alanına bakıldı. Tüm koleksiyonda arayın ya da İçerir'i deneyin.`,
        earlier: `Önceki Belgeler filtresine uyan belgelerin ${paths} alanına bakıldı. Tüm koleksiyonda arayın ya da İçerir'i deneyin.`,
        whole: `Tüm koleksiyonun ${paths} alanına bakıldı. İçerir'i ya da başka bir yazımı deneyin.`,
      })[where],
    searchWhole: 'Tüm koleksiyonda ara',
    errors: {
      empty: 'Ne aranacağını yazın.',
      tooLong: 'Bir düzenli ifade en fazla 200 karakterdir.',
      badRegex: 'Bu düzenli ifade geçerli değil.',
      noPaths: 'Bu koleksiyonun bir örneğinde hiçbir alan bulunamadı.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Bunu taşıyan alan adları:',
    noNames: 'Bunu taşıyan bir alan adı yok.',
    show: 'Belgelerde göster',
    showHint: 'Bu aramayı Belgeler sorgusuna koyar',
    open: 'Aç',
    allFields: 'Bütün alanlar',
    columns: { document: 'Belge', matched: 'Eşleşen' },
    noPlace: 'Aramak için bir koleksiyon açın.',
    failed: 'Arama yapılamadı: ',
    fieldsFailed: 'Alanlar bir örnekten okunamadı: ',
    retry: 'Yeniden dene',
    more: (n: number) => `+${n} daha`,
  },
  zh: {
    title: '值搜索',
    description: (coll: string) => `在 ${coll} 的每个字段中查找文本、数字、日期或 ObjectId。`,
    term: '搜索内容',
    placeholder: '文本、数字、日期（2026-01-05）或 ObjectId',
    clear: '清除',
    modes: { contains: '包含', exact: '完整值', regex: '正则' } satisfies Record<Mode, string>,
    modeLabel: '匹配方式',
    find: '搜索',
    ignoreCase: '忽略大小写',
    names: '同时匹配字段名',
    scopeLabel: '搜索范围',
    scopes: { whole: '整个集合', filter: '文档筛选' } satisfies Record<Scope, string>,
    readingFields: '正在读取字段…',
    searching: '正在搜索…',
    emptyTitle: '一次搜索所有字段',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `输入要查找的内容；将在${scope === 'whole' ? '集合的所有文档' : '文档筛选保留的文档'}中，对${paths ? `全部 ${paths} 个字段` : '所有字段'}进行搜索。字段读取自 ${sample} 个文档的样本。`,
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''} 个文档`,
    inFields: (paths: number, where: Where) =>
      `${paths} 个字段 · ${{ whole: '整个集合', filter: '在文档筛选范围内', earlier: '在之前的文档筛选范围内' }[where]}`,
    noneTitle: '未找到任何内容',
    noneHint: (paths: number, where: Where) =>
      ({
        filter: `已在文档筛选保留的文档的 ${paths} 个字段中查找。请搜索整个集合，或尝试“包含”。`,
        earlier: `已在之前的文档筛选保留的文档的 ${paths} 个字段中查找。请搜索整个集合，或尝试“包含”。`,
        whole: `已在整个集合的 ${paths} 个字段中查找。请尝试“包含”，或换一种写法。`,
      })[where],
    searchWhole: '搜索整个集合',
    errors: {
      empty: '输入要查找的内容。',
      tooLong: '正则表达式最多 200 个字符。',
      badRegex: '此正则表达式无效。',
      noPaths: '在此集合的样本中未找到任何字段。',
    } satisfies Record<SearchError, string>,
    namesFound: '包含它的字段名：',
    noNames: '没有字段名包含它。',
    show: '在文档中显示',
    showHint: '将此搜索放入文档查询',
    open: '打开',
    allFields: '所有字段',
    columns: { document: '文档', matched: '匹配' },
    noPlace: '打开集合后才能搜索。',
    failed: '无法执行搜索：',
    fieldsFailed: '无法从样本中读取字段：',
    retry: '重试',
    more: (n: number) => `另有 ${n} 项`,
  },
  ja: {
    title: '値の検索',
    description: (coll: string) =>
      `${coll} のすべてのフィールドからテキスト、数値、日付、ObjectId を探します。`,
    term: '検索する内容',
    placeholder: 'テキスト、数値、日付（2026-01-05）、ObjectId',
    clear: 'クリア',
    modes: { contains: '含む', exact: '完全一致', regex: '正規表現' } satisfies Record<Mode, string>,
    modeLabel: '一致の方法',
    find: '検索',
    ignoreCase: '大文字と小文字を区別しない',
    names: 'フィールド名も対象にする',
    scopeLabel: '検索範囲',
    scopes: { whole: 'コレクション全体', filter: 'ドキュメントのフィルター' } satisfies Record<Scope, string>,
    readingFields: 'フィールドを読み込み中…',
    searching: '検索中…',
    emptyTitle: 'すべてのフィールドをまとめて検索',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `探したい内容を入力してください。${scope === 'whole' ? 'コレクションのすべてのドキュメント' : 'ドキュメントのフィルターで絞り込まれたドキュメント'}の${paths ? `全 ${paths} フィールド` : 'すべてのフィールド'}が検索対象です。フィールドは ${sample} 件のドキュメントのサンプルから読み取ります。`,
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''} 件のドキュメント`,
    inFields: (paths: number, where: Where) =>
      `${paths} フィールド · ${{ whole: 'コレクション全体', filter: 'ドキュメントのフィルター内', earlier: '以前のドキュメントのフィルター内' }[where]}`,
    noneTitle: '見つかりませんでした',
    noneHint: (paths: number, where: Where) =>
      ({
        filter: `ドキュメントのフィルターで絞り込まれたドキュメントの ${paths} フィールドを調べました。コレクション全体を検索するか、「含む」をお試しください。`,
        earlier: `以前のドキュメントのフィルターで絞り込まれたドキュメントの ${paths} フィールドを調べました。コレクション全体を検索するか、「含む」をお試しください。`,
        whole: `コレクション全体の ${paths} フィールドを調べました。「含む」か、別の表記をお試しください。`,
      })[where],
    searchWhole: 'コレクション全体を検索',
    errors: {
      empty: '検索する内容を入力してください。',
      tooLong: '正規表現は 200 文字以内で指定してください。',
      badRegex: 'この正規表現は無効です。',
      noPaths: 'このコレクションのサンプルにフィールドが見つかりませんでした。',
    } satisfies Record<SearchError, string>,
    namesFound: '該当するフィールド名：',
    noNames: '該当するフィールド名はありません。',
    show: 'ドキュメントで表示',
    showHint: 'この検索をドキュメントのクエリに設定します',
    open: '開く',
    allFields: 'すべてのフィールド',
    columns: { document: 'ドキュメント', matched: '一致' },
    noPlace: 'コレクションを開くと検索できます。',
    failed: '検索を実行できませんでした：',
    fieldsFailed: 'サンプルからフィールドを読み取れませんでした：',
    retry: '再試行',
    more: (n: number) => `ほか ${n} 件`,
  },
  es: {
    title: 'Búsqueda de valores',
    description: (coll: string) => `Encuentra un texto, número, fecha u ObjectId en cada campo de ${coll}.`,
    term: 'Buscar',
    placeholder: 'Un texto, un número, una fecha (2026-01-05) o un ObjectId',
    clear: 'Borrar',
    modes: { contains: 'Contiene', exact: 'Valor completo', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Cómo coincidir',
    find: 'Buscar',
    ignoreCase: 'Ignorar mayúsculas y minúsculas',
    names: 'Coincidir también con nombres de campo',
    scopeLabel: 'Dónde buscar',
    scopes: { whole: 'Toda la colección', filter: 'Filtro de documentos' } satisfies Record<Scope, string>,
    readingFields: 'Leyendo los campos…',
    searching: 'Buscando…',
    emptyTitle: 'Busca en todos los campos a la vez',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Escribe lo que buscas; se busca en ${scope === 'whole' ? 'todos los documentos de la colección' : 'los documentos que conserva el filtro de documentos'}, en ${paths ? `los ${paths} campos` : 'todos los campos'}. Los campos se leen de una muestra de ${sample} ${new Intl.PluralRules('es').select(sample) === 'one' ? 'documento' : 'documentos'}.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${cat === 'one' ? 'documento' : 'documentos'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${cat === 'one' ? 'campo' : 'campos'} · ${{ whole: 'toda la colección', filter: 'dentro del filtro de documentos', earlier: 'dentro de un filtro de documentos anterior' }[where]}`,
    noneTitle: 'No se encontró nada',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const fields = `${paths} ${cat === 'one' ? 'campo' : 'campos'}`
      return {
        filter: `Se buscó en ${fields} de los documentos que conserva el filtro de documentos. Busca en toda la colección o prueba con Contiene.`,
        earlier: `Se buscó en ${fields} de los documentos que conservó un filtro de documentos anterior. Busca en toda la colección o prueba con Contiene.`,
        whole: `Se buscó en ${fields} de toda la colección. Prueba con Contiene o con otra grafía.`,
      }[where]
    },
    searchWhole: 'Buscar en toda la colección',
    errors: {
      empty: 'Escribe lo que quieres buscar.',
      tooLong: 'Una expresión regular tiene como máximo 200 caracteres.',
      badRegex: 'Esta expresión regular no es válida.',
      noPaths: 'No se encontró ningún campo en una muestra de esta colección.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Nombres de campo que lo contienen:',
    noNames: 'Ningún nombre de campo lo contiene.',
    show: 'Mostrar en Documentos',
    showHint: 'Pone esta búsqueda en la consulta de Documentos',
    open: 'Abrir',
    allFields: 'Todos los campos',
    columns: { document: 'Documento', matched: 'Coincidencia' },
    noPlace: 'Abre una colección para buscar en ella.',
    failed: 'No se pudo ejecutar la búsqueda: ',
    fieldsFailed: 'No se pudieron leer los campos de una muestra: ',
    retry: 'Reintentar',
    more: (n: number) => `+${n} más`,
  },
  pt: {
    title: 'Busca de valores',
    description: (coll: string) =>
      `Encontre um texto, número, data ou ObjectId em todos os campos de ${coll}.`,
    term: 'Buscar por',
    placeholder: 'Um texto, um número, uma data (2026-01-05) ou um ObjectId',
    clear: 'Limpar',
    modes: { contains: 'Contém', exact: 'Valor inteiro', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Como corresponder',
    find: 'Buscar',
    ignoreCase: 'Ignorar maiúsculas e minúsculas',
    names: 'Corresponder também a nomes de campo',
    scopeLabel: 'Onde buscar',
    scopes: { whole: 'Coleção inteira', filter: 'Filtro de documentos' } satisfies Record<Scope, string>,
    readingFields: 'Lendo os campos…',
    searching: 'Buscando…',
    emptyTitle: 'Busque em todos os campos de uma vez',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Digite o que procura; a busca é feita ${scope === 'whole' ? 'em todos os documentos da coleção' : 'nos documentos que o filtro de documentos mantém'}, ${paths ? `em todos os ${paths} campos` : 'em todos os campos'}. Os campos são lidos de uma amostra de ${sample} ${new Intl.PluralRules('pt').select(sample) === 'one' ? 'documento' : 'documentos'}.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${cat === 'one' ? 'documento' : 'documentos'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${cat === 'one' ? 'campo' : 'campos'} · ${{ whole: 'coleção inteira', filter: 'dentro do filtro de documentos', earlier: 'dentro de um filtro de documentos anterior' }[where]}`,
    noneTitle: 'Nada encontrado',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const checked = cat === 'one' ? `Foi verificado ${paths} campo` : `Foram verificados ${paths} campos`
      return {
        filter: `${checked} dos documentos que o filtro de documentos mantém. Busque na coleção inteira ou tente Contém.`,
        earlier: `${checked} dos documentos que um filtro de documentos anterior manteve. Busque na coleção inteira ou tente Contém.`,
        whole: `${checked} da coleção inteira. Tente Contém ou outra grafia.`,
      }[where]
    },
    searchWhole: 'Buscar na coleção inteira',
    errors: {
      empty: 'Digite o que deseja buscar.',
      tooLong: 'Uma expressão regular tem no máximo 200 caracteres.',
      badRegex: 'Esta expressão regular não é válida.',
      noPaths: 'Nenhum campo foi encontrado em uma amostra desta coleção.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Nomes de campo que o contêm:',
    noNames: 'Nenhum nome de campo o contém.',
    show: 'Mostrar em Documentos',
    showHint: 'Coloca esta busca na consulta de Documentos',
    open: 'Abrir',
    allFields: 'Todos os campos',
    columns: { document: 'Documento', matched: 'Correspondência' },
    noPlace: 'Abra uma coleção para buscar nela.',
    failed: 'Não foi possível executar a busca: ',
    fieldsFailed: 'Não foi possível ler os campos de uma amostra: ',
    retry: 'Tentar de novo',
    more: (n: number) => `+${n} mais`,
  },
  ko: {
    title: '값 검색',
    description: (coll: string) =>
      `${coll} 컬렉션의 모든 필드에서 텍스트, 숫자, 날짜 또는 ObjectId를 찾습니다.`,
    term: '검색어',
    placeholder: '텍스트, 숫자, 날짜(2026-01-05) 또는 ObjectId',
    clear: '지우기',
    modes: { contains: '포함', exact: '전체 값', regex: '정규식' } satisfies Record<Mode, string>,
    modeLabel: '일치 방식',
    find: '검색',
    ignoreCase: '대소문자 구분 안 함',
    names: '필드 이름도 일치 대상에 포함',
    scopeLabel: '검색 위치',
    scopes: { whole: '컬렉션 전체', filter: '도큐먼트 필터' } satisfies Record<Scope, string>,
    readingFields: '필드를 읽는 중…',
    searching: '검색 중…',
    emptyTitle: '모든 필드를 한 번에 검색하세요',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `찾을 내용을 입력하세요. ${scope === 'whole' ? '컬렉션의 모든 도큐먼트' : '도큐먼트 필터가 남긴 도큐먼트'}에서 ${paths ? `${paths}개 필드 전체` : '모든 필드'}를 검색합니다. 필드는 도큐먼트 ${sample}개의 샘플에서 읽습니다.`,
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''}개 도큐먼트`,
    inFields: (paths: number, where: Where) =>
      `${paths}개 필드 · ${{ whole: '컬렉션 전체', filter: '도큐먼트 필터 범위 내', earlier: '이전 도큐먼트 필터 범위 내' }[where]}`,
    noneTitle: '찾을 수 없습니다',
    noneHint: (paths: number, where: Where) =>
      ({
        filter: `도큐먼트 필터가 남긴 도큐먼트의 필드 ${paths}개를 확인했습니다. 컬렉션 전체를 검색하거나 “포함”을 사용해 보세요.`,
        earlier: `이전 도큐먼트 필터가 남긴 도큐먼트의 필드 ${paths}개를 확인했습니다. 컬렉션 전체를 검색하거나 “포함”을 사용해 보세요.`,
        whole: `컬렉션 전체의 필드 ${paths}개를 확인했습니다. “포함”을 사용하거나 다른 표기로 검색해 보세요.`,
      })[where],
    searchWhole: '컬렉션 전체에서 검색',
    errors: {
      empty: '검색할 내용을 입력하세요.',
      tooLong: '정규식은 최대 200자입니다.',
      badRegex: '이 정규식은 올바르지 않습니다.',
      noPaths: '이 컬렉션의 샘플에서 필드를 찾지 못했습니다.',
    } satisfies Record<SearchError, string>,
    namesFound: '이 값이 들어 있는 필드 이름:',
    noNames: '이 값이 들어 있는 필드 이름이 없습니다.',
    show: '도큐먼트에서 보기',
    showHint: '이 검색을 도큐먼트 쿼리에 넣습니다',
    open: '열기',
    allFields: '모든 필드',
    columns: { document: '도큐먼트', matched: '일치' },
    noPlace: '검색하려면 컬렉션을 여세요.',
    failed: '검색을 실행할 수 없습니다: ',
    fieldsFailed: '샘플에서 필드를 읽을 수 없습니다: ',
    retry: '다시 시도',
    more: (n: number) => `${n}개 더`,
  },
  de: {
    title: 'Wertsuche',
    description: (coll: string) =>
      `Findet einen Text, eine Zahl, ein Datum oder eine ObjectId in jedem Feld von ${coll}.`,
    term: 'Suchen nach',
    placeholder: 'Ein Text, eine Zahl, ein Datum (2026-01-05) oder eine ObjectId',
    clear: 'Leeren',
    modes: { contains: 'Enthält', exact: 'Ganzer Wert', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Art des Abgleichs',
    find: 'Suchen',
    ignoreCase: 'Groß-/Kleinschreibung ignorieren',
    names: 'Auch Feldnamen abgleichen',
    scopeLabel: 'Wo suchen',
    scopes: { whole: 'Ganze Collection', filter: 'Dokumentfilter' } satisfies Record<Scope, string>,
    readingFields: 'Felder werden gelesen…',
    searching: 'Suche läuft…',
    emptyTitle: 'Alle Felder auf einmal durchsuchen',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Geben Sie ein, wonach Sie suchen. Durchsucht ${scope === 'whole' ? 'werden alle Dokumente der Collection' : 'werden die Dokumente, die der Dokumentfilter behält'}, ${paths ? `und zwar in allen ${paths} Feldern` : 'und zwar in jedem Feld'}. Die Felder werden aus einer Stichprobe von ${sample} ${new Intl.PluralRules('de').select(sample) === 'one' ? 'Dokument' : 'Dokumenten'} gelesen.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${cat === 'one' ? 'Dokument' : 'Dokumente'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${cat === 'one' ? 'Feld' : 'Felder'} · ${{ whole: 'ganze Collection', filter: 'innerhalb des Dokumentfilters', earlier: 'innerhalb eines früheren Dokumentfilters' }[where]}`,
    noneTitle: 'Nichts gefunden',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const fields = `${paths} ${cat === 'one' ? 'Feld' : 'Feldern'}`
      return {
        filter: `Es wurde in ${fields} der Dokumente gesucht, die der Dokumentfilter behält. Durchsuchen Sie die ganze Collection oder versuchen Sie „Enthält“.`,
        earlier: `Es wurde in ${fields} der Dokumente gesucht, die ein früherer Dokumentfilter behalten hat. Durchsuchen Sie die ganze Collection oder versuchen Sie „Enthält“.`,
        whole: `Es wurde in ${fields} der ganzen Collection gesucht. Versuchen Sie „Enthält“ oder eine andere Schreibweise.`,
      }[where]
    },
    searchWhole: 'Ganze Collection durchsuchen',
    errors: {
      empty: 'Geben Sie ein, wonach gesucht werden soll.',
      tooLong: 'Ein regulärer Ausdruck darf höchstens 200 Zeichen lang sein.',
      badRegex: 'Dieser reguläre Ausdruck ist ungültig.',
      noPaths: 'In einer Stichprobe dieser Collection wurde kein Feld gefunden.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Feldnamen, die ihn enthalten:',
    noNames: 'Kein Feldname enthält ihn.',
    show: 'In Dokumenten anzeigen',
    showHint: 'Übernimmt diese Suche in die Abfrage von Dokumente',
    open: 'Öffnen',
    allFields: 'Alle Felder',
    columns: { document: 'Dokument', matched: 'Treffer' },
    noPlace: 'Öffnen Sie eine Collection, um sie zu durchsuchen.',
    failed: 'Die Suche konnte nicht ausgeführt werden: ',
    fieldsFailed: 'Die Felder konnten nicht aus einer Stichprobe gelesen werden: ',
    retry: 'Erneut versuchen',
    more: (n: number) => `+${n} weitere`,
  },
  fr: {
    title: 'Recherche de valeurs',
    description: (coll: string) =>
      `Trouvez un texte, un nombre, une date ou un ObjectId dans chaque champ de ${coll}.`,
    term: 'Rechercher',
    placeholder: 'Un texte, un nombre, une date (2026-01-05) ou un ObjectId',
    clear: 'Effacer',
    modes: { contains: 'Contient', exact: 'Valeur entière', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Type de correspondance',
    find: 'Rechercher',
    ignoreCase: 'Ignorer la casse',
    names: 'Inclure aussi les noms de champ',
    scopeLabel: 'Où chercher',
    scopes: { whole: 'Toute la collection', filter: 'Filtre de documents' } satisfies Record<Scope, string>,
    readingFields: 'Lecture des champs…',
    searching: 'Recherche en cours…',
    emptyTitle: 'Cherchez dans tous les champs à la fois',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Saisissez ce que vous cherchez ; la recherche porte sur ${scope === 'whole' ? 'tous les documents de la collection' : 'les documents que conserve le filtre de documents'}, dans ${paths ? `les ${paths} champs` : 'tous les champs'}. Les champs sont lus dans un échantillon de ${sample} ${new Intl.PluralRules('fr').select(sample) === 'one' ? 'document' : 'documents'}.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${cat === 'one' ? 'document' : 'documents'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${cat === 'one' ? 'champ' : 'champs'} · ${{ whole: 'toute la collection', filter: 'dans le filtre de documents', earlier: 'dans un filtre de documents précédent' }[where]}`,
    noneTitle: 'Aucun résultat',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const fields = `${paths} ${cat === 'one' ? 'champ' : 'champs'}`
      return {
        filter: `Recherche effectuée dans ${fields} des documents que conserve le filtre de documents. Cherchez dans toute la collection ou essayez « Contient ».`,
        earlier: `Recherche effectuée dans ${fields} des documents que conservait un filtre de documents précédent. Cherchez dans toute la collection ou essayez « Contient ».`,
        whole: `Recherche effectuée dans ${fields} de toute la collection. Essayez « Contient » ou une autre orthographe.`,
      }[where]
    },
    searchWhole: 'Rechercher dans toute la collection',
    errors: {
      empty: 'Saisissez ce que vous cherchez.',
      tooLong: 'Une expression régulière contient 200 caractères au maximum.',
      badRegex: 'Cette expression régulière n’est pas valide.',
      noPaths: 'Aucun champ n’a été trouvé dans un échantillon de cette collection.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Noms de champ qui le contiennent :',
    noNames: 'Aucun nom de champ ne le contient.',
    show: 'Afficher dans Documents',
    showHint: 'Place cette recherche dans la requête de Documents',
    open: 'Ouvrir',
    allFields: 'Tous les champs',
    columns: { document: 'Document', matched: 'Correspondance' },
    noPlace: 'Ouvrez une collection pour y chercher.',
    failed: 'La recherche n’a pas pu s’exécuter : ',
    fieldsFailed: 'Les champs n’ont pas pu être lus dans un échantillon : ',
    retry: 'Réessayer',
    more: (n: number) => `+${n} de plus`,
  },
  ru: {
    title: 'Поиск значений',
    description: (coll: string) => `Найдите текст, число, дату или ObjectId в каждом поле коллекции ${coll}.`,
    term: 'Что искать',
    placeholder: 'Текст, число, дата (2026-01-05) или ObjectId',
    clear: 'Очистить',
    modes: { contains: 'Содержит', exact: 'Значение целиком', regex: 'Regex' } satisfies Record<Mode, string>,
    modeLabel: 'Способ сопоставления',
    find: 'Найти',
    ignoreCase: 'Без учета регистра',
    names: 'Искать и в названиях полей',
    scopeLabel: 'Где искать',
    scopes: { whole: 'Вся коллекция', filter: 'Фильтр документов' } satisfies Record<Scope, string>,
    readingFields: 'Чтение полей…',
    searching: 'Поиск…',
    emptyTitle: 'Поиск сразу по всем полям',
    emptyHint: (paths: number, scope: Scope, sample: number) =>
      `Введите, что нужно найти. Поиск выполняется ${scope === 'whole' ? 'по всем документам коллекции' : 'по документам, которые оставляет фильтр документов'}, ${paths ? `по всем полям (${paths})` : 'по всем полям'}. Поля считываются из выборки в ${sample} ${RU_DOCUMENTS[new Intl.PluralRules('ru').select(sample)]}.`,
    found: (n: string, more: boolean, cat: Plural) =>
      `${n}${more ? '+' : ''} ${{ one: 'документ', few: 'документа' }[cat as 'one' | 'few'] ?? 'документов'}`,
    inFields: (paths: number, where: Where, cat: Plural) =>
      `${paths} ${{ one: 'поле', few: 'поля' }[cat as 'one' | 'few'] ?? 'полей'} · ${{ whole: 'вся коллекция', filter: 'в рамках фильтра документов', earlier: 'в рамках прежнего фильтра документов' }[where]}`,
    noneTitle: 'Ничего не найдено',
    noneHint: (paths: number, where: Where, cat: Plural) => {
      const fields = `${paths} ${cat === 'one' ? 'полю' : 'полям'}`
      return {
        filter: `Поиск выполнен по ${fields} в документах, которые оставляет фильтр документов. Найдите по всей коллекции или попробуйте «Содержит».`,
        earlier: `Поиск выполнен по ${fields} в документах, которые оставил прежний фильтр документов. Найдите по всей коллекции или попробуйте «Содержит».`,
        whole: `Поиск выполнен по ${fields} всей коллекции. Попробуйте «Содержит» или другое написание.`,
      }[where]
    },
    searchWhole: 'Искать по всей коллекции',
    errors: {
      empty: 'Введите, что нужно найти.',
      tooLong: 'Регулярное выражение содержит не более 200 символов.',
      badRegex: 'Это регулярное выражение недопустимо.',
      noPaths: 'В выборке из этой коллекции не найдено ни одного поля.',
    } satisfies Record<SearchError, string>,
    namesFound: 'Названия полей с этим значением:',
    noNames: 'Нет названий полей с этим значением.',
    show: 'Показать в «Документах»',
    showHint: 'Подставляет этот поиск в запрос раздела «Документы»',
    open: 'Открыть',
    allFields: 'Все поля',
    columns: { document: 'Документ', matched: 'Совпадение' },
    noPlace: 'Откройте коллекцию, чтобы искать в ней.',
    failed: 'Не удалось выполнить поиск: ',
    fieldsFailed: 'Не удалось прочитать поля из выборки: ',
    retry: 'Повторить',
    more: (n: number) => `еще ${n}`,
  },
}
export { TEXT }
type Text = (typeof TEXT)['en']
// Every language must hold every entry: a missing one fails to compile.
const complete: Record<Language, Text> = TEXT
void complete

/** The _id as a row shows it. */
function idText(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  if (id && typeof id === 'object') {
    const o = id as Record<string, unknown>
    for (const k of ['$oid', '$numberInt', '$numberLong', '$numberDouble'])
      if (typeof o[k] === 'string') return o[k] as string
  }
  return JSON.stringify(id)
}

/** Canonical EJSON's wrappers of one value ($regularExpression is left out: it matches by pattern). */
const VALUE_WRAPPERS = new Set([
  '$oid',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$date',
  '$uuid',
  '$binary',
  '$timestamp',
  '$symbol',
  '$minKey',
  '$maxKey',
])

/** Whether a filter is `{ _id: <value> }`: one document, as opening a document in the app sets it. */
export function oneDocument(filter: Doc): boolean {
  const keys = Object.keys(filter)
  if (keys.length !== 1 || keys[0] !== '_id') return false
  const id = filter._id
  if (id === null || typeof id !== 'object' || Array.isArray(id)) return id !== undefined
  const inner = Object.keys(id)
  if (!inner.some((k) => k.startsWith('$'))) return true
  return inner.length === 1 && VALUE_WRAPPERS.has(inner[0]!)
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let paths: string[] = []
  let sampled: Promise<void> = new Promise(() => {})
  let ready = false
  let knowContext!: () => void
  /** Settles once the app has said where this page is (or failed to). */
  const contextKnown = new Promise<void>((resolve) => (knowContext = resolve))
  let scope: Scope = 'whole'
  let docs: Doc[] = []
  let facet: string | null = null
  let lastSpec: { term: string; mode: Mode; ignoreCase: boolean } | null = null
  let lastBase: Doc = {}
  let lastScope: Scope = 'whole'
  let running = 0
  /** More documents matched than are shown. */
  let more = false
  /** What the results area shows, kept raw so a language change draws it again in the new one. */
  let phase:
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'invalid'; error: SearchError }
    | { kind: 'failed'; error: unknown; regex: boolean }
    | { kind: 'done' } = { kind: 'idle' }
  /** The field names holding the term, or null when not asked. */
  let holding: string[] | null = null
  // Review 2026-10-10: the app runs one pipeline of a frame at a time; a second waits its turn.
  const aggregate = serialAsk((params: unknown) =>
    client.ask<PipelineDocuments<Doc>>('documents.aggregate', params),
  )
  /** How many documents the fields were read from: fewer than asked when they did not fit in one answer. */
  let sampleSize = SAMPLE
  /** Why the fields could not be read (user report 2026-11-07: it once said "no field was found"). */
  let sampleError: unknown = null

  // A filter naming one document is what opening a result leaves in Documents, not a scope to search
  // (user report 2026-10-16).
  const currentFilter = (): Doc => {
    const filter = ctx?.place?.filter ?? {}
    return oneDocument(filter) ? {} : filter
  }
  const hasFilter = () => Object.keys(currentFilter()).length > 0
  const within = (base: Doc, own: Doc): Doc => (Object.keys(base).length ? { $and: [base, own] } : own)

  // ---- the page
  const showButton = button({ label: text.show, icon: 'external', id: 'show', title: text.showHint })
  showButton.hidden = true
  const header = pageHeader({ icon: 'search', title: text.title, description: '', actions: [showButton] })
  const term = h('input', {
    id: 'term',
    class: 'mm-input',
    attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false' },
  })
  const termLabel = h('label', { class: 'mm-sr', attrs: { for: 'term' } })
  const clear = button({ label: text.clear, icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true })
  clear.hidden = true
  const searchBox = h('div', { class: 'mm-search' }, termLabel, icon('search', 16), term, clear)
  const mode = segmented<Mode>({
    label: text.modeLabel,
    id: 'mode',
    options: MODES.map((m) => ({ value: m, label: text.modes[m] })),
    value: 'contains',
  })
  const findButton = button({ label: text.find, icon: 'search', variant: 'primary', id: 'find' })
  const scopeControl = segmented<Scope>({
    label: text.scopeLabel,
    id: 'scope',
    options: [
      { value: 'whole', label: text.scopes.whole, icon: 'database' },
      { value: 'filter', label: text.scopes.filter, icon: 'filter' },
    ],
    value: 'whole',
    onChange: (next) => {
      scope = next
      if (lastSpec) void search()
      else render()
    },
  })
  const filterChip = h('span', { id: 'filter', class: 'mm-chip mm-mono vs-filter' })
  const scopeRow = h('div', { class: 'vs-scope' }, scopeControl.el, filterChip)
  const ignoreCase = switchControl({ label: text.ignoreCase, checked: true, id: 'ignore-case' })
  const names = switchControl({ label: text.names, checked: false, id: 'names' })
  const status = statusLine('status')
  const facets = h('div', { id: 'facets', class: 'vs-facets' })
  const fieldNames = h('p', { id: 'field-names', class: 'mm-status', hidden: true })
  const results = h('div', { id: 'results', class: 'vs-results' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h(
        'div',
        { class: 'mm-toolbar' },
        h('div', { class: 'mm-toolbar-row' }, searchBox, mode.el, findButton),
        h(
          'div',
          { class: 'mm-toolbar-row' },
          scopeRow,
          h('span', { class: 'mm-spacer' }),
          ignoreCase.el,
          names.el,
        ),
      ),
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status, facets), fieldNames, results),
    ),
  )

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    termLabel.textContent = text.term
    term.placeholder = text.placeholder
    setLabel(clear, text.clear)
    mode.relabel(text.modes)
    mode.el.setAttribute('aria-label', text.modeLabel)
    setLabel(findButton, ready || !ctx?.place ? text.find : text.readingFields)
    scopeControl.relabel(text.scopes)
    scopeControl.el.setAttribute('aria-label', text.scopeLabel)
    ignoreCase.text.textContent = text.ignoreCase
    names.text.textContent = text.names
    setLabel(showButton, text.show)
    showButton.title = text.showHint
    const filter = currentFilter()
    scopeRow.hidden = !hasFilter()
    filterChip.textContent = JSON.stringify(filter).slice(0, 160)
    filterChip.title = JSON.stringify(filter).slice(0, 2000)
  }

  function idle(): void {
    status.textContent = ''
    facets.replaceChildren()
    results.replaceChildren(
      !ctx?.place
        ? emptyState({ icon: 'database', title: text.noPlace })
        : sampleError !== null
          ? emptyState({
              icon: 'error',
              tone: 'danger',
              title: `${text.fieldsFailed}${askMessage(sampleError, locale)}`,
              action: button({ label: text.retry, icon: 'refresh', onClick: () => readSample() }),
            })
          : emptyState({
              icon: 'search',
              title: text.emptyTitle,
              hint: text.emptyHint(paths.length, scope, sampleSize),
            }),
    )
  }

  /**
   * The marked text of a matched value (Contains), as text nodes only. Found in the text itself,
   * not in a lower-cased copy: "İ" lower-cased is two characters, and the mark slipped (review
   * 2026-10-10).
   */
  function marked(value: string): Node[] {
    const cut = value.length > 120 ? `${value.slice(0, 119)}…` : value
    if (lastSpec?.mode !== 'contains' || !lastSpec.term) return [document.createTextNode(cut)]
    const escaped = lastSpec.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const found = new RegExp(escaped, lastSpec.ignoreCase ? 'iu' : 'u').exec(cut)
    if (!found) return [document.createTextNode(cut)]
    const at = found.index
    const end = at + found[0].length
    return [
      document.createTextNode(cut.slice(0, at)),
      h('mark', { text: cut.slice(at, end) }),
      document.createTextNode(cut.slice(end)),
    ]
  }

  /** The results area as `phase` says. */
  function render(): void {
    fieldNames.hidden = holding === null
    if (holding !== null)
      fieldNames.textContent = holding.length ? `${text.namesFound} ${holding.join(', ')}` : text.noNames
    switch (phase.kind) {
      case 'idle':
        return idle()
      case 'running':
        status.textContent = ready ? text.searching : text.readingFields
        facets.replaceChildren()
        results.replaceChildren(skeleton(5))
        return
      case 'invalid':
        status.textContent = ''
        facets.replaceChildren()
        results.replaceChildren(
          emptyState({ icon: 'warning', tone: 'warning', title: text.errors[phase.error] }),
        )
        return
      case 'failed': {
        // A pattern the server cannot read is said to be one (review M8: PCRE, not JavaScript, judges).
        const message = phase.regex
          ? `${text.errors.badRegex} ${askMessage(phase.error, locale)}`
          : `${text.failed}${askMessage(phase.error, locale)}`
        status.textContent = ''
        facets.replaceChildren()
        results.replaceChildren(emptyState({ icon: 'error', tone: 'danger', title: message }))
        return
      }
      case 'done':
        return renderResults()
    }
  }

  function renderResults(): void {
    if (!lastSpec) return idle()
    const spec = lastSpec
    if (!docs.length) {
      status.textContent = ''
      facets.replaceChildren()
      const action =
        lastScope === 'filter'
          ? button({
              label: text.searchWhole,
              icon: 'database',
              onClick: () => {
                scopeControl.set('whole')
                chooseWhole()
              },
            })
          : undefined
      results.replaceChildren(
        emptyState({
          icon: 'search',
          title: text.noneTitle,
          hint: text.noneHint(paths.length, searchedIn(), pluralOf(paths.length, shown(TEXT, locale))),
          ...(action ? { action } : {}),
        }),
      )
      return
    }
    status.replaceChildren(
      h('strong', {
        text: text.found(
          formatNumber(docs.length, shown(TEXT, locale)),
          more,
          more ? 'other' : pluralOf(docs.length, shown(TEXT, locale)),
        ),
      }),
      document.createTextNode(
        ` · ${text.inFields(paths.length, searchedIn(), pluralOf(paths.length, shown(TEXT, locale)))}`,
      ),
    )
    const counts = facetsOf(docs, spec)
    facets.replaceChildren(
      ...(counts.length > 1
        ? [chip({ label: text.allFields, pressed: facet === null, onClick: () => pick(null) })]
        : []),
      ...counts.slice(0, 12).map((f) =>
        chip({
          label: f.path,
          count: f.count,
          mono: true,
          pressed: facet === f.path,
          onClick: () => pick(facet === f.path ? null : f.path),
        }),
      ),
    )
    const rows = h('div', { class: 'vs-list', attrs: { role: 'list' } })
    for (const doc of docs) {
      const hits = matchedIn(doc, spec)
      if (facet && !hits.some((m) => m.path === facet)) continue
      const matchedPaths = [...new Set(hits.map((m) => m.path))]
      const preview = previewOf(doc, matchedPaths, 4)
      const open = button({
        label: text.open,
        icon: 'external',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          void client
            .ask('ui.openDocument', { id: doc._id })
            .catch((e: unknown) => (status.textContent = `${text.failed}${askMessage(e, locale)}`))
        },
      })
      rows.append(
        h(
          'div',
          { class: 'vs-row', attrs: { role: 'listitem' } },
          h(
            'div',
            { class: 'vs-doc' },
            h('span', { class: 'vs-id mm-mono', title: idText(doc._id), text: idText(doc._id) }),
            h(
              'div',
              { class: 'vs-preview' },
              ...preview.map((f) =>
                h(
                  'span',
                  { class: 'mm-kv' },
                  h('span', { class: 'mm-key', text: f.key }),
                  valueView(f.value, 40),
                ),
              ),
            ),
          ),
          h(
            'div',
            { class: 'vs-hits' },
            ...hits
              .slice(0, 4)
              .map((m) =>
                h(
                  'div',
                  { class: 'vs-hit' },
                  h('span', { class: 'mm-key vs-path', text: m.path }),
                  h('span', { class: 'vs-hit-value' }, ...marked(m.value)),
                ),
              ),
            hits.length > 4 ? h('span', { class: 'mm-subtle', text: text.more(hits.length - 4) }) : null,
          ),
          h('div', { class: 'vs-actions' }, open),
        ),
      )
    }
    results.replaceChildren(rows)
  }

  const searchedIn = (): Where =>
    lastScope === 'whole'
      ? 'whole'
      : JSON.stringify(lastBase) === JSON.stringify(currentFilter())
        ? 'filter'
        : 'earlier'

  function pick(path: string | null): void {
    facet = path
    renderResults()
  }
  function chooseWhole(): void {
    scope = 'whole'
    void search()
  }

  async function search(): Promise<void> {
    // A search asked before the app said where this page is waits for it: it was dropped, and the
    // button looked as if it had done nothing (CI 2026-11-04).
    if (!ctx) {
      const asked = ++running
      setBusy(findButton, true)
      await contextKnown
      if (asked !== running) return
      setBusy(findButton, false)
    }
    if (!ctx?.place) return
    const run = ++running
    const spec = { term: term.value, mode: mode.value(), ignoreCase: ignoreCase.input.checked }
    showButton.hidden = true
    facet = null
    setBusy(findButton, true)
    phase = { kind: 'running' }
    holding = null
    render()
    // A search started before the fields were read waits for them (it once said "no field found").
    await sampled
    if (run !== running) return
    // Fields that could not be read are not "no field": the page says why, with Try again.
    if (sampleError !== null) {
      setBusy(findButton, false)
      phase = { kind: 'idle' }
      return render()
    }
    holding = names.input.checked ? matchingNames(paths, spec) : null
    const built = buildSearch({ ...spec, paths })
    if ('error' in built) {
      setBusy(findButton, false)
      lastSpec = null
      phase = { kind: 'invalid', error: built.error }
      return render()
    }
    render()
    const base = scope === 'filter' ? currentFilter() : {}
    try {
      // One more than is shown: "+" only when more matched (review 2026-10-10). Large documents come
      // as many as fit in one answer, and "+" says more matched (user report 2026-11-07).
      const answer = await aggregate({
        pipeline: [{ $match: within(base, built.filter) }, { $limit: { $numberInt: String(LIMIT + 1) } }],
        limit: LIMIT + 1,
        fit: true,
      })
      if (run !== running) return
      more = answer.documents.length > LIMIT || answer.cut === true
      docs = answer.documents.slice(0, LIMIT)
      lastSpec = spec
      lastBase = base
      lastScope = scope === 'filter' ? 'filter' : 'whole'
      showButton.hidden = !docs.length
      phase = { kind: 'done' }
      render()
    } catch (e) {
      if (run !== running) return
      lastSpec = null
      phase = { kind: 'failed', error: e, regex: spec.mode === 'regex' }
      render()
    } finally {
      if (run === running) setBusy(findButton, false)
    }
  }

  findButton.addEventListener('click', () => void search())
  term.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void search()
    if (e.key === 'Escape') clearSearch()
  })
  term.addEventListener('input', () => (clear.hidden = !term.value))
  const clearSearch = () => {
    term.value = ''
    clear.hidden = true
    lastSpec = null
    docs = []
    showButton.hidden = true
    holding = null
    phase = { kind: 'idle' }
    running++
    setBusy(findButton, false)
    render()
    term.focus()
  }
  clear.addEventListener('click', clearSearch)
  showButton.addEventListener('click', () => {
    if (!lastSpec) return
    // A field chosen among the results narrows what goes to Documents too.
    const built = buildSearch({ ...lastSpec, paths: facet ? [facet] : paths })
    if ('error' in built) return
    void client
      .ask('ui.useQuery', { filter: within(lastBase, built.filter) })
      .catch((e: unknown) => (status.textContent = `${text.failed}${askMessage(e, locale)}`))
  })

  client.onContext((next, theme, accent) => {
    locale = next
    text = pickText<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    render()
    void refreshPlace()
  })
  /**
   * The app keeps this page while Documents shows (user report 2026-10-16) and says the context
   * changed when its filter did: the filter is read again for the next search; the results shown
   * stay, said to be from an earlier filter where they are — nothing is searched unasked.
   */
  let asking = 0
  async function refreshPlace(): Promise<void> {
    if (!ctx?.place) return
    const ask = ++asking
    let next: PluginContext
    try {
      next = await client.ask<PluginContext>('context.get')
    } catch {
      return
    }
    if (ask !== asking || !ctx?.place || !next.place) return
    ctx = { ...ctx, place: { ...ctx.place, filter: next.place.filter ?? {} } }
    if (scope === 'filter' && !hasFilter()) {
      scopeControl.set('whole')
      scope = 'whole'
    }
    applyText()
    render()
  }
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } finally {
      knowContext()
    }
    locale = ctx.locale
    text = pickText<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    if (!ctx.place) {
      findButton.disabled = true
      term.disabled = true
      applyText()
      idle()
      return
    }
    applyText()
    idle()
    term.focus()
    // Kept while another section shows: a result opened in Documents, the search is still here.
    void client.ask('ui.keepOpen').catch(() => {})
    readSample()
  })

  /**
   * The fields, read from a random sample, not the first documents: fields only newer ones hold are
   * searched too (review M7). User report 2026-11-07: documents of ~60 KB are read as many as fit in
   * one answer, and a sample that could not be read says why, with Try again.
   */
  function readSample(): void {
    ready = false
    sampleError = null
    setLabel(findButton, text.readingFields)
    if (phase.kind === 'idle') idle()
    sampled = aggregate({
      pipeline: [{ $sample: { size: { $numberInt: String(SAMPLE) } } }],
      limit: SAMPLE,
      fit: true,
    })
      .then(
        (sample) => {
          paths = searchPaths(sample.documents)
          sampleSize = sample.cut ? sample.documents.length : SAMPLE
        },
        (e: unknown) => {
          paths = []
          sampleError = e
        },
      )
      .finally(() => {
        ready = true
        setLabel(findButton, text.find)
        if (phase.kind === 'idle') idle()
        else if (phase.kind === 'running') render()
      })
  }
  applyText()
}
