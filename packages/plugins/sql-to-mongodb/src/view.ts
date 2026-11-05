// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { AskError, askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  icon,
  langTag,
  pageHeader,
  pick as pickText,
  pluralOf,
  type Language as UiLanguage,
  shown,
  segmented,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
  table,
  valueView,
} from '../../kit/src/ui'
import { LANGUAGE_NAMES, LANGUAGES, code, type Language } from './codegen'
import { examples, quoteName, type Example, type ExampleId } from './examples'
import { sqlMessage } from './messages'
import {
  ROWS,
  asPipeline,
  columnHeads,
  columnOrder,
  columnSource,
  columnsOf,
  flatRow,
  joinAliases,
  nestedKeys,
  planRun,
  positionOf,
  snippetOf,
} from './run'
import { SqlError, canonical, translate, type Doc, type Model } from './translate'
import {
  applyCompletion,
  catalogOf,
  completionsAt,
  type Catalog,
  type Completions,
  type Item,
  type ItemKind,
} from './complete'
import { caretPoint } from './caret'
import { formatSql } from './format'
import { highlightCode, highlightSql, type Piece } from './highlight'

/**
 * SQL to MongoDB (plugins wave 1; redesigned 2026-10-10, spec plugin-tabs-redesign §2.2): the SQL a
 * person knows, as the MongoDB query it means — a find or a pipeline — and as driver code; run
 * read-only in the open collection (at most 50 rows), or put in its Documents or Aggregations.
 * Without a collection (none is given to a collection tab; kept as a guard), it translates only.
 */
