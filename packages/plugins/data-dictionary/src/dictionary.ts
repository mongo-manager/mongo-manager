/**
 * Plugins wave 3 (spec §5; NoSQLBooster's schema documentation, Hackolade, DbSchema, Dataedo): a
 * database's data dictionary — each collection's fields (types, presence, what its $jsonSchema says),
 * the references from and to it, its indexes (never a partial filter's values) and its validation —
 * as the page shows it and as Markdown or HTML to save. A hidden field is named only.
 */

import { langTag, pick, pluralOf, shown, type Language } from '../../kit/src/i18n'

/** The app's data model (the Database tab's), as `database.model` gives it. */
export interface Model {
  db: string
  sampleSize: number
  collections: Array<{
    name: string
    type: 'collection' | 'view' | 'timeseries'
    sampled: number
    fields: Array<{ path: string; types: string[]; share: number; masked?: true }>
    moreFields: number
    viewOn?: string
    refused?: string
  }>
  references: Array<{
    from: string
    field: string
    to: string
    toField: string
    sources: string[]
    many: boolean
  }>
  skipped: number
  at: string
}

export interface IndexDef {
  name: string
  key: Record<string, unknown>
  options: Record<string, unknown>
}
export interface Validation {
  validator: unknown
  validationLevel: string
  validationAction: string
}
export interface Extras {
  indexes: IndexDef[] | null
  validation: Validation | null
  /** Why the indexes could not be read, as the person reads it (wave 3 review). */
  indexError?: string
  /** Why the rules could not be read. */
  validationError?: string
}

export interface FieldFacts {
  required: boolean
  bsonType?: string
  description?: string
  enum?: string[]
}
export interface DictField extends FieldFacts {
  path: string
  types: string[]
  share: number
  hidden: boolean
}
export interface DictIndex {
  name: string
  keys: string
  unique: boolean
  partial: boolean
  ttl?: number
}
export interface DictCollection {
  name: string
  anchor: string
  type: string
  sampled: number
  viewOn?: string
  refused?: string
  fields: DictField[]
  moreFields: number
  indexes: DictIndex[] | null
  indexError?: string
  validation: { level: string; action: string } | null
  validationError?: string
  refsOut: Array<{ field: string; to: string; many: boolean }>
  refsIn: Array<{ from: string; field: string }>
}
export interface Dictionary {
  db: string
  sampleSize: number
  at: string
  skipped: number
  collections: DictCollection[]
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
/** A number as the bridge gives it, canonical Extended JSON (`{ "$numberInt": "1" }`), or as it is. */
const numberOf = (v: unknown): unknown => {
  if (!isPlain(v) || Object.keys(v).length !== 1) return v
  const [k, s] = Object.entries(v)[0]!
  if (!['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'].includes(k) || typeof s !== 'string')
    return v
  const n = Number(s)
  return Number.isFinite(n) ? n : v
}

/** A value of a rule as text (an enum's values are the rule's, never a document's). */
const valueText = (raw: unknown): string => {
  const v = numberOf(raw)
  return typeof v === 'string' ? v : JSON.stringify(v)
}
const ENUM_MAX = 20
const TEXT_MAX = 300
/** The longest allowed value said (wave 3 second review: a few long ones made a dictionary too large). */
const ENUM_VALUE_MAX = 80
const capped = (v: string) =>
  [...v].length > ENUM_VALUE_MAX ? `${[...v].slice(0, ENUM_VALUE_MAX - 1).join('')}…` : v

/**
 * What a validator's $jsonSchema says of each field (dotted path, arrays seen through) — its own, or
 * each one of a top-level $and (wave 3 review), what they say joined: required if any says so.
 */
export function schemaFacts(validator: unknown): Map<string, FieldFacts> {
  const out = new Map<string, FieldFacts>()
  if (!isPlain(validator)) return out
  const schemas = [validator, ...(Array.isArray(validator.$and) ? validator.$and : [])]
    .map((v) => (isPlain(v) && isPlain(v.$jsonSchema) ? v.$jsonSchema : null))
    .filter((s): s is Record<string, unknown> => s !== null)
  const join = (path: string, next: FieldFacts): void => {
    const was = out.get(path)
    out.set(path, was ? { ...next, ...was, required: was.required || next.required } : next)
  }
  const walk = (schema: Record<string, unknown>, base: string, depth: number): void => {
    if (depth > 8) return
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [],
    )
    const properties = isPlain(schema.properties) ? schema.properties : {}
    for (const name of new Set([...Object.keys(properties), ...required])) {
      const path = base ? `${base}.${name}` : name
      const p = isPlain(properties[name]) ? (properties[name] as Record<string, unknown>) : {}
      const bsonType = Array.isArray(p.bsonType)
        ? p.bsonType.join(' | ')
        : typeof p.bsonType === 'string'
          ? p.bsonType
          : undefined
      join(path, {
        required: required.has(name),
        ...(bsonType ? { bsonType } : {}),
        ...(typeof p.description === 'string' ? { description: p.description.slice(0, TEXT_MAX) } : {}),
        ...(Array.isArray(p.enum)
          ? { enum: p.enum.slice(0, ENUM_MAX).map((v) => capped(valueText(v))) }
          : {}),
      })
      walk(p, path, depth + 1)
      // An array's elements: their fields under the array's own path.
      if (isPlain(p.items)) walk(p.items, path, depth + 1)
    }
  }
  for (const schema of schemas) walk(schema, '', 0)
  return out
}

