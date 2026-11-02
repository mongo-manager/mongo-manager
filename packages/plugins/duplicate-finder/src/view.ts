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
  icon,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  shown,
  segmented,
  serialAsk,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
  switchControl,
  table,
  valueView,
  type Language,
} from '../../kit/src/ui'
import {
  MAX_FIELDS,
  MAX_GROUPS,
  MAX_IDS,
  countOf,
  duplicatePipeline,
  fieldProblem,
  groupFilter,
  idsProjection,
  keysOf,
  splitFields,
  suggestFields,
  valueAt,
  type Doc,
  type FieldProblem,
} from './duplicates'

/**
 * The duplicate finder (plugins wave 1; redesigned 2026-10-10, spec plugin-tabs-redesign §2.4): the
 * documents grouped by fields the user picks as chips (the server does the work, with the user's
 * rights and masking), the values found more than once listed with their counts, each opening to
 * its documents; a group shown in Documents. The whole collection unless the user picks the
 * Documents filter.
 */
type Scope = 'whole' | 'filter'
type Problem = FieldProblem | 'none'

const TEXTS = {
  en: {
    title: 'Duplicates',
    description: (coll: string) =>
      `Values more than one document of ${coll} shares, in fields that should be unique.`,
    fields: 'Fields that should be unique',
    placeholder: 'Type a field and press Enter (address.city for a nested one)',
    placeholderMore: 'Add a field to check them together',
    placeholderFull: `Up to ${MAX_FIELDS} fields`,
    remove: (f: string) => `Remove ${f}`,
    suggest: 'In this collection:',
    ignoreCase: 'Ignore letter case',
    skipMissing: 'Leave out documents missing a field',
    scopeLabel: 'Where to look',
    scopes: { whole: 'Whole collection', filter: 'Documents filter' } satisfies Record<Scope, string>,
    find: 'Find duplicates',
    finding: 'Grouping the documents…',
    emptyTitle: 'Pick the fields that should be unique',
    emptyHint:
      'One field, or up to five checked together (first and last name, say). The values more than one document shares are listed, the most shared first.',
    noneTitle: 'No duplicates: every value is unique',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `No two documents of the whole collection share a value of ${fields}.`
        : `No two documents the Documents filter keeps share a value of ${fields}.`,
    lookWhole: 'Look in the whole collection',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} duplicated ${n === '1' && !more ? 'value' : 'values'}`,
    involved: (n: string, more: boolean) => `${n}${more ? '+' : ''} documents involved`,
    scopeNote: { whole: 'whole collection', filter: 'within the Documents filter' } satisfies Record<
      Scope,
      string
    >,
    capped: `Only the ${MAX_GROUPS} most shared values are listed.`,
    count: 'Documents',
    show: 'Show',
    showHint: 'Puts these documents in the Documents query',
    expand: 'List the documents',
    collapse: 'Hide the documents',
    reading: 'Reading the documents…',
    open: 'Open',
    firstOf: (shown: string, total: string) => `The first ${shown} of ${total} documents.`,
    gone: 'These documents are no longer there: run it again.',
    showAll: 'All of them in Documents',
    missing: 'missing',
    noPlace: 'Open a collection to look for duplicates in it.',
    problems: {
      bad: (f: string) => `"${f}" is not a field name.`,
      twice: (f: string) => `${f} is already picked.`,
      tooMany: () => `Up to ${MAX_FIELDS} fields.`,
      none: () => 'Pick at least one field first.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'The documents could not be grouped: ',
    readFailed: 'The documents could not be read: ',
    actionFailed: 'The app did not take it: ',
  },
  tr: {
    title: 'Yinelenenler',
    description: (coll: string) =>
      `${coll} koleksiyonunda, benzersiz olması gereken alanlarda birden fazla belgenin paylaştığı değerler.`,
    fields: 'Benzersiz olması gereken alanlar',
    placeholder: 'Bir alan yazıp Enter’a basın (iç içe alan için address.city)',
    placeholderMore: 'Birlikte denetlemek için bir alan daha ekleyin',
    placeholderFull: `En fazla ${MAX_FIELDS} alan`,
    remove: (f: string) => `${f} alanını kaldır`,
    suggest: 'Bu koleksiyonda:',
    ignoreCase: 'Büyük/küçük harfi yok say',
    skipMissing: 'Alanı olmayan belgeleri dışarıda bırak',
    scopeLabel: 'Nerede aransın',
    scopes: { whole: 'Tüm koleksiyon', filter: 'Belgeler filtresi' } satisfies Record<Scope, string>,
    find: 'Yinelenenleri bul',
    finding: 'Belgeler gruplanıyor…',
    emptyTitle: 'Benzersiz olması gereken alanları seçin',
    emptyHint:
      'Tek bir alan ya da birlikte denetlenecek en fazla beş alan (örneğin ad ve soyad). Birden fazla belgenin paylaştığı değerler, en çok paylaşılandan başlayarak listelenir.',
    noneTitle: 'Yinelenen yok: her değer benzersiz',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Tüm koleksiyonda ${fields} değeri aynı olan iki belge yok.`
        : `Belgeler filtresinin bıraktığı belgeler arasında ${fields} değeri aynı olan iki belge yok.`,
    lookWhole: 'Tüm koleksiyonda ara',
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''} yinelenen değer`,
    involved: (n: string, more: boolean) => `${n}${more ? '+' : ''} ilgili belge`,
    scopeNote: { whole: 'tüm koleksiyon', filter: 'Belgeler filtresi içinde' } satisfies Record<
      Scope,
      string
    >,
    capped: `Yalnızca en çok paylaşılan ${MAX_GROUPS} değer listelenir.`,
    count: 'Belge',
    show: 'Göster',
    showHint: 'Bu belgeleri Belgeler sekmesinde gösterir',
    expand: 'Belgeleri listele',
    collapse: 'Belgeleri gizle',
    reading: 'Belgeler okunuyor…',
    open: 'Aç',
    firstOf: (shown: string, total: string) => `Toplam ${total} belgenin ilk ${shown} tanesi.`,
    gone: 'Bu belgeler artık yok: aramayı yeniden çalıştırın.',
    showAll: 'Hepsini Belgelerde göster',
    missing: 'eksik',
    noPlace: 'Yinelenenleri aramak için bir koleksiyon açın.',
    problems: {
      bad: (f: string) => `"${f}" bir alan adı değil.`,
      twice: (f: string) => `${f} zaten seçili.`,
      tooMany: () => `En fazla ${MAX_FIELDS} alan.`,
      none: () => 'Önce en az bir alan seçin.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'Belgeler gruplanamadı: ',
    readFailed: 'Belgeler okunamadı: ',
    actionFailed: 'Uygulama kabul etmedi: ',
  },
  zh: {
    title: '重复项',
    description: (coll: string) => `${coll} 中本应唯一的字段里，被多个文档共有的值。`,
    fields: '应保持唯一的字段',
    placeholder: '输入字段后按 Enter（嵌套字段如 address.city）',
    placeholderMore: '再添加一个字段，一起检查',
    placeholderFull: `最多 ${MAX_FIELDS} 个字段`,
    remove: (f: string) => `移除 ${f}`,
    suggest: '此集合中的字段：',
    ignoreCase: '忽略大小写',
    skipMissing: '排除缺少字段的文档',
    scopeLabel: '查找范围',
    scopes: { whole: '整个集合', filter: '文档筛选' } satisfies Record<Scope, string>,
    find: '查找重复项',
    finding: '正在对文档分组…',
    emptyTitle: '选择应保持唯一的字段',
    emptyHint:
      '可选一个字段，或最多五个字段一起检查（例如姓和名）。被多个文档共有的值会列出，共有最多的排在前面。',
    noneTitle: '没有重复项：每个值都是唯一的',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `整个集合中没有两个文档的 ${fields} 值相同。`
        : `文档筛选保留的文档中没有两个文档的 ${fields} 值相同。`,
    lookWhole: '在整个集合中查找',
    found: (n: string, more: boolean) => `${n}${more ? '+' : ''} 个重复值`,
    involved: (n: string, more: boolean) => `涉及 ${n}${more ? '+' : ''} 个文档`,
    scopeNote: { whole: '整个集合', filter: '文档筛选范围内' } satisfies Record<Scope, string>,
    capped: `仅列出共有最多的 ${MAX_GROUPS} 个值。`,
    count: '文档',
    show: '显示',
    showHint: '将这些文档放入文档查询',
    expand: '列出文档',
    collapse: '隐藏文档',
    reading: '正在读取文档…',
    open: '打开',
    firstOf: (shown: string, total: string) => `共 ${total} 个文档，显示前 ${shown} 个。`,
    gone: '这些文档已不存在，请重新运行。',
    showAll: '在文档中查看全部',
    missing: '缺失',
    noPlace: '打开一个集合，即可在其中查找重复项。',
    problems: {
      bad: (f: string) => `“${f}”不是有效的字段名。`,
      twice: (f: string) => `${f} 已选择。`,
      tooMany: () => `最多 ${MAX_FIELDS} 个字段。`,
      none: () => '请先选择至少一个字段。',
    } satisfies Record<Problem, (f: string) => string>,
    failed: '无法对文档分组：',
    readFailed: '无法读取文档：',
    actionFailed: '应用未接受该操作：',
  },
  ja: {
    title: '重複',
    description: (coll: string) =>
      `${coll} で、一意であるべきフィールドの値を複数のドキュメントが共有しているもの。`,
    fields: '一意であるべきフィールド',
    placeholder: 'フィールドを入力して Enter（ネストは address.city のように）',
    placeholderMore: 'フィールドを追加して一緒に確認',
    placeholderFull: `フィールドは最大 ${MAX_FIELDS} 個`,
    remove: (f: string) => `${f} を削除`,
    suggest: 'このコレクションのフィールド:',
    ignoreCase: '大文字と小文字を区別しない',
    skipMissing: 'フィールドがないドキュメントを除外',
    scopeLabel: '検索範囲',
    scopes: { whole: 'コレクション全体', filter: 'ドキュメントのフィルター' } satisfies Record<Scope, string>,
    find: '重複を検索',
    finding: 'ドキュメントをグループ化しています…',
    emptyTitle: '一意であるべきフィールドを選択',
    emptyHint:
      'フィールドを 1 つ、または最大 5 つまとめて確認できます（姓と名など）。複数のドキュメントが共有する値が、共有数の多い順に表示されます。',
    noneTitle: '重複はありません。すべての値が一意です',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `コレクション全体で ${fields} の値が同じドキュメントはありません。`
        : `ドキュメントのフィルターで絞り込まれた範囲に、${fields} の値が同じドキュメントはありません。`,
    lookWhole: 'コレクション全体を検索',
    found: (n: string, more: boolean) => `重複した値 ${n}${more ? '+' : ''} 件`,
    involved: (n: string, more: boolean) => `関連ドキュメント ${n}${more ? '+' : ''} 件`,
    scopeNote: { whole: 'コレクション全体', filter: 'ドキュメントのフィルター内' } satisfies Record<
      Scope,
      string
    >,
    capped: `共有数の多い上位 ${MAX_GROUPS} 件の値のみ表示しています。`,
    count: 'ドキュメント',
    show: '表示',
    showHint: 'これらのドキュメントをドキュメントのクエリに設定します',
    expand: 'ドキュメントを一覧表示',
    collapse: 'ドキュメントを隠す',
    reading: 'ドキュメントを読み込んでいます…',
    open: '開く',
    firstOf: (shown: string, total: string) => `${total} 件中、先頭の ${shown} 件です。`,
    gone: 'これらのドキュメントは見つかりません。もう一度実行してください。',
    showAll: 'すべてをドキュメントで表示',
    missing: 'なし',
    noPlace: 'コレクションを開くと、重複を検索できます。',
    problems: {
      bad: (f: string) => `「${f}」はフィールド名ではありません。`,
      twice: (f: string) => `${f} はすでに選択されています。`,
      tooMany: () => `フィールドは最大 ${MAX_FIELDS} 個です。`,
      none: () => '先にフィールドを 1 つ以上選択してください。',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'ドキュメントをグループ化できませんでした: ',
    readFailed: 'ドキュメントを読み込めませんでした: ',
    actionFailed: 'アプリが受け付けませんでした: ',
  },
  es: {
    title: 'Duplicados',
    description: (coll: string) =>
      `Valores que más de un documento de ${coll} comparte, en campos que deberían ser únicos.`,
    fields: 'Campos que deberían ser únicos',
    placeholder: 'Escribe un campo y pulsa Intro (address.city para uno anidado)',
    placeholderMore: 'Añade un campo para comprobarlos juntos',
    placeholderFull: `Hasta ${MAX_FIELDS} campos`,
    remove: (f: string) => `Quitar ${f}`,
    suggest: 'En esta colección:',
    ignoreCase: 'Ignorar mayúsculas y minúsculas',
    skipMissing: 'Omitir documentos sin el campo',
    scopeLabel: 'Dónde buscar',
    scopes: { whole: 'Toda la colección', filter: 'Filtro de documentos' } satisfies Record<Scope, string>,
    find: 'Buscar duplicados',
    finding: 'Agrupando los documentos…',
    emptyTitle: 'Elige los campos que deberían ser únicos',
    emptyHint:
      'Un campo, o hasta cinco comprobados juntos (nombre y apellido, por ejemplo). Se listan los valores que comparte más de un documento, primero los más compartidos.',
    noneTitle: 'Sin duplicados: todos los valores son únicos',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Ningún par de documentos de toda la colección comparte un valor de ${fields}.`
        : `Ningún par de documentos que conserva el filtro de documentos comparte un valor de ${fields}.`,
    lookWhole: 'Buscar en toda la colección',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'valor duplicado' : 'valores duplicados'}`,
    involved: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'documento afectado' : 'documentos afectados'}`,
    scopeNote: { whole: 'toda la colección', filter: 'dentro del filtro de documentos' } satisfies Record<
      Scope,
      string
    >,
    capped: `Solo se listan los ${MAX_GROUPS} valores más compartidos.`,
    count: 'Documentos',
    show: 'Mostrar',
    showHint: 'Coloca estos documentos en la consulta de Documentos',
    expand: 'Listar los documentos',
    collapse: 'Ocultar los documentos',
    reading: 'Leyendo los documentos…',
    open: 'Abrir',
    firstOf: (shown: string, total: string) => `Los primeros ${shown} de ${total} documentos.`,
    gone: 'Estos documentos ya no existen: vuelve a ejecutarlo.',
    showAll: 'Todos en Documentos',
    missing: 'ausente',
    noPlace: 'Abre una colección para buscar duplicados en ella.',
    problems: {
      bad: (f: string) => `«${f}» no es un nombre de campo.`,
      twice: (f: string) => `${f} ya está elegido.`,
      tooMany: () => `Hasta ${MAX_FIELDS} campos.`,
      none: () => 'Elige primero al menos un campo.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'No se pudieron agrupar los documentos: ',
    readFailed: 'No se pudieron leer los documentos: ',
    actionFailed: 'La aplicación no lo aceptó: ',
  },
  pt: {
    title: 'Duplicados',
    description: (coll: string) =>
      `Valores que mais de um documento de ${coll} compartilha, em campos que deveriam ser únicos.`,
    fields: 'Campos que deveriam ser únicos',
    placeholder: 'Digite um campo e pressione Enter (address.city para um aninhado)',
    placeholderMore: 'Adicione um campo para verificá-los juntos',
    placeholderFull: `Até ${MAX_FIELDS} campos`,
    remove: (f: string) => `Remover ${f}`,
    suggest: 'Nesta coleção:',
    ignoreCase: 'Ignorar maiúsculas e minúsculas',
    skipMissing: 'Omitir documentos sem o campo',
    scopeLabel: 'Onde procurar',
    scopes: { whole: 'Coleção inteira', filter: 'Filtro de documentos' } satisfies Record<Scope, string>,
    find: 'Encontrar duplicados',
    finding: 'Agrupando os documentos…',
    emptyTitle: 'Escolha os campos que deveriam ser únicos',
    emptyHint:
      'Um campo, ou até cinco verificados juntos (nome e sobrenome, por exemplo). Os valores compartilhados por mais de um documento são listados, os mais compartilhados primeiro.',
    noneTitle: 'Sem duplicados: todos os valores são únicos',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Nenhum par de documentos da coleção inteira compartilha um valor de ${fields}.`
        : `Nenhum par de documentos mantidos pelo filtro de documentos compartilha um valor de ${fields}.`,
    lookWhole: 'Procurar na coleção inteira',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'valor duplicado' : 'valores duplicados'}`,
    involved: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'documento envolvido' : 'documentos envolvidos'}`,
    scopeNote: { whole: 'coleção inteira', filter: 'dentro do filtro de documentos' } satisfies Record<
      Scope,
      string
    >,
    capped: `Somente os ${MAX_GROUPS} valores mais compartilhados são listados.`,
    count: 'Documentos',
    show: 'Mostrar',
    showHint: 'Coloca estes documentos na consulta de Documentos',
    expand: 'Listar os documentos',
    collapse: 'Ocultar os documentos',
    reading: 'Lendo os documentos…',
    open: 'Abrir',
    firstOf: (shown: string, total: string) => `Os primeiros ${shown} de ${total} documentos.`,
    gone: 'Estes documentos não existem mais: execute novamente.',
    showAll: 'Todos em Documentos',
    missing: 'ausente',
    noPlace: 'Abra uma coleção para procurar duplicados nela.',
    problems: {
      bad: (f: string) => `"${f}" não é um nome de campo.`,
      twice: (f: string) => `${f} já foi escolhido.`,
      tooMany: () => `Até ${MAX_FIELDS} campos.`,
      none: () => 'Escolha primeiro pelo menos um campo.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'Não foi possível agrupar os documentos: ',
    readFailed: 'Não foi possível ler os documentos: ',
    actionFailed: 'O app não aceitou: ',
  },
  ko: {
    title: '중복',
    description: (coll: string) =>
      `${coll} 컬렉션에서 고유해야 하는 필드의 값을 둘 이상의 도큐먼트가 공유하는 항목입니다.`,
    fields: '고유해야 하는 필드',
    placeholder: '필드를 입력하고 Enter를 누르세요(중첩 필드는 address.city)',
    placeholderMore: '필드를 더 추가하면 함께 확인합니다',
    placeholderFull: `필드는 최대 ${MAX_FIELDS}개`,
    remove: (f: string) => `${f} 제거`,
    suggest: '이 컬렉션의 필드:',
    ignoreCase: '대소문자 무시',
    skipMissing: '필드가 없는 도큐먼트 제외',
    scopeLabel: '검색 범위',
    scopes: { whole: '전체 컬렉션', filter: '도큐먼트 필터' } satisfies Record<Scope, string>,
    find: '중복 찾기',
    finding: '도큐먼트를 그룹화하는 중…',
    emptyTitle: '고유해야 하는 필드를 선택하세요',
    emptyHint:
      '필드 하나 또는 최대 다섯 개를 함께 확인할 수 있습니다(예: 성과 이름). 둘 이상의 도큐먼트가 공유하는 값이 공유 수가 많은 순서로 표시됩니다.',
    noneTitle: '중복 없음: 모든 값이 고유합니다',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `전체 컬렉션에서 ${fields} 값이 같은 도큐먼트가 없습니다.`
        : `도큐먼트 필터로 남은 도큐먼트 중 ${fields} 값이 같은 도큐먼트가 없습니다.`,
    lookWhole: '전체 컬렉션에서 찾기',
    found: (n: string, more: boolean) => `중복 값 ${n}${more ? '+' : ''}개`,
    involved: (n: string, more: boolean) => `관련 도큐먼트 ${n}${more ? '+' : ''}개`,
    scopeNote: { whole: '전체 컬렉션', filter: '도큐먼트 필터 범위 내' } satisfies Record<Scope, string>,
    capped: `공유 수가 가장 많은 ${MAX_GROUPS}개 값만 표시합니다.`,
    count: '도큐먼트',
    show: '표시',
    showHint: '이 도큐먼트를 도큐먼트 쿼리에 넣습니다',
    expand: '도큐먼트 나열',
    collapse: '도큐먼트 숨기기',
    reading: '도큐먼트를 읽는 중…',
    open: '열기',
    firstOf: (shown: string, total: string) => `도큐먼트 ${total}개 중 처음 ${shown}개입니다.`,
    gone: '이 도큐먼트는 더 이상 없습니다. 다시 실행하세요.',
    showAll: '모두 도큐먼트에서 보기',
    missing: '없음',
    noPlace: '컬렉션을 열면 그 안에서 중복을 찾을 수 있습니다.',
    problems: {
      bad: (f: string) => `"${f}"은(는) 필드 이름이 아닙니다.`,
      twice: (f: string) => `${f}은(는) 이미 선택되어 있습니다.`,
      tooMany: () => `필드는 최대 ${MAX_FIELDS}개입니다.`,
      none: () => '먼저 필드를 하나 이상 선택하세요.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: '도큐먼트를 그룹화할 수 없습니다: ',
    readFailed: '도큐먼트를 읽을 수 없습니다: ',
    actionFailed: '앱에서 받아들이지 않았습니다: ',
  },
  de: {
    title: 'Duplikate',
    description: (coll: string) =>
      `Werte, die mehrere Dokumente von ${coll} gemeinsam haben, und zwar in Feldern, die eindeutig sein sollten.`,
    fields: 'Felder, die eindeutig sein sollten',
    placeholder: 'Feld eingeben und Eingabetaste drücken (address.city für ein verschachteltes)',
    placeholderMore: 'Weiteres Feld hinzufügen, um sie gemeinsam zu prüfen',
    placeholderFull: `Bis zu ${MAX_FIELDS} Felder`,
    remove: (f: string) => `${f} entfernen`,
    suggest: 'In dieser Collection:',
    ignoreCase: 'Groß-/Kleinschreibung ignorieren',
    skipMissing: 'Dokumente ohne das Feld auslassen',
    scopeLabel: 'Wo gesucht wird',
    scopes: { whole: 'Gesamte Collection', filter: 'Dokumentfilter' } satisfies Record<Scope, string>,
    find: 'Duplikate suchen',
    finding: 'Dokumente werden gruppiert…',
    emptyTitle: 'Felder wählen, die eindeutig sein sollten',
    emptyHint:
      'Ein Feld oder bis zu fünf, die gemeinsam geprüft werden (zum Beispiel Vor- und Nachname). Die Werte, die mehrere Dokumente gemeinsam haben, werden aufgelistet, die häufigsten zuerst.',
    noneTitle: 'Keine Duplikate: Jeder Wert ist eindeutig',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Keine zwei Dokumente der gesamten Collection haben denselben Wert in ${fields}.`
        : `Keine zwei Dokumente, die der Dokumentfilter übrig lässt, haben denselben Wert in ${fields}.`,
    lookWhole: 'In der gesamten Collection suchen',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'doppelter Wert' : 'doppelte Werte'}`,
    involved: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${n === '1' && !more ? 'beteiligtes Dokument' : 'beteiligte Dokumente'}`,
    scopeNote: { whole: 'gesamte Collection', filter: 'innerhalb des Dokumentfilters' } satisfies Record<
      Scope,
      string
    >,
    capped: `Es werden nur die ${MAX_GROUPS} am häufigsten vorkommenden Werte aufgelistet.`,
    count: 'Dokumente',
    show: 'Anzeigen',
    showHint: 'Übernimmt diese Dokumente in die Dokumentabfrage',
    expand: 'Dokumente auflisten',
    collapse: 'Dokumente ausblenden',
    reading: 'Dokumente werden gelesen…',
    open: 'Öffnen',
    firstOf: (shown: string, total: string) => `Dokumente: ${shown} von ${total} angezeigt.`,
    gone: 'Diese Dokumente sind nicht mehr vorhanden. Führen Sie die Suche erneut aus.',
    showAll: 'Alle in Dokumenten anzeigen',
    missing: 'fehlt',
    noPlace: 'Öffnen Sie eine Collection, um darin nach Duplikaten zu suchen.',
    problems: {
      bad: (f: string) => `„${f}“ ist kein Feldname.`,
      twice: (f: string) => `${f} ist bereits ausgewählt.`,
      tooMany: () => `Bis zu ${MAX_FIELDS} Felder.`,
      none: () => 'Wählen Sie zuerst mindestens ein Feld aus.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'Die Dokumente konnten nicht gruppiert werden: ',
    readFailed: 'Die Dokumente konnten nicht gelesen werden: ',
    actionFailed: 'Die App hat die Aktion nicht angenommen: ',
  },
  fr: {
    title: 'Doublons',
    description: (coll: string) =>
      `Valeurs que plusieurs documents de ${coll} partagent, dans des champs qui devraient être uniques.`,
    fields: 'Champs qui devraient être uniques',
    placeholder: 'Saisissez un champ et appuyez sur Entrée (address.city pour un champ imbriqué)',
    placeholderMore: 'Ajoutez un champ pour les vérifier ensemble',
    placeholderFull: `Jusqu’à ${MAX_FIELDS} champs`,
    remove: (f: string) => `Retirer ${f}`,
    suggest: 'Dans cette collection :',
    ignoreCase: 'Ignorer la casse',
    skipMissing: 'Exclure les documents sans le champ',
    scopeLabel: 'Où chercher',
    scopes: { whole: 'Toute la collection', filter: 'Filtre de documents' } satisfies Record<Scope, string>,
    find: 'Rechercher les doublons',
    finding: 'Regroupement des documents…',
    emptyTitle: 'Choisissez les champs qui devraient être uniques',
    emptyHint:
      'Un champ, ou jusqu’à cinq vérifiés ensemble (nom et prénom, par exemple). Les valeurs que plusieurs documents partagent sont listées, les plus partagées en premier.',
    noneTitle: 'Aucun doublon : toutes les valeurs sont uniques',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Aucun couple de documents de toute la collection ne partage une valeur de ${fields}.`
        : `Aucun couple de documents conservés par le filtre de documents ne partage une valeur de ${fields}.`,
    lookWhole: 'Chercher dans toute la collection',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${(n === '0' || n === '1') && !more ? 'valeur en double' : 'valeurs en double'}`,
    involved: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${(n === '0' || n === '1') && !more ? 'document concerné' : 'documents concernés'}`,
    scopeNote: { whole: 'toute la collection', filter: 'dans le filtre de documents' } satisfies Record<
      Scope,
      string
    >,
    capped: `Seules les ${MAX_GROUPS} valeurs les plus partagées sont listées.`,
    count: 'Documents',
    show: 'Afficher',
    showHint: 'Place ces documents dans la requête de Documents',
    expand: 'Lister les documents',
    collapse: 'Masquer les documents',
    reading: 'Lecture des documents…',
    open: 'Ouvrir',
    firstOf: (shown: string, total: string) => `Documents affichés : ${shown} sur ${total}.`,
    gone: 'Ces documents n’existent plus : relancez la recherche.',
    showAll: 'Tous dans Documents',
    missing: 'absent',
    noPlace: 'Ouvrez une collection pour y rechercher des doublons.',
    problems: {
      bad: (f: string) => `« ${f} » n’est pas un nom de champ.`,
      twice: (f: string) => `${f} est déjà choisi.`,
      tooMany: () => `Jusqu’à ${MAX_FIELDS} champs.`,
      none: () => 'Choisissez d’abord au moins un champ.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'Impossible de regrouper les documents : ',
    readFailed: 'Impossible de lire les documents : ',
    actionFailed: 'L’application ne l’a pas accepté : ',
  },
  ru: {
    title: 'Дубликаты',
    description: (coll: string) =>
      `Значения, которые разделяют несколько документов коллекции ${coll} в полях, которые должны быть уникальными.`,
    fields: 'Поля, которые должны быть уникальными',
    placeholder: 'Введите поле и нажмите Enter (для вложенного — address.city)',
    placeholderMore: 'Добавьте поле, чтобы проверять их вместе',
    placeholderFull: `Не более ${MAX_FIELDS} полей`,
    remove: (f: string) => `Убрать ${f}`,
    suggest: 'В этой коллекции:',
    ignoreCase: 'Игнорировать регистр',
    skipMissing: 'Пропускать документы без поля',
    scopeLabel: 'Где искать',
    scopes: { whole: 'Вся коллекция', filter: 'Фильтр документов' } satisfies Record<Scope, string>,
    find: 'Найти дубликаты',
    finding: 'Группировка документов…',
    emptyTitle: 'Выберите поля, которые должны быть уникальными',
    emptyHint:
      'Одно поле или до пяти, проверяемых вместе (например, имя и фамилия). Значения, общие для нескольких документов, перечислены по убыванию числа совпадений.',
    noneTitle: 'Дубликатов нет: все значения уникальны',
    noneHint: (fields: string, scope: Scope) =>
      scope === 'whole'
        ? `Во всей коллекции нет двух документов с одинаковым значением ${fields}.`
        : `Среди документов, оставшихся после фильтра, нет двух с одинаковым значением ${fields}.`,
    lookWhole: 'Искать во всей коллекции',
    found: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${ruForm(more ? Infinity : wholeNumber(n), 'повторяющееся значение', 'повторяющихся значения', 'повторяющихся значений')}`,
    involved: (n: string, more: boolean) =>
      `${n}${more ? '+' : ''} ${ruForm(more ? Infinity : wholeNumber(n), 'затронутый документ', 'затронутых документа', 'затронутых документов')}`,
    scopeNote: { whole: 'вся коллекция', filter: 'в пределах фильтра документов' } satisfies Record<
      Scope,
      string
    >,
    capped: `Перечислены только ${MAX_GROUPS} самых частых значений.`,
    count: 'Документы',
    show: 'Показать',
    showHint: 'Помещает эти документы в запрос раздела «Документы»',
    expand: 'Показать документы',
    collapse: 'Скрыть документы',
    reading: 'Чтение документов…',
    open: 'Открыть',
    firstOf: (shown: string, total: string) => `Документы: показано ${shown} из ${total}.`,
    gone: 'Этих документов больше нет. Запустите поиск снова.',
    showAll: 'Все в разделе «Документы»',
    missing: 'нет',
    noPlace: 'Откройте коллекцию, чтобы искать в ней дубликаты.',
    problems: {
      bad: (f: string) => `«${f}» — недопустимое имя поля.`,
      twice: (f: string) => `Поле ${f} уже выбрано.`,
      tooMany: () => `Не более ${MAX_FIELDS} полей.`,
      none: () => 'Сначала выберите хотя бы одно поле.',
    } satisfies Record<Problem, (f: string) => string>,
    failed: 'Не удалось сгруппировать документы: ',
    readFailed: 'Не удалось прочитать документы: ',
    actionFailed: 'Приложение не приняло действие: ',
  },
}
export type Text = (typeof TEXTS)['en']

