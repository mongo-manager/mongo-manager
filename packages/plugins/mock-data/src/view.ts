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
import { shapeOf } from '../../kit/src/shape'
import {
  DATA_LANGUAGES,
  dataLanguageOf,
  fitsOneMessage,
  generate,
  MAX_CHARS,
  MAX_COUNT,
  MESSAGE_BYTES,
  PREVIEW,
  previewDocs,
  sentSize,
  toNdjson,
  type Settings,
} from './generate'
import { plansOf, templateFor, type FieldPlan } from './plan'
import { shellText } from '../../kit/src/shell'
import { GROUPS, TEMPLATES, type Group } from './templates'

/**
 * Plugins wave 3 (spec §3): test documents shaped like the collection's. Its fields are read from a
 * sample; each gets test values from a template the user may change; the documents go to the app's
 * Import wizard, where the user checks and starts the import. The plugin itself writes nothing.
 */
const SAMPLE = 100

/** Russian counts a document in three forms (one 1, 21; few 2-4, 22-24; many 0, 5-20, decimals). */
const RU_DOCUMENTS: Record<Intl.LDMLPluralRule, string> = {
  zero: 'документов',
  one: 'документ',
  two: 'документа',
  few: 'документа',
  many: 'документов',
  other: 'документов',
}

const TABLE = {
  en: {
    title: 'Test data',
    description: (coll: string) =>
      `Realistic test documents shaped like those of ${coll}, imported when you say so.`,
    reading: 'Reading the fields…',
    noPlace: 'Open a collection to make test data for it.',
    view: 'A view holds no documents of its own: open its collection to make test data.',
    fields: 'Fields',
    include: 'Include',
    field: 'Field',
    seen: 'Seen as',
    template: 'Test values',
    constant: 'Text',
    hidden: 'hidden',
    hiddenHint:
      'Hidden from you as personal data: its type is not known, so its test values are text until you pick others. The Import wizard leaves it out unless you include it there.',
    addField: 'Add a field',
    addFieldName: 'New field name (a.b for one inside another)',
    add: 'Add',
    count: 'Documents',
    blank: 'Left out (%)',
    lang: 'Words in',
    langs: {
      en: 'English',
      tr: 'Turkish',
      zh: 'Chinese',
      ja: 'Japanese',
      es: 'Spanish',
      pt: 'Portuguese',
      ko: 'Korean',
      de: 'German',
      fr: 'French',
      ru: 'Russian',
    },
    seed: 'Seed',
    newSeed: 'New seed',
    preview: 'Preview',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of ? (of === 1 ? 'The only document' : `All ${f(of)}`) : `The first ${f(n)} of ${f(of)}`,
    insert: 'Insert…',
    insertHint: 'Opens the Import wizard with these documents: check them there and start the import.',
    handed: 'Opened in the Import wizard: check the documents there and start the import.',
    download: 'Download JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `These documents are ${mb} MB as sent; one hand-off to the wizard takes at most ${chars} characters and ${limit} MB as sent: make fewer.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `These documents are ${mb} MB as sent; one download takes at most ${chars} characters and ${limit} MB as sent: make fewer.`,
    notPermitted:
      'You may not import into this collection: importing needs the rights to write documents and run jobs here.',
    notHanded: 'Not handed over.',
    notSaved: 'Not saved.',
    hiddenUnknown:
      'Which fields are hidden from you could not be told: every field is treated as hidden until you try again.',
    retry: 'Try again',
    badField:
      'Not added: a new field needs a name of its own — not _id, not one already listed or holding or inside one, and no $, bracket, space, empty part, __proto__, constructor or prototype.',
    badFieldArray: (list: string) =>
      `Not added: it would sit inside a list of documents (${list}), which the test documents make as a list — add it to the collection's documents first.`,
    noFields: 'No field to make: include one, or add one.',
    failed: 'The fields could not be read: ',
    groups: {
      person: 'Person',
      internet: 'Internet',
      location: 'Location',
      company: 'Company',
      commerce: 'Commerce',
      finance: 'Finance',
      date: 'Date and time',
      number: 'Number',
      text: 'Text',
      identifier: 'Identifier',
      boolean: 'True or false',
      other: 'Other',
    } satisfies Record<Group, string>,
  },
  tr: {
    title: 'Test verisi',
    description: (coll: string) =>
      `${coll} koleksiyonunun belgelerine benzeyen gerçekçi test belgeleri; siz isteyince içe aktarılır.`,
    reading: 'Alanlar okunuyor…',
    noPlace: 'Test verisi üretmek için bir koleksiyon açın.',
    view: 'Bir görünümün kendi belgeleri yoktur: test verisi için koleksiyonunu açın.',
    fields: 'Alanlar',
    include: 'Dahil',
    field: 'Alan',
    seen: 'Görülen tür',
    template: 'Test değerleri',
    constant: 'Metin',
    hidden: 'gizli',
    hiddenHint:
      'Kişisel veri olarak sizden gizli: türü bilinmiyor, bu yüzden test değerleri siz başkasını seçene dek metindir. İçe aktarma sihirbazı, orada dahil etmedikçe bu alanı dışarıda bırakır.',
    addField: 'Alan ekle',
    addFieldName: 'Yeni alan adı (biri içindeki için a.b)',
    add: 'Ekle',
    count: 'Belge sayısı',
    blank: 'Boş bırakılan (%)',
    lang: 'Sözcük dili',
    langs: {
      en: 'İngilizce',
      tr: 'Türkçe',
      zh: 'Çince',
      ja: 'Japonca',
      es: 'İspanyolca',
      pt: 'Portekizce',
      ko: 'Korece',
      de: 'Almanca',
      fr: 'Fransızca',
      ru: 'Rusça',
    },
    seed: 'Tohum',
    newSeed: 'Yeni tohum',
    preview: 'Önizleme',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of ? (of === 1 ? 'Tek belge' : `${f(of)} belgenin tümü`) : `${f(of)} belgenin ilk ${f(n)} tanesi`,
    insert: 'İçe aktar…',
    insertHint:
      'Bu belgelerle İçe aktarma sihirbazını açar: belgeleri orada kontrol edip içe aktarmayı başlatın.',
    handed: 'İçe aktarma sihirbazında açıldı: belgeleri orada kontrol edip içe aktarmayı başlatın.',
    download: 'JSON indir',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Bu belgeler gönderildiği hâliyle ${mb} MB; sihirbaza bir seferde en fazla ${chars} karakter ve gönderildiği hâliyle ${limit} MB verilir: daha az belge üretin.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Bu belgeler gönderildiği hâliyle ${mb} MB; bir indirme en fazla ${chars} karakter ve gönderildiği hâliyle ${limit} MB alır: daha az belge üretin.`,
    notPermitted:
      'Bu koleksiyona içe aktaramazsınız: içe aktarma için burada belge yazma ve iş çalıştırma yetkisi gerekir.',
    notHanded: 'Sihirbaza verilmedi.',
    notSaved: 'Kaydedilmedi.',
    hiddenUnknown:
      'Hangi alanların sizden gizlendiği anlaşılamadı: yeniden deneyene dek her alan gizli sayılır.',
    retry: 'Yeniden dene',
    badField:
      'Eklenmedi: yeni alanın kendine ait bir adı olmalı — _id değil, listedeki bir alan ya da onun içi veya üstü değil; $, köşeli ayraç, boşluk, boş parça, __proto__, constructor ya da prototype içermez.',
    badFieldArray: (list: string) =>
      `Eklenmedi: bir belge listesinin (${list}) içine düşer; test belgeleri onu liste olarak üretir — önce koleksiyonun belgelerine ekleyin.`,
    noFields: 'Üretilecek alan yok: birini dahil edin ya da ekleyin.',
    failed: 'Alanlar okunamadı: ',
    groups: {
      person: 'Kişi',
      internet: 'İnternet',
      location: 'Konum',
      company: 'Şirket',
      commerce: 'Ticaret',
      finance: 'Finans',
      date: 'Tarih ve saat',
      number: 'Sayı',
      text: 'Metin',
      identifier: 'Kimlik',
      boolean: 'Doğru ya da yanlış',
      other: 'Diğer',
    } satisfies Record<Group, string>,
  },
  zh: {
    title: '测试数据',
    description: (coll: string) => `生成与 ${coll} 中文档结构相仿的逼真测试文档，在你确认后才会导入。`,
    reading: '正在读取字段…',
    noPlace: '打开一个集合，为它生成测试数据。',
    view: '视图本身不包含文档：请打开它的集合来生成测试数据。',
    fields: '字段',
    include: '包含',
    field: '字段',
    seen: '检测到的类型',
    template: '测试值',
    constant: '文本',
    hidden: '已隐藏',
    hiddenHint:
      '作为个人数据对你隐藏：其类型未知，因此测试值为文本，直到你选择其他模板。除非你在导入向导中将其包含，否则向导会将其忽略。',
    addField: '添加字段',
    addFieldName: '新字段名（嵌套字段用 a.b）',
    add: '添加',
    count: '文档数量',
    blank: '留空比例 (%)',
    lang: '词语语言',
    langs: {
      en: '英语',
      tr: '土耳其语',
      zh: '中文',
      ja: '日语',
      es: '西班牙语',
      pt: '葡萄牙语',
      ko: '韩语',
      de: '德语',
      fr: '法语',
      ru: '俄语',
    },
    seed: '种子',
    newSeed: '新种子',
    preview: '预览',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of ? (of === 1 ? '唯一的文档' : `全部 ${f(of)} 个文档`) : `${f(of)} 个文档中的前 ${f(n)} 个`,
    insert: '导入…',
    insertHint: '用这些文档打开导入向导：在那里检查后开始导入。',
    handed: '已在导入向导中打开：请在那里检查文档并开始导入。',
    download: '下载 JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `这些文档按发送时计为 ${mb} MB；一次交给向导最多 ${chars} 个字符，按发送时计 ${limit} MB：请减少数量。`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `这些文档按发送时计为 ${mb} MB；一次下载最多 ${chars} 个字符，按发送时计 ${limit} MB：请减少数量。`,
    notPermitted: '你无权导入到此集合：导入需要在此处写入文档和运行任务的权限。',
    notHanded: '未交给向导。',
    notSaved: '未保存。',
    hiddenUnknown: '无法确定哪些字段对你隐藏：在你重试之前，所有字段都按已隐藏处理。',
    retry: '重试',
    badField:
      '未添加：新字段需要有自己的名称——不能是 _id，不能是已列出的字段，也不能包含或位于已有字段之内，且不能含有 $、方括号、空格、空段、__proto__、constructor 或 prototype。',
    badFieldArray: (list: string) =>
      `未添加：它会位于文档列表（${list}）之内，而测试文档会把该列表生成为数组——请先把它添加到集合的文档中。`,
    noFields: '没有可生成的字段：请包含一个，或添加一个。',
    failed: '无法读取字段：',
    groups: {
      person: '人物',
      internet: '互联网',
      location: '位置',
      company: '公司',
      commerce: '商业',
      finance: '金融',
      date: '日期和时间',
      number: '数字',
      text: '文本',
      identifier: '标识符',
      boolean: '真或假',
      other: '其他',
    } satisfies Record<Group, string>,
  },
  ja: {
    title: 'テストデータ',
    description: (coll: string) =>
      `${coll} のドキュメントに似せたリアルなテストドキュメントを作成します。インポートは、あなたが指示したときに行われます。`,
    reading: 'フィールドを読み込んでいます…',
    noPlace: 'コレクションを開いて、テストデータを作成します。',
    view: 'ビューには独自のドキュメントがありません。テストデータを作成するには、元のコレクションを開いてください。',
    fields: 'フィールド',
    include: '含める',
    field: 'フィールド',
    seen: '検出された型',
    template: 'テスト値',
    constant: 'テキスト',
    hidden: '非表示',
    hiddenHint:
      '個人データとして非表示になっています。型が不明なため、別のテンプレートを選ぶまでテスト値はテキストになります。インポートウィザードで含めない限り、このフィールドは除外されます。',
    addField: 'フィールドを追加',
    addFieldName: '新しいフィールド名（入れ子は a.b）',
    add: '追加',
    count: 'ドキュメント数',
    blank: '空にする割合 (%)',
    lang: '単語の言語',
    langs: {
      en: '英語',
      tr: 'トルコ語',
      zh: '中国語',
      ja: '日本語',
      es: 'スペイン語',
      pt: 'ポルトガル語',
      ko: '韓国語',
      de: 'ドイツ語',
      fr: 'フランス語',
      ru: 'ロシア語',
    },
    seed: 'シード',
    newSeed: '新しいシード',
    preview: 'プレビュー',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? '唯一のドキュメント'
          : `全 ${f(of)} 件のドキュメント`
        : `${f(of)} 件中の先頭 ${f(n)} 件`,
    insert: 'インポート…',
    insertHint:
      'このドキュメントでインポートウィザードを開きます。ウィザードで確認してからインポートを開始してください。',
    handed:
      'インポートウィザードで開きました。ウィザードでドキュメントを確認し、インポートを開始してください。',
    download: 'JSON をダウンロード',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `これらのドキュメントは送信時のサイズで ${mb} MB です。ウィザードに一度に渡せるのは ${chars} 文字、送信時のサイズで ${limit} MB までです。件数を減らしてください。`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `これらのドキュメントは送信時のサイズで ${mb} MB です。一度にダウンロードできるのは ${chars} 文字、送信時のサイズで ${limit} MB までです。件数を減らしてください。`,
    notPermitted:
      'このコレクションにはインポートできません。インポートには、ここでドキュメントを書き込み、ジョブを実行する権限が必要です。',
    notHanded: 'ウィザードに渡されませんでした。',
    notSaved: '保存されませんでした。',
    hiddenUnknown:
      'どのフィールドが非表示になっているか確認できませんでした。もう一度試すまで、すべてのフィールドを非表示として扱います。',
    retry: 'もう一度試す',
    badField:
      '追加されませんでした。新しいフィールドには固有の名前が必要です。_id、既存のフィールド、既存のフィールドを含む名前や内側の名前は使えません。$、角括弧、空白、空の部分、__proto__、constructor、prototype も使えません。',
    badFieldArray: (list: string) =>
      `追加されませんでした。ドキュメントのリスト（${list}）の内側になりますが、テストドキュメントではそのリストを配列として作成します。先にコレクションのドキュメントに追加してください。`,
    noFields: '作成するフィールドがありません。フィールドを含めるか、追加してください。',
    failed: 'フィールドを読み込めませんでした: ',
    groups: {
      person: '人物',
      internet: 'インターネット',
      location: '場所',
      company: '会社',
      commerce: '商取引',
      finance: '金融',
      date: '日付と時刻',
      number: '数値',
      text: 'テキスト',
      identifier: '識別子',
      boolean: '真または偽',
      other: 'その他',
    } satisfies Record<Group, string>,
  },
  es: {
    title: 'Datos de prueba',
    description: (coll: string) =>
      `Documentos de prueba realistas con la forma de los de ${coll}, que se importan cuando tú lo decides.`,
    reading: 'Leyendo los campos…',
    noPlace: 'Abre una colección para crear datos de prueba.',
    view: 'Una vista no tiene documentos propios: abre su colección para crear datos de prueba.',
    fields: 'Campos',
    include: 'Incluir',
    field: 'Campo',
    seen: 'Tipo detectado',
    template: 'Valores de prueba',
    constant: 'Texto',
    hidden: 'oculto',
    hiddenHint:
      'Oculto para ti por ser un dato personal: se desconoce su tipo, así que sus valores de prueba son texto hasta que elijas otros. El asistente de importación lo deja fuera a menos que lo incluyas allí.',
    addField: 'Añadir un campo',
    addFieldName: 'Nombre del nuevo campo (a.b para uno anidado)',
    add: 'Añadir',
    count: 'Documentos',
    blank: 'Omitidos (%)',
    lang: 'Idioma de las palabras',
    langs: {
      en: 'Inglés',
      tr: 'Turco',
      zh: 'Chino',
      ja: 'Japonés',
      es: 'Español',
      pt: 'Portugués',
      ko: 'Coreano',
      de: 'Alemán',
      fr: 'Francés',
      ru: 'Ruso',
    },
    seed: 'Semilla',
    newSeed: 'Nueva semilla',
    preview: 'Vista previa',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? 'El único documento'
          : `Los ${f(of)} documentos`
        : `Los primeros ${f(n)} de ${f(of)}`,
    insert: 'Importar…',
    insertHint:
      'Abre el asistente de importación con estos documentos: compruébalos allí y empieza la importación.',
    handed: 'Abierto en el asistente de importación: comprueba allí los documentos y empieza la importación.',
    download: 'Descargar JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Estos documentos ocupan ${mb} MB tal como se envían; una entrega al asistente admite como máximo ${chars} caracteres y ${limit} MB tal como se envía: crea menos.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Estos documentos ocupan ${mb} MB tal como se envían; una descarga admite como máximo ${chars} caracteres y ${limit} MB tal como se envía: crea menos.`,
    notPermitted:
      'No puedes importar en esta colección: importar requiere permiso para escribir documentos y ejecutar trabajos aquí.',
    notHanded: 'No se entregó al asistente.',
    notSaved: 'No se guardó.',
    hiddenUnknown:
      'No se pudo saber qué campos están ocultos para ti: todos los campos se tratan como ocultos hasta que lo intentes de nuevo.',
    retry: 'Reintentar',
    badField:
      'No se añadió: un campo nuevo necesita un nombre propio; no puede ser _id, ni uno ya listado, ni contener a otro o estar dentro de otro, ni llevar $, corchetes, espacios, partes vacías, __proto__, constructor o prototype.',
    badFieldArray: (list: string) =>
      `No se añadió: quedaría dentro de una lista de documentos (${list}), que los documentos de prueba crean como lista; añádelo primero a los documentos de la colección.`,
    noFields: 'No hay ningún campo que crear: incluye uno o añade uno.',
    failed: 'No se pudieron leer los campos: ',
    groups: {
      person: 'Persona',
      internet: 'Internet',
      location: 'Ubicación',
      company: 'Empresa',
      commerce: 'Comercio',
      finance: 'Finanzas',
      date: 'Fecha y hora',
      number: 'Número',
      text: 'Texto',
      identifier: 'Identificador',
      boolean: 'Verdadero o falso',
      other: 'Otros',
    } satisfies Record<Group, string>,
  },
  pt: {
    title: 'Dados de teste',
    description: (coll: string) =>
      `Documentos de teste realistas, no formato dos de ${coll}, importados quando você mandar.`,
    reading: 'Lendo os campos…',
    noPlace: 'Abra uma coleção para criar dados de teste.',
    view: 'Uma view não tem documentos próprios: abra a coleção dela para criar dados de teste.',
    fields: 'Campos',
    include: 'Incluir',
    field: 'Campo',
    seen: 'Tipo detectado',
    template: 'Valores de teste',
    constant: 'Texto',
    hidden: 'oculto',
    hiddenHint:
      'Oculto para você por ser um dado pessoal: o tipo é desconhecido, então os valores de teste são texto até você escolher outros. O assistente de importação deixa o campo de fora, a menos que você o inclua lá.',
    addField: 'Adicionar um campo',
    addFieldName: 'Nome do novo campo (a.b para um aninhado)',
    add: 'Adicionar',
    count: 'Documentos',
    blank: 'Omitidos (%)',
    lang: 'Idioma das palavras',
    langs: {
      en: 'Inglês',
      tr: 'Turco',
      zh: 'Chinês',
      ja: 'Japonês',
      es: 'Espanhol',
      pt: 'Português',
      ko: 'Coreano',
      de: 'Alemão',
      fr: 'Francês',
      ru: 'Russo',
    },
    seed: 'Semente',
    newSeed: 'Nova semente',
    preview: 'Pré-visualização',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? 'O único documento'
          : `Todos os ${f(of)} documentos`
        : `Os primeiros ${f(n)} de ${f(of)}`,
    insert: 'Importar…',
    insertHint: 'Abre o assistente de importação com estes documentos: confira-os lá e inicie a importação.',
    handed: 'Aberto no assistente de importação: confira os documentos lá e inicie a importação.',
    download: 'Baixar JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Estes documentos têm ${mb} MB como enviados; uma entrega ao assistente aceita no máximo ${chars} caracteres e ${limit} MB como enviado: crie menos.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Estes documentos têm ${mb} MB como enviados; um download aceita no máximo ${chars} caracteres e ${limit} MB como enviado: crie menos.`,
    notPermitted:
      'Você não pode importar para esta coleção: importar exige permissão para gravar documentos e executar jobs aqui.',
    notHanded: 'Não foi entregue ao assistente.',
    notSaved: 'Não foi salvo.',
    hiddenUnknown:
      'Não foi possível saber quais campos estão ocultos para você: todos os campos são tratados como ocultos até você tentar novamente.',
    retry: 'Tentar novamente',
    badField:
      'Não foi adicionado: um campo novo precisa de um nome próprio; não pode ser _id, nem um já listado, nem conter outro ou estar dentro de outro, nem ter $, colchetes, espaços, partes vazias, __proto__, constructor ou prototype.',
    badFieldArray: (list: string) =>
      `Não foi adicionado: ele ficaria dentro de uma lista de documentos (${list}), que os documentos de teste criam como lista; adicione-o primeiro aos documentos da coleção.`,
    noFields: 'Nenhum campo para criar: inclua um ou adicione um.',
    failed: 'Não foi possível ler os campos: ',
    groups: {
      person: 'Pessoa',
      internet: 'Internet',
      location: 'Localização',
      company: 'Empresa',
      commerce: 'Comércio',
      finance: 'Finanças',
      date: 'Data e hora',
      number: 'Número',
      text: 'Texto',
      identifier: 'Identificador',
      boolean: 'Verdadeiro ou falso',
      other: 'Outros',
    } satisfies Record<Group, string>,
  },
  ko: {
    title: '테스트 데이터',
    description: (coll: string) =>
      `${coll} 컬렉션의 도큐먼트와 같은 형태의 현실적인 테스트 도큐먼트이며, 요청하실 때 가져옵니다.`,
    reading: '필드를 읽는 중…',
    noPlace: '테스트 데이터를 만들려면 컬렉션을 여세요.',
    view: '뷰에는 자체 도큐먼트가 없습니다. 테스트 데이터를 만들려면 해당 컬렉션을 여세요.',
    fields: '필드',
    include: '포함',
    field: '필드',
    seen: '확인된 유형',
    template: '테스트 값',
    constant: '텍스트',
    hidden: '숨김',
    hiddenHint:
      '개인 데이터로 분류되어 숨겨진 필드입니다. 유형을 알 수 없으므로 다른 값을 선택하기 전까지 테스트 값은 텍스트입니다. 가져오기 마법사는 거기서 포함하지 않으면 이 필드를 제외합니다.',
    addField: '필드 추가',
    addFieldName: '새 필드 이름(다른 필드 안에 넣으려면 a.b)',
    add: '추가',
    count: '도큐먼트 수',
    blank: '제외 비율(%)',
    lang: '단어 언어',
    langs: {
      en: '영어',
      tr: '튀르키예어',
      zh: '중국어',
      ja: '일본어',
      es: '스페인어',
      pt: '포르투갈어',
      ko: '한국어',
      de: '독일어',
      fr: '프랑스어',
      ru: '러시아어',
    },
    seed: '시드',
    newSeed: '새 시드',
    preview: '미리보기',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of ? (of === 1 ? '도큐먼트 1개뿐' : `전체 ${f(of)}개`) : `${f(of)}개 중 처음 ${f(n)}개`,
    insert: '가져오기…',
    insertHint: '이 도큐먼트로 가져오기 마법사를 엽니다. 마법사에서 확인한 뒤 가져오기를 시작하세요.',
    handed: '가져오기 마법사에서 열었습니다. 도큐먼트를 확인한 뒤 가져오기를 시작하세요.',
    download: 'JSON 다운로드',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `이 도큐먼트는 전송 기준으로 ${mb} MB입니다. 마법사에는 한 번에 최대 ${chars}자, 전송 기준 ${limit} MB까지 전달할 수 있습니다. 더 적게 만드세요.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `이 도큐먼트는 전송 기준으로 ${mb} MB입니다. 한 번에 다운로드할 수 있는 양은 최대 ${chars}자, 전송 기준 ${limit} MB입니다. 더 적게 만드세요.`,
    notPermitted:
      '이 컬렉션으로 가져올 수 없습니다. 가져오려면 여기에서 도큐먼트를 쓰고 작업을 실행할 권한이 필요합니다.',
    notHanded: '전달하지 않았습니다.',
    notSaved: '저장하지 않았습니다.',
    hiddenUnknown:
      '어떤 필드가 숨겨져 있는지 확인할 수 없습니다. 다시 시도하기 전까지 모든 필드를 숨김으로 처리합니다.',
    retry: '다시 시도',
    badField:
      '추가하지 않았습니다. 새 필드에는 고유한 이름이 필요합니다. _id, 이미 목록에 있는 이름, 다른 필드를 포함하거나 다른 필드 안에 들어가는 이름은 사용할 수 없으며, $, 대괄호, 공백, 빈 부분, __proto__, constructor, prototype도 사용할 수 없습니다.',
    badFieldArray: (list: string) =>
      `추가하지 않았습니다. 도큐먼트 목록(${list}) 안에 들어가게 되는데, 테스트 도큐먼트는 이를 목록으로 만듭니다. 먼저 컬렉션의 도큐먼트에 추가하세요.`,
    noFields: '만들 필드가 없습니다. 필드를 포함하거나 추가하세요.',
    failed: '필드를 읽을 수 없습니다: ',
    groups: {
      person: '사람',
      internet: '인터넷',
      location: '위치',
      company: '회사',
      commerce: '상거래',
      finance: '금융',
      date: '날짜 및 시간',
      number: '숫자',
      text: '텍스트',
      identifier: '식별자',
      boolean: '참 또는 거짓',
      other: '기타',
    } satisfies Record<Group, string>,
  },
  de: {
    title: 'Testdaten',
    description: (coll: string) =>
      `Realistische Testdokumente in der Form der Dokumente von ${coll}, die erst auf Ihren Wunsch importiert werden.`,
    reading: 'Felder werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um Testdaten dafür zu erzeugen.',
    view: 'Eine View enthält keine eigenen Dokumente: Öffnen Sie ihre Collection, um Testdaten zu erzeugen.',
    fields: 'Felder',
    include: 'Einbeziehen',
    field: 'Feld',
    seen: 'Erkannter Typ',
    template: 'Testwerte',
    constant: 'Text',
    hidden: 'verborgen',
    hiddenHint:
      'Als personenbezogene Daten vor Ihnen verborgen: Der Typ ist unbekannt, daher sind die Testwerte Text, bis Sie andere wählen. Der Import-Assistent lässt das Feld aus, sofern Sie es dort nicht einbeziehen.',
    addField: 'Feld hinzufügen',
    addFieldName: 'Name des neuen Felds (a.b für ein verschachteltes)',
    add: 'Hinzufügen',
    count: 'Dokumente',
    blank: 'Ausgelassen (%)',
    lang: 'Sprache der Wörter',
    langs: {
      en: 'Englisch',
      tr: 'Türkisch',
      zh: 'Chinesisch',
      ja: 'Japanisch',
      es: 'Spanisch',
      pt: 'Portugiesisch',
      ko: 'Koreanisch',
      de: 'Deutsch',
      fr: 'Französisch',
      ru: 'Russisch',
    },
    seed: 'Seed',
    newSeed: 'Neuer Seed',
    preview: 'Vorschau',
    previewOf: (n: number, of: number, f: (x: number) => string, _plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? 'Das einzige Dokument'
          : `Alle ${f(of)} Dokumente`
        : `Die ersten ${f(n)} von ${f(of)}`,
    insert: 'Importieren…',
    insertHint:
      'Öffnet den Import-Assistenten mit diesen Dokumenten: Prüfen Sie sie dort und starten Sie den Import.',
    handed: 'Im Import-Assistenten geöffnet: Prüfen Sie die Dokumente dort und starten Sie den Import.',
    download: 'JSON herunterladen',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Diese Dokumente sind ${mb} MB groß (wie gesendet); eine Übergabe an den Assistenten nimmt höchstens ${chars} Zeichen und ${limit} MB (wie gesendet) an: Erzeugen Sie weniger.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Diese Dokumente sind ${mb} MB groß (wie gesendet); ein Download nimmt höchstens ${chars} Zeichen und ${limit} MB (wie gesendet) an: Erzeugen Sie weniger.`,
    notPermitted:
      'Sie dürfen nicht in diese Collection importieren: Der Import erfordert die Rechte, hier Dokumente zu schreiben und Aufträge auszuführen.',
    notHanded: 'Nicht übergeben.',
    notSaved: 'Nicht gespeichert.',
    hiddenUnknown:
      'Es konnte nicht ermittelt werden, welche Felder vor Ihnen verborgen sind: Bis zum nächsten Versuch gilt jedes Feld als verborgen.',
    retry: 'Erneut versuchen',
    badField:
      'Nicht hinzugefügt: Ein neues Feld braucht einen eigenen Namen – nicht _id, nicht einen bereits aufgeführten, keinen, der ein Feld enthält oder in einem liegt, und ohne $, Klammern, Leerzeichen, leere Teile, __proto__, constructor oder prototype.',
    badFieldArray: (list: string) =>
      `Nicht hinzugefügt: Es läge in einer Liste von Dokumenten (${list}), die die Testdokumente als Liste erzeugen – fügen Sie es zuerst den Dokumenten der Collection hinzu.`,
    noFields: 'Kein Feld zu erzeugen: Beziehen Sie eines ein oder fügen Sie eines hinzu.',
    failed: 'Die Felder konnten nicht gelesen werden: ',
    groups: {
      person: 'Person',
      internet: 'Internet',
      location: 'Standort',
      company: 'Unternehmen',
      commerce: 'Handel',
      finance: 'Finanzen',
      date: 'Datum und Uhrzeit',
      number: 'Zahl',
      text: 'Text',
      identifier: 'Kennung',
      boolean: 'Wahr oder falsch',
      other: 'Sonstiges',
    } satisfies Record<Group, string>,
  },
  fr: {
    title: 'Données de test',
    description: (coll: string) =>
      `Des documents de test réalistes, de la forme de ceux de ${coll}, importés quand vous le décidez.`,
    reading: 'Lecture des champs…',
    noPlace: 'Ouvrez une collection pour en générer des données de test.',
    view: 'Une vue ne contient aucun document en propre : ouvrez sa collection pour générer des données de test.',
    fields: 'Champs',
    include: 'Inclure',
    field: 'Champ',
    seen: 'Type constaté',
    template: 'Valeurs de test',
    constant: 'Texte',
    hidden: 'masqué',
    hiddenHint:
      'Masqué pour vous en tant que donnée personnelle : son type est inconnu, donc ses valeurs de test sont du texte jusqu’à ce que vous en choisissiez d’autres. L’assistant d’importation l’ignore, sauf si vous l’y incluez.',
    addField: 'Ajouter un champ',
    addFieldName: 'Nom du nouveau champ (a.b pour un champ imbriqué)',
    add: 'Ajouter',
    count: 'Documents',
    blank: 'Omis (%)',
    lang: 'Langue des mots',
    langs: {
      en: 'Anglais',
      tr: 'Turc',
      zh: 'Chinois',
      ja: 'Japonais',
      es: 'Espagnol',
      pt: 'Portugais',
      ko: 'Coréen',
      de: 'Allemand',
      fr: 'Français',
      ru: 'Russe',
    },
    seed: 'Graine',
    newSeed: 'Nouvelle graine',
    preview: 'Aperçu',
    previewOf: (n: number, of: number, f: (x: number) => string, plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? 'Le seul document'
          : `Les ${f(of)} document${plural === 'one' ? '' : 's'}`
        : `Les ${f(n)} premiers sur ${f(of)}`,
    insert: 'Importer…',
    insertHint:
      'Ouvre l’assistant d’importation avec ces documents : vérifiez-les, puis lancez l’importation.',
    handed: 'Ouvert dans l’assistant d’importation : vérifiez les documents, puis lancez l’importation.',
    download: 'Télécharger le JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Ces documents pèsent ${mb} MB tels qu’envoyés ; un envoi à l’assistant accepte au plus ${chars} caractères et ${limit} MB tels qu’envoyés : générez-en moins.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Ces documents pèsent ${mb} MB tels qu’envoyés ; un téléchargement accepte au plus ${chars} caractères et ${limit} MB tels qu’envoyés : générez-en moins.`,
    notPermitted:
      'Vous ne pouvez pas importer dans cette collection : l’importation exige les droits d’écriture de documents et d’exécution de tâches ici.',
    notHanded: 'Non transmis.',
    notSaved: 'Non enregistré.',
    hiddenUnknown:
      'Impossible de savoir quels champs vous sont masqués : tous les champs sont traités comme masqués tant que vous n’avez pas réessayé.',
    retry: 'Réessayer',
    badField:
      'Non ajouté : un nouveau champ doit avoir un nom bien à lui — pas _id, pas un nom déjà listé, ni un champ qui en contient un autre ou se trouve dans un autre, et sans $, crochet, espace, partie vide, __proto__, constructor ni prototype.',
    badFieldArray: (list: string) =>
      `Non ajouté : il se trouverait dans une liste de documents (${list}), que les documents de test génèrent sous forme de liste — ajoutez-le d’abord aux documents de la collection.`,
    noFields: 'Aucun champ à générer : incluez-en un ou ajoutez-en un.',
    failed: 'Impossible de lire les champs : ',
    groups: {
      person: 'Personne',
      internet: 'Internet',
      location: 'Lieu',
      company: 'Entreprise',
      commerce: 'Commerce',
      finance: 'Finance',
      date: 'Date et heure',
      number: 'Nombre',
      text: 'Texte',
      identifier: 'Identifiant',
      boolean: 'Vrai ou faux',
      other: 'Autre',
    } satisfies Record<Group, string>,
  },
  ru: {
    title: 'Тестовые данные',
    description: (coll: string) =>
      `Реалистичные тестовые документы, по форме похожие на документы коллекции ${coll}; импортируются, когда вы скажете.`,
    reading: 'Чтение полей…',
    noPlace: 'Откройте коллекцию, чтобы создать для нее тестовые данные.',
    view: 'У представления нет собственных документов: откройте его коллекцию, чтобы создать тестовые данные.',
    fields: 'Поля',
    include: 'Включить',
    field: 'Поле',
    seen: 'Определенный тип',
    template: 'Тестовые значения',
    constant: 'Текст',
    hidden: 'скрыто',
    hiddenHint:
      'Скрыто от вас как персональные данные: тип неизвестен, поэтому тестовые значения остаются текстом, пока вы не выберете другие. Мастер импорта пропускает это поле, если вы не включите его там.',
    addField: 'Добавить поле',
    addFieldName: 'Имя нового поля (a.b для вложенного)',
    add: 'Добавить',
    count: 'Количество документов',
    blank: 'Пропущено (%)',
    lang: 'Язык слов',
    langs: {
      en: 'Английский',
      tr: 'Турецкий',
      zh: 'Китайский',
      ja: 'Японский',
      es: 'Испанский',
      pt: 'Португальский',
      ko: 'Корейский',
      de: 'Немецкий',
      fr: 'Французский',
      ru: 'Русский',
    },
    seed: 'Начальное значение',
    newSeed: 'Новое начальное значение',
    preview: 'Предпросмотр',
    previewOf: (n: number, of: number, f: (x: number) => string, plural: Intl.LDMLPluralRule = 'other') =>
      n === of
        ? of === 1
          ? 'Единственный документ'
          : `Все ${f(of)} ${RU_DOCUMENTS[plural]}`
        : `Первые ${f(n)} из ${f(of)}`,
    insert: 'Импортировать…',
    insertHint: 'Открывает мастер импорта с этими документами: проверьте их там и запустите импорт.',
    handed: 'Открыто в мастере импорта: проверьте документы там и запустите импорт.',
    download: 'Скачать JSON',
    tooLarge: (mb: string, chars: string, limit: string) =>
      `Эти документы занимают ${mb} MB в отправляемом виде; за одну передачу мастеру принимается не более ${chars} символов и ${limit} MB в отправляемом виде: создайте меньше.`,
    tooLargeDownload: (mb: string, chars: string, limit: string) =>
      `Эти документы занимают ${mb} MB в отправляемом виде; за одно скачивание принимается не более ${chars} символов и ${limit} MB в отправляемом виде: создайте меньше.`,
    notPermitted:
      'Вам нельзя импортировать в эту коллекцию: для импорта нужны права на запись документов и запуск заданий здесь.',
    notHanded: 'Не передано.',
    notSaved: 'Не сохранено.',
    hiddenUnknown:
      'Не удалось узнать, какие поля скрыты от вас: пока вы не повторите попытку, все поля считаются скрытыми.',
    retry: 'Повторить',
    badField:
      'Не добавлено: новому полю нужно собственное имя — не _id, не уже имеющееся в списке, не содержащее другое поле и не лежащее внутри другого, без $, скобок, пробелов, пустых частей, __proto__, constructor и prototype.',
    badFieldArray: (list: string) =>
      `Не добавлено: поле оказалось бы внутри списка документов (${list}), который тестовые документы создают как список — сначала добавьте его в документы коллекции.`,
    noFields: 'Нет полей для создания: включите одно или добавьте.',
    failed: 'Не удалось прочитать поля: ',
    groups: {
      person: 'Человек',
      internet: 'Интернет',
      location: 'Местоположение',
      company: 'Компания',
      commerce: 'Торговля',
      finance: 'Финансы',
      date: 'Дата и время',
      number: 'Число',
      text: 'Текст',
      identifier: 'Идентификатор',
      boolean: 'Истина или ложь',
      other: 'Другое',
    } satisfies Record<Group, string>,
  },
} satisfies Record<Language, unknown>
export type Text = (typeof TABLE)['en']
/** Every language's words, checked by the compiler against English's shape. */
export const TEXT: Record<Language, Text> = TABLE

/** A new field name: dotted keys, none holding a $, a bracket or what no key may (second review). */
const FIELD_NAME = /^[^.$\s[\]]+(\.[^.$\s[\]]+)*$/

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let plans: FieldPlan[] = []
  /** Third review 15: the fields the user chose for, and the ones they added — kept on Try again. */
  const edited = new Set<string>()
  const added = new Set<string>()
  /** Plans read again: what the user chose stays where the field still is; the rest is fresh. */
  const keepChoices = (fresh: FieldPlan[]): FieldPlan[] => {
    const before = new Map(plans.map((x) => [x.path, x]))
    const merged = fresh.map((x) => {
      const old = before.get(x.path)
      if (!old || !edited.has(x.path)) return x
      // "One of the existing values" only where it is still offered.
      const template = old.template === 'existing' && !x.existing?.length ? x.template : old.template
      return {
        ...x,
        include: old.include,
        template,
        ...(old.constant !== undefined ? { constant: old.constant } : {}),
      }
    })
    const paths = new Set(fresh.map((x) => x.path))
    return [...merged, ...plans.filter((x) => added.has(x.path) && !paths.has(x.path))]
  }
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' | 'view' = 'reading'
  let failure: unknown = null
  // Dates are made from the time the tab opened (wave 3 review: not a fixed day), the same all along.
  const settings: Settings = { count: 100, blankShare: 0, lang: 'en', seed: 1, now: Date.now() }
  let note: { tone: 'info' | 'danger' | 'success'; text: string } | null = null
  /** Personal-data rules said what is hidden: unknown (null) treats every field as hidden. */
  let hiddenUnknown = false
  /** Why the last new field was not added, and the name typed. */
  let fieldNote = ''
  let newField = ''

  const header = pageHeader({ icon: 'wand', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body md-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  const docs = () => generate(plans, { ...settings, count: Math.min(settings.count, MAX_COUNT) })
  const number = (n: number) => new Intl.NumberFormat(langTag(shown(TEXT, locale))).format(n)
  /** Megabytes to the hundredth, rounded up (a size) or down (a limit): 1.04 MB, never "1 MB". */
  const megabytes = (bytes: number, round: (x: number) => number = Math.ceil) =>
    new Intl.NumberFormat(langTag(shown(TEXT, locale)), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(round((bytes / 1_000_000) * 100) / 100)
  /** What a hand-off or a download is over, said with the limits as they are. */
  const overLimit = (said: Text['tooLarge'], sent: string) =>
    said(megabytes(sentSize(sent)), number(MAX_CHARS), megabytes(MESSAGE_BYTES, Math.floor))

  /**
   * Why a new field's name is refused, or null (wave 3 review): one reaching an object's prototype,
   * `_id`, one already listed, holding one or held by one (a scalar would turn into an object); second
   * review: a $ or a bracket anywhere, or a place inside a list of documents (`items.note` beside
   * `items[].qty` would make `items` an object).
   */
  function badFieldName(path: string): string | null {
    if (!FIELD_NAME.test(path)) return text.badField
    const keys = path.split('.')
    if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return text.badField
    if (keys[0] === '_id') return text.badField
    for (const p of plans) {
      // Each list above a listed field: `items` for `items[].qty`, `a.b` for `a.b[].c`.
      const parts = p.path.split('[]')
      for (let i = 1; i < parts.length; i++) {
        const list = parts.slice(0, i).join('')
        if (path === list || path.startsWith(`${list}.`)) return text.badFieldArray(`${list}[]`)
      }
      const listed = p.path.replace(/\[\]/g, '')
      if (listed === path || listed.startsWith(`${path}.`) || path.startsWith(`${listed}.`))
        return text.badField
    }
    return null
  }

  function templateSelect(plan: FieldPlan, hint: string | null): HTMLSelectElement {
    const select = h('select', {
      class: 'mm-select md-template',
      attrs: {
        'aria-label': `${text.template}: ${plan.path}`,
        // Second review: why a field is hidden, read with its controls (a title is not).
        ...(hint ? { 'aria-describedby': hint } : {}),
      },
      data: { field: plan.path, focus: `template:${plan.path}` },
    })
    for (const group of GROUPS) {
      const options = TEMPLATES.filter(
        (x) => x.group === group && (x.id !== 'existing' || plan.existing?.length),
      )
      if (!options.length) continue
      const optgroup = h('optgroup', { attrs: { label: text.groups[group] } })
      for (const x of options) {
        const option = h('option', { attrs: { value: x.id }, text: pick(x.label, locale) })
        optgroup.append(option)
      }
      select.append(optgroup)
    }
    // Chosen once its options are in it.
    select.value = plan.template
    select.addEventListener('change', () => {
      plan.template = select.value
      edited.add(plan.path)
      render()
    })
    return select
  }

  function fieldsTable(): HTMLElement {
    const rows = plans.map((plan, n) => {
      const hint = plan.hidden ? `hidden-hint-${n}` : null
      const include = h('input', {
        attrs: {
          type: 'checkbox',
          'aria-label': `${text.include}: ${plan.path}`,
          ...(hint ? { 'aria-describedby': hint } : {}),
        },
        data: { focus: `include:${plan.path}` },
      })
      include.checked = plan.include
      include.addEventListener('change', () => {
        plan.include = include.checked
        edited.add(plan.path)
        render()
      })
      const constant =
        plan.template === 'constant'
          ? (() => {
              const input = h('input', {
                class: 'mm-input md-constant',
                attrs: { type: 'text', 'aria-label': `${text.constant}: ${plan.path}`, maxlength: '200' },
                data: { focus: `constant:${plan.path}` },
              })
              input.value = plan.constant ?? ''
              input.addEventListener('change', () => {
                plan.constant = input.value
                edited.add(plan.path)
                render()
              })
              return input
            })()
          : null
      return h(
        'tr',
        { data: { plan: plan.path } },
        h('td', {}, include),
        h('td', { class: 'mm-mono' }, plan.path),
        h(
          'td',
          {},
          plan.hidden && hint
            ? h(
                'span',
                { title: text.hiddenHint },
                badge(text.hidden, 'warning'),
                h('span', { id: hint, class: 'mm-sr', text: text.hiddenHint }),
              )
            : h('span', { class: 'mm-subtle', text: plan.seen }),
        ),
        h('td', { class: 'md-template-cell' }, templateSelect(plan, hint), constant),
      )
    })
    return h(
      'div',
      { class: 'mm-table-wrap' },
      h(
        'table',
        { class: 'mm-table md-fields', id: 'fields' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...[text.include, text.field, text.seen, text.template].map((label) =>
              h('th', { attrs: { scope: 'col' }, text: label }),
            ),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    )
  }

  function addFieldRow(): HTMLElement {
    const name = h('input', {
      id: 'new-field',
      class: 'mm-input',
      attrs: {
        type: 'text',
        'aria-label': text.addFieldName,
        placeholder: text.addFieldName,
        maxlength: '200',
        'aria-describedby': 'new-field-note',
        ...(fieldNote ? { 'aria-invalid': 'true' } : {}),
      },
      data: { focus: 'new-field' },
    })
    name.value = newField
    name.addEventListener('input', () => (newField = name.value))
    const add = button({
      label: text.add,
      icon: 'plus',
      id: 'add-field',
      onClick: () => {
        const path = name.value.trim()
        const refused = badFieldName(path)
        if (refused) {
          newField = name.value
          fieldNote = refused
          return render()
        }
        plans.push({
          path,
          include: true,
          template: templateFor({ path, types: [], hidden: false }),
          hidden: false,
          seen: '—',
        })
        added.add(path)
        newField = ''
        fieldNote = ''
        render()
      },
    })
    focusable('add-field', add)
    const said = h('p', {
      id: 'new-field-note',
      class: 'mm-subtle md-field-note',
      attrs: { role: 'status' },
      text: fieldNote,
    })
    return h('div', {}, h('div', { class: 'md-add' }, name, add), said)
  }

  function numberInput(
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    set: (n: number) => void,
  ): HTMLElement {
    const input = h('input', {
      id,
      class: 'mm-input md-number',
      attrs: { type: 'number', min: String(min), max: String(max), step: '1' },
      data: { focus: id },
    })
    input.value = String(value)
    input.addEventListener('change', () => {
      const n = Math.trunc(Number(input.value))
      set(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min)
      render()
    })
    return h('label', { class: 'mm-field' }, h('span', { class: 'mm-label', text: label }), input)
  }

  function settingsRow(): HTMLElement {
    const lang = h('select', { id: 'lang', class: 'mm-select', data: { focus: 'lang' } })
    for (const value of DATA_LANGUAGES) {
      const option = h('option', { attrs: { value }, text: text.langs[value] })
      lang.append(option)
    }
    lang.value = settings.lang
    lang.addEventListener('change', () => {
      settings.lang = dataLanguageOf(lang.value)
      render()
    })
    return h(
      'div',
      { class: 'md-settings' },
      numberInput('count', text.count, settings.count, 1, MAX_COUNT, (n) => (settings.count = n)),
      numberInput(
        'blank',
        text.blank,
        Math.round(settings.blankShare * 100),
        0,
        90,
        (n) => (settings.blankShare = n / 100),
      ),
      h('label', { class: 'mm-field' }, h('span', { class: 'mm-label', text: text.lang }), lang),
      numberInput('seed', text.seed, settings.seed, 0, 2 ** 31 - 1, (n) => (settings.seed = n)),
      focusable(
        'new-seed',
        button({
          label: text.newSeed,
          icon: 'refresh',
          id: 'new-seed',
          onClick: () => {
            settings.seed = Math.floor(Math.random() * 2 ** 31)
            render()
          },
        }),
      ),
    )
  }

  /** The user said no to the app's question. */
  const declined = (e: unknown) => e instanceof AskError && e.code === 'declined'
  /** A refusal said as it is: the user's rights, not the plugin's, when they may not import. */
  const refusal = (e: unknown) =>
    e instanceof AskError && e.code === 'not_permitted' ? text.notPermitted : askMessage(e, locale)

  async function insert(b: HTMLButtonElement): Promise<void> {
    const ndjson = toNdjson(docs())
    if (!fitsOneMessage(ndjson)) {
      note = { tone: 'danger', text: overLimit(text.tooLarge, ndjson) }
      return render()
    }
    b.disabled = true
    try {
      await client.ask('ui.importDocuments', { ndjson })
      note = { tone: 'success', text: text.handed }
    } catch (e) {
      // The user said no in the app: nothing went wrong (second review).
      note = declined(e) ? { tone: 'info', text: text.notHanded } : { tone: 'danger', text: refusal(e) }
    }
    render()
  }

  async function download(): Promise<void> {
    const json = JSON.stringify(docs(), null, 2)
    if (!fitsOneMessage(json)) {
      note = { tone: 'danger', text: overLimit(text.tooLargeDownload, json) }
      return render()
    }
    try {
      await client.ask('ui.download', {
        name: `${ctx?.place?.coll ?? 'test'}-test-data`,
        type: 'json',
        text: json,
      })
    } catch (e) {
      note = declined(e) ? { tone: 'info', text: text.notSaved } : { tone: 'danger', text: refusal(e) }
      render()
    }
  }

  /** Each control's place, so the focus comes back to it when the page is drawn again. */
  function focusable<T extends HTMLElement>(key: string, el: T): T {
    el.dataset.focus = key
    return el
  }

  function render(): void {
    // Wave 3 review: drawing the page again dropped the focus to the page; it comes back.
    const active = document.activeElement
    const focused = active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined
    draw()
    if (!focused) return
    const again = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(
      (el) => el.dataset.focus === focused,
    )
    again?.focus()
  }

  function draw(): void {
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    body.replaceChildren()
    status.textContent = ''
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'wand', title: text.noPlace }))
    if (phase === 'view') return void body.append(emptyState({ icon: 'wand', title: text.view }))
    if (phase === 'reading') {
      status.textContent = text.reading
      return void body.append(skeleton(5))
    }
    if (phase === 'failed')
      return void body.append(callout('danger', `${text.failed}${askMessage(failure, locale)}`))
    const included = plans.some((p) => p.include)
    const insertButton: HTMLButtonElement = button({
      label: text.insert,
      icon: 'upload',
      variant: 'primary',
      id: 'insert',
      title: text.insertHint,
      onClick: () => void insert(insertButton),
    })
    focusable('insert', insertButton)
    const downloadButton = button({
      label: text.download,
      icon: 'download',
      id: 'download',
      onClick: () => void download(),
    })
    focusable('download', downloadButton)
    insertButton.disabled = !included
    downloadButton.disabled = !included
    // Only the documents shown are made (wave 3 review: all 5,000 were, to show 5).
    const sample = included
      ? previewDocs(plans, { ...settings, count: Math.min(settings.count, MAX_COUNT) })
      : []
    const retry = button({
      label: text.retry,
      icon: 'refresh',
      id: 'hidden-retry',
      onClick: () => void load(),
    })
    focusable('hidden-retry', retry)
    // Third review 15: the kit's own warning, Try again inside it.
    const unknown = hiddenUnknown ? callout('warning', text.hiddenUnknown, undefined, retry) : null
    if (unknown) unknown.id = 'hidden-unknown'
    body.append(
      ...(unknown ? [unknown] : []),
      settingsRow(),
      h('h2', { class: 'mm-section-title', text: text.fields }),
      fieldsTable(),
      addFieldRow(),
      h('h2', {
        class: 'mm-section-title',
        text: `${text.preview} · ${text.previewOf(Math.min(PREVIEW, settings.count), settings.count, number, pluralOf(settings.count, shown(TEXT, locale)))}`,
      }),
      included
        ? h('pre', {
            class: 'mm-mono md-preview',
            id: 'preview',
            text: sample.map((d) => shellText(d)).join('\n\n'),
          })
        : callout('info', text.noFields),
      ...(note ? [callout(note.tone, note.text)] : []),
      h('div', { class: 'md-actions' }, downloadButton, insertButton),
    )
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  /**
   * The context, then a sample of the collection's documents. What is hidden from the user unknown
   * (null, second review): every field is treated as hidden — no type, no value told — until the
   * user tries again.
   */
  async function load(first = false): Promise<void> {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } catch (e) {
      failure = e
      phase = 'failed'
      return render()
    }
    if (first) {
      locale = ctx.locale
      settings.lang = dataLanguageOf(locale)
      applyLook(ctx.theme, ctx.accent)
    }
    if (!ctx.place) phase = 'noPlace'
    else if (ctx.place.view) phase = 'view'
    else {
      if (first) render()
      try {
        const found = await client.ask<{ documents: unknown[] }>('documents.find', { limit: SAMPLE })
        hiddenUnknown = ctx.place.hidden === null
        const hidden = hiddenUnknown ? [['**']] : (ctx.place.hidden ?? [])
        const fresh = plansOf(shapeOf(found.documents, hidden), found.documents)
        plans = first ? fresh : keepChoices(fresh)
        phase = 'ready'
      } catch (e) {
        failure = e
        phase = 'failed'
      }
    }
    render()
  }
  client.onReady(() => void load(true))
  render()
}