/** An anchor a link may name (letters, digits, - and _), told apart from those taken. */
export function anchorOf(name: string, taken: Set<string>): string {
  const base = `coll-${
    name
      .normalize('NFD')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  }`.slice(0, 90)
  let anchor = base
  for (let n = 2; taken.has(anchor); n++) anchor = `${base}-${n}`
  taken.add(anchor)
  return anchor
}

/** An index's keys: each one's direction told by its value (↑ only where there are several). */
const keyText = (key: Record<string, unknown>) => {
  const entries = Object.entries(key).map(([k, raw]) => [k, numberOf(raw)] as const)
  return entries
    .map(([k, v]) =>
      v === 1 || v === undefined
        ? entries.length > 1
          ? `${k} ↑`
          : k
        : v === -1
          ? `${k} ↓`
          : `${k} (${valueText(v)})`,
    )
    .join(', ')
}

/** The dictionary of a model, with each collection's indexes and rules where they were read. */
export function buildDictionary(model: Model, extras: ReadonlyMap<string, Extras>): Dictionary {
  const anchors = new Set<string>()
  const collections = model.collections.map((c): DictCollection => {
    const extra = extras.get(c.name)
    const facts = schemaFacts(extra?.validation?.validator)
    const fields = c.fields.map((f): DictField => {
      const hidden = !!f.masked
      const all = facts.get(f.path.replace(/\[\]/g, ''))
      // A hidden field: whether it is required (the rule names it, never a value), nothing else.
      const fact = hidden ? undefined : all
      return {
        path: f.path,
        types: hidden ? [] : f.types,
        share: f.share,
        hidden,
        required: all?.required ?? false,
        ...(fact?.bsonType ? { bsonType: fact.bsonType } : {}),
        ...(fact?.description ? { description: fact.description } : {}),
        ...(fact?.enum ? { enum: fact.enum } : {}),
      }
    })
    return {
      name: c.name,
      anchor: anchorOf(c.name, anchors),
      type: c.type,
      sampled: c.sampled,
      ...(c.viewOn ? { viewOn: c.viewOn } : {}),
      ...(c.refused ? { refused: c.refused } : {}),
      fields,
      moreFields: c.moreFields,
      indexes:
        extra?.indexes?.map((ix) => ({
          name: ix.name,
          keys: keyText(ix.key),
          unique: ix.options.unique === true || ix.name === '_id_',
          partial: isPlain(ix.options.partialFilterExpression),
          ...(typeof numberOf(ix.options.expireAfterSeconds) === 'number'
            ? { ttl: numberOf(ix.options.expireAfterSeconds) as number }
            : {}),
        })) ?? null,
      ...(extra?.indexError !== undefined ? { indexError: extra.indexError } : {}),
      validation: extra?.validation?.validator
        ? { level: extra.validation.validationLevel, action: extra.validation.validationAction }
        : null,
      ...(extra?.validationError !== undefined ? { validationError: extra.validationError } : {}),
      refsOut: model.references
        .filter((r) => r.from === c.name)
        .map((r) => ({ field: r.field, to: r.to, many: r.many })),
      refsIn: model.references.filter((r) => r.to === c.name).map((r) => ({ from: r.from, field: r.field })),
    }
  })
  return { db: model.db, sampleSize: model.sampleSize, at: model.at, skipped: model.skipped, collections }
}

/** The words of the dictionary, as the page and the saved files say them. */
export interface Words {
  title: (db: string) => string
  sampled: (n: string, at: string) => string
  contents: string
  kinds: Record<string, string>
  viewOf: (c: string) => string
  refused: string
  fields: string
  columns: string[]
  hidden: string
  yes: string
  no: string
  oneOf: string
  /** What follows a label: a colon (French sets a narrow no-break space before it). */
  colon: string
  rule: string
  more: (n: number) => string
  refs: string
  refTo: (field: string, to: string, many: boolean) => string
  refFrom: (from: string, field: string) => string
  indexes: string
  indexColumns: string[]
  unique: string
  partial: string
  ttl: (n: string) => string
  plain: string
  noIndexes: string
  indexesFailed: (why: string) => string
  rulesFailed: (why: string) => string
  validation: (level: string, action: string) => string
  noValidation: string
  skipped: (n: number) => string
  percent: (n: number) => string
  partialFile: (kept: string, total: string) => string
}