/** Every language, none missing: a key left out of one fails to compile. */
export const TEXT = TEXTS satisfies Record<Language, Text>

/** The whole number inside a formatted count ("1 234", "1.234"). */
const wholeNumber = (formatted: string): number => Number(formatted.replace(/\D/g, ''))

/** Russian has three forms, by the kit's plural rule; a "more than" count reads as many. */
function ruForm(n: number, one: string, few: string, many: string): string {
  if (!Number.isFinite(n)) return many
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}

/** What was asked for: the results on screen belong to it. */
interface Run {
  fields: string[]
  ignoreCase: boolean
  skipMissing: boolean
  scope: Scope
  base: Doc
}
interface Group {
  key: Doc
  count: number
}
type Outcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'groups'; groups: Group[] }
type Listing = { state: 'reading' } | { state: 'done'; docs: Doc[] } | { state: 'failed'; error: unknown }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let picked: string[] = []
  let suggested: string[] = []
  let issue: { problem: Problem; field: string } | null = null
  let scope: Scope = 'whole'
  let current: Run | null = null
  let outcome: Outcome = { kind: 'idle' }
  /** The groups opened to their documents, and the documents read for each (by index). */
  const opened = new Set<number>()
  const listings = new Map<number, Listing>()
  /** Where each group's documents are drawn, in the table on screen. */
  const cells = new Map<number, Element>()
  let running = 0
  // The app runs one pipeline of a plugin at a time ("busy"): a run waits for the one before, and
  // one already replaced by a later run is not sent at all.
  const aggregate = serialAsk(async (mine: number, run: Run) =>
    mine !== running
      ? null
      : client.ask<{ documents: Array<{ _id?: Doc; count: unknown }> }>('documents.aggregate', {
          pipeline: duplicatePipeline(
            run.fields,
            { ignoreCase: run.ignoreCase, skipMissing: run.skipMissing },
            run.base,
          ),
          limit: MAX_GROUPS + 1,
        }),
  )

  const currentFilter = (): Doc => ctx?.place?.filter ?? {}
  const hasFilter = () => Object.keys(currentFilter()).length > 0
  const fmt = (n: number) => formatNumber(n, shown(TEXT, locale), 0)

  // ---- the page
  const header = pageHeader({ icon: 'layers', title: text.title, description: '' })
  const fieldsLabel = h('label', { class: 'mm-sr', attrs: { for: 'fields' } })
  const pickedList = h('span', { id: 'picked', class: 'df-picked' })
  const input = h('input', {
    id: 'fields',
    class: 'df-input',
    attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'fields-error' },
  })
  const fieldBox = h('div', { class: 'df-fields' }, fieldsLabel, icon('layers', 15), pickedList, input)
  const findButton = button({ label: text.find, icon: 'search', variant: 'primary', id: 'find' })
  const fieldError = h('p', { id: 'fields-error', class: 'df-error', attrs: { role: 'alert' }, hidden: true })
  const suggestLabel = h('span', { class: 'df-suggest-label' })
  const suggestions = h('div', { id: 'suggestions', class: 'df-suggest-list' })
  const suggestRow = h('div', { class: 'df-suggest', hidden: true }, suggestLabel, suggestions)
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
      rerun()
    },
  })
  const filterChip = h('span', { id: 'filter', class: 'mm-chip mm-mono df-filter' })
  const scopeRow = h('div', { class: 'df-scope' }, scopeControl.el, filterChip)
  const ignoreCase = switchControl({
    label: text.ignoreCase,
    checked: false,
    id: 'ignore-case',
    onChange: rerun,
  })
  const skipMissing = switchControl({
    label: text.skipMissing,
    checked: true,
    id: 'skip-missing',
    onChange: rerun,
  })
  const status = statusLine('status')
  const cap = h('span', { class: 'mm-subtle df-cap', hidden: true })
  const notice = h('p', { class: 'df-error', attrs: { role: 'alert' }, hidden: true })
  const results = h('div', { id: 'results' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h(
        'div',
        { class: 'mm-toolbar' },
        h('div', { class: 'mm-toolbar-row' }, fieldBox, findButton),
        fieldError,
        suggestRow,
        h(
          'div',
          { class: 'mm-toolbar-row' },
          scopeRow,
          h('span', { class: 'mm-spacer' }),
          ignoreCase.el,
          skipMissing.el,
        ),
      ),
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status, cap), notice, results),
    ),
  )

  // ---- the fields picked
  function say(next: typeof issue): void {
    issue = next
    fieldError.hidden = !issue
    fieldError.textContent = issue ? text.problems[issue.problem](issue.field) : ''
  }

  /** Adds the fields in order up to the first refused; what was not added is given back. */
  function add(fields: string[]): string[] {
    for (let i = 0; i < fields.length; i++) {
      const problem = fieldProblem(fields[i]!, picked)
      if (problem) {
        say({ problem, field: fields[i]! })
        paintPicked()
        return fields.slice(i)
      }
      picked.push(fields[i]!)
    }
    paintPicked()
    return []
  }
  function remove(field: string): void {
    picked = picked.filter((f) => f !== field)
    say(null)
    paintPicked()
    input.focus()
  }
  /** What is typed, taken as chips; false when some of it was refused. */
  function commitDraft(): boolean {
    const rest = add(splitFields(input.value))
    input.value = rest.join(', ')
    return !rest.length
  }

  function paintPicked(): void {
    pickedList.replaceChildren(
      ...picked.map((f) =>
        h(
          'span',
          { class: 'mm-chip df-field', title: f },
          h('span', { class: 'mm-mono', text: f }),
          h(
            'button',
            {
              class: 'df-remove',
              attrs: { type: 'button', 'aria-label': text.remove(f) },
              title: text.remove(f),
              on: { click: () => remove(f) },
            },
            icon('x', 12),
          ),
        ),
      ),
    )
    input.placeholder = !picked.length
      ? text.placeholder
      : picked.length < MAX_FIELDS
        ? text.placeholderMore
        : text.placeholderFull
    const offered = picked.length < MAX_FIELDS ? suggested.filter((f) => !picked.includes(f)) : []
    suggestRow.hidden = !offered.length
    suggestions.replaceChildren(
      ...offered.map((f) =>
        chip({
          label: f,
          icon: 'plus',
          mono: true,
          onClick: () => {
            say(null)
            add([f])
            input.focus()
          },
        }),
      ),
    )
  }

  input.addEventListener('input', () => {
    say(null)
    // A comma ends a field, typed or pasted ("city, status").
    if (!input.value.includes(',')) return
    const parts = input.value.split(',')
    const last = parts.pop()!.trimStart()
    const rest = add(splitFields(parts.join(',')))
    input.value = rest.length ? [...rest, last].filter(Boolean).join(', ') : last
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (input.value.trim()) commitDraft()
      else find()
    } else if (e.key === 'Backspace' && !input.value && picked.length) {
      remove(picked.at(-1)!)
    }
  })
  fieldBox.addEventListener('click', (e) => {
    if (e.target === fieldBox || e.target === pickedList) input.focus()
  })

  // ---- running
  const snapshot = (fields: string[]): Run => ({
    fields: [...fields],
    ignoreCase: ignoreCase.input.checked,
    skipMissing: skipMissing.input.checked,
    scope,
    base: scope === 'filter' ? currentFilter() : {},
  })

  function find(): void {
    notice.hidden = true
    if (!ctx?.place || !commitDraft()) return
    if (!picked.length) return say({ problem: 'none', field: '' })
    say(null)
    void start(snapshot(picked))
  }
  /** An option or the scope changed: the results on screen follow. */
  function rerun(): void {
    if (current) void start(snapshot(picked.length ? picked : current.fields))
  }

  async function start(run: Run): Promise<void> {
    const mine = ++running
    current = run
    opened.clear()
    listings.clear()
    outcome = { kind: 'running' }
    setBusy(findButton, true)
    render()
    try {
      const answer = await aggregate(mine, run)
      if (mine !== running || !answer) return
      outcome = {
        kind: 'groups',
        groups: answer.documents.map((g) => ({ key: g._id ?? {}, count: countOf(g.count) })),
      }
    } catch (error) {
      if (mine !== running) return
      outcome = { kind: 'failed', error }
    } finally {
      if (mine === running) {
        setBusy(findButton, false)
        render()
      }
    }
  }

  // ---- the results
  function render(): void {
    status.textContent = ''
    cap.hidden = true
    if (outcome.kind === 'idle') {
      results.replaceChildren(
        ctx?.place
          ? emptyState({ icon: 'layers', title: text.emptyTitle, hint: text.emptyHint })
          : emptyState({ icon: 'database', title: text.noPlace }),
      )
      return
    }
    if (outcome.kind === 'running') {
      status.textContent = text.finding
      results.replaceChildren(skeleton(5))
      return
    }
    if (outcome.kind === 'failed') {
      results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: `${text.failed}${askMessage(outcome.error, locale)}`,
        }),
      )
      return
    }
    const run = current!
    const groups = outcome.groups
    if (!groups.length) {
      const action =
        run.scope === 'filter'
          ? button({
              label: text.lookWhole,
              icon: 'database',
              onClick: () => {
                scopeControl.set('whole')
                scope = 'whole'
                rerun()
              },
            })
          : undefined
      results.replaceChildren(
        emptyState({
          icon: 'ok',
          tone: 'success',
          title: text.noneTitle,
          hint: text.noneHint(run.fields.join(' + '), run.scope),
          ...(action ? { action } : {}),
        }),
      )
      return
    }
    // The one past MAX_GROUPS only says there are more: it is not listed.
    const more = groups.length > MAX_GROUPS
    const listed = groups.slice(0, MAX_GROUPS)
    const involved = listed.reduce((sum, g) => sum + g.count, 0)
    status.replaceChildren(
      h('strong', { text: text.found(fmt(listed.length), more) }),
      document.createTextNode(` · ${text.involved(fmt(involved), more)} · ${text.scopeNote[run.scope]}`),
    )
    cap.hidden = !more
    cap.textContent = text.capped
    const columns = [
      { label: '' },
      ...run.fields.map((f) => ({ label: f })),
      { label: text.count, numeric: true },
      { label: '' },
    ]
    const grid = table(columns)
    cells.clear()
    grid.el.classList.add('df-table')
    const keys = keysOf(run.fields)
    listed.forEach((g, i) => {
      const chevron = button({
        label: text.expand,
        icon: 'chevronRight',
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
      })
      chevron.classList.add('df-chevron')
      const show = button({
        label: text.show,
        icon: 'filter',
        variant: 'ghost',
        size: 'sm',
        title: text.showHint,
        onClick: () => useGroup(run, g),
      })
      const row = grid.row(
        { node: chevron, class: 'df-toggle' },
        ...keys.map((k) =>
          g.key[k] === undefined
            ? h('span', { class: 'mm-value df-missing', text: text.missing })
            : valueView(g.key[k], 80),
        ),
        { node: badge(fmt(g.count), 'accent'), numeric: true, class: 'count' },
        h('div', { class: 'mm-row-actions' }, show),
      )
      row.classList.add('df-group')
      const idsRow = h(
        'tr',
        { class: 'df-ids-row', id: `df-ids-${i}` },
        h('td', { attrs: { colspan: String(columns.length) } }),
      )
      cells.set(i, idsRow.firstElementChild!)
      const paint = (open: boolean) => {
        chevron.setAttribute('aria-expanded', String(open))
        setLabel(chevron, open ? text.collapse : text.expand)
        if (open) chevron.setAttribute('aria-controls', idsRow.id)
        else chevron.removeAttribute('aria-controls')
        row.classList.toggle('df-open', open)
        if (open) row.after(idsRow)
        else idsRow.remove()
      }
      const toggle = () => {
        const open = !opened.has(i)
        if (open) opened.add(i)
        else opened.delete(i)
        paint(open)
        if (!open) return
        const known = listings.get(i)
        // Read once; again only after a failure.
        if (!known || known.state === 'failed') void readIds(run, g, i)
        else fillIds(run, g, i)
      }
      chevron.addEventListener('click', toggle)
      // The whole row opens too, but not through its buttons.
      row.addEventListener('click', (e) => {
        if (!(e.target as Element).closest('button')) toggle()
      })
      paint(opened.has(i))
      if (opened.has(i)) fillIds(run, g, i)
    })
    results.replaceChildren(h('div', { class: 'mm-table-wrap' }, grid.el))
  }

  /** A group's first documents, read when it is opened. */
  async function readIds(run: Run, g: Group, i: number): Promise<void> {
    const mine = running
    listings.set(i, { state: 'reading' })
    fillIds(run, g, i)
    let listing: Listing
    try {
      const answer = await client.ask<{ documents: Doc[] }>('documents.find', {
        filter: groupFilter(run.fields, g.key, run.ignoreCase, run.base),
        projection: idsProjection(run.fields),
        sort: { _id: 1 },
        limit: MAX_IDS,
      })
      listing = { state: 'done', docs: answer.documents.slice(0, MAX_IDS) }
    } catch (error) {
      listing = { state: 'failed', error }
    }
    if (mine !== running) return
    listings.set(i, listing)
    fillIds(run, g, i)
  }

  function fillIds(run: Run, g: Group, i: number): void {
    const cell = cells.get(i)
    if (!cell) return
    const listing = listings.get(i) ?? { state: 'reading' }
    if (listing.state === 'reading') {
      cell.replaceChildren(
        h('div', { class: 'df-ids' }, h('p', { class: 'mm-status', text: text.reading }), skeleton(2)),
      )
      return
    }
    if (listing.state === 'failed') {
      cell.replaceChildren(
        h(
          'div',
          { class: 'df-ids' },
          callout('danger', `${text.readFailed}${askMessage(listing.error, locale)}`),
        ),
      )
      return
    }
    const docs = listing.docs
    const list = h('ul', { class: 'df-id-list' })
    for (const doc of docs) {
      const open = button({
        label: text.open,
        icon: 'external',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          void client.ask('ui.openDocument', { id: doc._id }).catch((e: unknown) => tell(e))
        },
      })
      list.append(
        h(
          'li',
          {},
          h('span', { class: 'df-id' }, valueView(doc._id, 48)),
          // Where the case was ignored, each document's own spelling (the group shows it folded).
          ...(run.ignoreCase
            ? run.fields.map((f) =>
                h(
                  'span',
                  { class: 'mm-kv' },
                  h('span', { class: 'mm-key', text: f }),
                  valueView(valueAt(doc, f), 60),
                ),
              )
            : []),
          h('span', { class: 'mm-spacer' }),
          open,
        ),
      )
    }
    const footer =
      !docs.length || g.count > docs.length
        ? h(
            'p',
            { class: 'df-more' },
            h('span', { text: docs.length ? text.firstOf(fmt(docs.length), fmt(g.count)) : text.gone }),
            docs.length
              ? button({
                  label: text.showAll,
                  icon: 'filter',
                  variant: 'ghost',
                  size: 'sm',
                  onClick: () => useGroup(run, g),
                })
              : null,
          )
        : null
    cell.replaceChildren(
      h('div', { class: 'df-ids', data: { group: String(i) } }, docs.length ? list : null, footer),
    )
  }

  function useGroup(run: Run, g: Group): void {
    notice.hidden = true
    void client
      .ask('ui.useQuery', { filter: groupFilter(run.fields, g.key, run.ignoreCase, run.base) })
      .catch((e: unknown) => tell(e))
  }
  /** A click the app did not take, said above the results. */
  function tell(e: unknown): void {
    notice.textContent = `${text.actionFailed}${askMessage(e, locale)}`
    notice.hidden = false
  }

  // ---- words
  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    fieldsLabel.textContent = text.fields
    setLabel(findButton, text.find)
    suggestLabel.textContent = text.suggest
    ignoreCase.text.textContent = text.ignoreCase
    skipMissing.text.textContent = text.skipMissing
    scopeControl.relabel(text.scopes)
    scopeControl.el.setAttribute('aria-label', text.scopeLabel)
    const filter = currentFilter()
    scopeRow.hidden = !hasFilter()
    filterChip.textContent = JSON.stringify(filter).slice(0, 160)
    filterChip.title = JSON.stringify(filter).slice(0, 2000)
    paintPicked()
    say(issue)
  }
  function setLanguage(next: string): void {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
  }

  findButton.addEventListener('click', () => find())
  client.onContext((next, theme, accent) => {
    setLanguage(next)
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    setLanguage(ctx.locale)
    applyLook(ctx.theme, ctx.accent)
    applyText()
    render()
    if (!ctx.place) {
      for (const control of [findButton, input, ignoreCase.input, skipMissing.input]) control.disabled = true
      return
    }
    input.focus()
    try {
      const sample = await client.ask<{ documents: Doc[] }>('documents.find', { limit: 50 })
      suggested = suggestFields(sample.documents, 12)
      paintPicked()
    } catch {
      // No suggestions: the fields can still be typed.
    }
  })
  applyText()
  render()
}
