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
  h,
  langTag,
  type Language,
  pageHeader,
  pick,
  pluralOf,
  shown,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { shapeOf, type FieldShape } from '../../kit/src/shape'
import { shellText } from '../../kit/src/shell'
import {
  CONVERT_TO,
  KINDS,
  MAX_STAGES,
  clashesOf,
  hiddenGuard,
  problemOf,
  stagesOf,
  type DefaultWhen,
  type HiddenGuard,
  type Operation,
  type OperationKind,
  type Problem,
} from './reshape'

/**
 * Plugins wave 3 (spec §6): fields renamed, flattened, nested, converted or removed — built as
 * $set and $unset stages, previewed on sample documents (the same documents before and after), and
 * handed to Aggregations, where the user adds a $out to write a new collection. The collection the
 * tab is on is never changed here.
 *
 * Review 28–29: a change redraws only what it changes (focus stays where the user is), and the
 * preview waits for the edits to stop, runs one at a time, then once more with the latest steps.
 */
const SAMPLE = 50
const PREVIEW = 5
/** How long the preview waits for the edits to stop. */
export const PREVIEW_DELAY = 250
type Doc = Record<string, unknown>

/** One of a Russian count's three forms, by the kit's plural category. */
function ruForms(n: number, forms: { one: string; few: string; many: string }): string {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? forms.one : category === 'few' ? forms.few : forms.many
}