export const WORDS = {
  en: {
    title: (db: string) => `${db} — data dictionary`,
    sampled: (n: string, at: string) => `Fields from up to ${n} sampled documents a collection, read ${at}.`,
    contents: 'Collections',
    kinds: { collection: 'collection', view: 'view', timeseries: 'time series' },
    viewOf: (c: string) => `A view of ${c}.`,
    refused: 'Its documents could not be read.',
    fields: 'Fields',
    columns: ['Field', 'Type', 'Present', 'Required', 'Notes'],
    hidden: 'hidden',
    yes: 'yes',
    no: 'no',
    oneOf: 'one of',
    colon: ':',
    rule: 'rule',
    more: (n: number) => `${n} more ${pluralOf(n, 'en') === 'one' ? 'field was' : 'fields were'} not listed.`,
    refs: 'References',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (by ${field}${many ? ', several' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (by ${field})`,
    indexes: 'Indexes',
    indexColumns: ['Name', 'Keys', 'Kind'],
    unique: 'unique',
    partial: 'partial',
    ttl: (n: string) => `expires after ${n} s`,
    plain: '—',
    noIndexes: 'Its indexes could not be read.',
    indexesFailed: (why: string) => `Its indexes could not be read: ${why}`,
    rulesFailed: (why: string) => `Its rules could not be read: ${why}`,
    validation: (level: string, action: string) => `Validation: ${level}, ${action}.`,
    noValidation: 'No validation rules.',
    skipped: (n: number) =>
      `${n} more ${pluralOf(n, 'en') === 'one' ? 'collection was' : 'collections were'} not read.`,
    percent: (n: number) => `${n}%`,
    partialFile: (kept: string, total: string) =>
      `Only the first ${kept} of ${total} collections are in this file: the whole dictionary is over the 1 MB a saved file may be.`,
  },
  tr: {
    title: (db: string) => `${db} — veri sözlüğü`,
    sampled: (n: string, at: string) =>
      `Alanlar her koleksiyondan en çok ${n} örnek belgeden, ${at} tarihinde okundu.`,
    contents: 'Koleksiyonlar',
    kinds: { collection: 'koleksiyon', view: 'görünüm', timeseries: 'zaman serisi' },
    viewOf: (c: string) => `${c} üzerinde bir görünüm.`,
    refused: 'Belgeleri okunamadı.',
    fields: 'Alanlar',
    columns: ['Alan', 'Tür', 'Bulunma', 'Zorunlu', 'Notlar'],
    hidden: 'gizli',
    yes: 'evet',
    no: 'hayır',
    oneOf: 'şunlardan biri',
    colon: ':',
    rule: 'kural',
    more: (n: number) => `${n} alan daha listelenmedi.`,
    refs: 'Referanslar',
    refTo: (field: string, to: string, many: boolean) =>
      `→ ${to} (${field} ile${many ? ', birden çok' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (${field} ile)`,
    indexes: 'Dizinler',
    indexColumns: ['Ad', 'Anahtarlar', 'Tür'],
    unique: 'benzersiz',
    partial: 'kısmi',
    ttl: (n: string) => `${n} sn sonra silinir`,
    plain: '—',
    noIndexes: 'Dizinleri okunamadı.',
    indexesFailed: (why: string) => `Dizinleri okunamadı: ${why}`,
    rulesFailed: (why: string) => `Kuralları okunamadı: ${why}`,
    validation: (level: string, action: string) => `Doğrulama: ${level}, ${action}.`,
    noValidation: 'Doğrulama kuralı yok.',
    skipped: (n: number) => `${n} koleksiyon daha okunmadı.`,
    percent: (n: number) => `%${n}`,
    partialFile: (kept: string, total: string) =>
      `${total} koleksiyonun yalnızca ilk ${kept} tanesi bu dosyada: sözlüğün tamamı, kaydedilen bir dosyanın sınırı olan 1 MB'ı aşıyor.`,
  },
  zh: {
    title: (db: string) => `${db} — 数据字典`,
    sampled: (n: string, at: string) => `字段取自每个集合最多 ${n} 个采样文档，读取于 ${at}。`,
    contents: '集合',
    kinds: { collection: '集合', view: '视图', timeseries: '时间序列' },
    viewOf: (c: string) => `${c} 的视图。`,
    refused: '无法读取其文档。',
    fields: '字段',
    columns: ['字段', '类型', '出现率', '必填', '备注'],
    hidden: '已隐藏',
    yes: '是',
    no: '否',
    oneOf: '可选值',
    colon: ':',
    rule: '规则',
    more: (n: number) => `另有 ${n} 个字段未列出。`,
    refs: '引用',
    refTo: (field: string, to: string, many: boolean) => `→ ${to}（通过 ${field}${many ? '，多个' : ''}）`,
    refFrom: (from: string, field: string) => `← ${from}（通过 ${field}）`,
    indexes: '索引',
    indexColumns: ['名称', '键', '类型'],
    unique: '唯一',
    partial: '部分',
    ttl: (n: string) => `${n} 秒后过期`,
    plain: '—',
    noIndexes: '无法读取其索引。',
    indexesFailed: (why: string) => `无法读取其索引：${why}`,
    rulesFailed: (why: string) => `无法读取其规则：${why}`,
    validation: (level: string, action: string) => `验证：${level}，${action}。`,
    noValidation: '没有验证规则。',
    skipped: (n: number) => `另有 ${n} 个集合未读取。`,
    percent: (n: number) => `${n}%`,
    partialFile: (kept: string, total: string) =>
      `此文件仅包含 ${total} 个集合中的前 ${kept} 个：完整字典超过了保存文件 1 MB 的上限。`,
  },
  ja: {
    title: (db: string) => `${db} — データ辞書`,
    sampled: (n: string, at: string) =>
      `フィールドは各コレクションから最大 ${n} 件のサンプルドキュメントを読み取ったものです（読み取り日時: ${at}）。`,
    contents: 'コレクション',
    kinds: { collection: 'コレクション', view: 'ビュー', timeseries: '時系列' },
    viewOf: (c: string) => `${c} のビューです。`,
    refused: 'ドキュメントを読み取れませんでした。',
    fields: 'フィールド',
    columns: ['フィールド', '型', '出現率', '必須', 'メモ'],
    hidden: '非表示',
    yes: 'はい',
    no: 'いいえ',
    oneOf: '次のいずれか',
    colon: ':',
    rule: 'ルール',
    more: (n: number) => `ほか ${n} 件のフィールドは一覧に含まれていません。`,
    refs: '参照',
    refTo: (field: string, to: string, many: boolean) =>
      `→ ${to}（${field} による参照${many ? '、複数' : ''}）`,
    refFrom: (from: string, field: string) => `← ${from}（${field} による参照）`,
    indexes: 'インデックス',
    indexColumns: ['名前', 'キー', '種類'],
    unique: '一意',
    partial: '部分',
    ttl: (n: string) => `${n} 秒後に失効`,
    plain: '—',
    noIndexes: 'インデックスを読み取れませんでした。',
    indexesFailed: (why: string) => `インデックスを読み取れませんでした: ${why}`,
    rulesFailed: (why: string) => `ルールを読み取れませんでした: ${why}`,
    validation: (level: string, action: string) => `検証: ${level}、${action}。`,
    noValidation: '検証ルールはありません。',
    skipped: (n: number) => `ほか ${n} 件のコレクションは読み取られていません。`,
    percent: (n: number) => `${n}%`,
    partialFile: (kept: string, total: string) =>
      `このファイルには ${total} 件のコレクションのうち最初の ${kept} 件のみが含まれています。辞書全体が、保存できるファイルの上限である 1 MB を超えています。`,
  },
  es: {
    title: (db: string) => `${db} — diccionario de datos`,
    sampled: (n: string, at: string) =>
      `Campos de hasta ${n} documentos de muestra por colección, leídos el ${at}.`,
    contents: 'Colecciones',
    kinds: { collection: 'colección', view: 'vista', timeseries: 'serie temporal' },
    viewOf: (c: string) => `Una vista de ${c}.`,
    refused: 'No se pudieron leer sus documentos.',
    fields: 'Campos',
    columns: ['Campo', 'Tipo', 'Presencia', 'Obligatorio', 'Notas'],
    hidden: 'oculto',
    yes: 'sí',
    no: 'no',
    oneOf: 'uno de',
    colon: ':',
    rule: 'regla',
    more: (n: number) =>
      pluralOf(n, 'es') === 'one'
        ? `No se incluyó ${n} campo más en la lista.`
        : `No se incluyeron ${n} campos más en la lista.`,
    refs: 'Referencias',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (por ${field}${many ? ', varias' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (por ${field})`,
    indexes: 'Índices',
    indexColumns: ['Nombre', 'Claves', 'Tipo'],
    unique: 'único',
    partial: 'parcial',
    ttl: (n: string) => `caduca tras ${n} s`,
    plain: '—',
    noIndexes: 'No se pudieron leer sus índices.',
    indexesFailed: (why: string) => `No se pudieron leer sus índices: ${why}`,
    rulesFailed: (why: string) => `No se pudieron leer sus reglas: ${why}`,
    validation: (level: string, action: string) => `Validación: ${level}, ${action}.`,
    noValidation: 'Sin reglas de validación.',
    skipped: (n: number) =>
      pluralOf(n, 'es') === 'one' ? `No se leyó ${n} colección más.` : `No se leyeron ${n} colecciones más.`,
    percent: (n: number) => `${n} %`,
    partialFile: (kept: string, total: string) =>
      `Este archivo solo incluye las primeras ${kept} de ${total} colecciones: el diccionario completo supera el máximo de 1 MB de un archivo guardado.`,
  },
  pt: {
    title: (db: string) => `${db} — dicionário de dados`,
    sampled: (n: string, at: string) =>
      `Campos de até ${n} documentos de amostra por coleção, lidos em ${at}.`,
    contents: 'Coleções',
    kinds: { collection: 'coleção', view: 'visualização', timeseries: 'série temporal' },
    viewOf: (c: string) => `Uma visualização de ${c}.`,
    refused: 'Não foi possível ler os documentos.',
    fields: 'Campos',
    columns: ['Campo', 'Tipo', 'Presença', 'Obrigatório', 'Observações'],
    hidden: 'oculto',
    yes: 'sim',
    no: 'não',
    oneOf: 'um de',
    colon: ':',
    rule: 'regra',
    more: (n: number) =>
      pluralOf(n, 'pt') === 'one'
        ? `Mais ${n} campo não foi listado.`
        : `Mais ${n} campos não foram listados.`,
    refs: 'Referências',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (por ${field}${many ? ', vários' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (por ${field})`,
    indexes: 'Índices',
    indexColumns: ['Nome', 'Chaves', 'Tipo'],
    unique: 'único',
    partial: 'parcial',
    ttl: (n: string) => `expira após ${n} s`,
    plain: '—',
    noIndexes: 'Não foi possível ler os índices.',
    indexesFailed: (why: string) => `Não foi possível ler os índices: ${why}`,
    rulesFailed: (why: string) => `Não foi possível ler as regras: ${why}`,
    validation: (level: string, action: string) => `Validação: ${level}, ${action}.`,
    noValidation: 'Nenhuma regra de validação.',
    skipped: (n: number) =>
      pluralOf(n, 'pt') === 'one' ? `Mais ${n} coleção não foi lida.` : `Mais ${n} coleções não foram lidas.`,
    percent: (n: number) => `${n}%`,
    partialFile: (kept: string, total: string) =>
      `Este arquivo contém apenas as primeiras ${kept} de ${total} coleções: o dicionário completo excede o limite de 1 MB de um arquivo salvo.`,
  },
  ko: {
    title: (db: string) => `${db} — 데이터 사전`,
    sampled: (n: string, at: string) =>
      `필드는 컬렉션마다 최대 ${n}개의 샘플 도큐먼트에서 읽은 것입니다(읽은 시각: ${at}).`,
    contents: '컬렉션',
    kinds: { collection: '컬렉션', view: '뷰', timeseries: '시계열' },
    viewOf: (c: string) => `${c}의 뷰입니다.`,
    refused: '도큐먼트를 읽을 수 없습니다.',
    fields: '필드',
    columns: ['필드', '유형', '존재율', '필수', '비고'],
    hidden: '숨김',
    yes: '예',
    no: '아니요',
    oneOf: '다음 중 하나',
    colon: ':',
    rule: '규칙',
    more: (n: number) => `필드 ${n}개는 목록에 포함되지 않았습니다.`,
    refs: '참조',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (${field} 기준${many ? ', 여러 개' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (${field} 기준)`,
    indexes: '인덱스',
    indexColumns: ['이름', '키', '종류'],
    unique: '고유',
    partial: '부분',
    ttl: (n: string) => `${n}초 후 만료`,
    plain: '—',
    noIndexes: '인덱스를 읽을 수 없습니다.',
    indexesFailed: (why: string) => `인덱스를 읽을 수 없습니다: ${why}`,
    rulesFailed: (why: string) => `규칙을 읽을 수 없습니다: ${why}`,
    validation: (level: string, action: string) => `유효성 검사: ${level}, ${action}.`,
    noValidation: '유효성 검사 규칙이 없습니다.',
    skipped: (n: number) => `컬렉션 ${n}개를 읽지 않았습니다.`,
    percent: (n: number) => `${n}%`,
    partialFile: (kept: string, total: string) =>
      `이 파일에는 컬렉션 ${total}개 중 처음 ${kept}개만 들어 있습니다. 전체 사전이 저장 파일의 상한인 1 MB를 넘습니다.`,
  },
  de: {
    title: (db: string) => `${db} — Datenwörterbuch`,
    sampled: (n: string, at: string) =>
      `Felder aus bis zu ${n} Beispieldokumenten pro Collection, gelesen am ${at}.`,
    contents: 'Collections',
    kinds: { collection: 'Collection', view: 'View', timeseries: 'Time Series' },
    viewOf: (c: string) => `Eine View auf ${c}.`,
    refused: 'Die Dokumente konnten nicht gelesen werden.',
    fields: 'Felder',
    columns: ['Feld', 'Typ', 'Vorkommen', 'Pflicht', 'Hinweise'],
    hidden: 'verborgen',
    yes: 'ja',
    no: 'nein',
    oneOf: 'eines von',
    colon: ':',
    rule: 'Regel',
    more: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? `${n} weiteres Feld wurde nicht aufgeführt.`
        : `${n} weitere Felder wurden nicht aufgeführt.`,
    refs: 'Verweise',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (über ${field}${many ? ', mehrere' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (über ${field})`,
    indexes: 'Indizes',
    indexColumns: ['Name', 'Schlüssel', 'Art'],
    unique: 'eindeutig',
    partial: 'partiell',
    ttl: (n: string) => `läuft nach ${n} s ab`,
    plain: '—',
    noIndexes: 'Die Indizes konnten nicht gelesen werden.',
    indexesFailed: (why: string) => `Die Indizes konnten nicht gelesen werden: ${why}`,
    rulesFailed: (why: string) => `Die Regeln konnten nicht gelesen werden: ${why}`,
    validation: (level: string, action: string) => `Validierung: ${level}, ${action}.`,
    noValidation: 'Keine Validierungsregeln.',
    skipped: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? `${n} weitere Collection wurde nicht gelesen.`
        : `${n} weitere Collections wurden nicht gelesen.`,
    percent: (n: number) => `${n} %`,
    partialFile: (kept: string, total: string) =>
      `Diese Datei enthält nur ${kept} von ${total} Collections (die ersten): Das gesamte Wörterbuch überschreitet die 1 MB, die eine gespeicherte Datei haben darf.`,
  },
  fr: {
    title: (db: string) => `${db} — dictionnaire de données`,
    sampled: (n: string, at: string) =>
      `Champs issus d’au plus ${n} documents échantillons par collection, lus le ${at}.`,
    contents: 'Collections',
    kinds: { collection: 'collection', view: 'vue', timeseries: 'série chronologique' },
    viewOf: (c: string) => `Une vue de ${c}.`,
    refused: 'Impossible de lire ses documents.',
    fields: 'Champs',
    columns: ['Champ', 'Type', 'Présence', 'Obligatoire', 'Remarques'],
    hidden: 'masqué',
    yes: 'oui',
    no: 'non',
    oneOf: 'l’une de',
    colon: ' :',
    rule: 'règle',
    more: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `${n} autre champ n’a pas été listé.`
        : `${n} autres champs n’ont pas été listés.`,
    refs: 'Références',
    refTo: (field: string, to: string, many: boolean) => `→ ${to} (par ${field}${many ? ', plusieurs' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (par ${field})`,
    indexes: 'Index',
    indexColumns: ['Nom', 'Clés', 'Type'],
    unique: 'unique',
    partial: 'partiel',
    ttl: (n: string) => `expire après ${n} s`,
    plain: '—',
    noIndexes: 'Impossible de lire ses index.',
    indexesFailed: (why: string) => `Impossible de lire ses index : ${why}`,
    rulesFailed: (why: string) => `Impossible de lire ses règles : ${why}`,
    validation: (level: string, action: string) => `Validation : ${level}, ${action}.`,
    noValidation: 'Aucune règle de validation.',
    skipped: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `${n} autre collection n’a pas été lue.`
        : `${n} autres collections n’ont pas été lues.`,
    percent: (n: number) => `${n} %`,
    partialFile: (kept: string, total: string) =>
      `Ce fichier ne contient que les premières collections (${kept} sur ${total}) : le dictionnaire complet dépasse la limite de 1 MB d’un fichier enregistré.`,
  },
  ru: {
    title: (db: string) => `${db} — словарь данных`,
    sampled: (n: string, at: string) =>
      `Поля прочитаны не более чем из ${n} образцов документов каждой коллекции; время чтения: ${at}.`,
    contents: 'Коллекции',
    kinds: { collection: 'коллекция', view: 'представление', timeseries: 'временные ряды' },
    viewOf: (c: string) => `Представление коллекции ${c}.`,
    refused: 'Не удалось прочитать документы коллекции.',
    fields: 'Поля',
    columns: ['Поле', 'Тип', 'Наличие', 'Обязательное', 'Примечания'],
    hidden: 'скрыто',
    yes: 'да',
    no: 'нет',
    oneOf: 'одно из',
    colon: ':',
    rule: 'правило',
    more: (n: number) =>
      ({
        one: `${n} поле не показано.`,
        few: `${n} поля не показаны.`,
        many: `${n} полей не показано.`,
        other: `${n} поля не показано.`,
        zero: `${n} полей не показано.`,
        two: `${n} поля не показаны.`,
      })[pluralOf(n, 'ru')],
    refs: 'Ссылки',
    refTo: (field: string, to: string, many: boolean) =>
      `→ ${to} (по полю ${field}${many ? ', несколько' : ''})`,
    refFrom: (from: string, field: string) => `← ${from} (по полю ${field})`,
    indexes: 'Индексы',
    indexColumns: ['Имя', 'Ключи', 'Вид'],
    unique: 'уникальный',
    partial: 'частичный',
    ttl: (n: string) => `истекает через ${n} с`,
    plain: '—',
    noIndexes: 'Не удалось прочитать индексы.',
    indexesFailed: (why: string) => `Не удалось прочитать индексы: ${why}`,
    rulesFailed: (why: string) => `Не удалось прочитать правила: ${why}`,
    validation: (level: string, action: string) => `Валидация: ${level}, ${action}.`,
    noValidation: 'Правил валидации нет.',
    skipped: (n: number) =>
      ({
        one: `${n} коллекция не прочитана.`,
        few: `${n} коллекции не прочитаны.`,
        many: `${n} коллекций не прочитано.`,
        other: `${n} коллекции не прочитано.`,
        zero: `${n} коллекций не прочитано.`,
        two: `${n} коллекции не прочитаны.`,
      })[pluralOf(n, 'ru')],
    percent: (n: number) => `${n} %`,
    partialFile: (kept: string, total: string) =>
      `В этом файле только первые коллекции (${kept} из ${total}): весь словарь превышает 1 MB — предельный размер сохраняемого файла.`,
  },
} satisfies Record<Language, Words>
export const wordsFor = (lang: string): Words => pick<Words>(WORDS, lang)

/** The `lang` of what is written: the reader's language, English where the words are English. */
export const tagOf = (lang: string): string => langTag(shown(WORDS, lang))
const number = (n: number, lang: string) => new Intl.NumberFormat(tagOf(lang)).format(n)
export const when = (iso: string, lang: string) => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms)
    ? new Intl.DateTimeFormat(tagOf(lang), {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(ms) + ' UTC'
    : iso
}

/** A field's notes: its rule's description, its allowed values, the type its rule asks for. */
export function notesOf(f: DictField, w: Words): string {
  return [
    f.description,
    f.enum?.length ? `${w.oneOf}${w.colon} ${f.enum.join(', ')}` : null,
    f.bsonType && !f.types.includes(f.bsonType) ? `${w.rule}${w.colon} ${f.bsonType}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
export const indexKind = (ix: DictIndex, w: Words, lang: string): string =>
  [
    ix.unique ? w.unique : null,
    ix.partial ? w.partial : null,
    ix.ttl !== undefined ? w.ttl(number(ix.ttl, lang)) : null,
  ]
    .filter(Boolean)
    .join(', ') || w.plain

/** What a collection's indexes say, or why they could not be read. */
export const indexesNote = (c: DictCollection, w: Words): string =>
  c.indexError !== undefined ? w.indexesFailed(c.indexError) : w.noIndexes
/** What a collection's rules say, or why they could not be read — never "no rules" then. */
export const rulesNote = (c: DictCollection, w: Words): string =>
  c.validationError !== undefined
    ? w.rulesFailed(c.validationError)
    : c.validation
      ? w.validation(c.validation.level, c.validation.action)
      : w.noValidation

/** Every kind of line break (CR, LF, NEL, line and paragraph separators, tab, VT, FF). */
const BREAKS = /\r\n|[\t\n\v\f\r\u0085\u2028\u2029]/g
/** Characters that show nothing or turn text around: controls, zero-width, bidi, fillers, tags. */
const UNSEEN =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- these unseen characters are what is removed
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|\udb40[\udc00-\udc7f]/g
/**
 * Text as saved (wave 3 review): the database's names and a rule's words are data — on one line,
 * with nothing hidden that could turn them around or make them read as something else.
 */
export const plainText = (s: string): string => s.replace(BREAKS, ' ').replace(UNSEEN, '')

/**
 * Markdown's inline punctuation, each written as itself (a link, image or emphasis never forms).
 * Wave 3 second review: `:` and `@` too — GitHub links an address (`https://`), a `www.` name or an
 * e-mail found in one run of text, and an escape splits the run, so none forms.
 */
const MD_PUNCT = /[\\`*_{}[\]()#+\-.!|~<>:@]/g
/**
 * Text in a Markdown line or table cell: one line, &, < and > as entities (no tag ever forms), every
 * other punctuation that could open a link, an image, emphasis or a column escaped.
 */
const md = (s: string) =>
  plainText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MD_PUNCT, (ch) => `\\${ch}`)
/**
 * Code as Markdown writes it: fenced with one backtick more than its longest run, a space inside
 * each end where it starts or ends with a backtick or holds a space at both (Markdown takes one
 * off), and `|` escaped in a table cell.
 */
const code = (raw: string, cell = false) => {
  const s = cell ? plainText(raw).replace(/\|/g, '\\|') : plainText(raw)
  if (!s) return '` `'
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length)) + 1)
  const pad = s.startsWith('`') || s.endsWith('`') || (s.startsWith(' ') && s.endsWith(' ')) ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

/** A file holding only the first collections of the dictionary (wave 3 third review): how many of all. */
export interface SavedPart {
  kept: number
  total: number
}

export function dictionaryMarkdown(d: Dictionary, lang: string, partial?: SavedPart): string {
  const w = wordsFor(lang)
  const out: string[] = [
    `# ${md(w.title(d.db))}`,
    '',
    w.sampled(number(d.sampleSize, lang), when(d.at, lang)),
    '',
  ]
  // Said in the file itself, so a reader of the file alone knows it is a part (wave 3 third review).
  if (partial) out.push(`> ${w.partialFile(number(partial.kept, lang), number(partial.total, lang))}`, '')
  out.push(`## ${w.contents}`, '', ...d.collections.map((c) => `- [${md(c.name)}](#${c.anchor})`), '')
  if (d.skipped) out.push(w.skipped(d.skipped), '')
  for (const c of d.collections) {
    // The anchor the contents list names, in every renderer (wave 3 review): an id is letters,
    // digits, - and _ only (anchorOf).
    out.push(`<a id="${c.anchor}"></a>`, '', `## ${md(c.name)}`, '', `*${md(w.kinds[c.type] ?? c.type)}*`, '')
    if (c.viewOn) out.push(w.viewOf(code(c.viewOn)), '')
    if (c.refused) out.push(w.refused, '')
    if (c.fields.length) {
      out.push(
        `### ${w.fields}`,
        '',
        `| ${w.columns.join(' | ')} |`,
        `|${w.columns.map(() => ' --- ').join('|')}|`,
      )
      for (const f of c.fields)
        out.push(
          `| ${code(f.path, true)} | ${f.hidden ? w.hidden : md(f.types.join(', '))} | ${w.percent(Math.round(f.share * 100))} | ${f.required ? w.yes : w.no} | ${md(notesOf(f, w))} |`,
        )
      out.push('')
      if (c.moreFields) out.push(w.more(c.moreFields), '')
    }
    if (c.refsOut.length || c.refsIn.length) {
      out.push(`### ${w.refs}`, '')
      for (const r of c.refsOut) out.push(`- ${w.refTo(code(r.field), code(r.to), r.many)}`)
      for (const r of c.refsIn) out.push(`- ${w.refFrom(code(r.from), code(r.field))}`)
      out.push('')
    }
    if (c.type !== 'view') {
      out.push(`### ${w.indexes}`, '')
      if (c.indexes) {
        out.push(`| ${w.indexColumns.join(' | ')} |`, `|${w.indexColumns.map(() => ' --- ').join('|')}|`)
        for (const ix of c.indexes)
          out.push(`| ${code(ix.name, true)} | ${code(ix.keys, true)} | ${md(indexKind(ix, w, lang))} |`)
      } else out.push(md(indexesNote(c, w)))
      out.push('', md(rulesNote(c, w)), '')
    }
  }
  return out.join('\n')
}

const html = (s: string) =>
  plainText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
const HTML_CSS = [
  'body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #18181b; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; }',
  'h1 { font-size: 1.6rem; } h2 { margin-top: 2rem; border-bottom: 1px solid #d0d5dd; padding-bottom: .25rem; }',
  'table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }',
  'th, td { border: 1px solid #d0d5dd; padding: .3rem .5rem; text-align: left; vertical-align: top; }',
  'th { background: #f2f4f7; } code { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: .9em; }',
  '.muted { color: #667085; }',
  '.partial { border-left: 3px solid #f79009; background: #fffaeb; padding: .4rem .75rem; }',
].join('\n')

/** The dictionary as an HTML page's parts: the app assembles the page around them (spec §1.1). */
export function dictionaryHtml(
  d: Dictionary,
  lang: string,
  partial?: SavedPart,
): { title: string; css: string; body: string; lang: string } {
  const w = wordsFor(lang)
  const c_ = (s: string) => `<code>${html(s)}</code>`
  const table = (head: string[], rows: string[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`
  const parts: string[] = [
    `<h1>${html(w.title(d.db))}</h1>`,
    `<p class="muted">${html(w.sampled(number(d.sampleSize, lang), when(d.at, lang)))}</p>`,
    ...(partial
      ? [
          `<p class="partial">${html(w.partialFile(number(partial.kept, lang), number(partial.total, lang)))}</p>`,
        ]
      : []),
    `<h2>${html(w.contents)}</h2>`,
    `<ul>${d.collections.map((c) => `<li><a href="#${c.anchor}">${html(c.name)}</a></li>`).join('')}</ul>`,
  ]
  if (d.skipped) parts.push(`<p>${html(w.skipped(d.skipped))}</p>`)
  for (const c of d.collections) {
    parts.push(
      `<section id="${c.anchor}">`,
      `<h2>${html(c.name)}</h2>`,
      `<p class="muted">${html(w.kinds[c.type] ?? c.type)}</p>`,
    )
    if (c.viewOn) parts.push(`<p>${html(w.viewOf(c.viewOn))}</p>`)
    if (c.refused) parts.push(`<p>${html(w.refused)}</p>`)
    if (c.fields.length) {
      parts.push(
        `<h3>${html(w.fields)}</h3>`,
        table(
          w.columns,
          c.fields.map((f) => [
            c_(f.path),
            html(f.hidden ? w.hidden : f.types.join(', ')),
            html(w.percent(Math.round(f.share * 100))),
            html(f.required ? w.yes : w.no),
            html(notesOf(f, w)),
          ]),
        ),
      )
      if (c.moreFields) parts.push(`<p class="muted">${html(w.more(c.moreFields))}</p>`)
    }
    if (c.refsOut.length || c.refsIn.length)
      parts.push(
        `<h3>${html(w.refs)}</h3>`,
        `<ul>${[
          ...c.refsOut.map((r) => w.refTo(r.field, r.to, r.many)),
          ...c.refsIn.map((r) => w.refFrom(r.from, r.field)),
        ]
          .map((t) => `<li>${html(t)}</li>`)
          .join('')}</ul>`,
      )
    if (c.type !== 'view') {
      parts.push(`<h3>${html(w.indexes)}</h3>`)
      parts.push(
        c.indexes
          ? table(
              w.indexColumns,
              c.indexes.map((ix) => [c_(ix.name), c_(ix.keys), html(indexKind(ix, w, lang))]),
            )
          : `<p>${html(indexesNote(c, w))}</p>`,
      )
      parts.push(`<p>${html(rulesNote(c, w))}</p>`)
    }
    parts.push('</section>')
  }
  return { title: plainText(w.title(d.db)), css: HTML_CSS, body: parts.join(''), lang: tagOf(lang) }
}

/** What the app saves at most (spec §1.1): each text 1,000,000 characters, a message 1 MiB as JSON. */
export const SAVE_LIMITS = { chars: 1_000_000, bytes: 1024 * 1024 }
/** Room in a message for what goes around the file (the request's own fields). */
const ENVELOPE = 256

/**
 * The dictionary as the app is asked to save it — whole, or (wave 3 second review: a large database
 * met the save limit with a generic error) its first collections that fit, and how many those are;
 * a part says so inside the file, and when not one collection fits there is nothing to save
 * (`params` null; wave 3 third review).
 */
export function savable(
  d: Dictionary,
  lang: string,
  type: 'markdown' | 'html',
  limits: { chars: number; bytes: number } = SAVE_LIMITS,
): { params: Record<string, unknown> | null; kept: number; total: number } {
  const total = d.collections.length
  const paramsOf = (n: number): Record<string, unknown> => {
    const part = { ...d, collections: d.collections.slice(0, n) }
    const partial = n < total ? { kept: n, total } : undefined
    return {
      name: `${d.db}-dictionary`,
      type,
      ...(type === 'markdown'
        ? { text: dictionaryMarkdown(part, lang, partial) }
        : { html: dictionaryHtml(part, lang, partial) }),
    }
  }
  const fits = (params: Record<string, unknown>) => {
    const texts =
      type === 'markdown'
        ? [params.text as string]
        : [(params.html as { css: string }).css, (params.html as { body: string }).body]
    return (
      texts.every((t) => t.length <= limits.chars) &&
      new TextEncoder().encode(JSON.stringify(params)).length + ENVELOPE <= limits.bytes
    )
  }
  const whole = paramsOf(total)
  if (fits(whole)) return { params: whole, kept: total, total }
  // The most collections that fit, found by halving.
  let low = 0
  let high = total - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(paramsOf(mid))) low = mid
    else high = mid - 1
  }
  if (low === 0) return { params: null, kept: 0, total }
  return { params: paramsOf(low), kept: low, total }
}
