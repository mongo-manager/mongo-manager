import { pluralOf } from '../../kit/src/i18n'
import type { Scope, Text } from './view'
import type { Measure, Unit } from './pipelines'

/** The words of Charts in Korean, German, French and Russian (the rest are in view.ts and text.ts). */

/** Russian plural by the Unicode categories: one (1, 21…), few (2–4, 22–24…), many/other (0, 5–20…, decimals). */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}

// ---- Korean
const KO_MEASURES: Record<Measure, string> = {
  count: '개수',
  sum: '합계',
  avg: '평균',
  min: '최솟값',
  max: '최댓값',
}
const KO_PER_UNIT: Record<Unit, string> = {
  hour: '시간별',
  day: '일별',
  week: '주별',
  month: '월별',
  year: '연별',
}

export const ko: Text = {
  title: '차트',
  description: (coll: string) =>
    `${coll}의 값을 차트로 그립니다. 필드별, 시간별, 또는 숫자의 분포로 볼 수 있습니다.`,
  types: { bar: '막대', line: '시간별 추이', donut: '도넛', histogram: '히스토그램', scatter: '산점도' },
  chartType: '차트 유형',
  field: '필드',
  dateField: '날짜 필드',
  numberField: '숫자 필드',
  x: 'X축',
  y: 'Y축',
  unit: '기간',
  units: { hour: '시간', day: '일', week: '주', month: '월', year: '연' },
  measure: '집계',
  measures: KO_MEASURES,
  of: '대상 필드',
  draw: '그리기',
  scopeLabel: '차트로 그릴 도큐먼트',
  scopes: { filter: '도큐먼트 필터', whole: '전체 컬렉션' },
  readingFields: '필드를 읽는 중…',
  drawing: '도큐먼트를 읽는 중…',
  emptyTitle: '차트로 그릴 대상을 선택하세요',
  emptyHint: '차트 유형과 필드를 선택하세요. 선택하면 차트가 그려지고, 변경할 때마다 다시 그려집니다.',
  noFieldsTitle: '이 방식으로는 그릴 수 있는 차트가 없습니다',
  noFields: {
    bar: '이 컬렉션의 샘플에는 그룹화할 수 있는 텍스트, 숫자, 참/거짓 또는 ObjectId 필드가 없습니다.',
    donut: '이 컬렉션의 샘플에는 그룹화할 수 있는 텍스트, 숫자, 참/거짓 또는 ObjectId 필드가 없습니다.',
    line: '이 컬렉션의 샘플에는 날짜 필드가 없습니다.',
    histogram: '이 컬렉션의 샘플에는 숫자 필드가 없습니다.',
    scatter: '이 컬렉션의 샘플에는 숫자 필드가 없습니다.',
  },
  nothingTitle: '차트로 그릴 대상이 없습니다',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `도큐먼트 필터에 남은 도큐먼트 중 ${field} 값을 가진 도큐먼트가 없습니다.`
      : `이 컬렉션의 도큐먼트 중 ${field} 값을 가진 도큐먼트가 없습니다.`,
  chartWhole: '전체 컬렉션 차트 그리기',
  noPlace: '차트를 그리려면 컬렉션을 여세요.',
  failed: '차트를 그리지 못했습니다. ',
  other: '기타',
  missing: '(없음)',
  data: '데이터',
  show: '표시',
  showHint: '이 도큐먼트를 도큐먼트 탭에 표시',
  period: '기간',
  range: '구간',
  axis: '축',
  pointsHead: '포인트',
  documents: (_n: number, shownN: string) => `도큐먼트 ${shownN}개`,
  documentsLabel: '도큐먼트',
  values: (n: number, other: boolean) => `값 ${n}개${other ? ' 및 기타' : ''}`,
  periods: (n: number) => `기간 ${n}개`,
  latest: '최신 항목만 표시하며 이전 항목은 제외됩니다',
  ranges: (n: number) => `구간 ${n}개`,
  points: (_n: number, shownN: string) => `포인트 ${shownN}개, 최대 1,000개 도큐먼트의 샘플 기준`,
  within: { filter: '도큐먼트 필터 범위 내', whole: '전체 컬렉션' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `${field}별 도큐먼트 수` : `${field}별 ${of}의 ${KO_MEASURES[measure]}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${KO_PER_UNIT[unit]} ${measure === 'count' ? '도큐먼트 수' : `${of}의 ${KO_MEASURES[measure]}`} (${field})`,
  spread: (field: string) => `${field}의 분포`,
  share: (pct: string) => `비율: ${pct}`,
}

// ---- German (Sie)
const DE_MEASURES: Record<Measure, string> = {
  count: 'Anzahl',
  sum: 'Summe',
  avg: 'Durchschnitt',
  min: 'Minimum',
  max: 'Maximum',
}
const DE_UNITS: Record<Unit, string> = {
  hour: 'Stunde',
  day: 'Tag',
  week: 'Woche',
  month: 'Monat',
  year: 'Jahr',
}

export const de: Text = {
  title: 'Diagramme',
  description: (coll: string) =>
    `Stellt die Werte von ${coll} als Diagramm dar: nach einem Feld, im Zeitverlauf oder als Verteilung einer Zahl.`,
  types: {
    bar: 'Balken',
    line: 'Zeitverlauf',
    donut: 'Ring',
    histogram: 'Histogramm',
    scatter: 'Streudiagramm',
  },
  chartType: 'Diagrammtyp',
  field: 'Feld',
  dateField: 'Datumsfeld',
  numberField: 'Zahlenfeld',
  x: 'X-Achse',
  y: 'Y-Achse',
  unit: 'Zeitraum',
  units: DE_UNITS,
  measure: 'Kennzahl',
  measures: DE_MEASURES,
  of: 'Von',
  draw: 'Zeichnen',
  scopeLabel: 'Darzustellende Dokumente',
  scopes: { filter: 'Dokumentenfilter', whole: 'Gesamte Collection' },
  readingFields: 'Felder werden gelesen …',
  drawing: 'Dokumente werden gelesen …',
  emptyTitle: 'Wählen Sie aus, was dargestellt werden soll',
  emptyHint:
    'Wählen Sie einen Diagrammtyp und ein Feld: Das Diagramm wird bei der Auswahl gezeichnet und bei jeder Änderung neu.',
  noFieldsTitle: 'Auf diese Weise gibt es nichts darzustellen',
  noFields: {
    bar: 'Eine Stichprobe dieser Collection enthält kein Text-, Zahlen-, Wahrheitswert- oder ObjectId-Feld zum Gruppieren.',
    donut:
      'Eine Stichprobe dieser Collection enthält kein Text-, Zahlen-, Wahrheitswert- oder ObjectId-Feld zum Gruppieren.',
    line: 'Eine Stichprobe dieser Collection enthält kein Datumsfeld.',
    histogram: 'Eine Stichprobe dieser Collection enthält kein Zahlenfeld.',
    scatter: 'Eine Stichprobe dieser Collection enthält kein Zahlenfeld.',
  },
  nothingTitle: 'Nichts darzustellen',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `Kein Dokument, das der Dokumentenfilter übrig lässt, hat einen Wert für ${field}.`
      : `Kein Dokument dieser Collection hat einen Wert für ${field}.`,
  chartWhole: 'Gesamte Collection darstellen',
  noPlace: 'Öffnen Sie eine Collection, um sie darzustellen.',
  failed: 'Das Diagramm konnte nicht gezeichnet werden: ',
  other: 'Sonstige',
  missing: '(fehlt)',
  data: 'Daten',
  show: 'Anzeigen',
  showHint: 'Diese Dokumente im Tab Dokumente anzeigen',
  period: 'Zeitraum',
  range: 'Bereich',
  axis: 'Achse',
  pointsHead: 'Punkte',
  documents: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'de') === 'one' ? 'Dokument' : 'Dokumente'}`,
  documentsLabel: 'Dokumente',
  values: (n: number, other: boolean) =>
    `${n} ${pluralOf(n, 'de') === 'one' ? 'Wert' : 'Werte'}${other ? ' und Sonstige' : ''}`,
  periods: (n: number) => `${n} ${pluralOf(n, 'de') === 'one' ? 'Zeitraum' : 'Zeiträume'}`,
  latest: 'die neuesten; ältere werden ausgelassen',
  ranges: (n: number) => `${n} ${pluralOf(n, 'de') === 'one' ? 'Bereich' : 'Bereiche'}`,
  points: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'de') === 'one' ? 'Punkt' : 'Punkte'}, aus einer Stichprobe von höchstens 1.000 Dokumenten`,
  within: { filter: 'innerhalb des Dokumentenfilters', whole: 'gesamte Collection' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `Dokumente nach ${field}` : `${DE_MEASURES[measure]} von ${of} nach ${field}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${measure === 'count' ? 'Dokumente' : `${DE_MEASURES[measure]} von ${of}`} pro ${DE_UNITS[unit]} (${field})`,
  spread: (field: string) => `Verteilung von ${field}`,
  share: (pct: string) => `Anteil: ${pct}`,
}