const BASE = {
  en: {
    title: 'Reshape',
    description: (coll: string) =>
      `Rename, flatten, nest, convert or remove fields of ${coll}: previewed here, then handed to Aggregations — ${coll} itself is never changed.`,
    reading: 'Reading the fields…',
    noPlace: 'Open a collection to reshape its documents.',
    failed: 'The documents could not be read: ',
    steps: 'Steps',
    none: 'Add a step to begin.',
    add: 'Add step',
    kindOfStep: 'Kind of step',
    remove: (n: number, kind: string) => `Remove step ${n}: ${kind}`,
    kinds: {
      rename: 'Rename or move',
      flatten: 'Flatten an object',
      nest: 'Nest into an object',
      convert: 'Convert type',
      remove: 'Remove',
      default: 'Default where missing',
      split: 'Split text into a list',
      join: 'Join a list into text',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Default where missing or null',
    field: 'Field',
    to: 'New name (a.b moves it into an object)',
    into: 'Into',
    fields: 'Fields',
    picked: (n: number, of: number) => `Chosen: ${n} of ${of}`,
    noFields: 'No field to offer.',
    separator: 'Separator',
    type: 'To type',
    onError: 'A value that cannot be converted',
    onErrors: { null: 'becomes null', keep: 'is kept' },
    value: 'Value',
    valueKind: 'Kind of value',
    valueKinds: { text: 'text', number: 'number', true: 'true', false: 'false', null: 'null' },
    when: 'Fill where the field is',
    whens: { missing: 'missing', missingOrNull: 'missing or null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'A name here is not one a field may have ($ is not allowed in a name).',
      id: '_id cannot be renamed, moved or removed.',
      same: 'A field cannot be moved into itself.',
      overlap: 'A field and a field inside it cannot both be nested.',
      empty: 'Pick at least one field.',
      separator: 'Give a separator; a flatten’s may not hold . or $.',
      hidden: 'This step would touch a field hidden from you as personal data.',
      duplicate: 'Two fields here end in the same name: one would be lost.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} already exists: its value is replaced.`,
    each: (name: string) => `${name} is a list: the value is set in each of its documents.`,
    leftOut: (n: number) =>
      pluralOf(n, 'en') === 'one'
        ? '1 step with a problem is left out of the stages.'
        : `${n} steps with a problem are left out of the stages.`,
    incomplete: (n: number) =>
      pluralOf(n, 'en') === 'one' ? '1 step is not finished yet.' : `${n} steps are not finished yet.`,
    notShown: `Not shown: these steps make more stages than a preview takes (${MAX_STAGES}).`,
    hiddenUnknown:
      'Which fields are hidden from you as personal data could not be told in time: no field is offered until it is.',
    retry: 'Try again',
    tooMany: (n: number) =>
      `These steps make ${n} stages: at most ${MAX_STAGES} can be previewed and handed to Aggregations. Remove some steps.`,
    hiddenNote: 'Fields hidden from you as personal data are not offered, nor the objects holding them.',
    preview: 'Preview',
    before: 'Before',
    after: 'After',
    noPreview: 'The preview could not be made: ',
    stages: 'Stages',
    copy: 'Copy stages',
    copied: 'The stages were copied.',
    use: 'Use in Aggregations',
    handed:
      'In Aggregations: to write the result into a new collection, add a $out stage naming it; Aggregations shows what the write would do and asks you first.',
  },
  tr: {
    title: 'Yeniden şekillendir',
    description: (coll: string) =>
      `${coll} koleksiyonunun alanlarını yeniden adlandırın, düzleştirin, iç içe koyun, dönüştürün ya da kaldırın: burada önizlenir, sonra Aggregations'a verilir — ${coll} hiç değişmez.`,
    reading: 'Alanlar okunuyor…',
    noPlace: 'Belgelerini yeniden şekillendirmek için bir koleksiyon açın.',
    failed: 'Belgeler okunamadı: ',
    steps: 'Adımlar',
    none: 'Başlamak için bir adım ekleyin.',
    add: 'Adım ekle',
    kindOfStep: 'Adım türü',
    remove: (n: number, kind: string) => `${n}. adımı kaldır: ${kind}`,
    kinds: {
      rename: 'Yeniden adlandır ya da taşı',
      flatten: 'Bir nesneyi düzleştir',
      nest: 'Bir nesneye yerleştir',
      convert: 'Türünü dönüştür',
      remove: 'Kaldır',
      default: 'Yoksa varsayılan değer',
      split: 'Metni listeye böl',
      join: 'Listeyi metne birleştir',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Yoksa ya da null ise varsayılan değer',
    field: 'Alan',
    to: 'Yeni ad (a.b onu bir nesnenin içine taşır)',
    into: 'Hedef',
    fields: 'Alanlar',
    picked: (n: number, of: number) => `Seçili: ${n} / ${of}`,
    noFields: 'Sunulacak alan yok.',
    separator: 'Ayırıcı',
    type: 'Hedef tür',
    onError: 'Dönüştürülemeyen bir değer',
    onErrors: { null: 'null olur', keep: 'olduğu gibi kalır' },
    value: 'Değer',
    valueKind: 'Değerin türü',
    valueKinds: { text: 'metin', number: 'sayı', true: 'true', false: 'false', null: 'null' },
    when: 'Alan şu durumdaysa doldur',
    whens: { missing: 'yoksa', missingOrNull: 'yoksa ya da null ise' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'Buradaki bir ad, bir alanın alabileceği bir ad değil (adda $ olamaz).',
      id: '_id yeniden adlandırılamaz, taşınamaz ya da kaldırılamaz.',
      same: 'Bir alan kendi içine taşınamaz.',
      overlap: 'Bir alan ve onun içindeki bir alan birlikte yerleştirilemez.',
      empty: 'En az bir alan seçin.',
      separator: 'Bir ayırıcı verin; düzleştirmenin ayırıcısında . ya da $ olamaz.',
      hidden: 'Bu adım, kişisel veri olarak sizden gizlenen bir alana dokunur.',
      duplicate: 'Buradaki iki alanın adı aynı adla bitiyor: biri kaybolur.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} zaten var: değeri değiştirilir.`,
    each: (name: string) => `${name} bir liste: değer, içindeki her belgede ayarlanır.`,
    leftOut: (n: number) => `Sorunlu ${n} adım aşamalara alınmadı.`,
    incomplete: (n: number) => `${n} adım henüz tamamlanmadı.`,
    notShown: `Gösterilmiyor: bu adımlar bir önizlemenin alabileceğinden (${MAX_STAGES}) fazla aşama yapar.`,
    hiddenUnknown:
      'Kişisel veri olarak sizden hangi alanların gizlendiği zamanında anlaşılamadı: anlaşılana kadar hiçbir alan sunulmaz.',
    retry: 'Yeniden dene',
    tooMany: (n: number) =>
      `Bu adımlar ${n} aşama yapar: en fazla ${MAX_STAGES} aşama önizlenebilir ve Aggregations'a verilebilir. Bazı adımları kaldırın.`,
    hiddenNote: 'Kişisel veri olarak sizden gizlenen alanlar ve onları tutan nesneler sunulmaz.',
    preview: 'Önizleme',
    before: 'Önce',
    after: 'Sonra',
    noPreview: 'Önizleme yapılamadı: ',
    stages: 'Aşamalar',
    copy: 'Aşamaları kopyala',
    copied: 'Aşamalar kopyalandı.',
    use: "Aggregations'ta kullan",
    handed:
      "Aggregations'ta: sonucu yeni bir koleksiyona yazmak için onu adlandıran bir $out aşaması ekleyin; Aggregations yazmanın ne yapacağını gösterir ve önce size sorar.",
  },
}
type Text = (typeof BASE)['en']

export const TEXT = {
  ...BASE,
  zh: {
    title: '重塑',
    description: (coll: string) =>
      `重命名、展平、嵌套、转换或删除 ${coll} 的字段：先在此预览，再交给聚合 —— ${coll} 本身不会被更改。`,
    reading: '正在读取字段…',
    noPlace: '请打开一个集合以重塑其文档。',
    failed: '无法读取文档：',
    steps: '步骤',
    none: '添加一个步骤即可开始。',
    add: '添加步骤',
    kindOfStep: '步骤类型',
    remove: (n: number, kind: string) => `删除第 ${n} 步：${kind}`,
    kinds: {
      rename: '重命名或移动',
      flatten: '展平对象',
      nest: '嵌套到对象中',
      convert: '转换类型',
      remove: '删除',
      default: '缺失时设默认值',
      split: '将文本拆分为列表',
      join: '将列表合并为文本',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: '缺失或为 null 时设默认值',
    field: '字段',
    to: '新名称（a.b 会将其移入对象）',
    into: '目标',
    fields: '字段',
    picked: (n: number, of: number) => `已选择：${n} / ${of}`,
    noFields: '没有可选的字段。',
    separator: '分隔符',
    type: '目标类型',
    onError: '无法转换的值',
    onErrors: { null: '变为 null', keep: '保持不变' },
    value: '值',
    valueKind: '值的类型',
    valueKinds: { text: '文本', number: '数字', true: 'true', false: 'false', null: 'null' },
    when: '字段为以下情况时填充',
    whens: { missing: '缺失', missingOrNull: '缺失或为 null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: '此处的名称不能用作字段名（名称中不允许使用 $）。',
      id: '_id 不能被重命名、移动或删除。',
      same: '字段不能移入其自身。',
      overlap: '字段与其内部的字段不能同时嵌套。',
      empty: '请至少选择一个字段。',
      separator: '请提供分隔符；展平的分隔符不能包含 . 或 $。',
      hidden: '此步骤会涉及对您隐藏的个人数据字段。',
      duplicate: '此处有两个字段的名称以相同的名称结尾：其中一个会丢失。',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} 已存在：其值将被替换。`,
    each: (name: string) => `${name} 是列表：该值会设置到其中的每个文档。`,
    leftOut: (n: number) => `${n} 个有问题的步骤未纳入阶段。`,
    incomplete: (n: number) => `${n} 个步骤尚未完成。`,
    notShown: `未显示：这些步骤生成的阶段数超过预览上限（${MAX_STAGES}）。`,
    hiddenUnknown: '未能及时确定哪些字段作为个人数据对您隐藏：在确定之前不提供任何字段。',
    retry: '重试',
    tooMany: (n: number) =>
      `这些步骤生成 ${n} 个阶段：最多只能预览 ${MAX_STAGES} 个阶段并交给聚合。请删除部分步骤。`,
    hiddenNote: '作为个人数据对您隐藏的字段及包含它们的对象不会提供。',
    preview: '预览',
    before: '之前',
    after: '之后',
    noPreview: '无法生成预览：',
    stages: '阶段',
    copy: '复制阶段',
    copied: '阶段已复制。',
    use: '在聚合中使用',
    handed:
      '在聚合中：若要将结果写入新集合，请添加指定该集合的 $out 阶段；聚合会显示写入将执行的操作，并先征求您的确认。',
  },
  ja: {
    title: 'リシェイプ',
    description: (coll: string) =>
      `${coll} のフィールドの名前変更、フラット化、ネスト、変換、削除をここでプレビューし、集計に渡します。${coll} 自体は変更されません。`,
    reading: 'フィールドを読み込み中…',
    noPlace: 'ドキュメントをリシェイプするには、コレクションを開いてください。',
    failed: 'ドキュメントを読み込めませんでした：',
    steps: 'ステップ',
    none: 'ステップを追加して開始します。',
    add: 'ステップを追加',
    kindOfStep: 'ステップの種類',
    remove: (n: number, kind: string) => `ステップ ${n} を削除：${kind}`,
    kinds: {
      rename: '名前変更または移動',
      flatten: 'オブジェクトをフラット化',
      nest: 'オブジェクトにネスト',
      convert: '型を変換',
      remove: '削除',
      default: '欠落時のデフォルト値',
      split: 'テキストをリストに分割',
      join: 'リストをテキストに結合',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: '欠落または null 時のデフォルト値',
    field: 'フィールド',
    to: '新しい名前（a.b はオブジェクト内へ移動）',
    into: '移動先',
    fields: 'フィールド',
    picked: (n: number, of: number) => `選択済み：${n} / ${of}`,
    noFields: '選択できるフィールドがありません。',
    separator: '区切り文字',
    type: '変換後の型',
    onError: '変換できない値',
    onErrors: { null: 'null にする', keep: 'そのまま残す' },
    value: '値',
    valueKind: '値の種類',
    valueKinds: { text: 'テキスト', number: '数値', true: 'true', false: 'false', null: 'null' },
    when: '次の場合に埋める',
    whens: { missing: '欠落している', missingOrNull: '欠落または null' } satisfies Record<
      DefaultWhen,
      string
    >,
    problems: {
      incomplete: '',
      name: 'この名前はフィールド名として使えません（名前に $ は使えません）。',
      id: '_id は名前変更、移動、削除できません。',
      same: 'フィールドを自身の中に移動することはできません。',
      overlap: 'フィールドとその内側のフィールドを同時にネストすることはできません。',
      empty: 'フィールドを 1 つ以上選択してください。',
      separator: '区切り文字を指定してください。フラット化の区切り文字に . や $ は使えません。',
      hidden: 'このステップは、個人データとして非表示になっているフィールドに触れます。',
      duplicate: '同じ名前で終わるフィールドが 2 つあります。一方が失われます。',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} は既に存在します。値は置き換えられます。`,
    each: (name: string) => `${name} はリストです。値はその中の各ドキュメントに設定されます。`,
    leftOut: (n: number) => `問題のある ${n} 件のステップはステージに含まれません。`,
    incomplete: (n: number) => `${n} 件のステップがまだ完了していません。`,
    notShown: `表示されません。これらのステップはプレビューの上限（${MAX_STAGES}）を超えるステージを生成します。`,
    hiddenUnknown:
      '個人データとして非表示になっているフィールドを時間内に判定できませんでした。判定できるまで、フィールドは表示されません。',
    retry: '再試行',
    tooMany: (n: number) =>
      `これらのステップは ${n} 個のステージを生成します。プレビューして集計に渡せるのは最大 ${MAX_STAGES} 個です。ステップを減らしてください。`,
    hiddenNote: '個人データとして非表示になっているフィールドと、それを含むオブジェクトは表示されません。',
    preview: 'プレビュー',
    before: '変更前',
    after: '変更後',
    noPreview: 'プレビューを作成できませんでした：',
    stages: 'ステージ',
    copy: 'ステージをコピー',
    copied: 'ステージをコピーしました。',
    use: '集計で使用',
    handed:
      '集計では、結果を新しいコレクションに書き込むには、そのコレクションを指定した $out ステージを追加してください。集計が書き込みの内容を表示し、先に確認します。',
  },
  es: {
    title: 'Remodelar',
    description: (coll: string) =>
      `Cambia el nombre, aplana, anida, convierte o elimina campos de ${coll}: se previsualiza aquí y después se pasa a Agregaciones; ${coll} en sí nunca se modifica.`,
    reading: 'Leyendo los campos…',
    noPlace: 'Abre una colección para remodelar sus documentos.',
    failed: 'No se pudieron leer los documentos: ',
    steps: 'Pasos',
    none: 'Añade un paso para empezar.',
    add: 'Añadir paso',
    kindOfStep: 'Tipo de paso',
    remove: (n: number, kind: string) => `Eliminar el paso ${n}: ${kind}`,
    kinds: {
      rename: 'Renombrar o mover',
      flatten: 'Aplanar un objeto',
      nest: 'Anidar en un objeto',
      convert: 'Convertir el tipo',
      remove: 'Eliminar',
      default: 'Valor por defecto si falta',
      split: 'Dividir texto en una lista',
      join: 'Unir una lista en texto',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Valor por defecto si falta o es null',
    field: 'Campo',
    to: 'Nombre nuevo (a.b lo mueve a un objeto)',
    into: 'Destino',
    fields: 'Campos',
    picked: (n: number, of: number) => `Elegidos: ${n} de ${of}`,
    noFields: 'No hay ningún campo que ofrecer.',
    separator: 'Separador',
    type: 'Tipo de destino',
    onError: 'Un valor que no se puede convertir',
    onErrors: { null: 'pasa a null', keep: 'se conserva' },
    value: 'Valor',
    valueKind: 'Tipo de valor',
    valueKinds: { text: 'texto', number: 'número', true: 'true', false: 'false', null: 'null' },
    when: 'Rellenar cuando el campo',
    whens: { missing: 'falta', missingOrNull: 'falta o es null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'Un nombre de aquí no es válido para un campo (no se permite $ en un nombre).',
      id: '_id no se puede renombrar, mover ni eliminar.',
      same: 'Un campo no se puede mover dentro de sí mismo.',
      overlap: 'Un campo y otro campo dentro de él no se pueden anidar a la vez.',
      empty: 'Elige al menos un campo.',
      separator: 'Indica un separador; el de un aplanado no puede contener . ni $.',
      hidden: 'Este paso afectaría a un campo que se te oculta como dato personal.',
      duplicate: 'Dos campos de aquí terminan con el mismo nombre: uno se perdería.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} ya existe: su valor se reemplaza.`,
    each: (name: string) => `${name} es una lista: el valor se establece en cada uno de sus documentos.`,
    leftOut: (n: number) =>
      pluralOf(n, 'es') === 'one'
        ? '1 paso con un problema se deja fuera de las etapas.'
        : `${n} pasos con un problema se dejan fuera de las etapas.`,
    incomplete: (n: number) =>
      pluralOf(n, 'es') === 'one' ? '1 paso aún no está terminado.' : `${n} pasos aún no están terminados.`,
    notShown: `No se muestra: estos pasos generan más etapas de las que admite una vista previa (${MAX_STAGES}).`,
    hiddenUnknown:
      'No se pudo saber a tiempo qué campos se te ocultan como datos personales: no se ofrece ningún campo hasta entonces.',
    retry: 'Reintentar',
    tooMany: (n: number) =>
      `Estos pasos generan ${n} etapas: se pueden previsualizar y pasar a Agregaciones como máximo ${MAX_STAGES}. Elimina algunos pasos.`,
    hiddenNote:
      'Los campos que se te ocultan como datos personales y los objetos que los contienen no se ofrecen.',
    preview: 'Vista previa',
    before: 'Antes',
    after: 'Después',
    noPreview: 'No se pudo crear la vista previa: ',
    stages: 'Etapas',
    copy: 'Copiar etapas',
    copied: 'Se copiaron las etapas.',
    use: 'Usar en Agregaciones',
    handed:
      'En Agregaciones: para escribir el resultado en una colección nueva, añade una etapa $out que la nombre; Agregaciones muestra lo que haría la escritura y te pregunta antes.',
  },
  pt: {
    title: 'Remodelar',
    description: (coll: string) =>
      `Renomeie, nivele, aninhe, converta ou remova campos de ${coll}: a prévia aparece aqui e depois é enviada para Agregações — ${coll} em si nunca é alterada.`,
    reading: 'Lendo os campos…',
    noPlace: 'Abra uma coleção para remodelar seus documentos.',
    failed: 'Não foi possível ler os documentos: ',
    steps: 'Etapas',
    none: 'Adicione uma etapa para começar.',
    add: 'Adicionar etapa',
    kindOfStep: 'Tipo de etapa',
    remove: (n: number, kind: string) => `Remover a etapa ${n}: ${kind}`,
    kinds: {
      rename: 'Renomear ou mover',
      flatten: 'Nivelar um objeto',
      nest: 'Aninhar em um objeto',
      convert: 'Converter o tipo',
      remove: 'Remover',
      default: 'Padrão se ausente',
      split: 'Dividir texto em uma lista',
      join: 'Unir uma lista em texto',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Padrão se ausente ou null',
    field: 'Campo',
    to: 'Novo nome (a.b o move para dentro de um objeto)',
    into: 'Destino',
    fields: 'Campos',
    picked: (n: number, of: number) => `Escolhidos: ${n} de ${of}`,
    noFields: 'Nenhum campo para oferecer.',
    separator: 'Separador',
    type: 'Tipo de destino',
    onError: 'Um valor que não pode ser convertido',
    onErrors: { null: 'vira null', keep: 'é mantido' },
    value: 'Valor',
    valueKind: 'Tipo de valor',
    valueKinds: { text: 'texto', number: 'número', true: 'true', false: 'false', null: 'null' },
    when: 'Preencher quando o campo estiver',
    whens: { missing: 'ausente', missingOrNull: 'ausente ou null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'Um nome aqui não pode ser usado em um campo (não é permitido $ em um nome).',
      id: '_id não pode ser renomeado, movido nem removido.',
      same: 'Um campo não pode ser movido para dentro de si mesmo.',
      overlap: 'Um campo e um campo dentro dele não podem ser aninhados juntos.',
      empty: 'Escolha pelo menos um campo.',
      separator: 'Informe um separador; o de um nivelamento não pode conter . nem $.',
      hidden: 'Esta etapa atingiria um campo oculto de você como dado pessoal.',
      duplicate: 'Dois campos aqui terminam com o mesmo nome: um seria perdido.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} já existe: o valor dele é substituído.`,
    each: (name: string) => `${name} é uma lista: o valor é definido em cada um dos documentos dela.`,
    leftOut: (n: number) =>
      pluralOf(n, 'pt') === 'one'
        ? '1 etapa com problema ficou de fora dos estágios.'
        : `${n} etapas com problema ficaram de fora dos estágios.`,
    incomplete: (n: number) =>
      pluralOf(n, 'pt') === 'one'
        ? '1 etapa ainda não foi concluída.'
        : `${n} etapas ainda não foram concluídas.`,
    notShown: `Não exibido: estas etapas geram mais estágios do que uma prévia comporta (${MAX_STAGES}).`,
    hiddenUnknown:
      'Não foi possível saber a tempo quais campos ficam ocultos de você como dados pessoais: nenhum campo é oferecido até que isso seja determinado.',
    retry: 'Tentar novamente',
    tooMany: (n: number) =>
      `Estas etapas geram ${n} estágios: no máximo ${MAX_STAGES} podem ser visualizados e enviados para Agregações. Remova algumas etapas.`,
    hiddenNote: 'Campos ocultos de você como dados pessoais e os objetos que os contêm não são oferecidos.',
    preview: 'Prévia',
    before: 'Antes',
    after: 'Depois',
    noPreview: 'Não foi possível gerar a prévia: ',
    stages: 'Estágios',
    copy: 'Copiar estágios',
    copied: 'Os estágios foram copiados.',
    use: 'Usar em Agregações',
    handed:
      'Em Agregações: para gravar o resultado em uma nova coleção, adicione um estágio $out que a nomeie; Agregações mostra o que a gravação faria e pergunta antes.',
  },
  ko: {
    title: '재구성',
    description: (coll: string) =>
      `컬렉션 ${coll}의 필드 이름 변경, 평탄화, 중첩, 변환, 삭제: 여기서 미리 보고 집계로 넘깁니다 — ${coll} 자체는 변경되지 않습니다.`,
    reading: '필드를 읽는 중…',
    noPlace: '도큐먼트를 재구성할 컬렉션을 여세요.',
    failed: '도큐먼트를 읽을 수 없습니다: ',
    steps: '단계',
    none: '시작하려면 단계를 추가하세요.',
    add: '단계 추가',
    kindOfStep: '단계 유형',
    remove: (n: number, kind: string) => `${n}단계 삭제: ${kind}`,
    kinds: {
      rename: '이름 변경 또는 이동',
      flatten: '객체 평탄화',
      nest: '객체로 중첩',
      convert: '유형 변환',
      remove: '삭제',
      default: '없을 때 기본값',
      split: '텍스트를 목록으로 분할',
      join: '목록을 텍스트로 결합',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: '없거나 null일 때 기본값',
    field: '필드',
    to: '새 이름 (a.b는 객체 안으로 이동)',
    into: '대상',
    fields: '필드',
    picked: (n: number, of: number) => `선택됨: ${n} / ${of}`,
    noFields: '제안할 필드가 없습니다.',
    separator: '구분자',
    type: '대상 유형',
    onError: '변환할 수 없는 값',
    onErrors: { null: 'null이 됨', keep: '그대로 유지됨' },
    value: '값',
    valueKind: '값 유형',
    valueKinds: { text: '텍스트', number: '숫자', true: 'true', false: 'false', null: 'null' },
    when: '필드가 다음일 때 채우기',
    whens: { missing: '없음', missingOrNull: '없거나 null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: '여기의 이름은 필드 이름으로 쓸 수 없습니다 (이름에 $는 사용할 수 없음).',
      id: '_id는 이름을 변경하거나 이동하거나 삭제할 수 없습니다.',
      same: '필드를 자기 자신 안으로 이동할 수 없습니다.',
      overlap: '필드와 그 안의 필드를 함께 중첩할 수 없습니다.',
      empty: '필드를 하나 이상 선택하세요.',
      separator: '구분자를 입력하세요. 평탄화의 구분자에는 . 또는 $를 쓸 수 없습니다.',
      hidden: '이 단계는 개인 데이터로 숨겨진 필드를 건드리게 됩니다.',
      duplicate: '여기의 두 필드가 같은 이름으로 끝납니다. 하나가 사라집니다.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name}: 이미 있는 필드입니다. 값이 대체됩니다.`,
    each: (name: string) => `${name}: 목록입니다. 값이 목록의 각 도큐먼트에 설정됩니다.`,
    leftOut: (n: number) => `문제가 있는 ${n}개 단계는 스테이지에서 제외됩니다.`,
    incomplete: (n: number) => `${n}개 단계가 아직 완료되지 않았습니다.`,
    notShown: `표시되지 않음: 이 단계들은 미리 보기가 처리할 수 있는 스테이지 수(${MAX_STAGES})보다 많은 스테이지를 만듭니다.`,
    hiddenUnknown:
      '개인 데이터로 숨겨진 필드를 제때 확인하지 못했습니다. 확인될 때까지 필드를 제안하지 않습니다.',
    retry: '다시 시도',
    tooMany: (n: number) =>
      `이 단계들은 스테이지 ${n}개를 만듭니다. 미리 보기와 집계 전달은 최대 ${MAX_STAGES}개까지 가능합니다. 일부 단계를 삭제하세요.`,
    hiddenNote: '개인 데이터로 숨겨진 필드와 이를 포함한 객체는 제안되지 않습니다.',
    preview: '미리 보기',
    before: '이전',
    after: '이후',
    noPreview: '미리 보기를 만들 수 없습니다: ',
    stages: '스테이지',
    copy: '스테이지 복사',
    copied: '스테이지를 복사했습니다.',
    use: '집계에서 사용',
    handed:
      '집계에서: 결과를 새 컬렉션에 쓰려면 컬렉션 이름을 지정한 $out 스테이지를 추가하세요. 집계가 쓰기 동작을 보여 주고 먼저 확인합니다.',
  },
  de: {
    title: 'Umformen',
    description: (coll: string) =>
      `Felder von ${coll} umbenennen, verflachen, verschachteln, konvertieren oder entfernen: Die Vorschau erscheint hier, danach geht es an Aggregationen — ${coll} selbst wird nie geändert.`,
    reading: 'Felder werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um ihre Dokumente umzuformen.',
    failed: 'Die Dokumente konnten nicht gelesen werden: ',
    steps: 'Schritte',
    none: 'Fügen Sie einen Schritt hinzu, um zu beginnen.',
    add: 'Schritt hinzufügen',
    kindOfStep: 'Schrittart',
    remove: (n: number, kind: string) => `Schritt ${n} entfernen: ${kind}`,
    kinds: {
      rename: 'Umbenennen oder verschieben',
      flatten: 'Objekt verflachen',
      nest: 'In ein Objekt verschachteln',
      convert: 'Typ konvertieren',
      remove: 'Entfernen',
      default: 'Standardwert, wenn fehlend',
      split: 'Text in eine Liste aufteilen',
      join: 'Liste zu Text verbinden',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Standardwert, wenn fehlend oder null',
    field: 'Feld',
    to: 'Neuer Name (a.b verschiebt es in ein Objekt)',
    into: 'Ziel',
    fields: 'Felder',
    picked: (n: number, of: number) => `Ausgewählt: ${n} von ${of}`,
    noFields: 'Kein Feld zur Auswahl.',
    separator: 'Trennzeichen',
    type: 'Zieltyp',
    onError: 'Ein Wert, der sich nicht konvertieren lässt',
    onErrors: { null: 'wird zu null', keep: 'bleibt erhalten' },
    value: 'Wert',
    valueKind: 'Werttyp',
    valueKinds: { text: 'Text', number: 'Zahl', true: 'true', false: 'false', null: 'null' },
    when: 'Füllen, wenn das Feld',
    whens: { missing: 'fehlt', missingOrNull: 'fehlt oder null ist' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'Ein Name hier ist als Feldname nicht zulässig ($ ist in einem Namen nicht erlaubt).',
      id: '_id kann nicht umbenannt, verschoben oder entfernt werden.',
      same: 'Ein Feld kann nicht in sich selbst verschoben werden.',
      overlap: 'Ein Feld und ein Feld darin können nicht beide verschachtelt werden.',
      empty: 'Wählen Sie mindestens ein Feld aus.',
      separator:
        'Geben Sie ein Trennzeichen an; das Trennzeichen beim Verflachen darf weder . noch $ enthalten.',
      hidden: 'Dieser Schritt würde ein Feld berühren, das Ihnen als personenbezogene Daten verborgen ist.',
      duplicate: 'Zwei Felder hier enden auf denselben Namen: Eines ginge verloren.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} ist bereits vorhanden: Der Wert wird ersetzt.`,
    each: (name: string) => `${name} ist eine Liste: Der Wert wird in jedem ihrer Dokumente gesetzt.`,
    leftOut: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? '1 Schritt mit einem Problem wird in den Stages ausgelassen.'
        : `${n} Schritte mit einem Problem werden in den Stages ausgelassen.`,
    incomplete: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? '1 Schritt ist noch nicht fertig.'
        : `${n} Schritte sind noch nicht fertig.`,
    notShown: `Nicht angezeigt: Diese Schritte erzeugen mehr Stages, als eine Vorschau aufnimmt (${MAX_STAGES}).`,
    hiddenUnknown:
      'Welche Felder Ihnen als personenbezogene Daten verborgen sind, ließ sich nicht rechtzeitig ermitteln: Bis dahin wird kein Feld angeboten.',
    retry: 'Erneut versuchen',
    tooMany: (n: number) =>
      `Diese Schritte erzeugen ${n} Stages: Höchstens ${MAX_STAGES} lassen sich in der Vorschau anzeigen und an Aggregationen übergeben. Entfernen Sie einige Schritte.`,
    hiddenNote:
      'Felder, die Ihnen als personenbezogene Daten verborgen sind, und die Objekte, die sie enthalten, werden nicht angeboten.',
    preview: 'Vorschau',
    before: 'Vorher',
    after: 'Nachher',
    noPreview: 'Die Vorschau konnte nicht erstellt werden: ',
    stages: 'Stages',
    copy: 'Stages kopieren',
    copied: 'Die Stages wurden kopiert.',
    use: 'In Aggregationen verwenden',
    handed:
      'In Aggregationen: Um das Ergebnis in eine neue Collection zu schreiben, fügen Sie eine $out-Stage mit deren Namen hinzu; Aggregationen zeigt, was das Schreiben bewirken würde, und fragt vorher nach.',
  },
  fr: {
    title: 'Remodeler',
    description: (coll: string) =>
      `Renommez, aplatissez, imbriquez, convertissez ou supprimez les champs de ${coll} : l’aperçu s’affiche ici, puis est transmis à Agrégations — rien n’est jamais modifié dans ${coll}.`,
    reading: 'Lecture des champs…',
    noPlace: 'Ouvrez une collection pour remodeler ses documents.',
    failed: 'Impossible de lire les documents : ',
    steps: 'Opérations',
    none: 'Ajoutez une opération pour commencer.',
    add: 'Ajouter une opération',
    kindOfStep: 'Type d’opération',
    remove: (n: number, kind: string) => `Supprimer l’opération ${n} : ${kind}`,
    kinds: {
      rename: 'Renommer ou déplacer',
      flatten: 'Aplatir un objet',
      nest: 'Imbriquer dans un objet',
      convert: 'Convertir le type',
      remove: 'Supprimer',
      default: 'Valeur par défaut si absent',
      split: 'Scinder un texte en liste',
      join: 'Joindre une liste en texte',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Valeur par défaut si absent ou null',
    field: 'Champ',
    to: 'Nouveau nom (a.b le déplace dans un objet)',
    into: 'Destination',
    fields: 'Champs',
    picked: (n: number, of: number) => `Sélection : ${n} sur ${of}`,
    noFields: 'Aucun champ à proposer.',
    separator: 'Séparateur',
    type: 'Type cible',
    onError: 'Une valeur qui ne peut pas être convertie',
    onErrors: { null: 'devient null', keep: 'est conservée' },
    value: 'Valeur',
    valueKind: 'Type de valeur',
    valueKinds: { text: 'texte', number: 'nombre', true: 'true', false: 'false', null: 'null' },
    when: 'Remplir si le champ est',
    whens: { missing: 'absent', missingOrNull: 'absent ou null' } satisfies Record<DefaultWhen, string>,
    problems: {
      incomplete: '',
      name: 'Un nom ici ne peut pas être celui d’un champ ($ n’est pas autorisé dans un nom).',
      id: '_id ne peut être ni renommé, ni déplacé, ni supprimé.',
      same: 'Un champ ne peut pas être déplacé à l’intérieur de lui-même.',
      overlap: 'Un champ et un champ qu’il contient ne peuvent pas être imbriqués ensemble.',
      empty: 'Sélectionnez au moins un champ.',
      separator: 'Indiquez un séparateur ; celui d’un aplatissement ne peut contenir ni . ni $.',
      hidden: 'Cette opération toucherait un champ qui vous est masqué comme donnée personnelle.',
      duplicate: 'Deux champs ici se terminent par le même nom : l’un serait perdu.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} existe déjà : sa valeur est remplacée.`,
    each: (name: string) => `${name} est une liste : la valeur est définie dans chacun de ses documents.`,
    leftOut: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `${n} opération avec un problème est exclue des étapes.`
        : `${n} opérations avec un problème sont exclues des étapes.`,
    incomplete: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? `${n} opération n’est pas encore terminée.`
        : `${n} opérations ne sont pas encore terminées.`,
    notShown: `Non affiché : ces opérations produisent plus d’étapes qu’un aperçu n’en accepte (${MAX_STAGES}).`,
    hiddenUnknown:
      'Impossible de déterminer à temps quels champs vous sont masqués comme données personnelles : aucun champ n’est proposé d’ici là.',
    retry: 'Réessayer',
    tooMany: (n: number) =>
      `Ces opérations produisent ${n} étapes : au plus ${MAX_STAGES} peuvent être prévisualisées et transmises à Agrégations. Supprimez quelques opérations.`,
    hiddenNote:
      'Les champs qui vous sont masqués comme données personnelles, ainsi que les objets qui les contiennent, ne sont pas proposés.',
    preview: 'Aperçu',
    before: 'Avant',
    after: 'Après',
    noPreview: 'Impossible de générer l’aperçu : ',
    stages: 'Étapes',
    copy: 'Copier les étapes',
    copied: 'Les étapes ont été copiées.',
    use: 'Utiliser dans Agrégations',
    handed:
      'Dans Agrégations : pour écrire le résultat dans une nouvelle collection, ajoutez une étape $out qui la nomme ; Agrégations montre ce que l’écriture ferait et vous demande d’abord.',
  },
  ru: {
    title: 'Реструктуризация',
    description: (coll: string) =>
      `Переименуйте, разверните, вложите, преобразуйте или удалите поля коллекции ${coll}: предпросмотр здесь, затем передача в Агрегации — ${coll} никогда не изменяется.`,
    reading: 'Чтение полей…',
    noPlace: 'Откройте коллекцию, чтобы изменить структуру ее документов.',
    failed: 'Не удалось прочитать документы: ',
    steps: 'Шаги',
    none: 'Добавьте шаг, чтобы начать.',
    add: 'Добавить шаг',
    kindOfStep: 'Тип шага',
    remove: (n: number, kind: string) => `Удалить шаг ${n}: ${kind}`,
    kinds: {
      rename: 'Переименовать или переместить',
      flatten: 'Развернуть объект',
      nest: 'Вложить в объект',
      convert: 'Преобразовать тип',
      remove: 'Удалить',
      default: 'Значение по умолчанию, если нет',
      split: 'Разбить текст на список',
      join: 'Объединить список в текст',
    } satisfies Record<OperationKind, string>,
    defaultOrNull: 'Значение по умолчанию, если поля нет или оно null',
    field: 'Поле',
    to: 'Новое имя (a.b перемещает поле в объект)',
    into: 'Куда',
    fields: 'Поля',
    picked: (n: number, of: number) => `Выбрано: ${n} из ${of}`,
    noFields: 'Нет полей для выбора.',
    separator: 'Разделитель',
    type: 'В тип',
    onError: 'Значение, которое нельзя преобразовать',
    onErrors: { null: 'становится null', keep: 'сохраняется' },
    value: 'Значение',
    valueKind: 'Тип значения',
    valueKinds: { text: 'текст', number: 'число', true: 'true', false: 'false', null: 'null' },
    when: 'Заполнять, если поле',
    whens: { missing: 'отсутствует', missingOrNull: 'отсутствует или равно null' } satisfies Record<
      DefaultWhen,
      string
    >,
    problems: {
      incomplete: '',
      name: 'Недопустимое имя поля ($ в имени не разрешен).',
      id: '_id нельзя переименовать, переместить или удалить.',
      same: 'Поле нельзя переместить в само себя.',
      overlap: 'Поле и поле внутри него нельзя вложить вместе.',
      empty: 'Выберите хотя бы одно поле.',
      separator: 'Укажите разделитель; в разделителе для разворачивания нельзя использовать . и $.',
      hidden: 'Этот шаг затронул бы поле, скрытое от вас как персональные данные.',
      duplicate: 'Два поля здесь заканчиваются одним и тем же именем: одно будет потеряно.',
    } satisfies Record<Problem, string>,
    clash: (name: string) => `${name} уже существует: его значение заменяется.`,
    each: (name: string) => `${name} — это список: значение задается в каждом его документе.`,
    leftOut: (n: number) =>
      ruForms(n, {
        one: `${n} шаг с проблемой исключен из стадий.`,
        few: `${n} шага с проблемой исключены из стадий.`,
        many: `${n} шагов с проблемой исключены из стадий.`,
      }),
    incomplete: (n: number) =>
      ruForms(n, {
        one: `${n} шаг еще не завершен.`,
        few: `${n} шага еще не завершены.`,
        many: `${n} шагов еще не завершены.`,
      }),
    notShown: `Не показано: эти шаги создают больше стадий, чем помещается в предпросмотр (${MAX_STAGES}).`,
    hiddenUnknown:
      'Не удалось вовремя определить, какие поля скрыты от вас как персональные данные: пока это не выяснено, поля не предлагаются.',
    retry: 'Повторить',
    tooMany: (n: number) =>
      `Эти шаги создают ${n} ${ruForms(n, { one: 'стадию', few: 'стадии', many: 'стадий' })}: в предпросмотре и при передаче в Агрегации допускается не более ${MAX_STAGES}. Удалите часть шагов.`,
    hiddenNote: 'Поля, скрытые от вас как персональные данные, и содержащие их объекты не предлагаются.',
    preview: 'Предпросмотр',
    before: 'До',
    after: 'После',
    noPreview: 'Не удалось создать предпросмотр: ',
    stages: 'Стадии',
    copy: 'Копировать стадии',
    copied: 'Стадии скопированы.',
    use: 'Использовать в Агрегациях',
    handed:
      'В Агрегациях: чтобы записать результат в новую коллекцию, добавьте стадию $out с ее именем; Агрегации покажут, что сделает запись, и сначала спросят вас.',
  },
} satisfies Record<Language, Text>

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let shape: FieldShape[] = []
  let guard: HiddenGuard = () => false
  let sample: Doc[] = []
  const ops: Operation[] = []
  /** The preview's documents, before (when they came from the preview itself) and after. */
  let before: Doc[] | null = null
  let after: Doc[] | null = null
  let previewError: unknown = null
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' = 'reading'
  let failure: unknown = null
  let note: { tone: 'success' | 'danger' | 'declined'; text: string } | null = null
  /** Second review 6: what is hidden could not be told — every field is taken as hidden meanwhile. */
  let hiddenUnknown = false

  const header = pageHeader({ icon: 'shapes', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body rs-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  // Parts redrawn on their own.
  const stepsBox = h('div', { class: 'rs-steps-box' })
  const previewBox = h('div', { class: 'rs-preview-box' })
  const stagesPre = h('pre', { class: 'mm-mono rs-docs', id: 'stages' })
  const messagesBox = h('div', { class: 'rs-messages-box' })
  let copyButton: HTMLButtonElement | null = null
  let useButton: HTMLButtonElement | null = null

  /** The fields a step may name: not hidden nor holding a hidden one, not _id, not in an array. */
  const usable = (f: FieldShape) =>
    !f.hidden &&
    f.path !== '_id' &&
    !f.path.startsWith('_id.') &&
    !f.path.includes('[]') &&
    !guard(f.path, 'source')
  /** The fields directly under an object field, none hidden. */
  const childrenOf = (path: string) =>
    shape
      .filter(
        (f) => !f.hidden && f.path.startsWith(`${path}.`) && !f.path.slice(path.length + 1).includes('.'),
      )
      .map((f) => f.path.slice(path.length + 1))
  const fields = () => shape.filter(usable).map((f) => f.path)
  const objects = () => shape.filter((f) => usable(f) && childrenOf(f.path).length > 0).map((f) => f.path)
  const problem = (op: Operation) => problemOf(op, guard)
  /** A step's name, a default's by when it fills (second review 15). */
  const kindLabel = (op: Operation) =>
    op.kind === 'default' && op.when === 'missingOrNull' ? text.defaultOrNull : text.kinds[op.kind]
  const currentStages = () => stagesOf(ops, guard)

  function fresh(kind: OperationKind): Operation {
    const first = fields()[0] ?? ''
    switch (kind) {
      case 'rename':
        return { kind, from: first, to: '' }
      case 'flatten': {
        const path = objects()[0] ?? ''
        return { kind, path, keys: childrenOf(path), separator: '_' }
      }
      case 'nest':
        return { kind, fields: [], into: '' }
      case 'convert':
        return { kind, path: first, to: 'string', onError: 'null' }
      case 'remove':
        return { kind, path: first }
      case 'default':
        return { kind, path: first, value: '', when: 'missing' }
      case 'split':
        return { kind, path: first, separator: ',' }
      case 'join':
        return { kind, path: first, separator: ', ' }
    }
  }

  // ── The preview: after the edits stop, one at a time, then once more with the latest steps.
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  const schedulePreview = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void runPreview(), PREVIEW_DELAY)
  }
  async function runPreview(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    previewBox.setAttribute('aria-busy', 'true')
    try {
      do {
        again = false
        await previewOnce()
      } while (again)
    } finally {
      running = false
      previewBox.setAttribute('aria-busy', 'false')
    }
    renderPreview()
  }
  /** Before and after of the same sampled documents: the stages run on them, read-only. */
  async function previewOnce(): Promise<void> {
    const stages = currentStages()
    const docs = sample.slice(0, PREVIEW)
    before = null
    if (!stages.length || !docs.length || stages.length > MAX_STAGES) {
      after = null
      previewError = null
      return
    }
    try {
      if (docs.every((d) => d._id !== undefined)) {
        // User report 2026-11-07: large documents come as many as fit in one answer (`fit`).
        const result = await client.ask<{ documents: Doc[]; cut?: boolean }>('documents.aggregate', {
          pipeline: [{ $match: { _id: { $in: docs.map((d) => d._id) } } }, ...stages],
          limit: PREVIEW,
          fit: true,
        })
        // In the order of "before".
        const byId = new Map(result.documents.map((d) => [JSON.stringify(d._id), d]))
        if (result.cut) {
          // Only the documents that came, each beside itself — never an empty "after".
          before = docs.filter((d) => byId.has(JSON.stringify(d._id)))
          after = before.map((d) => byId.get(JSON.stringify(d._id))!)
        } else after = docs.map((d) => byId.get(JSON.stringify(d._id)) ?? {})
      } else {
        // No _id to find them by (a view may leave it out): the same documents before and after,
        // from one read (review 30).
        const result = await client.ask<{ documents: Array<{ before?: Doc[]; after?: Doc[] }> }>(
          'documents.aggregate',
          { pipeline: [{ $limit: PREVIEW }, { $facet: { before: [], after: stages } }], limit: 1 },
        )
        before = result.documents[0]?.before ?? []
        after = result.documents[0]?.after ?? []
      }
      previewError = null
    } catch (e) {
      after = null
      previewError = e
    }
  }

  // ── Focus: kept on the control the user is on when a part is drawn again (review 29).
  const focusKey = () => {
    const el = document.activeElement
    return el instanceof HTMLElement && root.contains(el) ? (el.dataset.focus ?? null) : null
  }
  const focusOn = (key: string | null) => {
    if (!key) return
    root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus()
  }
  const keyed = <T extends HTMLElement>(el: T, key: string): T => {
    el.dataset.focus = key
    return el
  }

  /** A step's control changed: its messages, the stages and (later) the preview follow. */
  function edited(li: HTMLElement, op: Operation, i: number, redraw = false): void {
    note = null
    if (redraw) {
      const key = focusKey()
      li.replaceWith(editor(op, i))
      focusOn(key)
    } else messagesOf(li, op)
    renderOutputs()
    schedulePreview()
  }

  function editor(op: Operation, i: number): HTMLElement {
    const controls: HTMLElement[] = []
    const li = h('li', { class: 'mm-card mm-card-pad rs-step', data: { step: op.kind } })
    let n = 0
    const key = () => `${i}:${n++}`
    const select = <T extends string>(
      label: string,
      options: Array<{ value: T; label: string }>,
      value: T,
      set: (v: T) => void,
      redraw = false,
    ) => {
      const el = keyed(h('select', { class: 'mm-select', attrs: { 'aria-label': label } }), key())
      for (const o of options) el.append(h('option', { attrs: { value: o.value }, text: o.label }))
      el.value = value
      el.addEventListener('change', () => {
        set(el.value as T)
        edited(li, op, i, redraw)
      })
      return h('label', { class: 'mm-field' }, h('span', { class: 'mm-label', text: label }), el)
    }
    const input = (label: string, value: string, set: (v: string) => void) => {
      const el = keyed(
        h('input', { class: 'mm-input', attrs: { type: 'text', 'aria-label': label, maxlength: '200' } }),
        key(),
      )
      el.value = value
      el.addEventListener('change', () => {
        set(el.value)
        edited(li, op, i)
      })
      return h('label', { class: 'mm-field' }, h('span', { class: 'mm-label', text: label }), el)
    }
    const fieldOptions = (list: string[]) => list.map((f) => ({ value: f, label: f }))

    switch (op.kind) {
      case 'rename':
        controls.push(
          select(text.field, fieldOptions(fields()), op.from, (v) => (op.from = v)),
          input(text.to, op.to, (v) => (op.to = v.trim())),
        )
        break
      case 'flatten':
        controls.push(
          select(text.field, fieldOptions(objects()), op.path, (v) => {
            op.path = v
            op.keys = childrenOf(v)
          }),
          input(text.separator, op.separator, (v) => (op.separator = v)),
        )
        break
      case 'nest': {
        // 2026-10-26 (user report): checkboxes, not a select of several squeezed into a select box.
        const offered = fields()
        const boxes = offered.map((f) => {
          const box = keyed(h('input', { attrs: { type: 'checkbox', value: f } }), `${i}:pick:${f}`)
          box.checked = op.fields.includes(f)
          return box
        })
        const picked = h('p', { class: 'mm-subtle rs-pick-count', data: { picked: '' } })
        const count = () => (picked.textContent = text.picked(op.fields.length, offered.length))
        for (const box of boxes)
          box.addEventListener('change', () => {
            // In the order offered, as a select of several gave them.
            op.fields = boxes.filter((b) => b.checked).map((b) => b.value)
            count()
            edited(li, op, i)
          })
        count()
        controls.push(
          h(
            'fieldset',
            { class: 'mm-field rs-pick' },
            h('legend', { class: 'mm-label', text: text.fields }),
            boxes.length
              ? h(
                  'div',
                  { class: 'rs-pick-list' },
                  ...boxes.map((box) =>
                    h(
                      'label',
                      { class: 'rs-pick-row' },
                      box,
                      // A long name is cut short in its row: whole in its tooltip.
                      h('span', { class: 'mm-mono', title: box.value, text: box.value }),
                    ),
                  ),
                )
              : h('p', { class: 'mm-subtle rs-pick-none', data: { noFields: '' }, text: text.noFields }),
            ...(boxes.length ? [picked] : []),
          ),
          input(text.into, op.into, (v) => (op.into = v.trim())),
        )
        break
      }
      case 'convert':
        controls.push(
          select(text.field, fieldOptions(fields()), op.path, (v) => (op.path = v)),
          select(
            text.type,
            CONVERT_TO.map((v) => ({ value: v, label: v })),
            op.to,
            (v) => (op.to = v),
          ),
          select(
            text.onError,
            (['null', 'keep'] as const).map((v) => ({ value: v, label: text.onErrors[v] })),
            op.onError,
            (v) => (op.onError = v),
          ),
        )
        break
      case 'remove':
        controls.push(select(text.field, fieldOptions(fields()), op.path, (v) => (op.path = v)))
        break
      case 'default': {
        const kindOf = (v: unknown) =>
          v === null
            ? 'null'
            : v === true
              ? 'true'
              : v === false
                ? 'false'
                : typeof v === 'number'
                  ? 'number'
                  : 'text'
        const valueKind = kindOf(op.value)
        controls.push(
          select(text.field, fieldOptions(fields()), op.path, (v) => (op.path = v)),
          // A kind with a value of its own adds or removes the value's box: the step is drawn again.
          select(
            text.valueKind,
            (['text', 'number', 'true', 'false', 'null'] as const).map((v) => ({
              value: v,
              label: text.valueKinds[v],
            })),
            valueKind,
            (v) =>
              (op.value =
                v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v === 'number' ? 0 : ''),
            true,
          ),
          select(
            text.when,
            (['missing', 'missingOrNull'] as const).map((v) => ({ value: v, label: text.whens[v] })),
            op.when,
            (v) => (op.when = v),
            // Its name says when it fills: the step is drawn again.
            true,
          ),
        )
        if (valueKind === 'text' || valueKind === 'number')
          controls.push(
            input(text.value, String(op.value ?? ''), (v) => {
              if (valueKind === 'number') {
                const num = Number(v)
                op.value = Number.isFinite(num) ? num : 0
              } else op.value = v
            }),
          )
        break
      }
      case 'split':
      case 'join':
        controls.push(
          select(text.field, fieldOptions(fields()), op.path, (v) => (op.path = v)),
          input(text.separator, op.separator, (v) => (op.separator = v)),
        )
        break
    }
    const remove = keyed(
      button({
        label: text.remove(i + 1, kindLabel(op)),
        icon: 'trash',
        iconOnly: true,
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          ops.splice(i, 1)
          note = null
          renderSteps()
          // On to the next step's Remove, else to the kind of a new step.
          focusOn(ops[i] ? `${i}:remove` : 'kind')
          renderOutputs()
          schedulePreview()
        },
      }),
      `${i}:remove`,
    )
    li.append(
      h(
        'div',
        { class: 'rs-step-head' },
        h('strong', { text: `${i + 1}. ${kindLabel(op)}` }),
        h('span', { class: 'mm-spacer' }),
        remove,
      ),
      h('div', { class: 'rs-controls' }, ...controls),
      h('div', { class: 'rs-messages', attrs: { 'aria-live': 'polite' } }),
    )
    messagesOf(li, op)
    return li
  }

  /** What is wrong with a step, or what it writes over. */
  function messagesOf(li: HTMLElement, op: Operation): void {
    const box = li.querySelector('.rs-messages')!
    const p = problem(op)
    box.replaceChildren(
      ...(p === 'incomplete'
        ? []
        : p
          ? [h('p', { class: 'rs-problem', data: { problem: p }, text: text.problems[p] })]
          : clashesOf(op, shape).map((c) =>
              h('p', {
                class: 'rs-clash',
                data: { clash: c.path },
                text: c.how === 'each' ? text.each(c.path) : text.clash(c.path),
              }),
            )),
    )
  }

  function renderSteps(): void {
    stepsBox.replaceChildren(
      ops.length
        ? h('ol', { class: 'rs-steps', id: 'steps' }, ...ops.map(editor))
        : h('p', { class: 'mm-subtle', text: text.none }),
    )
  }

  /** The stages, what is left out of them, the note and the buttons. */
  function renderOutputs(): void {
    const stages = currentStages()
    stagesPre.textContent = JSON.stringify(stages, null, 2)
    const problems = ops.map(problem)
    const leftOut = problems.filter((p) => p !== null && p !== 'incomplete').length
    const unfinished = problems.filter((p) => p === 'incomplete').length
    const tooMany = stages.length > MAX_STAGES
    messagesBox.replaceChildren(
      ...(leftOut ? [h('p', { class: 'mm-subtle', id: 'left-out', text: text.leftOut(leftOut) })] : []),
      ...(unfinished
        ? [h('p', { class: 'mm-subtle', id: 'incomplete', text: text.incomplete(unfinished) })]
        : []),
      ...(tooMany
        ? [h('div', { data: { tooMany: '' } }, callout('warning', text.tooMany(stages.length)))]
        : []),
      ...(note
        ? [
            note.tone === 'declined'
              ? h('div', { data: { note: 'declined' } }, callout('info', note.text))
              : callout(note.tone === 'success' ? 'info' : 'danger', note.text),
          ]
        : []),
    )
    if (copyButton) copyButton.disabled = !stages.length || tooMany
    if (useButton) useButton.disabled = !stages.length || tooMany
  }

  function renderPreview(): void {
    const shownBefore = before ?? sample.slice(0, PREVIEW)
    const capped = currentStages().length > MAX_STAGES
    previewBox.replaceChildren(
      previewError
        ? callout('danger', `${text.noPreview}${askMessage(previewError, locale)}`)
        : h(
            'div',
            { class: 'rs-preview', id: 'preview' },
            h(
              'div',
              {},
              h('h3', { class: 'mm-label', text: text.before }),
              h('pre', {
                class: 'mm-mono rs-docs',
                id: 'before',
                text: shownBefore.map((d) => shellText(d)).join('\n\n'),
              }),
            ),
            h(
              'div',
              {},
              h('h3', { class: 'mm-label', text: text.after }),
              h('pre', {
                class: 'mm-mono rs-docs',
                id: 'after',
                text: capped ? text.notShown : (after ?? shownBefore).map((d) => shellText(d)).join('\n\n'),
              }),
            ),
          ),
    )
  }

  async function use(b: HTMLButtonElement): Promise<void> {
    b.disabled = true
    try {
      await client.ask('ui.useAggregation', { stages: currentStages() })
      note = { tone: 'success', text: text.handed }
    } catch (e) {
      // The user kept the pipeline there: said, never as a failure (second review 4).
      note = {
        tone: e instanceof AskError && e.code === 'declined' ? 'declined' : 'danger',
        text: askMessage(e, locale),
      }
    }
    renderOutputs()
  }

  function copy(): void {
    // Asked at once, in the click: the app takes a copy only right after one.
    client
      .ask('ui.copy', { text: JSON.stringify(currentStages(), null, 2) })
      .then(() => (note = { tone: 'success', text: text.copied }))
      .catch(
        (e: unknown) =>
          (note = {
            tone: e instanceof AskError && e.code === 'declined' ? 'declined' : 'danger',
            text: askMessage(e, locale),
          }),
      )
      .finally(renderOutputs)
  }

  function render(): void {
    const key = focusKey()
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    body.replaceChildren()
    status.textContent = ''
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'shapes', title: text.noPlace }))
    if (phase === 'reading') {
      status.textContent = text.reading
      return void body.append(skeleton(5))
    }
    if (phase === 'failed')
      return void body.append(callout('danger', `${text.failed}${askMessage(failure, locale)}`))
    const kind = keyed(
      h('select', { id: 'kind', class: 'mm-select', attrs: { 'aria-label': text.kindOfStep } }),
      'kind',
    )
    for (const k of KINDS) kind.append(h('option', { attrs: { value: k }, text: text.kinds[k] }))
    const add = keyed(
      button({
        label: text.add,
        icon: 'plus',
        id: 'add-step',
        onClick: () => {
          ops.push(fresh(kind.value as OperationKind))
          note = null
          renderSteps()
          renderOutputs()
          schedulePreview()
        },
      }),
      'add',
    )
    const useB: HTMLButtonElement = keyed(
      button({
        label: text.use,
        icon: 'external',
        variant: 'primary',
        id: 'use',
        onClick: () => void use(useB),
      }),
      'use',
    )
    useButton = useB
    copyButton = keyed(button({ label: text.copy, icon: 'copy', id: 'copy', onClick: copy }), 'copy')
    // A field hidden in the sample, or one a rule keeps out (second review 15).
    const hiddenCount = shape.filter(
      (f) => f.hidden || (f.path !== '_id' && !f.path.includes('[]') && guard(f.path, 'source')),
    ).length
    const retry = keyed(
      button({
        label: text.retry,
        icon: 'refresh',
        id: 'hidden-retry',
        onClick: () => void tell(),
      }),
      'retry',
    )
    renderSteps()
    renderPreview()
    renderOutputs()
    body.append(
      ...(hiddenUnknown
        ? [
            h(
              'div',
              { data: { hiddenUnknown: '' } },
              callout('warning', text.hiddenUnknown, undefined, retry),
            ),
          ]
        : []),
      h('h2', { class: 'mm-section-title', text: text.steps }),
      stepsBox,
      h('div', { class: 'rs-add' }, kind, add),
      ...(hiddenCount ? [h('p', { class: 'mm-subtle', text: text.hiddenNote })] : []),
      h('h2', { class: 'mm-section-title', text: text.preview }),
      previewBox,
      h('h2', { class: 'mm-section-title', text: text.stages }),
      stagesPre,
      messagesBox,
      h('div', { class: 'rs-actions' }, copyButton, useButton),
    )
    focusOn(key)
  }

  /**
   * The fields as the sample shows them, and what a step may name. Second review 6: when what is
   * hidden could not be told (null), every field is taken as hidden until it can.
   */
  function learn(hidden: string[][] | null | undefined): void {
    hiddenUnknown = hidden === null
    const patterns = hidden === null ? [['**']] : (hidden ?? [])
    shape = shapeOf(sample, patterns)
    guard = hiddenGuard(patterns, shape)
  }
  /**
   * Asks the app again what is hidden (Try again). Third review 15: the focus stays on Try again
   * while it is there, else goes to the step kind; the preview is made again with what is known.
   */
  async function tell(): Promise<void> {
    try {
      const next = await client.ask<PluginContext>('context.get')
      if (next.place) learn(next.place.hidden)
    } catch {
      // Still unknown: the callout stays.
    }
    const wasOn = focusKey()
    render()
    renderOutputs()
    if (wasOn === 'retry' && !root.querySelector('[data-focus="retry"]')) focusOn('kind')
    schedulePreview()
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
      if (!ctx.place) {
        phase = 'noPlace'
        return render()
      }
      render()
      // User report 2026-11-07: of large documents (API logs), as many as fit in one answer.
      sample = (await client.ask<{ documents: Doc[] }>('documents.find', { limit: SAMPLE, fit: true }))
        .documents
      learn(ctx.place.hidden)
      phase = 'ready'
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  })
  render()
}