export const TEXT = {
  en: {
    title: 'SQL to MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Write a SELECT for ${coll}: see it as a MongoDB query and driver code, and run it here.`
        : 'Write a SELECT and see it as a MongoDB query and driver code.',
    editor: 'SQL query',
    examples: 'Examples',
    exampleNames: {
      filter: 'Filter, sort and limit',
      group: 'Count by group',
      sum: 'Total and average by group',
      like: 'Text pattern (LIKE)',
      in: 'One of a list (IN)',
      join: 'Join another collection',
    } satisfies Record<ExampleId, string>,
    run: 'Run',
    format: 'Format',
    formatHint: (keys: string) => `Format the SQL (${keys})`,
    runHint: (keys: string) => `Run read-only (${keys}): in this collection, and in the one a JOIN names`,
    copy: 'Copy code',
    copyHint: 'Copy the code in the chosen language',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'aggregation pipeline',
    languages: 'Code for',
    noCode: 'Write a SELECT to see it as MongoDB.',
    use: 'Use in Documents',
    agg: 'Open in Aggregations',
    noPlace: 'Open a collection to use the query there.',
    otherCollection: (from: string, coll: string) =>
      `This query reads "${from}"; the collection open here is "${coll}".`,
    paging: 'LIMIT and OFFSET stay in the code: Documents shows its results a page at a time.',
    applied: 'Done: see the collection.',
    failed: 'The app did not take it: ',
    position: (line: number, column: number) => `Line ${line}, column ${column}`,
    showInEditor: 'Show in the editor',
    results: 'Results',
    stale: 'Edited since this run',
    clear: 'Clear',
    clearHint: 'Clear the results',
    emptyTitle: 'Run the query to see what it returns',
    emptyHint: (coll: string, keys: string) =>
      `It runs read-only in ${coll} and shows at most ${ROWS} rows. ${keys} runs it from the editor.`,
    noPlaceTitle: 'Open a collection to run the query',
    noPlaceHint:
      'Here the SELECT is translated only; in a collection’s SQL tab it also runs and shows its rows.',
    running: 'Running…',
    rows: (count: number, n: string, more: boolean) =>
      more ? `First ${n} rows` : `${n} ${pluralOf(count, 'en') === 'one' ? 'row' : 'rows'}`,
    more: 'more match',
    noneTitle: 'No rows',
    noneHint: (coll: string) => `The query ran and matched nothing in ${coll}.`,
    otherTitle: (from: string) => `This query belongs to "${from}"`,
    otherText: (from: string, coll: string) =>
      `Run reads only the collection open here, "${coll}". Change FROM to ${coll}, or open "${from}" to run it there.`,
    runFailed: 'The query could not run',
    open: 'Open',
    openHint: 'Open this document',
    moreColumns: (n: number) => `+${n} more ${pluralOf(n, 'en') === 'one' ? 'column' : 'columns'} not shown`,
    missing: 'Not in this row',
    suggestions: 'Suggestions',
    kinds: {
      keyword: 'keyword',
      field: 'field',
      value: 'value',
      function: 'function',
      collection: 'collection',
    } satisfies Record<ItemKind, string>,
  },
  tr: {
    title: 'SQL → MongoDB',
    description: (coll: string | null) =>
      coll
        ? `${coll} için bir SELECT yazın: MongoDB sorgusu ve sürücü kodu olarak görün, burada çalıştırın.`
        : 'Bir SELECT yazın; MongoDB sorgusu ve sürücü kodu olarak görün.',
    editor: 'SQL sorgusu',
    examples: 'Örnekler',
    exampleNames: {
      filter: 'Filtrele, sırala, sınırla',
      group: 'Gruba göre say',
      sum: 'Gruba göre toplam ve ortalama',
      like: 'Metin kalıbı (LIKE)',
      in: 'Listedekilerden biri (IN)',
      join: 'Başka bir koleksiyonla birleştir',
    } satisfies Record<ExampleId, string>,
    run: 'Çalıştır',
    format: 'Biçimlendir',
    formatHint: (keys: string) => `SQL'i biçimlendir (${keys})`,
    runHint: (keys: string) =>
      `Salt okunur çalıştır (${keys}): bu koleksiyonda ve JOIN'in adlandırdığı koleksiyonda`,
    copy: 'Kodu kopyala',
    copyHint: 'Seçili dildeki kodu kopyala',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'aggregation pipeline',
    languages: 'Kod dili',
    noCode: 'MongoDB karşılığını görmek için bir SELECT yazın.',
    use: 'Belgelerde kullan',
    agg: "Aggregation'da aç",
    noPlace: 'Sorguyu kullanmak için bir koleksiyon açın.',
    otherCollection: (from: string, coll: string) =>
      `Bu sorgu "${from}" koleksiyonunu okuyor; burada açık olan "${coll}".`,
    paging: 'LIMIT ve OFFSET kodda kalır: Belgeler sonuçları sayfa sayfa gösterir.',
    applied: 'Tamam: koleksiyona bakın.',
    failed: 'Uygulama kabul etmedi: ',
    position: (line: number, column: number) => `${line}. satır, ${column}. sütun`,
    showInEditor: 'Düzenleyicide göster',
    results: 'Sonuçlar',
    stale: 'Çalıştırıldıktan sonra değişti',
    clear: 'Temizle',
    clearHint: 'Sonuçları temizle',
    emptyTitle: 'Ne döndürdüğünü görmek için sorguyu çalıştırın',
    emptyHint: (coll: string, keys: string) =>
      `${coll} içinde salt okunur çalışır, en fazla ${ROWS} satır gösterir. Düzenleyicide ${keys} ile de çalışır.`,
    noPlaceTitle: 'Sorguyu çalıştırmak için bir koleksiyon açın',
    noPlaceHint:
      'Burada SELECT yalnızca çevrilir; bir koleksiyonun SQL sekmesinde çalışır ve satırlarını da gösterir.',
    running: 'Çalışıyor…',
    rows: (count: number, n: string, more: boolean) => (more ? `İlk ${n} satır` : `${n} satır`),
    more: 'daha fazlası eşleşiyor',
    noneTitle: 'Satır yok',
    noneHint: (coll: string) => `Sorgu çalıştı; ${coll} içinde eşleşen belge yok.`,
    otherTitle: (from: string) => `Bu sorgu "${from}" koleksiyonuna ait`,
    otherText: (from: string, coll: string) =>
      `Çalıştır yalnızca burada açık olan "${coll}" koleksiyonunu okur. FROM'u ${coll} yapın ya da sorguyu orada çalıştırmak için "${from}" koleksiyonunu açın.`,
    runFailed: 'Sorgu çalıştırılamadı',
    open: 'Aç',
    openHint: 'Bu belgeyi aç',
    moreColumns: (n: number) => `+${n} sütun daha gösterilmiyor`,
    missing: 'Bu satırda yok',
    suggestions: 'Öneriler',
    kinds: {
      keyword: 'anahtar sözcük',
      field: 'alan',
      value: 'değer',
      function: 'fonksiyon',
      collection: 'koleksiyon',
    } satisfies Record<ItemKind, string>,
  },
  zh: {
    title: 'SQL 转 MongoDB',
    description: (coll: string | null) =>
      coll
        ? `为 ${coll} 编写 SELECT：查看对应的 MongoDB 查询和驱动代码，并在此运行。`
        : '编写 SELECT，查看对应的 MongoDB 查询和驱动代码。',
    editor: 'SQL 查询',
    examples: '示例',
    exampleNames: {
      filter: '筛选、排序和限制',
      group: '按分组计数',
      sum: '按分组求和与平均值',
      like: '文本模式 (LIKE)',
      in: '列表中的任一项 (IN)',
      join: '连接另一个集合',
    } satisfies Record<ExampleId, string>,
    run: '运行',
    format: '格式化',
    formatHint: (keys: string) => `格式化 SQL（${keys}）`,
    runHint: (keys: string) => `以只读方式运行（${keys}）：在此集合以及 JOIN 指定的集合中`,
    copy: '复制代码',
    copyHint: '复制所选语言的代码',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: '聚合管道',
    languages: '代码语言',
    noCode: '编写 SELECT，查看对应的 MongoDB 内容。',
    use: '用于文档',
    agg: '在聚合中打开',
    noPlace: '请先打开一个集合，再使用该查询。',
    otherCollection: (from: string, coll: string) => `此查询读取“${from}”；当前打开的集合是“${coll}”。`,
    paging: 'LIMIT 和 OFFSET 保留在代码中：文档页会分页显示结果。',
    applied: '完成：请查看该集合。',
    failed: '应用未接受：',
    position: (line: number, column: number) => `第 ${line} 行，第 ${column} 列`,
    showInEditor: '在编辑器中显示',
    results: '结果',
    stale: '自本次运行后已编辑',
    clear: '清除',
    clearHint: '清除结果',
    emptyTitle: '运行查询以查看返回内容',
    emptyHint: (coll: string, keys: string) =>
      `以只读方式在 ${coll} 中运行，最多显示 ${ROWS} 行。在编辑器中按 ${keys} 即可运行。`,
    noPlaceTitle: '打开集合后才能运行查询',
    noPlaceHint: '此处只翻译 SELECT；在集合的 SQL 标签页中还会运行并显示其行。',
    running: '正在运行…',
    rows: (count: number, n: string, more: boolean) => (more ? `前 ${n} 行` : `${n} 行`),
    more: '还有更多匹配项',
    noneTitle: '没有行',
    noneHint: (coll: string) => `查询已运行，但在 ${coll} 中没有匹配项。`,
    otherTitle: (from: string) => `此查询属于“${from}”`,
    otherText: (from: string, coll: string) =>
      `运行只会读取当前打开的集合“${coll}”。请将 FROM 改为 ${coll}，或打开“${from}”在那里运行。`,
    runFailed: '无法运行查询',
    open: '打开',
    openHint: '打开此文档',
    moreColumns: (n: number) => `另有 ${n} 列未显示`,
    missing: '此行中没有',
    suggestions: '建议',
    kinds: {
      keyword: '关键字',
      field: '字段',
      value: '值',
      function: '函数',
      collection: '集合',
    } satisfies Record<ItemKind, string>,
  },
  ja: {
    title: 'SQL から MongoDB へ',
    description: (coll: string | null) =>
      coll
        ? `${coll} 向けに SELECT を書くと、MongoDB クエリとドライバーコードで確認でき、ここで実行できます。`
        : 'SELECT を書くと、MongoDB クエリとドライバーコードで確認できます。',
    editor: 'SQL クエリ',
    examples: '例',
    exampleNames: {
      filter: 'フィルター、ソート、制限',
      group: 'グループごとの件数',
      sum: 'グループごとの合計と平均',
      like: 'テキストパターン (LIKE)',
      in: 'リストのいずれか (IN)',
      join: '別のコレクションと結合',
    } satisfies Record<ExampleId, string>,
    run: '実行',
    format: '整形',
    formatHint: (keys: string) => `SQL を整形（${keys}）`,
    runHint: (keys: string) =>
      `読み取り専用で実行（${keys}）：このコレクションと JOIN で指定したコレクションが対象`,
    copy: 'コードをコピー',
    copyHint: '選択した言語のコードをコピー',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: '集計パイプライン',
    languages: 'コードの言語',
    noCode: 'SELECT を書くと MongoDB での表現が表示されます。',
    use: 'ドキュメントで使用',
    agg: '集計で開く',
    noPlace: 'クエリを使うには、コレクションを開いてください。',
    otherCollection: (from: string, coll: string) =>
      `このクエリは「${from}」を読み取ります。ここで開いているコレクションは「${coll}」です。`,
    paging: 'LIMIT と OFFSET はコード内に残ります。ドキュメントでは結果がページ単位で表示されます。',
    applied: '完了しました。コレクションを確認してください。',
    failed: 'アプリが受け付けませんでした：',
    position: (line: number, column: number) => `${line} 行目、${column} 列目`,
    showInEditor: 'エディターで表示',
    results: '結果',
    stale: '実行後に編集されました',
    clear: 'クリア',
    clearHint: '結果をクリア',
    emptyTitle: 'クエリを実行すると返される内容を確認できます',
    emptyHint: (coll: string, keys: string) =>
      `${coll} で読み取り専用で実行し、最大 ${ROWS} 行を表示します。エディターで ${keys} を押しても実行できます。`,
    noPlaceTitle: 'クエリを実行するにはコレクションを開いてください',
    noPlaceHint: 'ここでは SELECT の変換のみ行います。コレクションの SQL タブでは実行して行も表示します。',
    running: '実行中…',
    rows: (count: number, n: string, more: boolean) => (more ? `先頭の ${n} 行` : `${n} 行`),
    more: '他にも一致があります',
    noneTitle: '行がありません',
    noneHint: (coll: string) => `クエリは実行されましたが、${coll} に一致するものはありませんでした。`,
    otherTitle: (from: string) => `このクエリは「${from}」のものです`,
    otherText: (from: string, coll: string) =>
      `実行できるのは、ここで開いているコレクション「${coll}」の読み取りのみです。FROM を ${coll} に変更するか、「${from}」を開いてそこで実行してください。`,
    runFailed: 'クエリを実行できませんでした',
    open: '開く',
    openHint: 'このドキュメントを開く',
    moreColumns: (n: number) => `他に ${n} 列あります（非表示）`,
    missing: 'この行にはありません',
    suggestions: '候補',
    kinds: {
      keyword: 'キーワード',
      field: 'フィールド',
      value: '値',
      function: '関数',
      collection: 'コレクション',
    } satisfies Record<ItemKind, string>,
  },
  es: {
    title: 'SQL a MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Escribe un SELECT para ${coll}: míralo como consulta de MongoDB y código de controlador, y ejecútalo aquí.`
        : 'Escribe un SELECT y míralo como consulta de MongoDB y código de controlador.',
    editor: 'Consulta SQL',
    examples: 'Ejemplos',
    exampleNames: {
      filter: 'Filtrar, ordenar y limitar',
      group: 'Contar por grupo',
      sum: 'Total y promedio por grupo',
      like: 'Patrón de texto (LIKE)',
      in: 'Uno de una lista (IN)',
      join: 'Unir con otra colección',
    } satisfies Record<ExampleId, string>,
    run: 'Ejecutar',
    format: 'Dar formato',
    formatHint: (keys: string) => `Dar formato al SQL (${keys})`,
    runHint: (keys: string) =>
      `Ejecutar en solo lectura (${keys}): en esta colección y en la que nombra un JOIN`,
    copy: 'Copiar código',
    copyHint: 'Copiar el código en el lenguaje elegido',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'pipeline de agregación',
    languages: 'Código para',
    noCode: 'Escribe un SELECT para verlo como MongoDB.',
    use: 'Usar en Documentos',
    agg: 'Abrir en Agregaciones',
    noPlace: 'Abre una colección para usar allí la consulta.',
    otherCollection: (from: string, coll: string) =>
      `Esta consulta lee «${from}»; la colección abierta aquí es «${coll}».`,
    paging: 'LIMIT y OFFSET se quedan en el código: Documentos muestra sus resultados por páginas.',
    applied: 'Listo: consulta la colección.',
    failed: 'La aplicación no lo aceptó: ',
    position: (line: number, column: number) => `Línea ${line}, columna ${column}`,
    showInEditor: 'Mostrar en el editor',
    results: 'Resultados',
    stale: 'Editado desde esta ejecución',
    clear: 'Borrar',
    clearHint: 'Borrar los resultados',
    emptyTitle: 'Ejecuta la consulta para ver qué devuelve',
    emptyHint: (coll: string, keys: string) =>
      `Se ejecuta en solo lectura en ${coll} y muestra como máximo ${ROWS} filas. ${keys} la ejecuta desde el editor.`,
    noPlaceTitle: 'Abre una colección para ejecutar la consulta',
    noPlaceHint:
      'Aquí el SELECT solo se traduce; en la pestaña SQL de una colección también se ejecuta y muestra sus filas.',
    running: 'Ejecutando…',
    rows: (count: number, n: string, more: boolean) =>
      more ? `Primeras ${n} filas` : `${n} ${pluralOf(count, 'es') === 'one' ? 'fila' : 'filas'}`,
    more: 'coinciden más',
    noneTitle: 'Sin filas',
    noneHint: (coll: string) => `La consulta se ejecutó y no coincidió nada en ${coll}.`,
    otherTitle: (from: string) => `Esta consulta pertenece a «${from}»`,
    otherText: (from: string, coll: string) =>
      `Ejecutar solo lee la colección abierta aquí, «${coll}». Cambia FROM a ${coll} o abre «${from}» para ejecutarla allí.`,
    runFailed: 'No se pudo ejecutar la consulta',
    open: 'Abrir',
    openHint: 'Abrir este documento',
    moreColumns: (n: number) =>
      `+${n} ${pluralOf(n, 'es') === 'one' ? 'columna más' : 'columnas más'} sin mostrar`,
    missing: 'No está en esta fila',
    suggestions: 'Sugerencias',
    kinds: {
      keyword: 'palabra clave',
      field: 'campo',
      value: 'valor',
      function: 'función',
      collection: 'colección',
    } satisfies Record<ItemKind, string>,
  },
  pt: {
    title: 'SQL para MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Escreva um SELECT para ${coll}: veja-o como consulta do MongoDB e código de driver, e execute-o aqui.`
        : 'Escreva um SELECT e veja-o como consulta do MongoDB e código de driver.',
    editor: 'Consulta SQL',
    examples: 'Exemplos',
    exampleNames: {
      filter: 'Filtrar, ordenar e limitar',
      group: 'Contar por grupo',
      sum: 'Total e média por grupo',
      like: 'Padrão de texto (LIKE)',
      in: 'Um item de uma lista (IN)',
      join: 'Juntar com outra coleção',
    } satisfies Record<ExampleId, string>,
    run: 'Executar',
    format: 'Formatar',
    formatHint: (keys: string) => `Formatar o SQL (${keys})`,
    runHint: (keys: string) => `Executar somente leitura (${keys}): nesta coleção e na que um JOIN nomeia`,
    copy: 'Copiar código',
    copyHint: 'Copiar o código na linguagem escolhida',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'pipeline de agregação',
    languages: 'Código para',
    noCode: 'Escreva um SELECT para vê-lo como MongoDB.',
    use: 'Usar em Documentos',
    agg: 'Abrir em Agregações',
    noPlace: 'Abra uma coleção para usar a consulta nela.',
    otherCollection: (from: string, coll: string) =>
      `Esta consulta lê "${from}"; a coleção aberta aqui é "${coll}".`,
    paging: 'LIMIT e OFFSET ficam no código: Documentos mostra os resultados por página.',
    applied: 'Pronto: veja a coleção.',
    failed: 'O app não aceitou: ',
    position: (line: number, column: number) => `Linha ${line}, coluna ${column}`,
    showInEditor: 'Mostrar no editor',
    results: 'Resultados',
    stale: 'Editado desde esta execução',
    clear: 'Limpar',
    clearHint: 'Limpar os resultados',
    emptyTitle: 'Execute a consulta para ver o que ela retorna',
    emptyHint: (coll: string, keys: string) =>
      `Ela é executada somente leitura em ${coll} e mostra no máximo ${ROWS} linhas. ${keys} a executa pelo editor.`,
    noPlaceTitle: 'Abra uma coleção para executar a consulta',
    noPlaceHint:
      'Aqui o SELECT é apenas traduzido; na aba SQL de uma coleção ele também é executado e mostra as linhas.',
    running: 'Executando…',
    rows: (count: number, n: string, more: boolean) =>
      more ? `Primeiras ${n} linhas` : `${n} ${pluralOf(count, 'pt') === 'one' ? 'linha' : 'linhas'}`,
    more: 'há mais correspondências',
    noneTitle: 'Nenhuma linha',
    noneHint: (coll: string) => `A consulta foi executada e nada correspondeu em ${coll}.`,
    otherTitle: (from: string) => `Esta consulta pertence a "${from}"`,
    otherText: (from: string, coll: string) =>
      `Executar lê apenas a coleção aberta aqui, "${coll}". Altere FROM para ${coll} ou abra "${from}" para executá-la lá.`,
    runFailed: 'Não foi possível executar a consulta',
    open: 'Abrir',
    openHint: 'Abrir este documento',
    moreColumns: (n: number) =>
      `+${n} ${pluralOf(n, 'pt') === 'one' ? 'coluna' : 'colunas'} não exibida${pluralOf(n, 'pt') === 'one' ? '' : 's'}`,
    missing: 'Não está nesta linha',
    suggestions: 'Sugestões',
    kinds: {
      keyword: 'palavra-chave',
      field: 'campo',
      value: 'valor',
      function: 'função',
      collection: 'coleção',
    } satisfies Record<ItemKind, string>,
  },
  ko: {
    title: 'SQL을 MongoDB로',
    description: (coll: string | null) =>
      coll
        ? `${coll}에 대한 SELECT를 작성하세요. MongoDB 쿼리와 드라이버 코드로 확인하고 여기서 실행할 수 있습니다.`
        : 'SELECT를 작성하면 MongoDB 쿼리와 드라이버 코드로 확인할 수 있습니다.',
    editor: 'SQL 쿼리',
    examples: '예시',
    exampleNames: {
      filter: '필터, 정렬, 제한',
      group: '그룹별 개수',
      sum: '그룹별 합계와 평균',
      like: '텍스트 패턴 (LIKE)',
      in: '목록 중 하나 (IN)',
      join: '다른 컬렉션 조인',
    } satisfies Record<ExampleId, string>,
    run: '실행',
    format: '서식',
    formatHint: (keys: string) => `SQL 서식 지정 (${keys})`,
    runHint: (keys: string) => `읽기 전용으로 실행 (${keys}): 이 컬렉션과 JOIN에 지정된 컬렉션에서`,
    copy: '코드 복사',
    copyHint: '선택한 언어의 코드를 복사합니다',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: '집계 파이프라인',
    languages: '코드 언어',
    noCode: 'SELECT를 작성하면 MongoDB 코드로 확인할 수 있습니다.',
    use: '도큐먼트에서 사용',
    agg: '집계에서 열기',
    noPlace: '쿼리를 사용하려면 컬렉션을 여세요.',
    otherCollection: (from: string, coll: string) =>
      `이 쿼리는 "${from}"을(를) 읽습니다. 여기서 열린 컬렉션은 "${coll}"입니다.`,
    paging: 'LIMIT와 OFFSET은 코드에만 남습니다. 도큐먼트는 결과를 페이지 단위로 표시합니다.',
    applied: '완료했습니다. 컬렉션을 확인하세요.',
    failed: '앱이 받아들이지 않았습니다: ',
    position: (line: number, column: number) => `${line}행 ${column}열`,
    showInEditor: '편집기에서 보기',
    results: '결과',
    stale: '실행 후 수정됨',
    clear: '지우기',
    clearHint: '결과 지우기',
    emptyTitle: '쿼리를 실행하여 결과를 확인하세요',
    emptyHint: (coll: string, keys: string) =>
      `${coll}에서 읽기 전용으로 실행되며 최대 ${ROWS}개 행을 표시합니다. 편집기에서 ${keys}로 실행할 수 있습니다.`,
    noPlaceTitle: '쿼리를 실행하려면 컬렉션을 여세요',
    noPlaceHint: '여기서는 SELECT를 변환만 합니다. 컬렉션의 SQL 탭에서는 실행하여 행도 표시합니다.',
    running: '실행 중…',
    rows: (count: number, n: string, more: boolean) => (more ? `처음 ${n}개 행` : `${n}개 행`),
    more: '더 일치합니다',
    noneTitle: '행 없음',
    noneHint: (coll: string) => `쿼리를 실행했지만 ${coll}에서 일치하는 항목이 없습니다.`,
    otherTitle: (from: string) => `이 쿼리는 "${from}"에 속합니다`,
    otherText: (from: string, coll: string) =>
      `실행은 여기서 열린 컬렉션 "${coll}"만 읽습니다. FROM을 ${coll}(으)로 바꾸거나 "${from}"을(를) 열어 그곳에서 실행하세요.`,
    runFailed: '쿼리를 실행할 수 없습니다',
    open: '열기',
    openHint: '이 도큐먼트 열기',
    moreColumns: (n: number) => `열 ${n}개가 더 있으나 표시되지 않습니다`,
    missing: '이 행에 없음',
    suggestions: '제안',
    kinds: {
      keyword: '키워드',
      field: '필드',
      value: '값',
      function: '함수',
      collection: '컬렉션',
    } satisfies Record<ItemKind, string>,
  },
  de: {
    title: 'SQL in MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Schreiben Sie ein SELECT für ${coll}: Sie sehen es als MongoDB-Abfrage und Treibercode und können es hier ausführen.`
        : 'Schreiben Sie ein SELECT und sehen Sie es als MongoDB-Abfrage und Treibercode.',
    editor: 'SQL-Abfrage',
    examples: 'Beispiele',
    exampleNames: {
      filter: 'Filtern, sortieren und begrenzen',
      group: 'Anzahl je Gruppe',
      sum: 'Summe und Durchschnitt je Gruppe',
      like: 'Textmuster (LIKE)',
      in: 'Eines aus einer Liste (IN)',
      join: 'Mit einer anderen Collection verknüpfen',
    } satisfies Record<ExampleId, string>,
    run: 'Ausführen',
    format: 'Formatieren',
    formatHint: (keys: string) => `SQL formatieren (${keys})`,
    runHint: (keys: string) =>
      `Schreibgeschützt ausführen (${keys}): in dieser Collection und in der, die ein JOIN nennt`,
    copy: 'Code kopieren',
    copyHint: 'Den Code in der gewählten Sprache kopieren',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'Aggregations-Pipeline',
    languages: 'Code für',
    noCode: 'Schreiben Sie ein SELECT, um es als MongoDB zu sehen.',
    use: 'In Dokumenten verwenden',
    agg: 'In Aggregationen öffnen',
    noPlace: 'Öffnen Sie eine Collection, um die Abfrage dort zu verwenden.',
    otherCollection: (from: string, coll: string) =>
      `Diese Abfrage liest „${from}“; hier ist die Collection „${coll}“ geöffnet.`,
    paging: 'LIMIT und OFFSET bleiben im Code: Dokumente zeigt seine Ergebnisse seitenweise an.',
    applied: 'Fertig: Sehen Sie sich die Collection an.',
    failed: 'Die App hat es nicht angenommen: ',
    position: (line: number, column: number) => `Zeile ${line}, Spalte ${column}`,
    showInEditor: 'Im Editor anzeigen',
    results: 'Ergebnisse',
    stale: 'Seit diesem Lauf bearbeitet',
    clear: 'Leeren',
    clearHint: 'Die Ergebnisse leeren',
    emptyTitle: 'Führen Sie die Abfrage aus, um ihr Ergebnis zu sehen',
    emptyHint: (coll: string, keys: string) =>
      `Sie läuft schreibgeschützt in ${coll} und zeigt höchstens ${ROWS} Zeilen. ${keys} führt sie aus dem Editor aus.`,
    noPlaceTitle: 'Öffnen Sie eine Collection, um die Abfrage auszuführen',
    noPlaceHint:
      'Hier wird das SELECT nur übersetzt; im SQL-Tab einer Collection wird es auch ausgeführt und zeigt seine Zeilen.',
    running: 'Läuft…',
    rows: (count: number, n: string, more: boolean) =>
      more ? `Erste ${n} Zeilen` : `${n} ${pluralOf(count, 'de') === 'one' ? 'Zeile' : 'Zeilen'}`,
    more: 'weitere passen',
    noneTitle: 'Keine Zeilen',
    noneHint: (coll: string) => `Die Abfrage lief und fand in ${coll} nichts.`,
    otherTitle: (from: string) => `Diese Abfrage gehört zu „${from}“`,
    otherText: (from: string, coll: string) =>
      `Ausführen liest nur die hier geöffnete Collection „${coll}“. Ändern Sie FROM in ${coll} oder öffnen Sie „${from}“, um sie dort auszuführen.`,
    runFailed: 'Die Abfrage konnte nicht ausgeführt werden',
    open: 'Öffnen',
    openHint: 'Dieses Dokument öffnen',
    moreColumns: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? `+${n} weitere Spalte wird nicht angezeigt`
        : `+${n} weitere Spalten werden nicht angezeigt`,
    missing: 'Nicht in dieser Zeile',
    suggestions: 'Vorschläge',
    kinds: {
      keyword: 'Schlüsselwort',
      field: 'Feld',
      value: 'Wert',
      function: 'Funktion',
      collection: 'Collection',
    } satisfies Record<ItemKind, string>,
  },
  fr: {
    title: 'SQL vers MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Écrivez un SELECT pour ${coll} : voyez-le comme une requête MongoDB et du code de pilote, et exécutez-le ici.`
        : 'Écrivez un SELECT et voyez-le comme une requête MongoDB et du code de pilote.',
    editor: 'Requête SQL',
    examples: 'Exemples',
    exampleNames: {
      filter: 'Filtrer, trier et limiter',
      group: 'Nombre par groupe',
      sum: 'Total et moyenne par groupe',
      like: 'Motif de texte (LIKE)',
      in: 'Une valeur d’une liste (IN)',
      join: 'Joindre une autre collection',
    } satisfies Record<ExampleId, string>,
    run: 'Exécuter',
    format: 'Mettre en forme',
    formatHint: (keys: string) => `Mettre en forme le SQL (${keys})`,
    runHint: (keys: string) =>
      `Exécuter en lecture seule (${keys}) : dans cette collection et dans celle que nomme un JOIN`,
    copy: 'Copier le code',
    copyHint: 'Copier le code dans le langage choisi',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'pipeline d’agrégation',
    languages: 'Code pour',
    noCode: 'Écrivez un SELECT pour le voir en MongoDB.',
    use: 'Utiliser dans Documents',
    agg: 'Ouvrir dans Agrégations',
    noPlace: 'Ouvrez une collection pour y utiliser la requête.',
    otherCollection: (from: string, coll: string) =>
      `Cette requête lit « ${from} » ; la collection ouverte ici est « ${coll} ».`,
    paging: 'LIMIT et OFFSET restent dans le code : Documents affiche ses résultats page par page.',
    applied: 'Terminé : consultez la collection.',
    failed: 'L’application ne l’a pas accepté : ',
    position: (line: number, column: number) => `Ligne ${line}, colonne ${column}`,
    showInEditor: 'Afficher dans l’éditeur',
    results: 'Résultats',
    stale: 'Modifiée depuis cette exécution',
    clear: 'Effacer',
    clearHint: 'Effacer les résultats',
    emptyTitle: 'Exécutez la requête pour voir ce qu’elle renvoie',
    emptyHint: (coll: string, keys: string) =>
      `Elle s’exécute en lecture seule dans ${coll} et affiche au plus ${ROWS} lignes. ${keys} l’exécute depuis l’éditeur.`,
    noPlaceTitle: 'Ouvrez une collection pour exécuter la requête',
    noPlaceHint:
      'Ici, le SELECT est seulement traduit ; dans l’onglet SQL d’une collection, il est aussi exécuté et affiche ses lignes.',
    running: 'Exécution…',
    rows: (count: number, n: string, more: boolean) =>
      more ? `Premières ${n} lignes` : `${n} ${pluralOf(count, 'fr') === 'one' ? 'ligne' : 'lignes'}`,
    more: 'autres correspondent',
    noneTitle: 'Aucune ligne',
    noneHint: (coll: string) => `La requête s’est exécutée et ne correspond à rien dans ${coll}.`,
    otherTitle: (from: string) => `Cette requête appartient à « ${from} »`,
    otherText: (from: string, coll: string) =>
      `Exécuter ne lit que la collection ouverte ici, « ${coll} ». Remplacez FROM par ${coll}, ou ouvrez « ${from} » pour l’y exécuter.`,
    runFailed: 'La requête n’a pas pu s’exécuter',
    open: 'Ouvrir',
    openHint: 'Ouvrir ce document',
    moreColumns: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `+${n} colonne de plus non affichée`
        : `+${n} colonnes de plus non affichées`,
    missing: 'Absent de cette ligne',
    suggestions: 'Suggestions',
    kinds: {
      keyword: 'mot-clé',
      field: 'champ',
      value: 'valeur',
      function: 'fonction',
      collection: 'collection',
    } satisfies Record<ItemKind, string>,
  },
  ru: {
    title: 'SQL в MongoDB',
    description: (coll: string | null) =>
      coll
        ? `Напишите SELECT для ${coll}: посмотрите на него как на запрос MongoDB и код драйвера и выполните здесь.`
        : 'Напишите SELECT и посмотрите на него как на запрос MongoDB и код драйвера.',
    editor: 'SQL-запрос',
    examples: 'Примеры',
    exampleNames: {
      filter: 'Фильтр, сортировка и лимит',
      group: 'Количество по группам',
      sum: 'Сумма и среднее по группам',
      like: 'Шаблон текста (LIKE)',
      in: 'Одно из списка (IN)',
      join: 'Объединить с другой коллекцией',
    } satisfies Record<ExampleId, string>,
    run: 'Выполнить',
    format: 'Форматировать',
    formatHint: (keys: string) => `Отформатировать SQL (${keys})`,
    runHint: (keys: string) =>
      `Выполнить только для чтения (${keys}): в этой коллекции и в той, которую называет JOIN`,
    copy: 'Копировать код',
    copyHint: 'Скопировать код на выбранном языке',
    mongodb: 'MongoDB',
    find: 'find',
    aggregate: 'конвейер агрегации',
    languages: 'Код для',
    noCode: 'Напишите SELECT, чтобы увидеть его в MongoDB.',
    use: 'Использовать в «Документах»',
    agg: 'Открыть в «Агрегациях»',
    noPlace: 'Откройте коллекцию, чтобы использовать запрос в ней.',
    otherCollection: (from: string, coll: string) =>
      `Этот запрос читает «${from}», а здесь открыта коллекция «${coll}».`,
    paging: 'LIMIT и OFFSET остаются в коде: «Документы» показывают результаты постранично.',
    applied: 'Готово: посмотрите коллекцию.',
    failed: 'Приложение не приняло запрос: ',
    position: (line: number, column: number) => `Строка ${line}, столбец ${column}`,
    showInEditor: 'Показать в редакторе',
    results: 'Результаты',
    stale: 'Изменен после этого запуска',
    clear: 'Очистить',
    clearHint: 'Очистить результаты',
    emptyTitle: 'Выполните запрос, чтобы увидеть результат',
    emptyHint: (coll: string, keys: string) =>
      `Он выполняется только для чтения в ${coll} и показывает не более ${ROWS} строк. ${keys} запускает его из редактора.`,
    noPlaceTitle: 'Откройте коллекцию, чтобы выполнить запрос',
    noPlaceHint:
      'Здесь SELECT только переводится; на вкладке SQL коллекции он еще и выполняется и показывает строки.',
    running: 'Выполняется…',
    rows: (count: number, n: string, more: boolean) =>
      more
        ? `Первые ${n} строк`
        : `${n} ${pluralOf(count, 'ru') === 'one' ? 'строка' : pluralOf(count, 'ru') === 'few' ? 'строки' : 'строк'}`,
    more: 'совпадают еще',
    noneTitle: 'Нет строк',
    noneHint: (coll: string) => `Запрос выполнен, в ${coll} ничего не найдено.`,
    otherTitle: (from: string) => `Этот запрос относится к «${from}»`,
    otherText: (from: string, coll: string) =>
      `«Выполнить» читает только открытую здесь коллекцию «${coll}». Замените FROM на ${coll} или откройте «${from}», чтобы выполнить запрос там.`,
    runFailed: 'Не удалось выполнить запрос',
    open: 'Открыть',
    openHint: 'Открыть этот документ',
    moreColumns: (n: number) =>
      pluralOf(n, 'ru') === 'one'
        ? `+${n} столбец не показан`
        : pluralOf(n, 'ru') === 'few'
          ? `+${n} столбца не показаны`
          : `+${n} столбцов не показано`,
    missing: 'Нет в этой строке',
    suggestions: 'Подсказки',
    kinds: {
      keyword: 'ключевое слово',
      field: 'поле',
      value: 'значение',
      function: 'функция',
      collection: 'коллекция',
    } satisfies Record<ItemKind, string>,
  },
}
type Text = (typeof TEXT)['en']
// Every language of the app has a full block, checked by the compiler.
TEXT satisfies Record<UiLanguage, Text>

