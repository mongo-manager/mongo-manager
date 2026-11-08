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
  h,
  icon,
  langTag,
  pick,
  pluralOf,
  shown,
  type Language,
  pageHeader,
  segmented,
  statusLine,
  table,
  type Child,
} from '../../kit/src/ui'
import { Analyzer, slowCsvFile, type Analysis, type SlowGroup } from './analyze'
import { MAX_FILE_BYTES, readLines } from './read'

/**
 * Plugins wave 3 (spec §7): a mongod or mongos log file the user drops, read here in a stream — it
 * never leaves the browser — into slow operations by query shape, errors and warnings, connections
 * and a timeline. A line as written is shown only when the user asks for an example.
 */
type Sort = 'total' | 'count' | 'max' | 'p95'
/** The slow operations' column each sort orders by. */
const SORT_COLUMN: Record<Sort, number> = { count: 3, total: 4, p95: 6, max: 7 }
const SHAPE_SHOWN = 160

/** Russian has three forms by the kit's plural rule: one (1, 21), few (2-4, 22-24) and many (0, 5-20, 25-30). */
function ruForms<T>(n: number, one: T, few: T, many: T): T {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}

export const TEXT = {
  en: {
    title: 'Log analyzer',
    description: 'Drop a mongod or mongos log file: it is read here, in your browser, and never leaves it.',
    drop: 'Drop a log file here',
    or: 'or',
    choose: 'Choose a file',
    formats: 'Structured JSON logs (4.4 and later), legacy text logs, and either gzipped',
    reading: (name: string, pct: number) => `Reading ${name}: ${pct}%`,
    readingOf: (name: string) => `Reading ${name}`,
    cancel: 'Stop',
    stopped: 'Stopped: what was read so far is shown.',
    tooBig: 'This file is over 2 GB (a gzipped one once unzipped): open a part of it.',
    badGzip:
      'This gzipped file could not be read to its end: it is cut short, or not gzip. What was read is shown.',
    nothing: 'No line of this file reads as a MongoDB log.',
    another: 'Read another file',
    csv: 'Save slow operations as CSV',
    summary: 'Summary',
    lines: 'Lines',
    unreadable: 'Not read as log lines',
    from: 'From',
    to: 'To',
    server: 'Server',
    slowOps: 'Slow operations',
    errors: 'Errors',
    warnings: 'Warnings',
    timeline: 'Timeline',
    timelineLabel: (unit: string) => `Log lines and slow operations, a ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `From ${from} to ${to}: at most ${maxText} ${pluralOf(max, 'en') === 'one' ? 'line' : 'lines'} a ${unit} (${busiest}); ${slowText} slow ${pluralOf(slow, 'en') === 'one' ? 'operation' : 'operations'} in all.`,
    units: {
      60000: 'minute',
      3600000: 'hour',
      86400000: 'day',
      604800000: 'week',
      2419200000: 'four-week period',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      pluralOf(n, 'en') === 'one'
        ? `${f} line has a time before 2009 or more than a day after now: it is left out of the range and the timeline.`
        : `${f} lines have a time before 2009 or more than a day after now: they are left out of the range and the timeline.`,
    done: (name: string, n: number, f: string) =>
      `Read ${name}: ${f} ${pluralOf(n, 'en') === 'one' ? 'line' : 'lines'}.`,
    csvLeft: (n: number, f: string) =>
      pluralOf(n, 'en') === 'one'
        ? `${f} slow operation row was left out of the CSV: the app saves 1 MB at most, the slowest first.`
        : `${f} slow operation rows were left out of the CSV: the app saves 1 MB at most, the slowest first.`,
    otherClients: (n: number, f: string) =>
      pluralOf(n, 'en') === 'one'
        ? `${f} more connection line, of a client not listed, was counted (1,000 clients at most).`
        : `${f} more connection lines, of clients not listed, were counted (1,000 clients at most).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? `${s} ${pluralOf(severities, 'en') === 'one' ? 'line' : 'lines'} of a severity past the 16 kept by name`
          : '',
        components
          ? `${c} ${pluralOf(components, 'en') === 'one' ? 'line' : 'lines'} of a component past the 200 kept by name`
          : '',
      ]
        .filter(Boolean)
        .join('; ') + ': counted in the totals, not by name (errors and warnings always are).',
    sortBy: 'Sort by',
    sorts: { total: 'Total time', count: 'Count', max: 'Slowest', p95: 'p95' } satisfies Record<Sort, string>,
    columns: [
      'Namespace',
      'Operation',
      'Shape',
      'Count',
      'Total',
      'Mean',
      'p95',
      'Max',
      'Plan',
      'Keys / docs read / returned',
    ],
    actions: 'Actions',
    copyShape: 'Copy shape',
    example: 'Example',
    hideExample: 'Hide example',
    collscan: 'no index',
    otherSlow: (n: number, f: string) =>
      pluralOf(n, 'en') === 'one'
        ? `${f} more slow operation, of a shape not listed, was counted (5,000 shapes at most).`
        : `${f} more slow operations, of shapes not listed, were counted (5,000 shapes at most).`,
    noSlow: 'No slow operation in this log.',
    messages: 'Errors and warnings',
    messageColumns: ['Severity', 'Component', 'Id', 'Message', 'Count', 'First', 'Last'],
    otherMessages: (n: number, f: string) =>
      pluralOf(n, 'en') === 'one'
        ? `${f} more message was counted but not listed.`
        : `${f} more messages were counted but not listed.`,
    noMessages: 'No error or warning in this log.',
    connections: 'Connections',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) => `${openedText} opened, ${endedText} ended${peakText ? `, at most ${peakText} at once` : ''}.`,
    clientColumns: ['Client', 'Opened', 'Ended', 'Applications'],
  },
  tr: {
    title: 'Log analizcisi',
    description:
      'Bir mongod ya da mongos log dosyası bırakın: burada, tarayıcınızda okunur ve oradan çıkmaz.',
    drop: 'Bir log dosyasını buraya bırakın',
    or: 'ya da',
    choose: 'Dosya seçin',
    formats: 'Yapılandırılmış JSON loglar (4.4 ve sonrası), eski metin loglar ve bunların gzip hâlleri',
    reading: (name: string, pct: number) => `${name} okunuyor: %${pct}`,
    readingOf: (name: string) => `${name} okunuyor`,
    cancel: 'Durdur',
    stopped: 'Durduruldu: o ana kadar okunan gösteriliyor.',
    tooBig: "Bu dosya 2 GB'tan büyük (gzip'liyse açıldığında): bir parçasını açın.",
    badGzip:
      'Bu gzip dosyası sonuna kadar okunamadı: yarım kalmış ya da gzip değil. Okunabilen gösteriliyor.',
    nothing: 'Bu dosyanın hiçbir satırı bir MongoDB logu olarak okunmuyor.',
    another: 'Başka bir dosya oku',
    csv: 'Yavaş işlemleri CSV olarak kaydet',
    summary: 'Özet',
    lines: 'Satır',
    unreadable: 'Log satırı olarak okunmayan',
    from: 'Başlangıç',
    to: 'Bitiş',
    server: 'Sunucu',
    slowOps: 'Yavaş işlemler',
    errors: 'Hatalar',
    warnings: 'Uyarılar',
    timeline: 'Zaman çizelgesi',
    timelineLabel: (unit: string) => `Log satırları ve yavaş işlemler, ${unit} başına`,
    timelineSummary: (
      from: string,
      to: string,
      _max: number,
      maxText: string,
      unit: string,
      busiest: string,
      _slow: number,
      slowText: string,
    ) =>
      `${from} – ${to}: ${unit} başına en çok ${maxText} satır (${busiest}); toplam ${slowText} yavaş işlem.`,
    units: {
      60000: 'dakika',
      3600000: 'saat',
      86400000: 'gün',
      604800000: 'hafta',
      2419200000: 'dört hafta',
    } satisfies Record<number, string>,
    outOfRange: (_n: number, f: string) =>
      `${f} satırın zamanı 2009'dan önce ya da şimdiden bir günden fazla sonra: aralığa ve zaman çizelgesine katılmadı.`,
    done: (name: string, _n: number, f: string) => `${name} okundu: ${f} satır.`,
    csvLeft: (_n: number, f: string) =>
      `${f} yavaş işlem satırı CSV'ye girmedi: uygulama en çok 1 MB kaydeder, önce en yavaşlar.`,
    otherClients: (_n: number, f: string) =>
      `${f} bağlantı satırı daha, listelenmeyen istemcilerden, sayıldı (en çok 1.000 istemci).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities ? `adıyla tutulan 16 önem derecesinin dışında kalan ${s} satır` : '',
        components ? `adıyla tutulan 200 bileşenin dışında kalan ${c} satır` : '',
      ]
        .filter(Boolean)
        .join('; ') + ': toplamlarda sayıldı, adıyla değil (hatalar ve uyarılar her zaman sayılır).',
    sortBy: 'Sırala',
    sorts: { total: 'Toplam süre', count: 'Sayı', max: 'En yavaş', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Ad alanı',
      'İşlem',
      'Biçim',
      'Sayı',
      'Toplam',
      'Ortalama',
      'p95',
      'En çok',
      'Plan',
      'Anahtar / okunan / dönen belge',
    ],
    actions: 'İşlemler',
    copyShape: 'Biçimi kopyala',
    example: 'Örnek',
    hideExample: 'Örneği gizle',
    collscan: 'dizinsiz',
    otherSlow: (_n: number, f: string) =>
      `${f} yavaş işlem daha, listelenmeyen biçimlerde, sayıldı (en çok 5.000 biçim).`,
    noSlow: 'Bu logda yavaş işlem yok.',
    messages: 'Hatalar ve uyarılar',
    messageColumns: ['Önem', 'Bileşen', 'Kimlik', 'İleti', 'Sayı', 'İlk', 'Son'],
    otherMessages: (_n: number, f: string) => `${f} ileti daha sayıldı ama listelenmedi.`,
    noMessages: 'Bu logda hata ya da uyarı yok.',
    connections: 'Bağlantılar',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) => `${openedText} açıldı, ${endedText} kapandı${peakText ? `, aynı anda en çok ${peakText}` : ''}.`,
    clientColumns: ['İstemci', 'Açılan', 'Kapanan', 'Uygulamalar'],
  },
  zh: {
    title: '日志分析器',
    description: '拖入 mongod 或 mongos 日志文件：它只在你的浏览器中读取，不会离开浏览器。',
    drop: '将日志文件拖到这里',
    or: '或',
    choose: '选择文件',
    formats: '结构化 JSON 日志（4.4 及更高版本）、旧版文本日志，以及它们的 gzip 压缩文件',
    reading: (name: string, pct: number) => `正在读取 ${name}：${pct}%`,
    readingOf: (name: string) => `正在读取 ${name}`,
    cancel: '停止',
    stopped: '已停止：显示的是目前已读取的内容。',
    tooBig: '此文件超过 2 GB（gzip 文件指解压后）：请打开其中一部分。',
    badGzip: '无法读取此 gzip 文件的末尾：文件被截断，或不是 gzip。显示的是已读取的内容。',
    nothing: '此文件中没有任何一行可识别为 MongoDB 日志。',
    another: '读取另一个文件',
    csv: '将慢操作保存为 CSV',
    summary: '摘要',
    lines: '行数',
    unreadable: '无法识别为日志行',
    from: '起始',
    to: '结束',
    server: '服务器',
    slowOps: '慢操作',
    errors: '错误',
    warnings: '警告',
    timeline: '时间线',
    timelineLabel: (unit: string) => `日志行与慢操作，每${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      _max: number,
      maxText: string,
      unit: string,
      busiest: string,
      _slow: number,
      slowText: string,
    ) => `${from} 至 ${to}：每${unit}最多 ${maxText} 行（${busiest}）；共 ${slowText} 个慢操作。`,
    units: {
      60000: '分钟',
      3600000: '小时',
      86400000: '天',
      604800000: '周',
      2419200000: '四周',
    } satisfies Record<number, string>,
    outOfRange: (_n: number, f: string) =>
      `${f} 行的时间早于 2009 年，或比当前时间晚一天以上：它们不计入时间范围和时间线。`,
    done: (name: string, _n: number, f: string) => `已读取 ${name}：${f} 行。`,
    csvLeft: (_n: number, f: string) => `${f} 行慢操作未写入 CSV：应用最多保存 1 MB，按最慢优先。`,
    otherClients: (_n: number, f: string) =>
      `另有 ${f} 行连接日志属于未列出的客户端，已计入统计（最多列出 1,000 个客户端）。`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities ? `超出按名称保留的 16 种严重级别的 ${s} 行` : '',
        components ? `超出按名称保留的 200 个组件的 ${c} 行` : '',
      ]
        .filter(Boolean)
        .join('；') + '：已计入总数，但不按名称列出（错误和警告始终会列出）。',
    sortBy: '排序方式',
    sorts: { total: '总耗时', count: '次数', max: '最慢', p95: 'p95' } satisfies Record<Sort, string>,
    columns: [
      '命名空间',
      '操作',
      '形状',
      '次数',
      '总计',
      '平均',
      'p95',
      '最大',
      '计划',
      '键 / 读取文档 / 返回文档',
    ],
    actions: '操作',
    copyShape: '复制形状',
    example: '示例',
    hideExample: '隐藏示例',
    collscan: '无索引',
    otherSlow: (_n: number, f: string) =>
      `另有 ${f} 个慢操作属于未列出的形状，已计入统计（最多列出 5,000 种形状）。`,
    noSlow: '此日志中没有慢操作。',
    messages: '错误和警告',
    messageColumns: ['严重级别', '组件', 'ID', '消息', '次数', '首次', '最近'],
    otherMessages: (_n: number, f: string) => `另有 ${f} 条消息已计入统计，但未列出。`,
    noMessages: '此日志中没有错误或警告。',
    connections: '连接',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) => `已打开 ${openedText} 个，已结束 ${endedText} 个${peakText ? `，同时最多 ${peakText} 个` : ''}。`,
    clientColumns: ['客户端', '已打开', '已结束', '应用程序'],
  },
  ja: {
    title: 'ログアナライザー',
    description:
      'mongod または mongos のログファイルをドロップしてください。ファイルはこのブラウザー内で読み取られ、外部には送信されません。',
    drop: 'ログファイルをここにドロップ',
    or: 'または',
    choose: 'ファイルを選択',
    formats: '構造化 JSON ログ（4.4 以降）、従来のテキストログ、およびそれらの gzip 圧縮ファイル',
    reading: (name: string, pct: number) => `${name} を読み取り中: ${pct}%`,
    readingOf: (name: string) => `${name} を読み取り中`,
    cancel: '停止',
    stopped: '停止しました。ここまでに読み取った内容を表示しています。',
    tooBig: 'このファイルは 2 GB を超えています（gzip の場合は展開後）。一部分だけを開いてください。',
    badGzip:
      'この gzip ファイルは最後まで読み取れませんでした。途中で切れているか、gzip ではありません。読み取れた内容を表示しています。',
    nothing: 'このファイルには、MongoDB のログとして読み取れる行がありません。',
    another: '別のファイルを読み取る',
    csv: '低速操作を CSV として保存',
    summary: '概要',
    lines: '行数',
    unreadable: 'ログ行として読み取れなかった行',
    from: '開始',
    to: '終了',
    server: 'サーバー',
    slowOps: '低速操作',
    errors: 'エラー',
    warnings: '警告',
    timeline: 'タイムライン',
    timelineLabel: (unit: string) => `ログ行と低速操作（${unit}あたり）`,
    timelineSummary: (
      from: string,
      to: string,
      _max: number,
      maxText: string,
      unit: string,
      busiest: string,
      _slow: number,
      slowText: string,
    ) => `${from} から ${to}: ${unit}あたり最大 ${maxText} 行（${busiest}）、低速操作は合計 ${slowText} 件。`,
    units: {
      60000: '1分',
      3600000: '1時間',
      86400000: '1日',
      604800000: '1週間',
      2419200000: '4週間',
    } satisfies Record<number, string>,
    outOfRange: (_n: number, f: string) =>
      `${f} 行の時刻が 2009 年より前、または現在より 1 日以上先です。これらは範囲とタイムラインから除外されました。`,
    done: (name: string, _n: number, f: string) => `${name} を読み取りました: ${f} 行。`,
    csvLeft: (_n: number, f: string) =>
      `低速操作の ${f} 行は CSV に含まれませんでした。アプリが保存できるのは最大 1 MB で、遅いものから順に保存されます。`,
    otherClients: (_n: number, f: string) =>
      `一覧にないクライアントの接続ログ ${f} 行を追加でカウントしました（クライアントは最大 1,000 件）。`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities ? `名前で保持される 16 種類を超える重大度の ${s} 行` : '',
        components ? `名前で保持される 200 個を超えるコンポーネントの ${c} 行` : '',
      ]
        .filter(Boolean)
        .join('、') + ': 合計には含まれますが、名前別には表示されません（エラーと警告は常に表示されます）。',
    sortBy: '並べ替え',
    sorts: { total: '合計時間', count: '回数', max: '最も遅い', p95: 'p95' } satisfies Record<Sort, string>,
    columns: [
      '名前空間',
      '操作',
      'シェイプ',
      '回数',
      '合計',
      '平均',
      'p95',
      '最大',
      'プラン',
      'キー / 読み取り / 返却ドキュメント',
    ],
    actions: '操作',
    copyShape: 'シェイプをコピー',
    example: '例',
    hideExample: '例を隠す',
    collscan: 'インデックスなし',
    otherSlow: (_n: number, f: string) =>
      `一覧にないシェイプの低速操作 ${f} 件を追加でカウントしました（シェイプは最大 5,000 件）。`,
    noSlow: 'このログには低速操作がありません。',
    messages: 'エラーと警告',
    messageColumns: ['重大度', 'コンポーネント', 'ID', 'メッセージ', '回数', '最初', '最後'],
    otherMessages: (_n: number, f: string) =>
      `さらに ${f} 件のメッセージをカウントしましたが、一覧には表示していません。`,
    noMessages: 'このログにはエラーも警告もありません。',
    connections: '接続',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) => `開始 ${openedText} 件、終了 ${endedText} 件${peakText ? `、同時接続数は最大 ${peakText}` : ''}。`,
    clientColumns: ['クライアント', '開始', '終了', 'アプリケーション'],
  },
  es: {
    title: 'Analizador de registros',
    description:
      'Suelta un archivo de registro de mongod o mongos: se lee aquí, en tu navegador, y nunca sale de él.',
    drop: 'Suelta aquí un archivo de registro',
    or: 'o',
    choose: 'Elegir un archivo',
    formats:
      'Registros JSON estructurados (4.4 y posteriores), registros de texto antiguos y ambos comprimidos con gzip',
    reading: (name: string, pct: number) => `Leyendo ${name}: ${pct} %`,
    readingOf: (name: string) => `Leyendo ${name}`,
    cancel: 'Detener',
    stopped: 'Detenido: se muestra lo leído hasta ahora.',
    tooBig: 'Este archivo supera los 2 GB (si es gzip, una vez descomprimido): abre una parte de él.',
    badGzip:
      'No se pudo leer este archivo gzip hasta el final: está cortado o no es gzip. Se muestra lo leído.',
    nothing: 'Ninguna línea de este archivo se reconoce como un registro de MongoDB.',
    another: 'Leer otro archivo',
    csv: 'Guardar las operaciones lentas como CSV',
    summary: 'Resumen',
    lines: 'Líneas',
    unreadable: 'No leídas como líneas de registro',
    from: 'Desde',
    to: 'Hasta',
    server: 'Servidor',
    slowOps: 'Operaciones lentas',
    errors: 'Errores',
    warnings: 'Advertencias',
    timeline: 'Cronología',
    timelineLabel: (unit: string) => `Líneas de registro y operaciones lentas, por ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `De ${from} a ${to}: como máximo ${maxText} ${pluralOf(max, 'es') === 'one' ? 'línea' : 'líneas'} por ${unit} (${busiest}); ${slowText} ${pluralOf(slow, 'es') === 'one' ? 'operación lenta' : 'operaciones lentas'} en total.`,
    units: {
      60000: 'minuto',
      3600000: 'hora',
      86400000: 'día',
      604800000: 'semana',
      2419200000: 'período de cuatro semanas',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      pluralOf(n, 'es') === 'one'
        ? `${f} línea tiene una hora anterior a 2009 o más de un día posterior a la actual: se deja fuera del rango y de la cronología.`
        : `${f} líneas tienen una hora anterior a 2009 o más de un día posterior a la actual: se dejan fuera del rango y de la cronología.`,
    done: (name: string, n: number, f: string) =>
      `Leído ${name}: ${f} ${pluralOf(n, 'es') === 'one' ? 'línea' : 'líneas'}.`,
    csvLeft: (n: number, f: string) =>
      pluralOf(n, 'es') === 'one'
        ? `${f} fila de operaciones lentas se dejó fuera del CSV: la aplicación guarda 1 MB como máximo, primero las más lentas.`
        : `${f} filas de operaciones lentas se dejaron fuera del CSV: la aplicación guarda 1 MB como máximo, primero las más lentas.`,
    otherClients: (n: number, f: string) =>
      pluralOf(n, 'es') === 'one'
        ? `Se contó ${f} línea de conexión más, de un cliente que no figura en la lista (1.000 clientes como máximo).`
        : `Se contaron ${f} líneas de conexión más, de clientes que no figuran en la lista (1.000 clientes como máximo).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? `${s} ${pluralOf(severities, 'es') === 'one' ? 'línea' : 'líneas'} de una gravedad fuera de las 16 que se conservan por nombre`
          : '',
        components
          ? `${c} ${pluralOf(components, 'es') === 'one' ? 'línea' : 'líneas'} de un componente fuera de los 200 que se conservan por nombre`
          : '',
      ]
        .filter(Boolean)
        .join('; ') +
      ': se cuentan en los totales, no por nombre (los errores y las advertencias siempre se cuentan).',
    sortBy: 'Ordenar por',
    sorts: { total: 'Tiempo total', count: 'Cantidad', max: 'Más lenta', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Espacio de nombres',
      'Operación',
      'Forma',
      'Cantidad',
      'Total',
      'Media',
      'p95',
      'Máx.',
      'Plan',
      'Claves / documentos leídos / devueltos',
    ],
    actions: 'Acciones',
    copyShape: 'Copiar forma',
    example: 'Ejemplo',
    hideExample: 'Ocultar ejemplo',
    collscan: 'sin índice',
    otherSlow: (n: number, f: string) =>
      pluralOf(n, 'es') === 'one'
        ? `Se contó ${f} operación lenta más, de una forma que no figura en la lista (5.000 formas como máximo).`
        : `Se contaron ${f} operaciones lentas más, de formas que no figuran en la lista (5.000 formas como máximo).`,
    noSlow: 'No hay ninguna operación lenta en este registro.',
    messages: 'Errores y advertencias',
    messageColumns: ['Gravedad', 'Componente', 'Id', 'Mensaje', 'Cantidad', 'Primero', 'Último'],
    otherMessages: (n: number, f: string) =>
      pluralOf(n, 'es') === 'one'
        ? `Se contó ${f} mensaje más, pero no figura en la lista.`
        : `Se contaron ${f} mensajes más, pero no figuran en la lista.`,
    noMessages: 'No hay ningún error ni advertencia en este registro.',
    connections: 'Conexiones',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) =>
      `${openedText} ${pluralOf(opened, 'es') === 'one' ? 'abierta' : 'abiertas'}, ${endedText} ${pluralOf(ended, 'es') === 'one' ? 'cerrada' : 'cerradas'}${peakText ? `, hasta ${peakText} a la vez` : ''}.`,
    clientColumns: ['Cliente', 'Abiertas', 'Cerradas', 'Aplicaciones'],
  },
  pt: {
    title: 'Analisador de logs',
    description:
      'Solte um arquivo de log do mongod ou do mongos: ele é lido aqui, no seu navegador, e nunca sai dele.',
    drop: 'Solte um arquivo de log aqui',
    or: 'ou',
    choose: 'Escolher um arquivo',
    formats: 'Logs JSON estruturados (4.4 e posteriores), logs de texto antigos e ambos compactados com gzip',
    reading: (name: string, pct: number) => `Lendo ${name}: ${pct}%`,
    readingOf: (name: string) => `Lendo ${name}`,
    cancel: 'Parar',
    stopped: 'Interrompido: o que foi lido até agora é exibido.',
    tooBig: 'Este arquivo tem mais de 2 GB (se for gzip, depois de descompactado): abra uma parte dele.',
    badGzip:
      'Não foi possível ler este arquivo gzip até o fim: ele está cortado ou não é gzip. O que foi lido é exibido.',
    nothing: 'Nenhuma linha deste arquivo é reconhecida como um log do MongoDB.',
    another: 'Ler outro arquivo',
    csv: 'Salvar as operações lentas como CSV',
    summary: 'Resumo',
    lines: 'Linhas',
    unreadable: 'Não lidas como linhas de log',
    from: 'De',
    to: 'Até',
    server: 'Servidor',
    slowOps: 'Operações lentas',
    errors: 'Erros',
    warnings: 'Avisos',
    timeline: 'Linha do tempo',
    timelineLabel: (unit: string) => `Linhas de log e operações lentas, por ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `De ${from} até ${to}: no máximo ${maxText} ${pluralOf(max, 'pt') === 'one' ? 'linha' : 'linhas'} por ${unit} (${busiest}); ${slowText} ${pluralOf(slow, 'pt') === 'one' ? 'operação lenta' : 'operações lentas'} no total.`,
    units: {
      60000: 'minuto',
      3600000: 'hora',
      86400000: 'dia',
      604800000: 'semana',
      2419200000: 'período de quatro semanas',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      pluralOf(n, 'pt') === 'one'
        ? `${f} linha tem um horário anterior a 2009 ou mais de um dia depois de agora: ela fica fora do intervalo e da linha do tempo.`
        : `${f} linhas têm um horário anterior a 2009 ou mais de um dia depois de agora: elas ficam fora do intervalo e da linha do tempo.`,
    done: (name: string, n: number, f: string) =>
      `Lido ${name}: ${f} ${pluralOf(n, 'pt') === 'one' ? 'linha' : 'linhas'}.`,
    csvLeft: (n: number, f: string) =>
      pluralOf(n, 'pt') === 'one'
        ? `${f} linha de operações lentas ficou fora do CSV: o app salva no máximo 1 MB, as mais lentas primeiro.`
        : `${f} linhas de operações lentas ficaram fora do CSV: o app salva no máximo 1 MB, as mais lentas primeiro.`,
    otherClients: (n: number, f: string) =>
      pluralOf(n, 'pt') === 'one'
        ? `Mais ${f} linha de conexão, de um cliente que não está na lista, foi contada (no máximo 1.000 clientes).`
        : `Mais ${f} linhas de conexão, de clientes que não estão na lista, foram contadas (no máximo 1.000 clientes).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? `${s} ${pluralOf(severities, 'pt') === 'one' ? 'linha' : 'linhas'} de uma severidade além das 16 mantidas por nome`
          : '',
        components
          ? `${c} ${pluralOf(components, 'pt') === 'one' ? 'linha' : 'linhas'} de um componente além dos 200 mantidos por nome`
          : '',
      ]
        .filter(Boolean)
        .join('; ') + ': contadas nos totais, não por nome (erros e avisos sempre são contados).',
    sortBy: 'Ordenar por',
    sorts: { total: 'Tempo total', count: 'Quantidade', max: 'Mais lenta', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Namespace',
      'Operação',
      'Forma',
      'Quantidade',
      'Total',
      'Média',
      'p95',
      'Máx.',
      'Plano',
      'Chaves / documentos lidos / retornados',
    ],
    actions: 'Ações',
    copyShape: 'Copiar forma',
    example: 'Exemplo',
    hideExample: 'Ocultar exemplo',
    collscan: 'sem índice',
    otherSlow: (n: number, f: string) =>
      pluralOf(n, 'pt') === 'one'
        ? `Mais ${f} operação lenta, de uma forma que não está na lista, foi contada (no máximo 5.000 formas).`
        : `Mais ${f} operações lentas, de formas que não estão na lista, foram contadas (no máximo 5.000 formas).`,
    noSlow: 'Nenhuma operação lenta neste log.',
    messages: 'Erros e avisos',
    messageColumns: ['Severidade', 'Componente', 'Id', 'Mensagem', 'Quantidade', 'Primeira', 'Última'],
    otherMessages: (n: number, f: string) =>
      pluralOf(n, 'pt') === 'one'
        ? `Mais ${f} mensagem foi contada, mas não está na lista.`
        : `Mais ${f} mensagens foram contadas, mas não estão na lista.`,
    noMessages: 'Nenhum erro ou aviso neste log.',
    connections: 'Conexões',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) =>
      `${openedText} ${pluralOf(opened, 'pt') === 'one' ? 'aberta' : 'abertas'}, ${endedText} ${pluralOf(ended, 'pt') === 'one' ? 'encerrada' : 'encerradas'}${peakText ? `, até ${peakText} ao mesmo tempo` : ''}.`,
    clientColumns: ['Cliente', 'Abertas', 'Encerradas', 'Aplicativos'],
  },
  ko: {
    title: '로그 분석기',
    description:
      'mongod 또는 mongos 로그 파일을 놓으세요. 파일은 브라우저에서만 읽히며 브라우저 밖으로 나가지 않습니다.',
    drop: '로그 파일을 여기에 놓으세요',
    or: '또는',
    choose: '파일 선택',
    formats: '구조화된 JSON 로그(4.4 이상), 기존 텍스트 로그, 그리고 둘 다 gzip으로 압축된 파일',
    reading: (name: string, pct: number) => `${name} 읽는 중: ${pct}%`,
    readingOf: (name: string) => `${name} 읽는 중`,
    cancel: '중지',
    stopped: '중지됨: 지금까지 읽은 내용을 표시합니다.',
    tooBig: '이 파일은 2 GB를 넘습니다(gzip 파일은 압축을 푼 크기 기준). 일부만 여세요.',
    badGzip:
      '이 gzip 파일을 끝까지 읽을 수 없습니다. 파일이 잘렸거나 gzip이 아닙니다. 읽은 내용을 표시합니다.',
    nothing: '이 파일에는 MongoDB 로그로 읽히는 줄이 없습니다.',
    another: '다른 파일 읽기',
    csv: '느린 작업을 CSV로 저장',
    summary: '요약',
    lines: '줄 수',
    unreadable: '로그 줄로 읽지 못함',
    from: '시작',
    to: '종료',
    server: '서버',
    slowOps: '느린 작업',
    errors: '오류',
    warnings: '경고',
    timeline: '타임라인',
    timelineLabel: (unit: string) => `로그 줄과 느린 작업, ${unit}당`,
    timelineSummary: (
      from: string,
      to: string,
      _max: number,
      maxText: string,
      unit: string,
      busiest: string,
      _slow: number,
      slowText: string,
    ) => `${from} ~ ${to}: ${unit}당 최대 ${maxText}줄(${busiest}), 느린 작업은 총 ${slowText}건.`,
    units: {
      60000: '1분',
      3600000: '1시간',
      86400000: '1일',
      604800000: '1주',
      2419200000: '4주',
    } satisfies Record<number, string>,
    outOfRange: (_n: number, f: string) =>
      `${f}줄의 시간이 2009년 이전이거나 현재보다 하루 넘게 뒤입니다. 해당 줄은 범위와 타임라인에서 제외됩니다.`,
    done: (name: string, _n: number, f: string) => `${name} 읽음: ${f}줄.`,
    csvLeft: (_n: number, f: string) =>
      `느린 작업 ${f}행이 CSV에서 제외되었습니다. 앱은 최대 1 MB까지 저장하며 가장 느린 것부터 담습니다.`,
    otherClients: (_n: number, f: string) =>
      `목록에 없는 클라이언트의 연결 로그 ${f}줄이 추가로 집계되었습니다(클라이언트 최대 1,000개).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities ? `이름으로 유지하는 16개 심각도 밖의 ${s}줄` : '',
        components ? `이름으로 유지하는 200개 컴포넌트 밖의 ${c}줄` : '',
      ]
        .filter(Boolean)
        .join('; ') + ': 총계에는 집계되지만 이름별로는 표시되지 않습니다(오류와 경고는 항상 표시됩니다).',
    sortBy: '정렬 기준',
    sorts: { total: '총 시간', count: '횟수', max: '가장 느림', p95: 'p95' } satisfies Record<Sort, string>,
    columns: [
      '네임스페이스',
      '작업',
      '형태',
      '횟수',
      '합계',
      '평균',
      'p95',
      '최대',
      '플랜',
      '키 / 읽은 도큐먼트 / 반환된 도큐먼트',
    ],
    actions: '동작',
    copyShape: '형태 복사',
    example: '예시',
    hideExample: '예시 숨기기',
    collscan: '인덱스 없음',
    otherSlow: (_n: number, f: string) =>
      `목록에 없는 형태의 느린 작업 ${f}건이 추가로 집계되었습니다(형태 최대 5,000개).`,
    noSlow: '이 로그에는 느린 작업이 없습니다.',
    messages: '오류 및 경고',
    messageColumns: ['심각도', '컴포넌트', 'ID', '메시지', '횟수', '처음', '마지막'],
    otherMessages: (_n: number, f: string) => `메시지 ${f}건이 추가로 집계되었지만 목록에는 없습니다.`,
    noMessages: '이 로그에는 오류나 경고가 없습니다.',
    connections: '연결',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) => `${openedText}개 열림, ${endedText}개 종료${peakText ? `, 동시 최대 ${peakText}개` : ''}.`,
    clientColumns: ['클라이언트', '열림', '종료', '애플리케이션'],
  },
  de: {
    title: 'Log-Analyzer',
    description:
      'Eine mongod- oder mongos-Logdatei ablegen: Sie wird hier im Browser gelesen und verlässt ihn nie.',
    drop: 'Logdatei hier ablegen',
    or: 'oder',
    choose: 'Datei auswählen',
    formats: 'Strukturierte JSON-Logs (ab 4.4), ältere Textlogs und beide als gzip',
    reading: (name: string, pct: number) => `${name} wird gelesen: ${pct} %`,
    readingOf: (name: string) => `${name} wird gelesen`,
    cancel: 'Anhalten',
    stopped: 'Angehalten: Das bisher Gelesene wird angezeigt.',
    tooBig: 'Diese Datei ist größer als 2 GB (bei gzip entpackt): Einen Teil davon öffnen.',
    badGzip:
      'Diese gzip-Datei konnte nicht bis zum Ende gelesen werden: Sie ist abgeschnitten oder kein gzip. Das bisher Gelesene wird angezeigt.',
    nothing: 'Keine Zeile dieser Datei lässt sich als MongoDB-Log lesen.',
    another: 'Weitere Datei lesen',
    csv: 'Langsame Operationen als CSV speichern',
    summary: 'Zusammenfassung',
    lines: 'Zeilen',
    unreadable: 'Nicht als Logzeilen gelesen',
    from: 'Von',
    to: 'Bis',
    server: 'Server',
    slowOps: 'Langsame Operationen',
    errors: 'Fehler',
    warnings: 'Warnungen',
    timeline: 'Zeitverlauf',
    timelineLabel: (unit: string) => `Logzeilen und langsame Operationen pro ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `Von ${from} bis ${to}: höchstens ${maxText} ${pluralOf(max, 'de') === 'one' ? 'Zeile' : 'Zeilen'} pro ${unit} (${busiest}); insgesamt ${slowText} ${pluralOf(slow, 'de') === 'one' ? 'langsame Operation' : 'langsame Operationen'}.`,
    units: {
      60000: 'Minute',
      3600000: 'Stunde',
      86400000: 'Tag',
      604800000: 'Woche',
      2419200000: 'Vierwochenzeitraum',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      pluralOf(n, 'de') === 'one'
        ? `${f} Zeile hat eine Zeit vor 2009 oder mehr als einen Tag nach jetzt: Sie bleibt außerhalb von Bereich und Zeitverlauf.`
        : `${f} Zeilen haben eine Zeit vor 2009 oder mehr als einen Tag nach jetzt: Sie bleiben außerhalb von Bereich und Zeitverlauf.`,
    done: (name: string, n: number, f: string) =>
      `${name} gelesen: ${f} ${pluralOf(n, 'de') === 'one' ? 'Zeile' : 'Zeilen'}.`,
    csvLeft: (n: number, f: string) =>
      pluralOf(n, 'de') === 'one'
        ? `${f} Zeile mit langsamen Operationen wurde nicht in die CSV übernommen: Die App speichert höchstens 1 MB, die langsamsten zuerst.`
        : `${f} Zeilen mit langsamen Operationen wurden nicht in die CSV übernommen: Die App speichert höchstens 1 MB, die langsamsten zuerst.`,
    otherClients: (n: number, f: string) =>
      pluralOf(n, 'de') === 'one'
        ? `${f} weitere Verbindungszeile eines nicht aufgeführten Clients wurde mitgezählt (höchstens 1.000 Clients).`
        : `${f} weitere Verbindungszeilen nicht aufgeführter Clients wurden mitgezählt (höchstens 1.000 Clients).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? pluralOf(severities, 'de') === 'one'
            ? `${s} Zeile mit einem Schweregrad außerhalb der 16 nach Namen geführten`
            : `${s} Zeilen mit Schweregraden außerhalb der 16 nach Namen geführten`
          : '',
        components
          ? pluralOf(components, 'de') === 'one'
            ? `${c} Zeile mit einer Komponente außerhalb der 200 nach Namen geführten`
            : `${c} Zeilen mit Komponenten außerhalb der 200 nach Namen geführten`
          : '',
      ]
        .filter(Boolean)
        .join('; ') + ': in den Summen mitgezählt, aber nicht nach Namen (Fehler und Warnungen immer).',
    sortBy: 'Sortieren nach',
    sorts: { total: 'Gesamtzeit', count: 'Anzahl', max: 'Langsamste', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Namespace',
      'Operation',
      'Form',
      'Anzahl',
      'Gesamt',
      'Mittel',
      'p95',
      'Max.',
      'Plan',
      'Schlüssel / gelesene / zurückgegebene Dokumente',
    ],
    actions: 'Aktionen',
    copyShape: 'Form kopieren',
    example: 'Beispiel',
    hideExample: 'Beispiel ausblenden',
    collscan: 'ohne Index',
    otherSlow: (n: number, f: string) =>
      pluralOf(n, 'de') === 'one'
        ? `${f} weitere langsame Operation einer nicht aufgeführten Form wurde mitgezählt (höchstens 5.000 Formen).`
        : `${f} weitere langsame Operationen nicht aufgeführter Formen wurden mitgezählt (höchstens 5.000 Formen).`,
    noSlow: 'Keine langsame Operation in diesem Log.',
    messages: 'Fehler und Warnungen',
    messageColumns: ['Schweregrad', 'Komponente', 'ID', 'Meldung', 'Anzahl', 'Erste', 'Letzte'],
    otherMessages: (n: number, f: string) =>
      pluralOf(n, 'de') === 'one'
        ? `${f} weitere Meldung wurde mitgezählt, aber nicht aufgeführt.`
        : `${f} weitere Meldungen wurden mitgezählt, aber nicht aufgeführt.`,
    noMessages: 'Kein Fehler und keine Warnung in diesem Log.',
    connections: 'Verbindungen',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) =>
      `${openedText} geöffnet, ${endedText} beendet${peakText ? `, höchstens ${peakText} gleichzeitig` : ''}.`,
    clientColumns: ['Client', 'Geöffnet', 'Beendet', 'Anwendungen'],
  },
  fr: {
    title: 'Analyseur de journaux',
    description:
      'Déposez un fichier journal mongod ou mongos : il est lu ici, dans votre navigateur, et ne le quitte jamais.',
    drop: 'Déposez un fichier journal ici',
    or: 'ou',
    choose: 'Choisir un fichier',
    formats:
      'Journaux JSON structurés (4.4 et ultérieurs), journaux texte anciens, et les uns comme les autres compressés en gzip',
    reading: (name: string, pct: number) => `Lecture de ${name} : ${pct} %`,
    readingOf: (name: string) => `Lecture de ${name}`,
    cancel: 'Arrêter',
    stopped: 'Arrêté : ce qui a été lu jusqu’ici est affiché.',
    tooBig: 'Ce fichier dépasse 2 Go (décompressé, s’il est en gzip) : ouvrez-en une partie.',
    badGzip:
      'Ce fichier gzip n’a pas pu être lu jusqu’à la fin : il est tronqué ou n’est pas du gzip. Ce qui a été lu est affiché.',
    nothing: 'Aucune ligne de ce fichier ne se lit comme un journal MongoDB.',
    another: 'Lire un autre fichier',
    csv: 'Enregistrer les opérations lentes en CSV',
    summary: 'Résumé',
    lines: 'Lignes',
    unreadable: 'Non lues comme lignes de journal',
    from: 'Début',
    to: 'Fin',
    server: 'Serveur',
    slowOps: 'Opérations lentes',
    errors: 'Erreurs',
    warnings: 'Avertissements',
    timeline: 'Chronologie',
    timelineLabel: (unit: string) => `Lignes de journal et opérations lentes, par ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `De ${from} à ${to} : au plus ${maxText} ${pluralOf(max, 'fr') === 'one' ? 'ligne' : 'lignes'} par ${unit} (${busiest}) ; ${slowText} ${pluralOf(slow, 'fr') === 'one' ? 'opération lente' : 'opérations lentes'} au total.`,
    units: {
      60000: 'minute',
      3600000: 'heure',
      86400000: 'jour',
      604800000: 'semaine',
      2419200000: 'période de quatre semaines',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      pluralOf(n, 'fr') === 'one'
        ? `${f} ligne a une heure antérieure à 2009 ou postérieure de plus d’un jour à maintenant : elle est exclue de la plage et de la chronologie.`
        : `${f} lignes ont une heure antérieure à 2009 ou postérieure de plus d’un jour à maintenant : elles sont exclues de la plage et de la chronologie.`,
    done: (name: string, n: number, f: string) =>
      `${name} lu : ${f} ${pluralOf(n, 'fr') === 'one' ? 'ligne' : 'lignes'}.`,
    csvLeft: (n: number, f: string) =>
      pluralOf(n, 'fr') === 'one'
        ? `${f} ligne d’opérations lentes n’a pas été incluse dans le CSV : l’app enregistre 1 Mo au plus, les plus lentes d’abord.`
        : `${f} lignes d’opérations lentes n’ont pas été incluses dans le CSV : l’app enregistre 1 Mo au plus, les plus lentes d’abord.`,
    otherClients: (n: number, f: string) =>
      pluralOf(n, 'fr') === 'one'
        ? `${f} ligne de connexion de plus, d’un client non listé, a été comptée (1 000 clients au plus).`
        : `${f} lignes de connexion de plus, de clients non listés, ont été comptées (1 000 clients au plus).`,
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? pluralOf(severities, 'fr') === 'one'
            ? `${s} ligne d’une gravité hors des 16 conservées par nom`
            : `${s} lignes de gravités hors des 16 conservées par nom`
          : '',
        components
          ? pluralOf(components, 'fr') === 'one'
            ? `${c} ligne d’un composant hors des 200 conservés par nom`
            : `${c} lignes de composants hors des 200 conservés par nom`
          : '',
      ]
        .filter(Boolean)
        .join(' ; ') +
      ' : comptées dans les totaux, mais pas par nom (les erreurs et les avertissements le sont toujours).',
    sortBy: 'Trier par',
    sorts: { total: 'Temps total', count: 'Nombre', max: 'Plus lente', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Espace de noms',
      'Opération',
      'Forme',
      'Nombre',
      'Total',
      'Moyenne',
      'p95',
      'Max.',
      'Plan',
      'Clés / documents lus / renvoyés',
    ],
    actions: 'Actions',
    copyShape: 'Copier la forme',
    example: 'Exemple',
    hideExample: 'Masquer l’exemple',
    collscan: 'sans index',
    otherSlow: (n: number, f: string) =>
      pluralOf(n, 'fr') === 'one'
        ? `${f} opération lente de plus, d’une forme non listée, a été comptée (5 000 formes au plus).`
        : `${f} opérations lentes de plus, de formes non listées, ont été comptées (5 000 formes au plus).`,
    noSlow: 'Aucune opération lente dans ce journal.',
    messages: 'Erreurs et avertissements',
    messageColumns: ['Gravité', 'Composant', 'ID', 'Message', 'Nombre', 'Premier', 'Dernier'],
    otherMessages: (n: number, f: string) =>
      pluralOf(n, 'fr') === 'one'
        ? `${f} message de plus a été compté, mais n’est pas listé.`
        : `${f} messages de plus ont été comptés, mais ne sont pas listés.`,
    noMessages: 'Aucune erreur ni avertissement dans ce journal.',
    connections: 'Connexions',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) =>
      `${openedText} ${pluralOf(opened, 'fr') === 'one' ? 'ouverte' : 'ouvertes'}, ${endedText} ${pluralOf(ended, 'fr') === 'one' ? 'terminée' : 'terminées'}${peakText ? `, ${peakText} au plus en même temps` : ''}.`,
    clientColumns: ['Client', 'Ouvertes', 'Terminées', 'Applications'],
  },
  ru: {
    title: 'Анализатор логов',
    description:
      'Перетащите сюда файл лога mongod или mongos: он читается здесь, в вашем браузере, и никогда его не покидает.',
    drop: 'Перетащите файл лога сюда',
    or: 'или',
    choose: 'Выбрать файл',
    formats: 'Структурированные JSON-логи (4.4 и новее), старые текстовые логи и те и другие в gzip',
    reading: (name: string, pct: number) => `Чтение ${name}: ${pct}%`,
    readingOf: (name: string) => `Чтение ${name}`,
    cancel: 'Остановить',
    stopped: 'Остановлено: показано то, что прочитано к этому моменту.',
    tooBig: 'Файл больше 2 ГБ (для gzip — после распаковки): откройте его часть.',
    badGzip:
      'Не удалось прочитать этот gzip-файл до конца: он обрезан или это не gzip. Показано прочитанное.',
    nothing: 'Ни одна строка этого файла не читается как лог MongoDB.',
    another: 'Прочитать другой файл',
    csv: 'Сохранить медленные операции в CSV',
    summary: 'Сводка',
    lines: 'Строки',
    unreadable: 'Не прочитано как строки лога',
    from: 'Начало',
    to: 'Конец',
    server: 'Сервер',
    slowOps: 'Медленные операции',
    errors: 'Ошибки',
    warnings: 'Предупреждения',
    timeline: 'Временная шкала',
    timelineLabel: (unit: string) => `Строки лога и медленные операции ${unit}`,
    timelineSummary: (
      from: string,
      to: string,
      max: number,
      maxText: string,
      unit: string,
      busiest: string,
      slow: number,
      slowText: string,
    ) =>
      `С ${from} по ${to}: не более ${maxText} ${ruForms(max, 'строки', 'строк', 'строк')} ${unit} (${busiest}); всего ${slowText} ${ruForms(slow, 'медленная операция', 'медленные операции', 'медленных операций')}.`,
    units: {
      60000: 'в минуту',
      3600000: 'в час',
      86400000: 'в день',
      604800000: 'в неделю',
      2419200000: 'за четыре недели',
    } satisfies Record<number, string>,
    outOfRange: (n: number, f: string) =>
      ruForms(
        n,
        `${f} строка имеет время раньше 2009 года или более чем на сутки позже текущего: она не входит в диапазон и временную шкалу.`,
        `${f} строки имеют время раньше 2009 года или более чем на сутки позже текущего: они не входят в диапазон и временную шкалу.`,
        `${f} строк имеют время раньше 2009 года или более чем на сутки позже текущего: они не входят в диапазон и временную шкалу.`,
      ),
    done: (name: string, n: number, f: string) =>
      `Файл ${name} прочитан: ${f} ${ruForms(n, 'строка', 'строки', 'строк')}.`,
    csvLeft: (n: number, f: string) =>
      ruForms(
        n,
        `В CSV не вошла ${f} строка медленных операций: приложение сохраняет не более 1 МБ, сначала самые медленные.`,
        `В CSV не вошли ${f} строки медленных операций: приложение сохраняет не более 1 МБ, сначала самые медленные.`,
        `В CSV не вошло ${f} строк медленных операций: приложение сохраняет не более 1 МБ, сначала самые медленные.`,
      ),
    otherClients: (n: number, f: string) =>
      ruForms(
        n,
        `Дополнительно учтена ${f} строка подключения клиента, не вошедшего в список (не более 1 000 клиентов).`,
        `Дополнительно учтены ${f} строки подключений клиентов, не вошедших в список (не более 1 000 клиентов).`,
        `Дополнительно учтено ${f} строк подключений клиентов, не вошедших в список (не более 1 000 клиентов).`,
      ),
    otherKinds: (severities: number, s: string, components: number, c: string) =>
      [
        severities
          ? `${s} ${ruForms(severities, 'строка', 'строки', 'строк')} с уровнем важности за пределами 16 учитываемых по имени`
          : '',
        components
          ? `${c} ${ruForms(components, 'строка', 'строки', 'строк')} с компонентом за пределами 200 учитываемых по имени`
          : '',
      ]
        .filter(Boolean)
        .join('; ') + ': учтены в итогах, но не по имени (ошибки и предупреждения учитываются всегда).',
    sortBy: 'Сортировка',
    sorts: { total: 'Общее время', count: 'Количество', max: 'Самые медленные', p95: 'p95' } satisfies Record<
      Sort,
      string
    >,
    columns: [
      'Пространство имен',
      'Операция',
      'Форма',
      'Количество',
      'Всего',
      'Среднее',
      'p95',
      'Макс.',
      'План',
      'Ключи / прочитанные / возвращенные документы',
    ],
    actions: 'Действия',
    copyShape: 'Копировать форму',
    example: 'Пример',
    hideExample: 'Скрыть пример',
    collscan: 'без индекса',
    otherSlow: (n: number, f: string) =>
      ruForms(
        n,
        `Дополнительно учтена ${f} медленная операция формы, не вошедшей в список (не более 5 000 форм).`,
        `Дополнительно учтены ${f} медленные операции форм, не вошедших в список (не более 5 000 форм).`,
        `Дополнительно учтено ${f} медленных операций форм, не вошедших в список (не более 5 000 форм).`,
      ),
    noSlow: 'В этом логе нет медленных операций.',
    messages: 'Ошибки и предупреждения',
    messageColumns: ['Важность', 'Компонент', 'ID', 'Сообщение', 'Количество', 'Первое', 'Последнее'],
    otherMessages: (n: number, f: string) =>
      ruForms(
        n,
        `Дополнительно учтено ${f} сообщение, не вошедшее в список.`,
        `Дополнительно учтены ${f} сообщения, не вошедшие в список.`,
        `Дополнительно учтено ${f} сообщений, не вошедших в список.`,
      ),
    noMessages: 'В этом логе нет ошибок и предупреждений.',
    connections: 'Подключения',
    connectionsLine: (
      opened: number,
      openedText: string,
      ended: number,
      endedText: string,
      peak: number,
      peakText: string,
    ) =>
      `Открыто: ${openedText}, закрыто: ${endedText}${peakText ? `, одновременно не более ${peakText}` : ''}.`,
    clientColumns: ['Клиент', 'Открыто', 'Закрыто', 'Приложения'],
  },
}
type Text = (typeof TEXT)['en']
// Every language of the kit has its block, with the same keys as English (a missing one fails to compile).
const ALL_TEXT: Record<Language, Text> = TEXT
void ALL_TEXT

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let analysis: Analysis | null = null
  let reading: { name: string; done: number; size: number; stop: AbortController } | null = null
  // While reading: the progress drawn once and changed in place (wave 3 review: drawn again five
  // times a second, Stop lost its focus and a screen reader heard every percent).
  let progress: { meter: HTMLElement; bar: HTMLElement; step: number } | null = null
  let stopped = false
  let problem: string | null = null
  /** The file last read, for the status line (wave 3 second review: it was cleared on every draw). */
  let last: { name: string; lines: number } | null = null
  /** What became of the last CSV saved: rows left out, or the app's refusal (never a "no"). */
  let csvNote: { tone: 'info' | 'danger'; text: string } | null = null
  let sort: Sort = 'total'
  const examples = new Set<string>()

  const header = pageHeader({ icon: 'scroll', title: '', description: '' })
  const status = statusLine('status')
  /** What the status line says, changed only when it changes: a live region is read out each time. */
  const say = (words: string) => {
    if (status.textContent !== words) status.textContent = words
  }
  const body = h('div', { class: 'mm-body la-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))
  // A file dropped beside the drop zone never opens in the page.
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  // The formatters, made once a language (wave 3 review: made again for every number).
  let formats: {
    locale: string
    number: Intl.NumberFormat
    time: Intl.DateTimeFormat
    minute: Intl.DateTimeFormat
  } | null = null
  const format = () => {
    const l = langTag(shown(TEXT, locale))
    if (formats?.locale !== l)
      formats = {
        locale: l,
        number: new Intl.NumberFormat(l),
        time: new Intl.DateTimeFormat(l, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
        minute: new Intl.DateTimeFormat(l, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
      }
    return formats
  }
  const number = (n: number) => format().number.format(n)
  const ms = (n: number) => (n >= 10_000 ? `${number(Math.round(n / 100) / 10)} s` : `${number(n)} ms`)
  const when = (t: number | null) => (t === null ? '—' : `${format().time.format(t)} UTC`)
  const minuteOf = (t: number | null) => (t === null ? '—' : `${format().minute.format(t)} UTC`)

  const percent = () =>
    reading && reading.size ? Math.min(100, Math.floor((reading.done / reading.size) * 100)) : 0
  /** The progress told in place; the status line only at each tenth. */
  function tick(): void {
    if (!reading || !progress) return
    const pct = percent()
    progress.bar.style.width = `${pct}%`
    progress.meter.setAttribute('aria-valuenow', String(pct))
    const step = Math.floor(pct / 10) * 10
    if (step !== progress.step) {
      progress.step = step
      say(text.reading(reading.name, step))
    }
  }

  async function read(file: File): Promise<void> {
    problem = null
    stopped = false
    last = null
    csvNote = null
    examples.clear()
    // Where the person was (the file chooser, then Stop): the summary takes the focus when it is read.
    const startedHere = root.contains(document.activeElement)
    if (file.size > MAX_FILE_BYTES) {
      problem = text.tooBig
      return render()
    }
    const analyzer = new Analyzer()
    const stop = new AbortController()
    reading = { name: file.name, done: 0, size: file.size, stop }
    render()
    try {
      await readLines(
        file,
        (line) => analyzer.add(line),
        (done) => {
          reading!.done = done
          tick()
        },
        stop.signal,
        undefined,
        { onTooLong: () => analyzer.addTooLong() },
      )
    } catch (e) {
      const why = e instanceof Error ? e.message : ''
      if (why === 'stopped') stopped = true
      else if (why === 'too_large') problem = text.tooBig
      else if (why === 'bad_gzip') problem = text.badGzip
      else problem = askMessage(e, locale)
    }
    // Never taken back from the app (wave 3 third review): a frame may take the focus without a
    // gesture, so only while this page still has it.
    const focused = document.hasFocus() && (startedHere || root.contains(document.activeElement))
    reading = null
    progress = null
    analysis = analyzer.result()
    last = { name: file.name, lines: analysis.lines }
    if (!stopped && !problem && analysis.lines === analysis.unreadable) problem = text.nothing
    render()
    // Wave 3 second review: the focus was lost when the page was drawn again.
    if (focused)
      (root.querySelector<HTMLElement>('#summary-title') ?? root.querySelector<HTMLElement>('#file'))?.focus()
  }

  /** Saves what fits the app, the slowest first; says what was left out, or why it was refused. */
  async function saveCsv(): Promise<void> {
    if (!analysis) return
    const file = slowCsvFile(analysis, 'slow-operations')
    csvNote = null
    try {
      await client.ask('ui.download', { name: 'slow-operations', type: 'csv', text: file.text })
      if (file.left) csvNote = { tone: 'info', text: text.csvLeft(file.left, number(file.left)) }
    } catch (e) {
      // A "no" from the person is no failure to show (wave 3 second review).
      if (!(e instanceof AskError && e.code === 'declined'))
        csvNote = { tone: 'danger', text: askMessage(e, locale) }
    }
    render()
  }

  function dropZone(): HTMLElement {
    const input = h('input', {
      id: 'file',
      class: 'mm-sr',
      attrs: { type: 'file', accept: '.log,.json,.txt,.gz,.log.gz,text/plain,application/gzip' },
    })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void read(file)
    })
    const zone = h(
      'label',
      { class: 'la-drop', attrs: { for: 'file' }, id: 'drop' },
      icon('upload', 22),
      h('span', { class: 'la-drop-title', text: text.drop }),
      h(
        'span',
        { class: 'mm-subtle', text: `${text.or} ` },
        h('span', { class: 'la-link', text: text.choose }),
      ),
      h('span', { class: 'mm-subtle la-formats', text: text.formats }),
      input,
    )
    zone.addEventListener('dragover', (e) => {
      e.preventDefault()
      zone.classList.add('la-over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('la-over'))
    zone.addEventListener('drop', (e) => {
      e.preventDefault()
      zone.classList.remove('la-over')
      const file = e.dataTransfer?.files?.[0]
      if (file) void read(file)
    })
    return zone
  }

  function stat(label: string, value: string, tone?: 'warning' | 'danger'): HTMLElement {
    return h(
      'div',
      { class: `mm-card mm-card-pad la-stat${tone ? ` la-${tone}` : ''}` },
      h('span', { class: 'mm-label', text: label }),
      h('strong', { text: value }),
    )
  }

  function chart(a: Analysis): HTMLElement {
    const { buckets, bucketMs } = a.timeline
    const W = 720
    const H = 120
    const max = Math.max(1, ...buckets.map((b) => b.lines))
    const units: Record<number, string> = text.units
    const unit = units[bucketMs] ?? ''
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('class', 'la-chart')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', text.timelineLabel(unit))
    // What the bars show, in words (wave 3 review: the timeline had no text alternative).
    svg.setAttribute('aria-describedby', 'timeline-summary')
    // 2026-10-26: a bar keeps a bar's width (a log of one minute was one block the chart's whole
    // width), and the few there are stand together in the middle.
    const width = Math.min(48, W / Math.max(1, buckets.length))
    const left = (W - width * buckets.length) / 2
    const gap = width > 8 ? 2 : 0.5
    buckets.forEach((b, i) => {
      for (const [value, cls] of [
        [b.lines, 'la-bar'],
        [b.slow, 'la-bar-slow'],
      ] as const) {
        if (!value) continue
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        const height = Math.max(1, (value / max) * (H - 4))
        rect.setAttribute('x', String(left + i * width + gap / 2))
        rect.setAttribute('y', String(H - height))
        rect.setAttribute('width', String(Math.max(0.5, width - gap)))
        rect.setAttribute('height', String(height))
        rect.setAttribute('class', cls)
        svg.append(rect)
      }
    })
    const busiest = buckets.reduce((top, b) => (b.lines > top.lines ? b : top), buckets[0]!)
    const slow = buckets.reduce((n, b) => n + b.slow, 0)
    return h(
      'figure',
      { class: 'mm-card mm-card-pad la-figure' },
      svg,
      // Bars that do not fill the chart stand in its middle: their times under them, not at its ends,
      // one slot's said once (review 2026-10-26, M6).
      left > 0.5
        ? h(
            'figcaption',
            { class: 'mm-subtle la-axis la-axis-centred' },
            h('span', {
              text:
                buckets.length > 1
                  ? `${when(buckets[0]?.at ?? null)} – ${when(buckets.at(-1)?.at ?? null)}`
                  : when(buckets[0]?.at ?? null),
            }),
            h('span', { text: text.timelineLabel(unit) }),
          )
        : h(
            'figcaption',
            { class: 'mm-subtle la-axis' },
            h('span', { text: when(buckets[0]?.at ?? null) }),
            h('span', { text: text.timelineLabel(unit) }),
            h('span', { text: when(buckets.at(-1)?.at ?? null) }),
          ),
      h('p', {
        class: 'mm-sr',
        id: 'timeline-summary',
        text: text.timelineSummary(
          minuteOf(buckets[0]?.at ?? null),
          minuteOf(buckets.at(-1)?.at ?? null),
          busiest.lines,
          number(busiest.lines),
          unit,
          minuteOf(busiest.at),
          slow,
          number(slow),
        ),
      }),
    )
  }

  function slowTable(a: Analysis): HTMLElement {
    const key: Record<Sort, (g: SlowGroup) => number> = {
      total: (g) => g.totalMs,
      count: (g) => g.count,
      max: (g) => g.maxMs,
      p95: (g) => g.p95Ms,
    }
    const groups = [...a.slow].sort((x, y) => key[sort](y) - key[sort](x))
    let index = 0
    const t = table([
      ...text.columns.map((label, i) => ({ label, numeric: i >= 3 && i <= 7 })),
      { label: '' },
    ])
    t.el.classList.add('la-slow')
    // 2026-10-26 (user report: the sort seemed to do nothing): the column sorted by is marked, highest
    // first, and a measure's header sorts by it too.
    const heads = t.el.querySelectorAll('thead th')
    for (const [value, i] of Object.entries(SORT_COLUMN) as Array<[Sort, number]>) {
      const th = heads[i]!
      const label = text.columns[i]!
      const on = value === sort
      if (on) th.setAttribute('aria-sort', 'descending')
      th.classList.toggle('la-sorted', on)
      const head = h(
        'button',
        {
          class: 'la-sort',
          // Named by its label alone: a header's name is read with each of its cells (review M5).
          title: `${text.sortBy}: ${label}`,
          attrs: { type: 'button' },
          data: { sort: value, focusKey: `column:${value}` },
        },
        h('span', { text: label }),
        on ? icon('arrowDown', 12) : null,
      )
      head.addEventListener('click', () => {
        if (sort === value) return
        sort = value
        render()
      })
      th.replaceChildren(head)
    }
    const measure = (i: number, node: Child) =>
      i === SORT_COLUMN[sort] ? { node, class: 'la-sorted' } : node
    // The actions column is named for a screen reader (wave 3 review: its header was empty).
    t.el
      .querySelector('thead th:last-child')!
      .replaceChildren(h('span', { class: 'mm-sr', text: text.actions }))
    for (const g of groups) {
      const id = `${g.ns}\u0000${g.op}\u0000${g.shape}`
      const shape = h('span', {
        class: 'mm-mono la-shape',
        text: g.shape.length > SHAPE_SHOWN ? `${g.shape.slice(0, SHAPE_SHOWN)}…` : g.shape,
        title: g.shape,
      })
      const plans = h(
        'span',
        { class: 'la-plans' },
        ...Object.keys(g.plans)
          .slice(0, 3)
          .map((p) =>
            p.startsWith('COLLSCAN') ? badge(`${p} · ${text.collscan}`, 'warning') : badge(p, 'neutral'),
          ),
      )
      const copy = button({
        label: text.copyShape,
        icon: 'copy',
        size: 'sm',
        variant: 'ghost',
        iconOnly: true,
        onClick: () => void client.ask('ui.copy', { text: g.shape }).catch(() => undefined),
      })
      const showing = examples.has(id)
      const example = button({
        label: showing ? text.hideExample : text.example,
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          if (showing) examples.delete(id)
          else examples.add(id)
          render()
        },
      })
      const at = index++
      copy.dataset.focusKey = `copy:${at}`
      example.dataset.focusKey = `example:${at}`
      const row = t.row(
        h('span', { class: 'mm-mono', text: g.ns }),
        g.op,
        shape,
        measure(3, number(g.count)),
        measure(4, ms(g.totalMs)),
        ms(g.meanMs),
        measure(6, ms(g.p95Ms)),
        measure(7, ms(g.maxMs)),
        plans,
        `${number(g.keysExamined)} / ${number(g.docsExamined)} / ${number(g.returned)}`,
        h('span', { class: 'la-row-actions' }, copy, example),
      )
      row.dataset.shape = g.shape
      if (g.collscan) row.classList.add('la-collscan')
      if (showing) {
        const tr = h(
          'tr',
          { class: 'la-example' },
          h(
            'td',
            { attrs: { colspan: String(text.columns.length + 1) } },
            h('pre', { class: 'mm-mono', text: g.example }),
          ),
        )
        t.body.append(tr)
      }
    }
    return h('div', { class: 'mm-table-wrap' }, t.el)
  }

  function results(a: Analysis): HTMLElement[] {
    const errors = (a.severities.E ?? 0) + (a.severities.F ?? 0)
    const warnings = a.severities.W ?? 0
    const sortControl = segmented<Sort>({
      label: text.sortBy,
      id: 'sort',
      options: (['total', 'count', 'max', 'p95'] as const).map((value) => ({
        value,
        label: text.sorts[value],
      })),
      value: sort,
      onChange: (next) => {
        sort = next
        render()
      },
    })
    for (const option of sortControl.el.querySelectorAll<HTMLElement>('[data-value]'))
      option.dataset.focusKey = `sort:${option.dataset.value}`
    const messages = table(text.messageColumns.map((label, i) => ({ label, numeric: i === 4 })))
    for (const m of a.messages)
      messages.row(
        badge(m.severity, m.severity === 'W' ? 'warning' : 'danger'),
        m.component,
        m.id === null ? '—' : String(m.id),
        m.msg,
        number(m.count),
        when(m.first),
        when(m.last),
      )
    const clients = table(text.clientColumns.map((label, i) => ({ label, numeric: i === 1 || i === 2 })))
    for (const c of a.connections.clients)
      clients.row(
        h('span', { class: 'mm-mono', text: c.client }),
        number(c.opened),
        number(c.ended),
        c.apps.join(', '),
      )
    return [
      h('h2', {
        class: 'mm-section-title',
        id: 'summary-title',
        attrs: { tabindex: '-1' },
        text: text.summary,
      }),
      h(
        'div',
        { class: 'la-stats', id: 'summary' },
        stat(text.lines, number(a.lines)),
        stat(text.unreadable, number(a.unreadable)),
        stat(text.from, when(a.first)),
        stat(text.to, when(a.last)),
        // Every slow line, of the shapes not listed too (wave 3 review).
        stat(text.slowOps, number(a.slowLines)),
        stat(text.errors, number(errors), errors ? 'danger' : undefined),
        stat(text.warnings, number(warnings), warnings ? 'warning' : undefined),
        ...(a.version || a.host ? [stat(text.server, [a.host, a.version].filter(Boolean).join(' · '))] : []),
      ),
      ...(a.outOfRange ? [callout('info', text.outOfRange(a.outOfRange, number(a.outOfRange)))] : []),
      ...(a.otherSeverities || a.otherComponents
        ? [
            Object.assign(
              callout(
                'info',
                text.otherKinds(
                  a.otherSeverities,
                  number(a.otherSeverities),
                  a.otherComponents,
                  number(a.otherComponents),
                ),
              ),
              { id: 'other-kinds' },
            ),
          ]
        : []),
      ...(a.timeline.buckets.length
        ? [h('h2', { class: 'mm-section-title', text: text.timeline }), chart(a)]
        : []),
      h(
        'div',
        { class: 'la-section-head' },
        h('h2', { class: 'mm-section-title', text: text.slowOps }),
        sortControl.el,
      ),
      a.slow.length ? slowTable(a) : h('p', { class: 'mm-subtle', text: text.noSlow }),
      ...(a.otherSlow ? [callout('info', text.otherSlow(a.otherSlow, number(a.otherSlow)))] : []),
      h('h2', { class: 'mm-section-title', text: text.messages }),
      a.messages.length
        ? h('div', { class: 'mm-table-wrap', id: 'messages' }, messages.el)
        : h('p', { class: 'mm-subtle', text: text.noMessages }),
      ...(a.otherMessages
        ? [callout('info', text.otherMessages(a.otherMessages, number(a.otherMessages)))]
        : []),
      h('h2', { class: 'mm-section-title', text: text.connections }),
      h('p', {
        text: text.connectionsLine(
          a.connections.opened,
          number(a.connections.opened),
          a.connections.ended,
          number(a.connections.ended),
          a.connections.peak,
          a.connections.peak ? number(a.connections.peak) : '',
        ),
      }),
      ...(a.connections.clients.length
        ? [h('div', { class: 'mm-table-wrap', id: 'clients' }, clients.el)]
        : []),
      ...(a.connections.otherClients
        ? [callout('info', text.otherClients(a.connections.otherClients, number(a.connections.otherClients)))]
        : []),
    ]
  }

  function render(): void {
    // The control that had the focus, found again once drawn (wave 3 second review).
    const focusKey = root.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.focusKey
      : undefined
    draw()
    if (focusKey) root.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus()
  }

  function draw(): void {
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    const actions: HTMLElement[] = []
    if (analysis && !reading) {
      actions.push(
        button({
          label: text.csv,
          icon: 'download',
          id: 'csv',
          onClick: () => void saveCsv(),
        }),
        button({
          label: text.another,
          icon: 'upload',
          id: 'another',
          onClick: () => {
            analysis = null
            problem = null
            // Wave 3 review: the last file's "Stopped" stayed.
            stopped = false
            last = null
            csvNote = null
            render()
          },
        }),
      )
      for (const b of actions) b.dataset.focusKey = b.id
    }
    header.setText(text.title, text.description)
    header.querySelector('.mm-head-actions')!.replaceChildren(...actions)
    body.replaceChildren()
    if (reading) {
      const pct = percent()
      const step = Math.floor(pct / 10) * 10
      say(text.reading(reading.name, step))
      const stop = reading.stop
      const meter = h(
        'div',
        {
          class: 'la-progress',
          attrs: {
            role: 'progressbar',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(pct),
            'aria-label': text.readingOf(reading.name),
          },
        },
        h('div', { class: 'la-progress-bar' }),
      )
      body.append(
        h(
          'div',
          { class: 'mm-card mm-card-pad la-reading' },
          meter,
          button({ label: text.cancel, icon: 'x', id: 'stop', onClick: () => stop.abort() }),
        ),
      )
      const bar = meter.querySelector<HTMLElement>('.la-progress-bar')!
      bar.style.width = `${pct}%`
      progress = { meter, bar, step }
      return
    }
    // What the last read came to, kept in the status line until the next.
    say(
      stopped
        ? text.stopped
        : (problem ?? (last ? text.done(last.name, last.lines, number(last.lines)) : '')),
    )
    if (problem) body.append(callout('danger', problem))
    if (stopped) body.append(callout('info', text.stopped))
    if (csvNote) {
      const note = callout(csvNote.tone, csvNote.text)
      note.id = 'csv-note'
      body.append(note)
    }
    if (!analysis || analysis.lines === analysis.unreadable) return void body.append(dropZone())
    body.append(...results(analysis))
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    try {
      const ctx = await client.ask<PluginContext>('context.get')
      locale = ctx.locale
      applyLook(ctx.theme, ctx.accent)
    } catch {
      // The page works without its context: the app's language only.
    }
    render()
  })
  render()
}
