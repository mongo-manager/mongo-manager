// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { pluralOf } from '../../kit/src/i18n'
import type { Scope, Text } from './view'
import type { Measure, Unit } from './pipelines'

/** The words of Charts in Chinese, Japanese, Spanish and Brazilian Portuguese (the rest are in view.ts). */

// ---- Chinese (Simplified)
const ZH_MEASURES: Record<Measure, string> = {
  count: '计数',
  sum: '求和',
  avg: '平均值',
  min: '最小值',
  max: '最大值',
}
const ZH_BY_UNIT: Record<Unit, string> = {
  hour: '按小时',
  day: '按天',
  week: '按周',
  month: '按月',
  year: '按年',
}

export const zh: Text = {
  title: '图表',
  description: (coll: string) => `绘制 ${coll} 的值:按字段、按时间,或某个数值的分布。`,
  types: { bar: '柱状图', line: '时间趋势', donut: '环形图', histogram: '直方图', scatter: '散点图' },
  chartType: '图表类型',
  field: '字段',
  dateField: '日期字段',
  numberField: '数值字段',
  x: 'X 轴',
  y: 'Y 轴',
  unit: '周期',
  units: { hour: '小时', day: '天', week: '周', month: '月', year: '年' },
  measure: '度量',
  measures: ZH_MEASURES,
  of: '取值字段',
  draw: '绘制',
  scopeLabel: '要绘制的文档',
  scopes: { filter: '文档筛选', whole: '整个集合' },
  readingFields: '正在读取字段…',
  drawing: '正在读取文档…',
  emptyTitle: '选择要绘制的内容',
  emptyHint: '选择图表类型和字段:选择后即会绘制图表,每次更改后都会重新绘制。',
  noFieldsTitle: '这种方式没有可绘制的内容',
  noFields: {
    bar: '此集合的样本中没有可用于分组的文本、数字、真/假或 ObjectId 字段。',
    donut: '此集合的样本中没有可用于分组的文本、数字、真/假或 ObjectId 字段。',
    line: '此集合的样本中没有日期字段。',
    histogram: '此集合的样本中没有数值字段。',
    scatter: '此集合的样本中没有数值字段。',
  },
  nothingTitle: '没有可绘制的内容',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `文档筛选保留的文档中,没有任何一个具有 ${field} 的值。`
      : `此集合中没有任何文档具有 ${field} 的值。`,
  chartWhole: '绘制整个集合',
  noPlace: '请打开一个集合来绘制图表。',
  failed: '无法绘制图表:',
  fieldsFailed: '无法从样本中读取字段：',
  retry: '重试',
  other: '其他',
  missing: '(缺失)',
  data: '数据',
  show: '显示',
  showHint: '在“文档”中显示这些文档',
  period: '周期',
  range: '区间',
  axis: '轴',
  pointsHead: '点',
  documents: (_n: number, shownN: string) => `${shownN} 个文档`,
  documentsLabel: '文档',
  values: (n: number, other: boolean) => `${n} 个值${other ? '和“其他”' : ''}`,
  periods: (n: number) => `${n} 个周期`,
  latest: '最近的;更早的已省略',
  ranges: (n: number) => `${n} 个区间`,
  points: (_n: number, shownN: string) => `${shownN} 个点,来自最多 1,000 个文档的样本`,
  within: { filter: '在文档筛选范围内', whole: '整个集合' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `按 ${field} 统计的文档数` : `按 ${field} 统计的 ${of} ${ZH_MEASURES[measure]}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${ZH_BY_UNIT[unit]}统计的${measure === 'count' ? '文档数' : ` ${of} ${ZH_MEASURES[measure]}`} (${field})`,
  spread: (field: string) => `${field} 的分布`,
  share: (pct: string) => `占比:${pct}`,
}

// ---- Japanese
const JA_MEASURES: Record<Measure, string> = {
  count: '件数',
  sum: '合計',
  avg: '平均',
  min: '最小',
  max: '最大',
}
const JA_PER_UNIT: Record<Unit, string> = {
  hour: '時間ごと',
  day: '日ごと',
  week: '週ごと',
  month: '月ごと',
  year: '年ごと',
}

export const ja: Text = {
  title: 'グラフ',
  description: (coll: string) =>
    `${coll} の値をグラフにします。フィールド別、時間別、または数値の分布で表示できます。`,
  types: { bar: '棒', line: '時系列', donut: 'ドーナツ', histogram: 'ヒストグラム', scatter: '散布図' },
  chartType: 'グラフの種類',
  field: 'フィールド',
  dateField: '日付フィールド',
  numberField: '数値フィールド',
  x: 'X 軸',
  y: 'Y 軸',
  unit: '期間',
  units: { hour: '時間', day: '日', week: '週', month: '月', year: '年' },
  measure: '集計',
  measures: JA_MEASURES,
  of: '対象フィールド',
  draw: '描画',
  scopeLabel: '対象ドキュメント',
  scopes: { filter: 'ドキュメントのフィルター', whole: 'コレクション全体' },
  readingFields: 'フィールドを読み込んでいます…',
  drawing: 'ドキュメントを読み込んでいます…',
  emptyTitle: 'グラフにする内容を選択してください',
  emptyHint:
    'グラフの種類とフィールドを選択してください。選択するとグラフが描画され、変更するたびに再描画されます。',
  noFieldsTitle: 'この種類ではグラフにできるものがありません',
  noFields: {
    bar: 'このコレクションのサンプルには、グループ化できるテキスト、数値、真偽値、ObjectId のフィールドがありません。',
    donut:
      'このコレクションのサンプルには、グループ化できるテキスト、数値、真偽値、ObjectId のフィールドがありません。',
    line: 'このコレクションのサンプルには、日付フィールドがありません。',
    histogram: 'このコレクションのサンプルには、数値フィールドがありません。',
    scatter: 'このコレクションのサンプルには、数値フィールドがありません。',
  },
  nothingTitle: 'グラフにするものがありません',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `ドキュメントのフィルターで絞り込まれたドキュメントに、${field} の値を持つものはありません。`
      : `このコレクションのドキュメントに、${field} の値を持つものはありません。`,
  chartWhole: 'コレクション全体をグラフにする',
  noPlace: 'グラフにするコレクションを開いてください。',
  failed: 'グラフを描画できませんでした: ',
  fieldsFailed: 'サンプルからフィールドを読み取れませんでした: ',
  retry: '再試行',
  other: 'その他',
  missing: '(なし)',
  data: 'データ',
  show: '表示',
  showHint: 'これらのドキュメントを「ドキュメント」で表示',
  period: '期間',
  range: '範囲',
  axis: '軸',
  pointsHead: 'ポイント',
  documents: (_n: number, shownN: string) => `${shownN} 件のドキュメント`,
  documentsLabel: 'ドキュメント',
  values: (n: number, other: boolean) => `${n} 個の値${other ? 'と「その他」' : ''}`,
  periods: (n: number) => `${n} 期間`,
  latest: '最新のもの。古いものは省略されています',
  ranges: (n: number) => `${n} 個の範囲`,
  points: (_n: number, shownN: string) => `${shownN} ポイント(最大 1,000 件のドキュメントのサンプルから)`,
  within: { filter: 'ドキュメントのフィルター内', whole: 'コレクション全体' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `${field} 別のドキュメント数` : `${field} 別の ${of} の${JA_MEASURES[measure]}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${JA_PER_UNIT[unit]}の${measure === 'count' ? 'ドキュメント数' : `${of} の${JA_MEASURES[measure]}`} (${field})`,
  spread: (field: string) => `${field} の分布`,
  share: (pct: string) => `割合: ${pct}`,
}

// ---- Spanish (neutral)
const ES_MEASURES: Record<Measure, string> = {
  count: 'Recuento',
  sum: 'Suma',
  avg: 'Promedio',
  min: 'Mínimo',
  max: 'Máximo',
}
const ES_UNITS: Record<Unit, string> = { hour: 'Hora', day: 'Día', week: 'Semana', month: 'Mes', year: 'Año' }

export const es: Text = {
  title: 'Gráficos',
  description: (coll: string) =>
    `Grafica los valores de ${coll}: por un campo, a lo largo del tiempo o según cómo se distribuye un número.`,
  types: {
    bar: 'Barras',
    line: 'A lo largo del tiempo',
    donut: 'Anillo',
    histogram: 'Histograma',
    scatter: 'Dispersión',
  },
  chartType: 'Tipo de gráfico',
  field: 'Campo',
  dateField: 'Campo de fecha',
  numberField: 'Campo numérico',
  x: 'Eje X',
  y: 'Eje Y',
  unit: 'Periodo',
  units: ES_UNITS,
  measure: 'Medida',
  measures: ES_MEASURES,
  of: 'De',
  draw: 'Graficar',
  scopeLabel: 'Documentos a graficar',
  scopes: { filter: 'Filtro de Documentos', whole: 'Colección completa' },
  readingFields: 'Leyendo los campos…',
  drawing: 'Leyendo los documentos…',
  emptyTitle: 'Elige qué graficar',
  emptyHint:
    'Elige un tipo de gráfico y un campo: el gráfico se dibuja al elegir y se vuelve a dibujar con cada cambio.',
  noFieldsTitle: 'No hay nada que graficar de esta forma',
  noFields: {
    bar: 'Una muestra de esta colección no contiene ningún campo de texto, número, verdadero/falso u ObjectId por el que agrupar.',
    donut:
      'Una muestra de esta colección no contiene ningún campo de texto, número, verdadero/falso u ObjectId por el que agrupar.',
    line: 'Una muestra de esta colección no contiene ningún campo de fecha.',
    histogram: 'Una muestra de esta colección no contiene ningún campo numérico.',
    scatter: 'Una muestra de esta colección no contiene ningún campo numérico.',
  },
  nothingTitle: 'No hay nada que graficar',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `Ningún documento que conserva el filtro de Documentos tiene un valor para ${field}.`
      : `Ningún documento de esta colección tiene un valor para ${field}.`,
  chartWhole: 'Graficar la colección completa',
  noPlace: 'Abre una colección para graficarla.',
  failed: 'No se pudo dibujar el gráfico: ',
  fieldsFailed: 'No se pudieron leer los campos de una muestra: ',
  retry: 'Reintentar',
  other: 'Otros',
  missing: '(ausente)',
  data: 'Datos',
  show: 'Mostrar',
  showHint: 'Mostrar estos documentos en Documentos',
  period: 'Periodo',
  range: 'Rango',
  axis: 'Eje',
  pointsHead: 'Puntos',
  documents: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'es') === 'one' ? 'documento' : 'documentos'}`,
  documentsLabel: 'documentos',
  values: (n: number, other: boolean) =>
    `${n} ${pluralOf(n, 'es') === 'one' ? 'valor' : 'valores'}${other ? ' y Otros' : ''}`,
  periods: (n: number) => `${n} ${pluralOf(n, 'es') === 'one' ? 'periodo' : 'periodos'}`,
  latest: 'los más recientes; los anteriores se omiten',
  ranges: (n: number) => `${n} ${pluralOf(n, 'es') === 'one' ? 'rango' : 'rangos'}`,
  points: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'es') === 'one' ? 'punto' : 'puntos'}, de una muestra de como máximo 1000 documentos`,
  within: { filter: 'dentro del filtro de Documentos', whole: 'colección completa' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `Documentos por ${field}` : `${ES_MEASURES[measure]} de ${of} por ${field}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${measure === 'count' ? 'Documentos' : `${ES_MEASURES[measure]} de ${of}`} por ${ES_UNITS[unit].toLowerCase()} (${field})`,
  spread: (field: string) => `Distribución de ${field}`,
  share: (pct: string) => `Proporción: ${pct}`,
}

// ---- Portuguese (Brazil)
const PT_MEASURES: Record<Measure, string> = {
  count: 'Contagem',
  sum: 'Soma',
  avg: 'Média',
  min: 'Mínimo',
  max: 'Máximo',
}
const PT_UNITS: Record<Unit, string> = { hour: 'Hora', day: 'Dia', week: 'Semana', month: 'Mês', year: 'Ano' }

export const pt: Text = {
  title: 'Gráficos',
  description: (coll: string) =>
    `Crie gráficos com os valores de ${coll}: por um campo, ao longo do tempo ou pela distribuição de um número.`,
  types: {
    bar: 'Barras',
    line: 'Ao longo do tempo',
    donut: 'Rosca',
    histogram: 'Histograma',
    scatter: 'Dispersão',
  },
  chartType: 'Tipo de gráfico',
  field: 'Campo',
  dateField: 'Campo de data',
  numberField: 'Campo numérico',
  x: 'Eixo X',
  y: 'Eixo Y',
  unit: 'Período',
  units: PT_UNITS,
  measure: 'Medida',
  measures: PT_MEASURES,
  of: 'De',
  draw: 'Gerar',
  scopeLabel: 'Documentos do gráfico',
  scopes: { filter: 'Filtro de Documentos', whole: 'Coleção inteira' },
  readingFields: 'Lendo os campos…',
  drawing: 'Lendo os documentos…',
  emptyTitle: 'Escolha o que representar',
  emptyHint:
    'Escolha um tipo de gráfico e um campo: o gráfico é desenhado ao escolher e de novo a cada alteração.',
  noFieldsTitle: 'Nada para representar desta forma',
  noFields: {
    bar: 'Uma amostra desta coleção não tem nenhum campo de texto, número, verdadeiro/falso ou ObjectId para agrupar.',
    donut:
      'Uma amostra desta coleção não tem nenhum campo de texto, número, verdadeiro/falso ou ObjectId para agrupar.',
    line: 'Uma amostra desta coleção não tem nenhum campo de data.',
    histogram: 'Uma amostra desta coleção não tem nenhum campo numérico.',
    scatter: 'Uma amostra desta coleção não tem nenhum campo numérico.',
  },
  nothingTitle: 'Nada para representar',
  nothingHint: (field: string, scope: Scope) =>
    scope === 'filter'
      ? `Nenhum documento mantido pelo filtro de Documentos tem um valor para ${field}.`
      : `Nenhum documento desta coleção tem um valor para ${field}.`,
  chartWhole: 'Representar a coleção inteira',
  noPlace: 'Abra uma coleção para criar o gráfico.',
  failed: 'Não foi possível desenhar o gráfico: ',
  fieldsFailed: 'Não foi possível ler os campos de uma amostra: ',
  retry: 'Tentar de novo',
  other: 'Outros',
  missing: '(ausente)',
  data: 'Dados',
  show: 'Mostrar',
  showHint: 'Mostrar estes documentos em Documentos',
  period: 'Período',
  range: 'Faixa',
  axis: 'Eixo',
  pointsHead: 'Pontos',
  documents: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'}`,
  documentsLabel: 'documentos',
  values: (n: number, other: boolean) =>
    `${n} ${pluralOf(n, 'pt') === 'one' ? 'valor' : 'valores'}${other ? ' e Outros' : ''}`,
  periods: (n: number) => `${n} ${pluralOf(n, 'pt') === 'one' ? 'período' : 'períodos'}`,
  latest: 'os mais recentes; os mais antigos ficam de fora',
  ranges: (n: number) => `${n} ${pluralOf(n, 'pt') === 'one' ? 'faixa' : 'faixas'}`,
  points: (n: number, shownN: string) =>
    `${shownN} ${pluralOf(n, 'pt') === 'one' ? 'ponto' : 'pontos'}, de uma amostra de no máximo 1.000 documentos`,
  within: { filter: 'dentro do filtro de Documentos', whole: 'coleção inteira' },
  byField: (measure: Measure, of: string | undefined, field: string) =>
    measure === 'count' ? `Documentos por ${field}` : `${PT_MEASURES[measure]} de ${of} por ${field}`,
  overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
    `${measure === 'count' ? 'Documentos' : `${PT_MEASURES[measure]} de ${of}`} por ${PT_UNITS[unit].toLowerCase()} (${field})`,
  spread: (field: string) => `Distribuição de ${field}`,
  share: (pct: string) => `Participação: ${pct}`,
}
