// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  segmented,
  setLabel,
  shown,
  type Language,
  statusLine,
} from '../../kit/src/ui'
import { dateFields, type DateField } from './fields'
import {
  PRESETS,
  UNITS,
  betweenRange,
  lastRange,
  presetRange,
  rangeFilter,
  type Preset,
  type Range,
  type Unit,
} from './ranges'

/**
 * Date filters (research 2026-10-28): the ranges people filter by — today, the last 7 days, this
 * month, the last n hours or days, between two days — put on a date field, or on _id by its
 * ObjectId's time, in the Documents query; in the browser's time or in UTC. Changes nothing.
 */
export const SAMPLE = 200
type Zone = 'local' | 'utc'

export const TEXT = {
  en: {
    title: 'Date filters',
    description: (coll: string) =>
      `Puts a date range — today, the last 7 days, this month — on a date field of ${coll} in the Documents query. Changes nothing.`,
    field: 'Field',
    fieldHint: 'A field holding dates, or _id for when its documents were made',
    zone: 'Days in',
    zones: { local: 'My time', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Looking for date fields…',
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      `Date fields found in ${count} sampled ${plural === 'one' ? 'document' : 'documents'}`,
    none: 'No date field in the sample: name the field to filter by.',
    sampleFailed: 'The sample could not be read: ',
    presets: 'Quick ranges',
    names: {
      today: 'Today',
      yesterday: 'Yesterday',
      last24h: 'Last 24 hours',
      last7d: 'Last 7 days',
      last30d: 'Last 30 days',
      thisWeek: 'This week',
      lastWeek: 'Last week',
      thisMonth: 'This month',
      lastMonth: 'Last month',
      thisYear: 'This year',
    } satisfies Record<Preset, string>,
    last: 'Last',
    lastLabel: 'How many',
    units: { hours: 'hours', days: 'days', weeks: 'weeks', months: 'months' } satisfies Record<Unit, string>,
    unitLabel: 'Unit',
    between: 'Between',
    from: 'From',
    to: 'To',
    show: 'Show',
    showHint: (range: string) => `Puts a filter selecting ${range} in the Documents query`,
    noField: 'Name the field to filter by.',
    badLast: 'Give a whole number from 1 to 9,999.',
    badBetween: 'Choose two days, the first not after the second.',
    failed: 'Could not open Documents: ',
    idNote: 'On _id, the documents made in the range: an ObjectId holds the second it was made.',
    weekNote: 'Weeks start on Monday.',
    noPlace: 'Open a collection to filter it by date.',
    kinds: { date: 'dates', objectId: 'ObjectId times' } satisfies Record<DateField['kind'], string>,
  },
  tr: {
    title: 'Tarih filtreleri',
    description: (coll: string) =>
      `${coll} koleksiyonunun bir tarih alanına — bugün, son 7 gün, bu ay gibi — bir tarih aralığını Belgeler sorgusunda koyar. Hiçbir şeyi değiştirmez.`,
    field: 'Alan',
    fieldHint: 'Tarih taşıyan bir alan ya da belgelerin oluşturulma zamanı için _id',
    zone: 'Gün başlangıcı',
    zones: { local: 'Benim saatim', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Tarih alanları aranıyor…',
    found: (_plural: Intl.LDMLPluralRule, count: string) =>
      `Örneklenen ${count} belgede bulunan tarih alanları`,
    none: 'Örnekte tarih alanı yok: filtrelenecek alanı yazın.',
    sampleFailed: 'Örnek okunamadı: ',
    presets: 'Hızlı aralıklar',
    names: {
      today: 'Bugün',
      yesterday: 'Dün',
      last24h: 'Son 24 saat',
      last7d: 'Son 7 gün',
      last30d: 'Son 30 gün',
      thisWeek: 'Bu hafta',
      lastWeek: 'Geçen hafta',
      thisMonth: 'Bu ay',
      lastMonth: 'Geçen ay',
      thisYear: 'Bu yıl',
    } satisfies Record<Preset, string>,
    last: 'Son',
    lastLabel: 'Kaç',
    units: { hours: 'saat', days: 'gün', weeks: 'hafta', months: 'ay' } satisfies Record<Unit, string>,
    unitLabel: 'Birim',
    between: 'İki gün arası',
    from: 'Başlangıç',
    to: 'Bitiş',
    show: 'Göster',
    showHint: (range: string) => `${range} aralığını seçen bir filtreyi Belgeler sorgusuna koyar`,
    noField: 'Filtrelenecek alanı yazın.',
    badLast: '1 ile 9.999 arasında bir tam sayı girin.',
    badBetween: 'İlki ikincisinden sonra olmayan iki gün seçin.',
    failed: 'Belgeler açılamadı: ',
    idNote: '_id üzerinde aralıkta oluşturulan belgeler: bir ObjectId oluşturulduğu saniyeyi taşır.',
    weekNote: 'Haftalar pazartesi başlar.',
    noPlace: 'Tarihe göre filtrelemek için bir koleksiyon açın.',
    kinds: { date: 'tarih', objectId: 'ObjectId zamanı' } satisfies Record<DateField['kind'], string>,
  },
  zh: {
    title: '日期筛选',
    description: (coll: string) =>
      `在“文档”查询中，为 ${coll} 的日期字段设置日期范围，如今天、最近 7 天、本月。不会更改任何内容。`,
    field: '字段',
    fieldHint: '包含日期的字段，或用 _id 按文档的创建时间筛选',
    zone: '按以下时区划分日期',
    zones: { local: '我的时间', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: '正在查找日期字段…',
    found: (_plural: Intl.LDMLPluralRule, count: string) => `在抽样的 ${count} 个文档中找到的日期字段`,
    none: '样本中没有日期字段：请输入要筛选的字段名。',
    sampleFailed: '无法读取样本：',
    presets: '快捷范围',
    names: {
      today: '今天',
      yesterday: '昨天',
      last24h: '最近 24 小时',
      last7d: '最近 7 天',
      last30d: '最近 30 天',
      thisWeek: '本周',
      lastWeek: '上周',
      thisMonth: '本月',
      lastMonth: '上月',
      thisYear: '今年',
    } satisfies Record<Preset, string>,
    last: '最近',
    lastLabel: '数量',
    units: { hours: '小时', days: '天', weeks: '周', months: '个月' } satisfies Record<Unit, string>,
    unitLabel: '单位',
    between: '两天之间',
    from: '起始',
    to: '结束',
    show: '显示',
    showHint: (range: string) => `在“文档”查询中设置筛选，选取 ${range}`,
    noField: '请输入要筛选的字段名。',
    badLast: '请输入 1 到 9,999 之间的整数。',
    badBetween: '请选择两天，第一天不能晚于第二天。',
    failed: '无法打开“文档”：',
    idNote: '对 _id 而言，选取的是在该范围内创建的文档：ObjectId 包含其创建时的秒数。',
    weekNote: '每周从星期一开始。',
    noPlace: '打开一个集合，即可按日期筛选。',
    kinds: { date: '日期', objectId: 'ObjectId 时间' } satisfies Record<DateField['kind'], string>,
  },
  ja: {
    title: '日付フィルター',
    description: (coll: string) =>
      `ドキュメントのクエリで、${coll} の日付フィールドに今日・過去 7 日間・今月などの日付範囲を設定します。何も変更しません。`,
    field: 'フィールド',
    fieldHint: '日付を持つフィールド、またはドキュメントの作成時刻を使う _id',
    zone: '日の区切り',
    zones: { local: '自分の時刻', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: '日付フィールドを検索中…',
    found: (_plural: Intl.LDMLPluralRule, count: string) =>
      `サンプリングした ${count} 件のドキュメントで見つかった日付フィールド`,
    none: 'サンプルに日付フィールドがありません。フィルター対象のフィールド名を入力してください。',
    sampleFailed: 'サンプルを読み取れませんでした: ',
    presets: 'クイック範囲',
    names: {
      today: '今日',
      yesterday: '昨日',
      last24h: '過去 24 時間',
      last7d: '過去 7 日間',
      last30d: '過去 30 日間',
      thisWeek: '今週',
      lastWeek: '先週',
      thisMonth: '今月',
      lastMonth: '先月',
      thisYear: '今年',
    } satisfies Record<Preset, string>,
    last: '過去',
    lastLabel: '数',
    units: { hours: '時間', days: '日', weeks: '週間', months: 'か月' } satisfies Record<Unit, string>,
    unitLabel: '単位',
    between: '2 つの日付の間',
    from: '開始',
    to: '終了',
    show: '表示',
    showHint: (range: string) => `${range} を選択するフィルターをドキュメントのクエリに設定します`,
    noField: 'フィルター対象のフィールド名を入力してください。',
    badLast: '1 から 9,999 までの整数を入力してください。',
    badBetween: '2 つの日付を選択してください。1 つ目は 2 つ目より後にできません。',
    failed: 'ドキュメントを開けませんでした: ',
    idNote:
      '_id では、範囲内に作成されたドキュメントを選択します。ObjectId には作成された秒が含まれています。',
    weekNote: '週は月曜日から始まります。',
    noPlace: '日付で絞り込むには、コレクションを開いてください。',
    kinds: { date: '日付', objectId: 'ObjectId の時刻' } satisfies Record<DateField['kind'], string>,
  },
  es: {
    title: 'Filtros de fecha',
    description: (coll: string) =>
      `Pone un rango de fechas (hoy, los últimos 7 días, este mes) en un campo de fecha de ${coll} en la consulta de Documentos. No cambia nada.`,
    field: 'Campo',
    fieldHint: 'Un campo con fechas, o _id para saber cuándo se crearon sus documentos',
    zone: 'Días en',
    zones: { local: 'Mi hora', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Buscando campos de fecha…',
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      `Campos de fecha encontrados en ${count} ${plural === 'one' ? 'documento' : 'documentos'} de la muestra`,
    none: 'No hay ningún campo de fecha en la muestra: escribe el campo por el que filtrar.',
    sampleFailed: 'No se pudo leer la muestra: ',
    presets: 'Rangos rápidos',
    names: {
      today: 'Hoy',
      yesterday: 'Ayer',
      last24h: 'Últimas 24 horas',
      last7d: 'Últimos 7 días',
      last30d: 'Últimos 30 días',
      thisWeek: 'Esta semana',
      lastWeek: 'Semana pasada',
      thisMonth: 'Este mes',
      lastMonth: 'Mes pasado',
      thisYear: 'Este año',
    } satisfies Record<Preset, string>,
    last: 'Últimos',
    lastLabel: 'Cuántos',
    units: { hours: 'horas', days: 'días', weeks: 'semanas', months: 'meses' } satisfies Record<Unit, string>,
    unitLabel: 'Unidad',
    between: 'Entre dos días',
    from: 'Desde',
    to: 'Hasta',
    show: 'Mostrar',
    showHint: (range: string) => `Pone en la consulta de Documentos un filtro que selecciona ${range}`,
    noField: 'Escribe el campo por el que filtrar.',
    badLast: 'Indica un número entero del 1 al 9.999.',
    badBetween: 'Elige dos días, el primero no posterior al segundo.',
    failed: 'No se pudo abrir Documentos: ',
    idNote: 'En _id, los documentos creados en el rango: un ObjectId contiene el segundo en que se creó.',
    weekNote: 'Las semanas empiezan el lunes.',
    noPlace: 'Abre una colección para filtrarla por fecha.',
    kinds: { date: 'fechas', objectId: 'horas de ObjectId' } satisfies Record<DateField['kind'], string>,
  },
  pt: {
    title: 'Filtros de data',
    description: (coll: string) =>
      `Coloca um intervalo de datas (hoje, os últimos 7 dias, este mês) em um campo de data de ${coll} na consulta de Documentos. Não altera nada.`,
    field: 'Campo',
    fieldHint: 'Um campo com datas, ou _id para saber quando seus documentos foram criados',
    zone: 'Dias em',
    zones: { local: 'Meu horário', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Procurando campos de data…',
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      `Campos de data encontrados em ${count} ${plural === 'one' ? 'documento' : 'documentos'} da amostra`,
    none: 'Nenhum campo de data na amostra: informe o campo para filtrar.',
    sampleFailed: 'Não foi possível ler a amostra: ',
    presets: 'Intervalos rápidos',
    names: {
      today: 'Hoje',
      yesterday: 'Ontem',
      last24h: 'Últimas 24 horas',
      last7d: 'Últimos 7 dias',
      last30d: 'Últimos 30 dias',
      thisWeek: 'Esta semana',
      lastWeek: 'Semana passada',
      thisMonth: 'Este mês',
      lastMonth: 'Mês passado',
      thisYear: 'Este ano',
    } satisfies Record<Preset, string>,
    last: 'Últimos',
    lastLabel: 'Quantos',
    units: { hours: 'horas', days: 'dias', weeks: 'semanas', months: 'meses' } satisfies Record<Unit, string>,
    unitLabel: 'Unidade',
    between: 'Entre dois dias',
    from: 'De',
    to: 'Até',
    show: 'Mostrar',
    showHint: (range: string) => `Coloca na consulta de Documentos um filtro que seleciona ${range}`,
    noField: 'Informe o campo para filtrar.',
    badLast: 'Informe um número inteiro de 1 a 9.999.',
    badBetween: 'Escolha dois dias, o primeiro não posterior ao segundo.',
    failed: 'Não foi possível abrir Documentos: ',
    idNote: 'Em _id, os documentos criados no intervalo: um ObjectId contém o segundo em que foi criado.',
    weekNote: 'As semanas começam na segunda-feira.',
    noPlace: 'Abra uma coleção para filtrá-la por data.',
    kinds: { date: 'datas', objectId: 'horários de ObjectId' } satisfies Record<DateField['kind'], string>,
  },
  ko: {
    title: '날짜 필터',
    description: (coll: string) =>
      `도큐먼트 쿼리에서 ${coll}의 날짜 필드에 오늘, 최근 7일, 이번 달 같은 날짜 범위를 설정합니다. 아무것도 변경하지 않습니다.`,
    field: '필드',
    fieldHint: '날짜가 들어 있는 필드, 또는 도큐먼트가 만들어진 시점을 기준으로 하는 _id',
    zone: '날짜 기준 시간대',
    zones: { local: '내 시간', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: '날짜 필드를 찾는 중…',
    found: (_plural: Intl.LDMLPluralRule, count: string) => `샘플링한 도큐먼트 ${count}개에서 찾은 날짜 필드`,
    none: '샘플에 날짜 필드가 없습니다. 필터링할 필드 이름을 입력하세요.',
    sampleFailed: '샘플을 읽을 수 없습니다: ',
    presets: '빠른 범위',
    names: {
      today: '오늘',
      yesterday: '어제',
      last24h: '최근 24시간',
      last7d: '최근 7일',
      last30d: '최근 30일',
      thisWeek: '이번 주',
      lastWeek: '지난주',
      thisMonth: '이번 달',
      lastMonth: '지난달',
      thisYear: '올해',
    } satisfies Record<Preset, string>,
    last: '최근',
    lastLabel: '개수',
    units: { hours: '시간', days: '일', weeks: '주', months: '개월' } satisfies Record<Unit, string>,
    unitLabel: '단위',
    between: '두 날짜 사이',
    from: '시작',
    to: '종료',
    show: '표시',
    showHint: (range: string) => `${range} 범위를 선택하는 필터를 도큐먼트 쿼리에 설정합니다`,
    noField: '필터링할 필드 이름을 입력하세요.',
    badLast: '1에서 9,999 사이의 정수를 입력하세요.',
    badBetween: '두 날짜를 선택하세요. 첫 번째 날짜는 두 번째 날짜보다 늦을 수 없습니다.',
    failed: '도큐먼트를 열 수 없습니다: ',
    idNote:
      '_id에서는 범위 안에 생성된 도큐먼트를 선택합니다. ObjectId에는 생성된 시점의 초가 들어 있습니다.',
    weekNote: '한 주는 월요일에 시작합니다.',
    noPlace: '날짜로 필터링하려면 컬렉션을 여세요.',
    kinds: { date: '날짜', objectId: 'ObjectId 시간' } satisfies Record<DateField['kind'], string>,
  },
  de: {
    title: 'Datumsfilter',
    description: (coll: string) =>
      `Setzt in der Dokumentabfrage einen Datumsbereich – heute, die letzten 7 Tage, dieser Monat – auf ein Datumsfeld von ${coll}. Ändert nichts.`,
    field: 'Feld',
    fieldHint: 'Ein Feld mit Datumswerten oder _id für den Zeitpunkt, zu dem die Dokumente erstellt wurden',
    zone: 'Tage in',
    zones: { local: 'Meine Zeit', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Datumsfelder werden gesucht…',
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      plural === 'one'
        ? `In ${count} Stichprobendokument gefundene Datumsfelder`
        : `In ${count} Stichprobendokumenten gefundene Datumsfelder`,
    none: 'Kein Datumsfeld in der Stichprobe: Geben Sie das Feld zum Filtern ein.',
    sampleFailed: 'Die Stichprobe konnte nicht gelesen werden: ',
    presets: 'Schnellbereiche',
    names: {
      today: 'Heute',
      yesterday: 'Gestern',
      last24h: 'Letzte 24 Stunden',
      last7d: 'Letzte 7 Tage',
      last30d: 'Letzte 30 Tage',
      thisWeek: 'Diese Woche',
      lastWeek: 'Letzte Woche',
      thisMonth: 'Dieser Monat',
      lastMonth: 'Letzter Monat',
      thisYear: 'Dieses Jahr',
    } satisfies Record<Preset, string>,
    last: 'Letzte',
    lastLabel: 'Anzahl',
    units: { hours: 'Stunden', days: 'Tage', weeks: 'Wochen', months: 'Monate' } satisfies Record<
      Unit,
      string
    >,
    unitLabel: 'Einheit',
    between: 'Zwischen zwei Tagen',
    from: 'Von',
    to: 'Bis',
    show: 'Anzeigen',
    showHint: (range: string) => `Setzt in der Dokumentabfrage einen Filter, der ${range} auswählt`,
    noField: 'Geben Sie das Feld zum Filtern ein.',
    badLast: 'Geben Sie eine ganze Zahl von 1 bis 9.999 ein.',
    badBetween: 'Wählen Sie zwei Tage, wobei der erste nicht nach dem zweiten liegt.',
    failed: 'Dokumente konnten nicht geöffnet werden: ',
    idNote:
      'Bei _id: die im Bereich erstellten Dokumente. Eine ObjectId enthält die Sekunde ihrer Erstellung.',
    weekNote: 'Wochen beginnen am Montag.',
    noPlace: 'Öffnen Sie eine Collection, um sie nach Datum zu filtern.',
    kinds: { date: 'Datumswerte', objectId: 'ObjectId-Zeiten' } satisfies Record<DateField['kind'], string>,
  },
  fr: {
    title: 'Filtres de date',
    description: (coll: string) =>
      `Place dans la requête Documents une plage de dates (aujourd’hui, les 7 derniers jours, ce mois-ci) sur un champ de date de ${coll}. Ne modifie rien.`,
    field: 'Champ',
    fieldHint: 'Un champ contenant des dates, ou _id pour le moment de création des documents',
    zone: 'Jours en',
    zones: { local: 'Mon heure', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Recherche des champs de date…',
    // French counts 0 and 1 as singular.
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      `Champs de date trouvés dans ${count} ${plural === 'one' ? 'document' : 'documents'} de l’échantillon`,
    none: 'Aucun champ de date dans l’échantillon : indiquez le champ à filtrer.',
    sampleFailed: 'Impossible de lire l’échantillon : ',
    presets: 'Plages rapides',
    names: {
      today: 'Aujourd’hui',
      yesterday: 'Hier',
      last24h: '24 dernières heures',
      last7d: '7 derniers jours',
      last30d: '30 derniers jours',
      thisWeek: 'Cette semaine',
      lastWeek: 'Semaine dernière',
      thisMonth: 'Ce mois-ci',
      lastMonth: 'Mois dernier',
      thisYear: 'Cette année',
    } satisfies Record<Preset, string>,
    last: 'Derniers',
    lastLabel: 'Combien',
    units: { hours: 'heures', days: 'jours', weeks: 'semaines', months: 'mois' } satisfies Record<
      Unit,
      string
    >,
    unitLabel: 'Unité',
    between: 'Entre deux jours',
    from: 'Du',
    to: 'Au',
    show: 'Afficher',
    showHint: (range: string) => `Place dans la requête Documents un filtre qui sélectionne ${range}`,
    noField: 'Indiquez le champ à filtrer.',
    badLast: 'Saisissez un nombre entier de 1 à 9 999.',
    badBetween: 'Choisissez deux jours, le premier n’étant pas postérieur au second.',
    failed: 'Impossible d’ouvrir Documents : ',
    idNote: 'Sur _id : les documents créés dans la plage. Un ObjectId contient la seconde de sa création.',
    weekNote: 'Les semaines commencent le lundi.',
    noPlace: 'Ouvrez une collection pour la filtrer par date.',
    kinds: { date: 'dates', objectId: 'heures d’ObjectId' } satisfies Record<DateField['kind'], string>,
  },
  ru: {
    title: 'Фильтры по дате',
    description: (coll: string) =>
      `Задает в запросе «Документы» диапазон дат (сегодня, последние 7 дней, этот месяц) для поля даты в ${coll}. Ничего не изменяет.`,
    field: 'Поле',
    fieldHint: 'Поле с датами или _id — по времени создания документов',
    zone: 'Дни по',
    zones: { local: 'Мое время', utc: 'UTC' } satisfies Record<Zone, string>,
    sampling: 'Поиск полей с датами…',
    found: (plural: Intl.LDMLPluralRule, count: string) =>
      `Поля с датами, найденные в ${count} ${plural === 'one' ? 'документе' : 'документах'} выборки`,
    none: 'В выборке нет полей с датами: введите поле для фильтрации.',
    sampleFailed: 'Не удалось прочитать выборку: ',
    presets: 'Быстрые диапазоны',
    names: {
      today: 'Сегодня',
      yesterday: 'Вчера',
      last24h: 'Последние 24 часа',
      last7d: 'Последние 7 дней',
      last30d: 'Последние 30 дней',
      thisWeek: 'Эта неделя',
      lastWeek: 'Прошлая неделя',
      thisMonth: 'Этот месяц',
      lastMonth: 'Прошлый месяц',
      thisYear: 'Этот год',
    } satisfies Record<Preset, string>,
    last: 'Последние',
    lastLabel: 'Сколько',
    units: { hours: 'часы', days: 'дни', weeks: 'недели', months: 'месяцы' } satisfies Record<Unit, string>,
    unitLabel: 'Единица',
    between: 'Между двумя днями',
    from: 'С',
    to: 'По',
    show: 'Показать',
    showHint: (range: string) => `Задает в запросе «Документы» фильтр, выбирающий ${range}`,
    noField: 'Введите поле для фильтрации.',
    badLast: 'Введите целое число от 1 до 9 999.',
    badBetween: 'Выберите два дня; первый не должен быть позже второго.',
    failed: 'Не удалось открыть «Документы»: ',
    idNote: 'Для _id: документы, созданные в этом диапазоне. ObjectId содержит секунду создания.',
    weekNote: 'Неделя начинается в понедельник.',
    noPlace: 'Откройте коллекцию, чтобы фильтровать ее по дате.',
    kinds: { date: 'даты', objectId: 'время ObjectId' } satisfies Record<DateField['kind'], string>,
  },
}
type Text = (typeof TEXT)['en']
// Every language has every word: a missing key fails to compile.
TEXT satisfies Record<Language, Text>

type Words = { en: Text } & Partial<Record<Language, Text>>

export function mount(
  root: HTMLElement,
  client: PluginClient,
  now: () => Date = () => new Date(),
  words: Words = TEXT,
): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let fields: DateField[] = []
  let problem: unknown = null
  let hint = ''

  const header = pageHeader({ icon: 'calendar', title: text.title, description: '' })
  const fieldLabel = h('span', { class: 'mm-label' })
  const fieldList = h('datalist', { id: 'date-fields' })
  const fieldInput = h('input', {
    id: 'field',
    class: 'mm-input mm-mono',
    attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', list: 'date-fields' },
  })
  const zone = segmented<Zone>({
    label: text.zone,
    id: 'zone',
    value: 'local',
    options: (['local', 'utc'] as Zone[]).map((value) => ({ value, label: text.zones[value] })),
    onChange: () => render(),
  })
  const zoneLabel = h('span', { class: 'mm-label' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'dp-notes' })
  const presetsTitle = h('h2', { class: 'mm-section-title' })
  const presets = h('div', { id: 'presets', class: 'dp-presets' })
  const lastTitle = h('h2', { class: 'mm-section-title' })
  const lastCount = h('input', {
    id: 'last-count',
    class: 'mm-input dp-number',
    attrs: { type: 'number', min: '1', max: '9999', step: '1', value: '7', inputmode: 'numeric' },
  })
  const lastUnit = h('select', { id: 'last-unit', class: 'mm-select' })
  const lastShow = button({ label: text.show, icon: 'filter', id: 'last-show', size: 'sm' })
  const betweenTitle = h('h2', { class: 'mm-section-title' })
  const fromInput = h('input', { id: 'from', class: 'mm-input', attrs: { type: 'date' } })
  const toInput = h('input', { id: 'to', class: 'mm-input', attrs: { type: 'date' } })
  const fromLabel = h('span', { class: 'mm-label' })
  const toLabel = h('span', { class: 'mm-label' })
  const betweenShow = button({ label: text.show, icon: 'filter', id: 'between-show', size: 'sm' })
  const formHint = h('p', { id: 'form-hint', class: 'mm-status', attrs: { 'aria-live': 'polite' } })
  const lastCountLabel = h('span', { class: 'mm-sr' })
  const lastUnitLabel = h('span', { class: 'mm-sr' })
  const weekNote = h('p', { class: 'mm-status' })
  const body = h(
    'div',
    { class: 'mm-body' },
    h(
      'div',
      { class: 'dp-controls' },
      h('label', { class: 'mm-field dp-field' }, fieldLabel, fieldInput, fieldList),
      h('div', { class: 'mm-field' }, zoneLabel, zone.el),
    ),
    h('div', { class: 'mm-summary' }, status),
    notes,
    h('section', { class: 'dp-section' }, presetsTitle, presets, weekNote),
    h(
      'section',
      { class: 'dp-section' },
      lastTitle,
      h(
        'div',
        { class: 'dp-row' },
        h('label', {}, lastCountLabel, lastCount),
        h('label', {}, lastUnitLabel, lastUnit),
        lastShow,
      ),
    ),
    h(
      'section',
      { class: 'dp-section' },
      betweenTitle,
      h(
        'div',
        { class: 'dp-row' },
        h('label', { class: 'mm-field' }, fromLabel, fromInput),
        h('label', { class: 'mm-field' }, toLabel, toInput),
        betweenShow,
      ),
    ),
    formHint,
  )
  root.replaceChildren(h('div', { class: 'mm-page' }, header, h('hr', { class: 'mm-divider' }), body))

  const utc = () => zone.value() === 'utc'
  const field = () => fieldInput.value.trim()
  // _id is an ObjectId's time unless the sample saw it hold dates (review: never by the sample alone).
  const byId = () => field() === '_id' && !fields.some((f) => f.path === '_id' && f.kind === 'date')

  function rangeText(r: Range): string {
    const tz = utc() ? { timeZone: 'UTC' } : {}
    const whole = (d: Date) =>
      utc()
        ? d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() === 0
        : d.getHours() + d.getMinutes() + d.getSeconds() === 0
    const days = whole(r.start) && whole(r.end)
    const fmt = new Intl.DateTimeFormat(
      shown(words, locale) === 'en' ? 'en-GB' : langTag(shown(words, locale)),
      {
        dateStyle: 'medium',
        ...(days ? {} : { timeStyle: 'short' }),
        ...tz,
      },
    )
    // A range of whole days ends at the start of the next: said as its last day.
    const last = days ? new Date(r.end.getTime() - 1) : r.end
    return `${fmt.format(r.start)} – ${fmt.format(last)}${utc() ? ' UTC' : ''}`
  }

  function show(r: Range | null, why: string): void {
    hint = ''
    if (!field()) hint = text.noField
    else if (!r) hint = why
    renderNotes()
    if (hint || !r) return
    void client.ask('ui.useQuery', { filter: rangeFilter(field(), r, byId()) }).then(
      () => {
        if (problem === null) return
        problem = null
        renderNotes()
      },
      (e: unknown) => {
        problem = e
        renderNotes()
      },
    )
  }

  function renderNotes(): void {
    formHint.textContent = hint
    notes.replaceChildren(
      ...(problem !== null ? [callout('danger', `${text.failed}${askMessage(problem, locale)}`)] : []),
      ...(byId() ? [h('p', { class: 'mm-status', text: text.idNote })] : []),
    )
  }

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    fieldLabel.textContent = text.field
    fieldInput.title = text.fieldHint
    zoneLabel.textContent = text.zone
    zone.relabel(text.zones)
    zone.el.setAttribute('aria-label', text.zone)
    presetsTitle.textContent = text.presets
    weekNote.textContent = text.weekNote
    lastTitle.textContent = text.last
    lastCountLabel.textContent = text.lastLabel
    lastUnitLabel.textContent = text.unitLabel
    const unit = lastUnit.value || 'days'
    lastUnit.replaceChildren(...UNITS.map((u) => h('option', { attrs: { value: u }, text: text.units[u] })))
    lastUnit.value = unit
    betweenTitle.textContent = text.between
    fromLabel.textContent = text.from
    toLabel.textContent = text.to
    setLabel(lastShow, text.show)
    setLabel(betweenShow, text.show)
  }

  function render(): void {
    if (!ctx) return
    if (!ctx.place) {
      body.replaceChildren(emptyState({ icon: 'calendar', title: text.noPlace }))
      return
    }
    const at = now()
    presets.replaceChildren(
      ...PRESETS.map((p) => {
        const r = presetRange(p, at, utc())
        const range = rangeText(r)
        const b = h(
          'button',
          {
            class: 'mm-card dp-preset',
            data: { preset: p },
            attrs: { type: 'button' },
            title: text.showHint(range),
          },
          h('span', { class: 'dp-preset-name', text: text.names[p] }),
          h('span', { class: 'dp-preset-range', text: range }),
        )
        b.addEventListener('click', () => show(presetRange(p, now(), utc()), ''))
        return b
      }),
    )
    fieldList.replaceChildren(
      ...fields.map((f) =>
        h('option', { attrs: { value: f.path }, text: `${f.path} · ${text.kinds[f.kind]}` }),
      ),
    )
    renderNotes()
  }

  async function sample(): Promise<void> {
    status.textContent = text.sampling
    try {
      const answer = await client.ask<{ documents: unknown[] }>('documents.aggregate', {
        pipeline: [{ $sample: { size: { $numberInt: String(SAMPLE) } } }],
        limit: SAMPLE,
      })
      fields = dateFields(answer.documents)
      status.textContent = fields.length
        ? text.found(
            pluralOf(answer.documents.length, shown(words, locale)),
            formatNumber(answer.documents.length, shown(words, locale)),
          )
        : text.none
      if (!fieldInput.value && fields[0]) fieldInput.value = fields[0].path
    } catch (e) {
      status.textContent = `${text.sampleFailed}${askMessage(e, locale)}`
    }
    render()
  }

  lastShow.addEventListener('click', () => {
    const n = Number(lastCount.value)
    const ok = Number.isInteger(n) && n >= 1 && n <= 9999
    show(ok ? lastRange(n, lastUnit.value as Unit, now(), utc()) : null, text.badLast)
  })
  betweenShow.addEventListener('click', () =>
    show(betweenRange(fromInput.value, toInput.value, utc()), text.badBetween),
  )
  fieldInput.addEventListener('input', () => {
    hint = ''
    renderNotes()
  })

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(words, locale)
    document.documentElement.lang = langTag(shown(words, locale))
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(words, locale)
    document.documentElement.lang = langTag(shown(words, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    render()
    if (ctx.place) void sample()
  })
  applyText()
}