type Outcome =
  | {
      kind: 'rows'
      rows: Doc[]
      more: boolean
      ms: number
      openable: boolean
      order?: string[]
      /** A column's heading and the collection field it comes from, by column. */
      heads?: Record<string, { label: string; note: string | null }>
    }
  | { kind: 'other'; from: string }
  | { kind: 'error'; error: unknown }

const isDoc = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)
/** Documents read for the examples and the suggestions: their fields and values. */
const SAMPLE = 100
/** How long typing must pause before an error in the SQL is shown. */
const ERROR_PAUSE = 900
const MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const KEYS = MAC ? '⌘ Enter' : 'Ctrl+Enter'
const FORMAT_KEYS = MAC ? '⇧⌥F' : 'Shift+Alt+F'

/**
 * The headings of a run's columns: a join's as its SELECT writes them, with where each comes from;
 * else the keys, a joined column noted by its collection field.
 */
function headsOf(
  sql: string,
  rows: Doc[],
  model: Model,
): Record<string, { label: string; note: string | null }> {
  const heads = columnHeads(sql)
  const keys = new Set(rows.flatMap((row) => Object.keys(row)))
  return Object.fromEntries(
    [...keys].map((key) => [key, heads ? heads(key) : { label: key, note: columnSource(key, model) }]),
  )
}