// ---- French (vous); U+202F is the narrow no-break space before : and in thousands
const FR_MEASURES: Record<Measure, string> = {
  count: 'Nombre',
  sum: 'Somme',
  avg: 'Moyenne',
  min: 'Minimum',
  max: 'Maximum',
}
const FR_UNITS: Record<Unit, string> = {
  hour: 'Heure',
  day: 'Jour',
  week: 'Semaine',
  month: 'Mois',
  year: 'Année',
}
const FR_PER_UNIT: Record<Unit, string> = {
  hour: 'par heure',
  day: 'par jour',
  week: 'par semaine',
  month: 'par mois',
  year: 'par an',
}
/** French counts 0 and 1 (and 1,5) as singular: the Unicode "one" category. */
const frOne = (n: number) => pluralOf(n, 'fr') === 'one'

export const fr: Text = {
  title: 'Graphiques',
  description: (coll: string) =>
    `Représente les valeurs de ${coll} sous forme de graphique : par champ, dans le temps ou selon la répartition d’un nombre.`,
  types: {
    bar: 'Barres',
    line: 'Dans le temps',
    donut: 'Anneau',
    histogram: 'Histogramme',
    scatter: 'Nuage de points',
  },
  chartType: 'Type de graphique',
  field: 'Champ',
  dateField: 'Champ de date',
  numberField: 'Champ numérique',
  x: 'Axe X',
  y: 'Axe Y',
  unit: 'Période',
  units: FR_UNITS,
  measure: 'Mesure',
  measures: FR_MEASURES,
  of: 'De',
  draw: 'Tracer',
  scopeLabel: 'Documents à représenter',
  scopes: { filter: 'Filtre de Documents', whole: 'Collection entière' },
  readingFields: 'Lecture des champs…',
  drawing: 'Lecture des documents…',
  emptyTitle: 'Choisissez ce qu’il faut représenter',
  emptyHint:
    'Choisissez un type de graphique et un champ : le graphique se trace dès que vous choisissez, puis à chaque modification.',
  noFieldsTitle: 'Rien à représenter de cette façon',
  noFields: {
    bar: 'Un échantillon de cette collection ne contient aucun champ de texte, de nombre, de booléen ou d’ObjectId à regrouper.',
    donut:
      'Un échantillon de cette collection ne contient aucun champ de texte, de nombre, de booléen ou d’ObjectId à regrouper.',
    line: 'Un échantillon de cette collection ne contient aucun champ de date.',
    histogram: 'Un échantillon de cette collection ne contient aucun champ numérique.',
    scatter: 'Un échantillon de cette collection ne contient aucun champ numérique.',
  },
  nothingTitle: 'Rien à représenter',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `Aucun document conservé par le filtre de Documents n’a de valeur pour ${field}.`
      : `Aucun document de cette collection n’a de valeur pour ${field}.`,
  chartWhole: 'Représenter toute la collection',
  noPlace: 'Ouvrez une collection pour la représenter.',
  failed: 'Impossible de tracer le graphique : ',
  other: 'Autres',
  missing: '(absent)',
  data: 'Données',
  show: 'Afficher',
  showHint: 'Afficher ces documents dans Documents',
  period: 'Période',
  range: 'Plage',
  axis: 'Axe',
  pointsHead: 'Points',
  documents: (n: number, shownN: string) => `${shownN} ${frOne(n) ? 'document' : 'documents'}`,
  documentsLabel: 'documents',
  values: (n: number, other: boolean) =>
    `${n} ${frOne(n) ? 'valeur' : 'valeurs'}${other ? ' et Autres' : ''}`,
  periods: (n: number) => `${n} ${frOne(n) ? 'période' : 'périodes'}`,
  latest: 'les plus récentes ; les plus anciennes sont omises',
  ranges: (n: number) => `${n} ${frOne(n) ? 'plage' : 'plages'}`,
  points: (n: number, shownN: string) =>
    `${shownN} ${frOne(n) ? 'point' : 'points'}, issus d’un échantillon de 1 000 documents au maximum`,
  within: { filter: 'dans le filtre de Documents', whole: 'collection entière' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `Documents par ${field}` : `${FR_MEASURES[measure]} de ${of} par ${field}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${measure === 'count' ? 'Documents' : `${FR_MEASURES[measure]} de ${of}`} ${FR_PER_UNIT[unit]} (${field})`,
  spread: (field: string) => `Répartition de ${field}`,
  share: (pct: string) => `Part : ${pct}`,
}

// ---- Russian (вы)
const RU_MEASURES: Record<Measure, string> = {
  count: 'Количество',
  sum: 'Сумма',
  avg: 'Среднее',
  min: 'Минимум',
  max: 'Максимум',
}
const RU_PER_UNIT: Record<Unit, string> = {
  hour: 'по часам',
  day: 'по дням',
  week: 'по неделям',
  month: 'по месяцам',
  year: 'по годам',
}

export const ru: Text = {
  title: 'Диаграммы',
  description: (coll: string) =>
    `Строит диаграммы по значениям ${coll}: по полю, по времени или по распределению числа.`,
  types: {
    bar: 'Столбчатая',
    line: 'По времени',
    donut: 'Кольцевая',
    histogram: 'Гистограмма',
    scatter: 'Точечная',
  },
  chartType: 'Тип диаграммы',
  field: 'Поле',
  dateField: 'Поле даты',
  numberField: 'Числовое поле',
  x: 'Ось X',
  y: 'Ось Y',
  unit: 'Период',
  units: { hour: 'Час', day: 'День', week: 'Неделя', month: 'Месяц', year: 'Год' },
  measure: 'Показатель',
  measures: RU_MEASURES,
  of: 'Поле значений',
  draw: 'Построить',
  scopeLabel: 'Документы для диаграммы',
  scopes: { filter: 'Фильтр документов', whole: 'Вся коллекция' },
  readingFields: 'Чтение полей…',
  drawing: 'Чтение документов…',
  emptyTitle: 'Выберите, что показать на диаграмме',
  emptyHint:
    'Выберите тип диаграммы и поле: диаграмма строится сразу после выбора и перестраивается при каждом изменении.',
  noFieldsTitle: 'Так построить диаграмму нельзя',
  noFields: {
    bar: 'В выборке из этой коллекции нет текстового, числового, логического поля или поля ObjectId для группировки.',
    donut:
      'В выборке из этой коллекции нет текстового, числового, логического поля или поля ObjectId для группировки.',
    line: 'В выборке из этой коллекции нет поля с датой.',
    histogram: 'В выборке из этой коллекции нет числового поля.',
    scatter: 'В выборке из этой коллекции нет числового поля.',
  },
  nothingTitle: 'Нечего показывать',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `Ни у одного документа, оставленного фильтром документов, нет значения в поле ${field}.`
      : `Ни у одного документа этой коллекции нет значения в поле ${field}.`,
  chartWhole: 'Построить по всей коллекции',
  noPlace: 'Откройте коллекцию, чтобы построить диаграмму.',
  failed: 'Не удалось построить диаграмму: ',
  other: 'Прочее',
  missing: '(нет)',
  data: 'Данные',
  show: 'Показать',
  showHint: 'Показать эти документы на вкладке «Документы»',
  period: 'Период',
  range: 'Диапазон',
  axis: 'Ось',
  pointsHead: 'Точки',
  documents: (n: number, shownN: string) => `${shownN} ${ruPlural(n, 'документ', 'документа', 'документов')}`,
  documentsLabel: 'документы',
  values: (n: number, other: boolean) =>
    `${n} ${ruPlural(n, 'значение', 'значения', 'значений')}${other ? ' и «Прочее»' : ''}`,
  periods: (n: number) => `${n} ${ruPlural(n, 'период', 'периода', 'периодов')}`,
  latest: 'самые новые; более старые не показаны',
  ranges: (n: number) => `${n} ${ruPlural(n, 'диапазон', 'диапазона', 'диапазонов')}`,
  points: (n: number, shownN: string) =>
    `${shownN} ${ruPlural(n, 'точка', 'точки', 'точек')}, из выборки не более чем из 1 000 документов`,
  within: { filter: 'в пределах фильтра документов', whole: 'вся коллекция' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `Документы по ${field}` : `${RU_MEASURES[measure]} ${of} по ${field}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${measure === 'count' ? 'Документы' : `${RU_MEASURES[measure]} ${of}`} ${RU_PER_UNIT[unit]} (${field})`,
  spread: (field: string) => `Распределение ${field}`,
  share: (pct: string) => `Доля: ${pct}`,
}