/** Whether two SQL texts are the same query (one laid out by Format, say). */
function sameQuery(a: string, b: string): boolean {
  try {
    return JSON.stringify(translate(a)) === JSON.stringify(translate(b))
  } catch {
    return false
  }
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let model: Model | null = null
  let failure: unknown = null
  let language: Language = 'mongosh'
  let last: { sql: string; outcome: Outcome } | null = null
  let busy = false
  let sample: Doc[] | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  /** A translation error kept back while the SQL is being typed. */
  let quiet = false
  /** The user is in the editor: its first SELECT is not written over them. */
  let touched = false

  const place = () => ctx?.place ?? null

  // ---- the page
  // User request 2026-10-11: SQL files are imported and exported on the app's SQL ↔ MongoDB page;
  // this tab translates and runs SELECTs only.
  const header = pageHeader({
    icon: 'code',
    title: text.title,
    description: '',
  })
  const examplesButton = button({ label: text.examples, icon: 'book', size: 'sm', id: 'examples' })
  examplesButton.append(icon('chevronDown', 14))
  examplesButton.setAttribute('aria-haspopup', 'menu')
  examplesButton.setAttribute('aria-expanded', 'false')
  examplesButton.setAttribute('aria-controls', 'examples-menu')
  const menu = h('div', { id: 'examples-menu', class: 'sq-menu', hidden: true, attrs: { role: 'menu' } })
  const examplesWrap = h('div', { class: 'sq-menu-wrap' }, examplesButton, menu)
  const formatButton = button({ label: text.format, icon: 'alignLeft', size: 'sm', id: 'format' })
  const copyButton = button({ label: text.copy, icon: 'copy', size: 'sm', id: 'copy' })
  const runButton = button({ label: text.run, icon: 'play', variant: 'primary', size: 'sm', id: 'run' })
  runButton.append(h('kbd', { class: 'sq-kbd', text: KEYS }))
  runButton.hidden = true
  const editorLabel = h('label', { class: 'mm-sr', attrs: { for: 'sql' } })
  const input = h('textarea', {
    id: 'sql',
    class: 'mm-textarea sq-editor',
    attrs: {
      rows: '8',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      'aria-invalid': 'false',
      'aria-describedby': 'error',
    },
  })
  const errorBox = h('div', { id: 'error', class: 'sq-error', attrs: { 'aria-live': 'polite' } })
  // Suggestions at the caret (user request 2026-10-10).
  const list = h('ul', {
    id: 'sql-complete',
    class: 'sq-complete',
    hidden: true,
    attrs: { role: 'listbox', 'aria-label': text.suggestions },
  })
  // A combobox, or a screen reader ignores the list; still many lines.
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-multiline', 'true')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', 'sql-complete')
  input.setAttribute('aria-expanded', 'false')
  // User request 2026-10-10: the SQL in colours — a copy of it drawn under the editor's own,
  // transparent, text (the editor keeps typing, selection, undo and the caret).
  const shade = h('pre', { class: 'mm-textarea sq-editor sq-shade', attrs: { 'aria-hidden': 'true' } })
  input.classList.add('sq-editor-input')
  const editorWrap = h('div', { class: 'sq-editor-wrap' }, shade, input, list)
  const editorCard = h(
    'section',
    { class: 'mm-card sq-card' },
    h(
      'div',
      { class: 'sq-bar' },
      examplesWrap,
      formatButton,
      h('span', { class: 'mm-spacer' }),
      copyButton,
      runButton,
    ),
    editorLabel,
    editorWrap,
    errorBox,
  )

  const codeTitle = h('span', { class: 'sq-card-title', text: text.mongodb })
  const kindBadge = h('span', { id: 'kind', class: 'mm-badge mm-badge-accent', hidden: true })
  const languages = segmented<Language>({
    label: text.languages,
    id: 'languages',
    options: LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] })),
    value: language,
    onChange: (next) => {
      language = next
      renderCode()
    },
  })
  languages.el.classList.add('sq-languages')
  const output = h('pre', { id: 'code', attrs: { tabindex: '0' } })
  const useButton = button({ label: text.use, icon: 'filter', size: 'sm', id: 'use' })
  const aggButton = button({ label: text.agg, icon: 'layers', size: 'sm', id: 'agg' })
  const note = h('p', { id: 'note', class: 'mm-status sq-note', attrs: { role: 'status' } })
  const codeCard = h(
    'section',
    { class: 'mm-code sq-code' },
    h('div', { class: 'mm-code-bar sq-code-bar' }, codeTitle, kindBadge, h('span', { class: 'mm-spacer' })),
    h('div', { class: 'sq-languages-row' }, languages.el),
    output,
    h('div', { class: 'sq-foot' }, useButton, aggButton, note),
  )

  const resultsTitle = h('h2', { class: 'mm-section-title' })
  const status = statusLine('status')
  const stale = h('span', { id: 'stale', class: 'mm-badge mm-badge-warning', hidden: true })
  const results = h('div', { id: 'results', class: 'sq-results' })
  // Rows of a query since deleted had no way out (user request 2026-10-10).
  const clearButton = button({
    label: text.clear,
    icon: 'x',
    variant: 'ghost',
    size: 'sm',
    id: 'clear-results',
  })
  clearButton.hidden = true
  const summary = h(
    'div',
    { class: 'mm-summary' },
    resultsTitle,
    status,
    stale,
    h('span', { class: 'mm-spacer' }),
    clearButton,
  )
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('div', { class: 'sq-work' }, editorCard, codeCard),
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, summary, results),
    ),
  )

  // ---- translation
  /**
   * Translates what was typed. `typing`: SQL being written is wrong half the time — its error waits
   * for a pause (and for the suggestions to close), the last good code staying meanwhile.
   */
  function translateNow(typing = false): void {
    clearTimeout(timer)
    clearTimeout(errorTimer)
    timer = undefined
    model = null
    failure = null
    shadeEditor()
    try {
      if (input.value.trim()) model = translate(input.value)
    } catch (e) {
      failure = e
    }
    quiet = typing && !!failure
    if (quiet) {
      errorTimer = setTimeout(revealError, ERROR_PAUSE)
      return renderEditor()
    }
    renderEditor()
    renderCode()
  }
  function revealError(): void {
    if (found) {
      errorTimer = setTimeout(revealError, ERROR_PAUSE)
      return
    }
    quiet = false
    renderEditor()
    renderCode()
  }

  function renderEditor(): void {
    const visible = !!failure && !quiet
    input.setAttribute('aria-invalid', String(visible))
    editorCard.classList.toggle('sq-invalid', visible)
    if (!visible) return errorBox.replaceChildren()
    if (!(failure instanceof SqlError))
      return errorBox.replaceChildren(callout('danger', String((failure as Error).message ?? failure)))
    const at = failure.position
    const { line, column } = positionOf(input.value, at)
    const snip = snippetOf(input.value, at)
    // In the app's language (wave 1 review Minor 10), where it went wrong marked in its line.
    errorBox.replaceChildren(
      callout(
        'danger',
        sqlMessage(failure, locale),
        text.position(line, column),
        h('pre', { class: 'sq-snippet' }, snip.before, h('mark', { text: snip.at }), snip.after),
        button({
          label: text.showInEditor,
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            // The character itself, or the place where something was missing.
            const ch = input.value.codePointAt(at)
            const width = ch === undefined || ch === 10 ? 0 : String.fromCodePoint(ch).length
            input.focus()
            input.setSelectionRange(at, at + width)
          },
        }),
      ),
    )
  }

  function renderCode(): void {
    kindBadge.hidden = !model
    kindBadge.textContent = model ? (model.kind === 'find' ? text.find : text.aggregate) : ''
    kindBadge.className = `mm-badge ${model?.kind === 'aggregate' ? 'mm-badge-info' : 'mm-badge-accent'}`
    paint(output, model ? highlightCode(code(model, language, place()?.db)) : [])
    const coll = place()?.coll
    const usable = !!model && !!coll && model.collection === coll
    copyButton.disabled = !model
    useButton.disabled = !usable || model?.kind !== 'find'
    aggButton.disabled = !usable
    runButton.disabled = !model || busy
    note.textContent = !model
      ? ''
      : !coll
        ? text.noPlace
        : model.collection !== coll
          ? text.otherCollection(model.collection, coll)
          : model.kind === 'find' && (model.skip !== undefined || model.limit !== undefined)
            ? text.paging
            : ''
    renderStale()
  }

  function renderStale(): void {
    stale.hidden = !last || last.sql === input.value
  }

  // ---- running
  const duration = (ms: number) =>
    ms < 1000
      ? `${formatNumber(Math.round(ms), shown(TEXT, locale))} ms`
      : `${formatNumber(ms / 1000, shown(TEXT, locale), 1)} s`

  function renderResults(): void {
    const where = place()
    status.replaceChildren()
    resultsTitle.textContent = text.results
    // No rows where nothing runs: the hint alone (and nothing before the app said where this is).
    summary.hidden = !where
    clearButton.hidden = !last || busy
    if (!ctx) return results.replaceChildren()
    if (!where) {
      results.replaceChildren(callout('info', text.noPlaceTitle, text.noPlaceHint))
      return
    }
    if (busy) {
      status.textContent = text.running
      results.replaceChildren(skeleton(5))
      return
    }
    if (!last) {
      results.replaceChildren(
        emptyState({ icon: 'play', title: text.emptyTitle, hint: text.emptyHint(where.coll, KEYS) }),
      )
      return
    }
    const outcome = last.outcome
    if (outcome.kind === 'other')
      return results.replaceChildren(
        callout('warning', text.otherTitle(outcome.from), text.otherText(outcome.from, where.coll)),
      )
    if (outcome.kind === 'error')
      return results.replaceChildren(callout('danger', text.runFailed, askMessage(outcome.error, locale)))
    status.append(
      h('strong', {
        text: text.rows(
          outcome.rows.length,
          formatNumber(outcome.rows.length, shown(TEXT, locale)),
          outcome.more,
        ),
      }),
      ` · ${outcome.more ? `${text.more} · ` : ''}${duration(outcome.ms)}`,
    )
    if (!outcome.rows.length)
      return results.replaceChildren(
        emptyState({ icon: 'search', title: text.noneTitle, hint: text.noneHint(where.coll) }),
      )
    const { columns, hidden } = columnsOf(outcome.rows, 30, outcome.order)
    const openable = outcome.openable && outcome.rows.some((r) => r._id !== undefined)
    const grid = table([
      { label: '#', numeric: true },
      ...columns.map((c) => {
        const head = outcome.heads?.[c]
        return { label: head?.label ?? c, ...(head?.note ? { note: head.note } : {}) }
      }),
      ...(openable ? [{ label: '' }] : []),
    ])
    grid.el.classList.add('sq-table')
    outcome.rows.forEach((row, i) => {
      const cells = columns.map((c) => {
        if (!(c in row))
          return {
            node: h(
              'span',
              { class: 'sq-missing', title: text.missing },
              h('span', { class: 'mm-sr', text: text.missing }),
            ),
          }
        const v = row[c]
        const view = valueView(v, 60)
        // An object or a list shows its size; the whole of it is a hover away.
        if (v && typeof v === 'object' && view.dataset.kind !== 'oid' && !view.title)
          view.title = JSON.stringify(v).slice(0, 2000)
        return { node: view }
      })
      const id = row._id
      grid.row(
        { node: h('span', { class: 'sq-rownum', text: String(i + 1) }) },
        ...cells,
        ...(openable
          ? [
              {
                node:
                  id === undefined
                    ? null
                    : h(
                        'div',
                        { class: 'mm-row-actions' },
                        button({
                          label: text.open,
                          title: text.openHint,
                          icon: 'external',
                          variant: 'ghost',
                          size: 'sm',
                          onClick: () => {
                            void client
                              .ask('ui.openDocument', { id })
                              .catch(
                                (e: unknown) => (note.textContent = `${text.failed}${askMessage(e, locale)}`),
                              )
                          },
                        }),
                      ),
              },
            ]
          : []),
      )
    })
    results.replaceChildren(h('div', { class: 'mm-table-wrap sq-table-wrap' }, grid.el))
    if (hidden) results.append(h('p', { class: 'mm-status', text: text.moreColumns(hidden) }))
  }

  function setRunning(on: boolean): void {
    busy = on
    setBusy(runButton, on)
    runButton.querySelector('.mm-icon')?.replaceWith(icon(on ? 'loader' : 'play', 14))
    runButton.disabled = on || !model
  }

  async function run(): Promise<void> {
    const where = place()
    if (!where || busy) return
    // What was typed, not what the last pause translated.
    translateNow()
    if (!model) return
    closeMenu()
    const sql = input.value
    const plan = planRun(model, where.coll)
    if (plan.kind !== 'run') {
      const outcome: Outcome =
        plan.kind === 'other'
          ? { kind: 'other', from: plan.from }
          : { kind: 'rows', rows: [], more: false, ms: 0, openable: false }
      last = { sql, outcome }
      renderResults()
      renderStale()
      return
    }
    const openable = model.kind === 'find'
    setRunning(true)
    renderResults()
    const started = performance.now()
    let outcome: Outcome
    try {
      const answer = await client.ask<{ documents?: unknown[]; hasMore?: boolean; truncated?: boolean }>(
        plan.method,
        plan.params,
      )
      // A joined document shows as columns of its fields ("c.name").
      const rows = (answer.documents ?? [])
        .filter(isDoc)
        .slice(0, ROWS)
        .map((row) => flatRow(row, joinAliases(model!), nestedKeys(model!)))
      outcome = {
        kind: 'rows',
        rows,
        more: plan.capped && !!(answer.hasMore ?? answer.truncated),
        ms: performance.now() - started,
        openable,
        order: columnOrder(model),
        heads: headsOf(sql, rows, model),
      }
    } catch (error) {
      outcome = { kind: 'error', error }
    }
    last = { sql, outcome }
    setRunning(false)
    renderResults()
    renderStale()
  }

  // ---- examples
  function closeMenu(): void {
    menu.hidden = true
    examplesButton.setAttribute('aria-expanded', 'false')
  }
  function pick(example: Example): void {
    input.value = example.sql
    closeMenu()
    translateNow()
    input.focus()
  }
  async function openMenu(): Promise<void> {
    // The collection's own fields and values make the examples its own.
    if (place() && sample === null) {
      setBusy(examplesButton, true)
      await loadSample()
      setBusy(examplesButton, false)
    }
    menu.replaceChildren(
      ...examples(place()?.coll ?? null, sample ?? []).map((example) =>
        h(
          'button',
          {
            class: 'sq-menu-item',
            attrs: { type: 'button', role: 'menuitem', tabindex: '-1' },
            on: { click: () => pick(example) },
          },
          h('span', { class: 'sq-menu-label', text: text.exampleNames[example.id] }),
          h('span', { class: 'sq-menu-sql', text: example.sql.replace(/\s*\n\s*/g, ' ') }),
        ),
      ),
    )
    menu.hidden = false
    examplesButton.setAttribute('aria-expanded', 'true')
    menu.querySelector<HTMLButtonElement>('button')?.focus()
  }
  examplesButton.addEventListener('click', () => {
    if (menu.hidden) void openMenu()
    else closeMenu()
  })
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
      examplesButton.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(i + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') closeMenu()
  })
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !examplesWrap.contains(e.target as Node)) closeMenu()
  })

  // ---- suggestions (user request 2026-10-10: "WHERE as I type it; st finds status")
  let catalog: Catalog = catalogOf([], null)
  let sampling: Promise<Doc[]> | null = null
  let found: Completions | null = null
  let active = 0
  /** An arrow key chose an item: Enter takes it even where nothing was typed. */
  let chosen = false
  /** A sample of the collection, read once: its fields and values are what is suggested. */
  function loadSample(): Promise<Doc[]> {
    if (!place()) return Promise.resolve([])
    sampling ??= client
      .ask<{ documents?: unknown[] }>('documents.find', { filter: {}, limit: SAMPLE })
      .then(
        (answer) => (answer.documents ?? []).filter(isDoc),
        () => [],
      )
      .then((docs) => {
        sample = docs
        catalog = catalogOf(docs, place()?.coll ?? null)
        return docs
      })
    return sampling
  }
  function closeList(): void {
    found = null
    chosen = false
    list.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }
  function paintActive(): void {
    const options = [...list.children] as HTMLElement[]
    options.forEach((o, i) => o.setAttribute('aria-selected', String(i === active)))
    const current = options[active]
    if (!current) return
    input.setAttribute('aria-activedescendant', current.id)
    current.scrollIntoView?.({ block: 'nearest' })
  }
  function showList(next: Completions): void {
    found = next
    active = 0
    chosen = false
    list.replaceChildren(
      ...next.items.map((item, i) =>
        h(
          'li',
          {
            id: `sql-option-${i}`,
            class: `sq-option sq-option-${item.kind}`,
            attrs: { role: 'option', 'aria-selected': 'false' },
            on: {
              // The editor keeps the focus: a click takes the item.
              mousedown: (e) => {
                e.preventDefault()
                accept(item)
              },
            },
          },
          h('span', { class: 'sq-option-label', text: item.label }),
          h('span', { class: 'sq-option-kind', text: text.kinds[item.kind] }),
        ),
      ),
    )
    const point = caretPoint(input, next.from)
    list.style.left = `${Math.max(0, input.offsetLeft + point.left - 6)}px`
    list.style.top = `${input.offsetTop + point.top + point.height + 4}px`
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
    paintActive()
  }
  /** What may come at the caret; keywords once a letter of them is typed, the rest at once. */
  function suggest(asked: boolean): void {
    const caret = input.selectionStart ?? input.value.length
    if ((input.selectionEnd ?? caret) !== caret) return closeList()
    const next = completionsAt(input.value, caret, catalog)
    if (!next) return closeList()
    const typed = caret > next.from
    if (!asked && !typed && next.items.every((i) => i.kind === 'keyword')) return closeList()
    showList(next)
  }
  function accept(item: Item): void {
    if (!found) return
    const { text: value, caret } = applyCompletion(input.value, found, item)
    input.value = value
    input.setSelectionRange(caret, caret)
    closeList()
    changed()
    // What may come next: the fields after WHERE, the values after "status =".
    suggest(false)
  }
  input.addEventListener('focus', () => {
    touched = true
    void loadSample().then(() => {
      if (document.activeElement === input && found) suggest(false)
    })
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void loadSample().then(() => suggest(true))
      return
    }
    if (!found) return
    const items = found.items
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      chosen = true
      paintActive()
    } else if (
      (e.key === 'Tab' && !e.shiftKey) ||
      (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)
    ) {
      // A list that opened by itself, nothing typed nor chosen: Enter is a new line, Tab moves on.
      const typed = (input.selectionStart ?? 0) > found.from
      if (typed || chosen) {
        e.preventDefault()
        accept(items[active]!)
      } else closeList()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeList()
    }
  })
  input.addEventListener('blur', closeList)
  input.addEventListener('mousedown', closeList)
  input.addEventListener('scroll', closeList)
  window.addEventListener('resize', closeList)

  // ---- colours (user request 2026-10-10)
  /** Pieces as text nodes and spans of their kind: never markup. */
  function paint(target: HTMLElement, pieces: Piece[]): void {
    target.replaceChildren(
      ...pieces.map((p) =>
        p.kind === 'plain'
          ? document.createTextNode(p.text)
          : h('span', { class: `hl-${p.kind}`, text: p.text }),
      ),
    )
  }
  /** The coloured copy under the editor's transparent text, scrolled with it. */
  function shadeEditor(): void {
    paint(shade, highlightSql(input.value))
    // A last empty line has a height in the editor: give the copy one too.
    if (input.value.endsWith('\n') || !input.value) shade.append(' ')
    shade.scrollTop = input.scrollTop
    shade.scrollLeft = input.scrollLeft
  }
  input.addEventListener('scroll', () => {
    shade.scrollTop = input.scrollTop
    shade.scrollLeft = input.scrollLeft
  })

  // ---- formatting (user request 2026-10-10)
  /** The editor's SQL formatted, kept in the browser's undo where it can be; unreadable SQL says why. */
  function formatEditor(): void {
    const formatted = formatSql(input.value)
    if (formatted === null) return translateNow()
    closeList()
    if (formatted === input.value) return
    input.focus()
    input.select()
    const undoable =
      typeof document.execCommand === 'function' && document.execCommand('insertText', false, formatted)
    if (!undoable || input.value !== formatted) input.value = formatted
    closeList()
    // The same query laid out: the results shown are still its own (review M7).
    if (last && sameQuery(last.sql, formatted)) last = { ...last, sql: formatted }
    translateNow()
  }
  formatButton.addEventListener('click', formatEditor)
  input.addEventListener('keydown', (e) => {
    // Shift+Alt+F, as in code editors (the key, not the letter: Alt changes it on a Mac).
    // …or the letter, where F lies on another key (Turkish F, Dvorak: review M9).
    if (
      e.shiftKey &&
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      (e.code === 'KeyF' || e.key.toLowerCase() === 'f')
    ) {
      e.preventDefault()
      formatEditor()
    }
  })

  // ---- actions
  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
      note.textContent = text.applied
    } catch (e) {
      if (e instanceof AskError && e.code === 'declined') return
      note.textContent = `${text.failed}${askMessage(e, locale)}`
    }
  }
  function openInAggregations(): void {
    // What was typed, not what the last pause translated.
    translateNow()
    if (!model || model.collection !== place()?.coll) return
    const stages = canonical(asPipeline(model))
    void act(() => client.ask('ui.useAggregation', { stages }))
  }

  /** The editor's text changed: translated after a pause. */
  function changed(): void {
    shadeEditor()
    renderStale()
    // Nothing to run: at once, not after the translation's pause.
    if (!input.value.trim()) runButton.disabled = true
    clearTimeout(timer)
    timer = setTimeout(() => translateNow(true), 150)
  }
  input.addEventListener('input', (e) => {
    changed()
    // Typing opens the suggestions; deleting only updates a list already open.
    const inserted = !(e instanceof InputEvent) || !e.inputType.startsWith('delete')
    if (inserted || found) suggest(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    void run()
  })
  runButton.addEventListener('click', () => void run())
  clearButton.addEventListener('click', () => {
    last = null
    renderResults()
    renderStale()
    // The button is gone: the focus goes back where a new query starts.
    input.focus()
  })
  copyButton.addEventListener('click', () => {
    translateNow()
    if (!model) return
    void act(() => client.ask('ui.copy', { text: output.textContent ?? '' }))
  })
  useButton.addEventListener('click', () => {
    translateNow()
    if (model?.kind !== 'find' || model.collection !== place()?.coll) return
    const m = model
    void act(() =>
      client.ask('ui.useQuery', {
        filter: canonical(m.filter),
        ...(m.projection ? { projection: canonical(m.projection) } : {}),
        ...(m.sort ? { sort: canonical(m.sort) } : {}),
      }),
    )
  })
  aggButton.addEventListener('click', openInAggregations)

  function applyText(): void {
    header.setText(text.title, text.description(place()?.coll ?? null))
    editorLabel.textContent = text.editor
    setLabel(examplesButton, text.examples)
    setLabel(copyButton, text.copy)
    copyButton.title = text.copyHint
    setLabel(runButton, text.run)
    setLabel(formatButton, text.format)
    formatButton.title = text.formatHint(FORMAT_KEYS)
    runButton.title = text.runHint(KEYS)
    codeTitle.textContent = text.mongodb
    languages.el.setAttribute('aria-label', text.languages)
    output.dataset.empty = text.noCode
    setLabel(useButton, text.use)
    setLabel(aggButton, text.agg)
    stale.textContent = text.stale
    setLabel(clearButton, text.clear)
    clearButton.title = text.clearHint
    if (!menu.hidden) closeMenu()
    list.setAttribute('aria-label', text.suggestions)
    closeList()
    renderEditor()
    renderCode()
    renderResults()
  }

  client.onContext((next, theme, accent) => {
    locale = next
    text = pickText<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pickText<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    const coll = ctx.place?.coll
    // Nothing runs where no collection is open: translation only.
    runButton.hidden = !coll
    // A collection named like a keyword (order) or with a backtick in it is quoted: it once was not.
    // Not where the user is already writing: an answer late to arrive would go before their words.
    if (!input.value && !touched)
      input.value = coll
        ? `SELECT * FROM ${quoteName(coll)} LIMIT 20`
        : 'SELECT name, age FROM users WHERE age > 30 ORDER BY name'
    translateNow()
    applyText()
  })
  applyText()
}
