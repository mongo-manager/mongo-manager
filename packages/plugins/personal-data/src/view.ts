import '../../kit/src/ui.css'
import './style.css'
import { AskError, askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  shown,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
  table,
  type Language,
} from '../../kit/src/ui'
import { findPersonalData, type Confidence, type Finding, type Kind, type Scan } from './detect'

/**
 * Personal data finder (research 2026-10-28): which fields of a collection hold personal data, from
 * a random sample, with how sure and why — and, on a click, those chosen handed to the app's own
 * Personal data section as suggested rules, where an administrator adds each. It only reads; no
 * value is shown but masked.
 */
/** Documents sampled; fewer when as many do not fit in one answer. */
export const SAMPLE = 300
const SMALLER = 60
/** Fields suggested at once, at most (the app's own limit). */
export const MAX_SUGGEST = 50

/** A Russian count's form by the kit's plural rules: one (1, 21…), few (2–4, 22–24…) or many. */
const ru = <T>(n: number, one: T, few: T, many: T): T => {
  const category = pluralOf(n, 'ru')
  return category === 'one' ? one : category === 'few' ? few : many
}
/** Whether a count takes the singular in a language (French: 0 and 1). */
const isOne = (n: number, language: Language) => pluralOf(n, language) === 'one'

const en = {
  title: 'Find personal data',
  description: (coll: string) =>
    `Which fields of ${coll} hold personal data, from a random sample of its documents. Values are shown masked; nothing is changed.`,
  scan: 'Scan again',
  suggest: 'Suggest as rules',
  suggestHint:
    'Opens this collection’s Personal data section with the fields chosen, for an administrator to add',
  copy: 'Copy list',
  copyHint: 'Copies the fields chosen, one per line',
  reading: (n: number) => `Reading a random sample of ${n} documents…`,
  found: (n: number, of: number) =>
    `${formatNumber(n, 'en')} ${isOne(n, 'en') ? 'field looks' : 'fields look'} like personal data in ${formatNumber(of, 'en')} ${isOne(of, 'en') ? 'document' : 'documents'}`,
  noPlace: 'Open a collection to look for personal data in it.',
  empty: 'This collection has no documents',
  none: 'No personal data found in the sample',
  noneHint: (n: number) =>
    `In ${formatNumber(n, 'en')} ${isOne(n, 'en') ? 'document' : 'documents'}, no field is named like or holds e-mail addresses, phone numbers, card numbers, IBANs, identity numbers, IP addresses, names, addresses, birth dates or passwords.`,
  failed: 'The documents could not be read',
  tryAgain: 'Try again',
  columns: {
    pick: 'Suggest',
    field: 'Field',
    kind: 'Holds',
    confidence: 'How sure',
    why: 'Why',
    examples: 'Examples',
  },
  kinds: {
    email: 'E-mail address',
    phone: 'Phone number',
    card: 'Card number',
    iban: 'IBAN',
    nationalId: 'Identity number',
    ip: 'IP address',
    name: 'Person’s name',
    address: 'Address',
    birthDate: 'Birth date',
    secret: 'Password or key',
  } satisfies Record<Kind, string>,
  confidences: { high: 'High', medium: 'Medium', low: 'Low' } satisfies Record<Confidence, string>,
  byValues: (matched: number, values: number) =>
    `${formatNumber(matched, 'en')} of ${formatNumber(values, 'en')} ${isOne(values, 'en') ? 'value' : 'values'}`,
  byName: 'its name says so',
  byNameOnly: 'Its name says so',
  pick: (field: string) => `Suggest ${field} as personal data`,
  notNameable:
    'No rule can name this field: a key with a dot, a $ first, a hidden character or spaces around it, or a path too long',
  hidden: (n: number) =>
    `${isOne(n, 'en') ? 'A field is' : `${formatNumber(n, 'en')} fields are`} hidden from you already`,
  hiddenUnknown:
    'Which fields are hidden from you could not be told in time: a hidden field’s values still arrive as ***, and are not taken for data.',
  secrets: 'Passwords belong hashed, and keys in a secrets store, never as they are',
  secretsHint:
    'A rule hides them from view in the app, not in the database: store a password as a slow hash (bcrypt, scrypt, Argon2), and a key in a secrets store.',
  onView: 'A view’s data is its source’s',
  onViewHint: 'Suggest rules on the collection it reads: its rules reach the view.',
  tooMany: (n: number) =>
    `${formatNumber(n, 'en')} fields are chosen: the first ${MAX_SUGGEST} are suggested at once, the others once these are added.`,
  suggested: (n: number) =>
    `The Personal data section lists ${isOne(n, 'en') ? 'the field' : `${formatNumber(n, 'en')} fields`} to add`,
  suggestedHint: 'Add each there: from then on, those who may not see personal data see its values as ***.',
  suggestedMore: (n: number) => `${formatNumber(n, 'en')} more chosen: suggest them once these are added.`,
  notAdmin: 'Only an administrator of this connection adds personal data rules',
  notAdminHint: 'Copy the list and send it to one.',
  suggestFailed: 'Could not open the Personal data section: ',
  copied: 'The list is on the clipboard.',
  copyFailed: 'Could not copy: ',
  privacy:
    'Values are read here only to be told apart: none is shown but masked, none is kept or sent anywhere.',
}
type Text = typeof en

export const TEXT = {
  en,
  tr: {
    title: 'Kişisel veri bul',
    description: (coll: string) =>
      `${coll} koleksiyonunun hangi alanlarının kişisel veri taşıdığı, belgelerinden rastgele bir örnekle. Değerler maskelenmiş gösterilir; hiçbir şey değiştirilmez.`,
    scan: 'Yeniden tara',
    suggest: 'Kural olarak öner',
    suggestHint:
      'Bu koleksiyonun Kişisel veriler bölümünü, bir yöneticinin eklemesi için seçilen alanlarla açar',
    copy: 'Listeyi kopyala',
    copyHint: 'Seçilen alanları her satıra bir tane olacak şekilde kopyalar',
    reading: (n: number) => `Rastgele ${n} belgelik bir örnek okunuyor…`,
    found: (n: number, of: number) =>
      `${formatNumber(of, 'tr')} belgede ${formatNumber(n, 'tr')} alan kişisel veriye benziyor`,
    noPlace: 'Kişisel veri aramak için bir koleksiyon açın.',
    empty: 'Bu koleksiyonda belge yok',
    none: 'Örnekte kişisel veri bulunmadı',
    noneHint: (n: number) =>
      `${formatNumber(n, 'tr')} belgede hiçbir alan e-posta adresi, telefon numarası, kart numarası, IBAN, kimlik numarası, IP adresi, ad, adres, doğum tarihi ya da parola gibi adlandırılmamış ve bunları taşımıyor.`,
    failed: 'Belgeler okunamadı',
    tryAgain: 'Yeniden dene',
    columns: {
      pick: 'Öner',
      field: 'Alan',
      kind: 'Taşıdığı',
      confidence: 'Ne kadar emin',
      why: 'Neden',
      examples: 'Örnekler',
    },
    kinds: {
      email: 'E-posta adresi',
      phone: 'Telefon numarası',
      card: 'Kart numarası',
      iban: 'IBAN',
      nationalId: 'Kimlik numarası',
      ip: 'IP adresi',
      name: 'Kişi adı',
      address: 'Adres',
      birthDate: 'Doğum tarihi',
      secret: 'Parola ya da anahtar',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Yüksek', medium: 'Orta', low: 'Düşük' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(values, 'tr')} değerden ${formatNumber(matched, 'tr')} tanesi`,
    byName: 'adı da bunu söylüyor',
    byNameOnly: 'Adı bunu söylüyor',
    pick: (field: string) => `${field} alanını kişisel veri olarak öner`,
    notNameable:
      'Hiçbir kural bu alanı adlandıramaz: noktalı, $ ile başlayan, gizli karakter ya da baştaki/sondaki boşluk taşıyan bir anahtar veya fazla uzun bir yol',
    hidden: (n: number) =>
      `${isOne(n, 'tr') ? 'Bir alan' : `${formatNumber(n, 'tr')} alan`} sizden zaten gizleniyor`,
    hiddenUnknown:
      'Hangi alanların sizden gizlendiği zamanında öğrenilemedi: gizli bir alanın değerleri yine *** olarak gelir ve veri sayılmaz.',
    secrets:
      'Parolalar olduğu gibi değil karma (hash) olarak, anahtarlar da bir gizli bilgi kasasında saklanmalı',
    secretsHint:
      'Bir kural onları veritabanında değil, uygulamada görünümden gizler: bir parolayı yavaş bir karma (bcrypt, scrypt, Argon2) olarak, bir anahtarı da bir gizli bilgi kasasında saklayın.',
    onView: 'Bir görünümün verisi kaynağınındır',
    onViewHint: 'Kuralları okuduğu koleksiyonda önerin: oradaki kurallar görünüme de uzanır.',
    tooMany: (n: number) =>
      `${formatNumber(n, 'tr')} alan seçili: bir seferde ilk ${MAX_SUGGEST} tanesi önerilir, diğerleri bunlar eklendikten sonra.`,
    suggested: (n: number) =>
      `Kişisel veriler bölümü eklenecek ${n === 1 ? 'alanı' : `${formatNumber(n, 'tr')} alanı`} listeliyor`,
    suggestedHint:
      'Her birini orada ekleyin: o andan sonra kişisel verileri göremeyenler değerlerini *** olarak görür.',
    suggestedMore: (n: number) =>
      `${formatNumber(n, 'tr')} alan daha seçili: bunlar eklendikten sonra onları önerin.`,
    notAdmin: 'Kişisel veri kurallarını yalnızca bu bağlantının bir yöneticisi ekler',
    notAdminHint: 'Listeyi kopyalayıp bir yöneticiye gönderin.',
    suggestFailed: 'Kişisel veriler bölümü açılamadı: ',
    copied: 'Liste panoda.',
    copyFailed: 'Kopyalanamadı: ',
    privacy:
      'Değerler burada yalnızca ayırt edilmek için okunur: hiçbiri maskesiz gösterilmez, saklanmaz ya da bir yere gönderilmez.',
  },
  zh: {
    title: '查找个人数据',
    description: (coll: string) =>
      `从 ${coll} 的文档中随机抽取样本，找出哪些字段包含个人数据。值以掩码形式显示；不会更改任何内容。`,
    scan: '重新扫描',
    suggest: '建议为规则',
    suggestHint: '打开此集合的“个人数据”部分并带上所选字段，供管理员添加',
    copy: '复制列表',
    copyHint: '复制所选字段，每行一个',
    reading: (n: number) => `正在读取 ${n} 个文档的随机样本…`,
    found: (n: number, of: number) =>
      `在 ${formatNumber(of, 'zh')} 个文档中，有 ${formatNumber(n, 'zh')} 个字段看起来像个人数据`,
    noPlace: '打开一个集合，即可在其中查找个人数据。',
    empty: '此集合中没有文档',
    none: '样本中未发现个人数据',
    noneHint: (n: number) =>
      `在 ${formatNumber(n, 'zh')} 个文档中，没有任何字段的名称类似或包含电子邮件地址、电话号码、银行卡号、IBAN、身份证号、IP 地址、姓名、地址、出生日期或密码。`,
    failed: '无法读取文档',
    tryAgain: '重试',
    columns: {
      pick: '建议',
      field: '字段',
      kind: '包含',
      confidence: '可信度',
      why: '原因',
      examples: '示例',
    },
    kinds: {
      email: '电子邮件地址',
      phone: '电话号码',
      card: '银行卡号',
      iban: 'IBAN',
      nationalId: '身份证号',
      ip: 'IP 地址',
      name: '人名',
      address: '地址',
      birthDate: '出生日期',
      secret: '密码或密钥',
    } satisfies Record<Kind, string>,
    confidences: { high: '高', medium: '中', low: '低' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(values, 'zh')} 个值中有 ${formatNumber(matched, 'zh')} 个`,
    byName: '名称也表明如此',
    byNameOnly: '名称表明如此',
    pick: (field: string) => `建议将 ${field} 作为个人数据`,
    notNameable: '任何规则都无法指定此字段：键中含有点号、以 $ 开头、含有隐藏字符、前后有空格，或路径过长',
    hidden: (n: number) => `已有 ${formatNumber(n, 'zh')} 个字段对您隐藏`,
    hiddenUnknown: '未能及时确定哪些字段对您隐藏：隐藏字段的值仍会以 *** 返回，不会被当作数据。',
    secrets: '密码应以哈希形式存储，密钥应存放在密钥库中，切勿原样保存',
    secretsHint:
      '规则只在应用中将它们隐藏，而不是在数据库中：请将密码存为慢速哈希（bcrypt、scrypt、Argon2），将密钥存入密钥库。',
    onView: '视图的数据来自其源集合',
    onViewHint: '请在它所读取的集合上建议规则：该集合的规则会作用于视图。',
    tooMany: (n: number) =>
      `已选择 ${formatNumber(n, 'zh')} 个字段：一次最多建议前 ${MAX_SUGGEST} 个，其余的待这些添加后再建议。`,
    suggested: (n: number) => `“个人数据”部分列出了 ${formatNumber(n, 'zh')} 个待添加的字段`,
    suggestedHint: '请在那里逐个添加：此后，无权查看个人数据的人看到的值将是 ***。',
    suggestedMore: (n: number) => `另有 ${formatNumber(n, 'zh')} 个已选字段：待这些添加后再建议它们。`,
    notAdmin: '只有此连接的管理员才能添加个人数据规则',
    notAdminHint: '请复制列表并发送给管理员。',
    suggestFailed: '无法打开“个人数据”部分：',
    copied: '列表已复制到剪贴板。',
    copyFailed: '无法复制：',
    privacy: '这里读取值只是为了区分类型：除掩码外不会显示任何值，也不会保存或发送到任何地方。',
  },
  ja: {
    title: '個人データを検索',
    description: (coll: string) =>
      `${coll} のどのフィールドに個人データが含まれているかを、ドキュメントからのランダムなサンプルで調べます。値はマスクして表示され、何も変更されません。`,
    scan: '再スキャン',
    suggest: 'ルールとして提案',
    suggestHint:
      'このコレクションの「個人データ」セクションを、選択したフィールド付きで開きます。管理者が追加できます',
    copy: 'リストをコピー',
    copyHint: '選択したフィールドを 1 行に 1 つずつコピーします',
    reading: (n: number) => `${n} 件のドキュメントのランダムなサンプルを読み取り中…`,
    found: (n: number, of: number) =>
      `${formatNumber(of, 'ja')} 件のドキュメントのうち、${formatNumber(n, 'ja')} 個のフィールドが個人データのようです`,
    noPlace: 'コレクションを開くと、その中の個人データを検索できます。',
    empty: 'このコレクションにはドキュメントがありません',
    none: 'サンプルに個人データは見つかりませんでした',
    noneHint: (n: number) =>
      `${formatNumber(n, 'ja')} 件のドキュメントに、メールアドレス、電話番号、カード番号、IBAN、身分証明書番号、IP アドレス、氏名、住所、生年月日、パスワードを示す名前のフィールドも、それらを含むフィールドもありません。`,
    failed: 'ドキュメントを読み取れませんでした',
    tryAgain: '再試行',
    columns: {
      pick: '提案',
      field: 'フィールド',
      kind: '内容',
      confidence: '確度',
      why: '理由',
      examples: '例',
    },
    kinds: {
      email: 'メールアドレス',
      phone: '電話番号',
      card: 'カード番号',
      iban: 'IBAN',
      nationalId: '身分証明書番号',
      ip: 'IP アドレス',
      name: '氏名',
      address: '住所',
      birthDate: '生年月日',
      secret: 'パスワードまたはキー',
    } satisfies Record<Kind, string>,
    confidences: { high: '高', medium: '中', low: '低' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(values, 'ja')} 個の値のうち ${formatNumber(matched, 'ja')} 個`,
    byName: '名前もそれを示している',
    byNameOnly: '名前がそれを示している',
    pick: (field: string) => `${field} を個人データとして提案`,
    notNameable:
      'このフィールドはどのルールでも指定できません。キーにドット、先頭の $、非表示文字、前後の空白が含まれているか、パスが長すぎます',
    hidden: (n: number) => `${formatNumber(n, 'ja')} 個のフィールドはすでに非表示になっています`,
    hiddenUnknown:
      'どのフィールドが非表示になっているかを時間内に確認できませんでした。非表示フィールドの値は引き続き *** として届き、データとは見なされません。',
    secrets:
      'パスワードはハッシュ化して、キーはシークレットストアに保管してください。そのまま保存してはいけません',
    secretsHint:
      'ルールはアプリ上で表示を隠すだけで、データベースでは隠しません。パスワードは低速なハッシュ（bcrypt、scrypt、Argon2）で、キーはシークレットストアに保存してください。',
    onView: 'ビューのデータは参照元のものです',
    onViewHint: '参照元のコレクションにルールを提案してください。そのルールはビューにも適用されます。',
    tooMany: (n: number) =>
      `${formatNumber(n, 'ja')} 個のフィールドが選択されています。一度に提案されるのは先頭の ${MAX_SUGGEST} 個で、残りはそれらを追加した後に提案します。`,
    suggested: (n: number) =>
      `「個人データ」セクションに、追加するフィールドが ${formatNumber(n, 'ja')} 個表示されています`,
    suggestedHint:
      'そこで 1 つずつ追加してください。以降、個人データを閲覧できないユーザーには値が *** と表示されます。',
    suggestedMore: (n: number) =>
      `さらに ${formatNumber(n, 'ja')} 個のフィールドが選択されています。これらを追加した後に提案してください。`,
    notAdmin: '個人データのルールを追加できるのは、この接続の管理者だけです',
    notAdminHint: 'リストをコピーして管理者に送ってください。',
    suggestFailed: '「個人データ」セクションを開けませんでした：',
    copied: 'リストをクリップボードにコピーしました。',
    copyFailed: 'コピーできませんでした：',
    privacy:
      '値はここで種類を見分けるためだけに読み取られます。マスクされたもの以外は表示されず、保存も送信もされません。',
  },
  es: {
    title: 'Buscar datos personales',
    description: (coll: string) =>
      `Qué campos de ${coll} contienen datos personales, a partir de una muestra aleatoria de sus documentos. Los valores se muestran enmascarados; no se cambia nada.`,
    scan: 'Volver a analizar',
    suggest: 'Sugerir como reglas',
    suggestHint:
      'Abre la sección Datos personales de esta colección con los campos elegidos, para que un administrador los añada',
    copy: 'Copiar lista',
    copyHint: 'Copia los campos elegidos, uno por línea',
    reading: (n: number) => `Leyendo una muestra aleatoria de ${n} documentos…`,
    found: (n: number, of: number) =>
      `${formatNumber(n, 'es')} ${isOne(n, 'es') ? 'campo parece' : 'campos parecen'} datos personales en ${formatNumber(of, 'es')} ${isOne(of, 'es') ? 'documento' : 'documentos'}`,
    noPlace: 'Abre una colección para buscar datos personales en ella.',
    empty: 'Esta colección no tiene documentos',
    none: 'No se encontraron datos personales en la muestra',
    noneHint: (n: number) =>
      `En ${formatNumber(n, 'es')} ${isOne(n, 'es') ? 'documento' : 'documentos'}, ningún campo tiene un nombre propio de direcciones de correo, números de teléfono, números de tarjeta, IBAN, números de identidad, direcciones IP, nombres, direcciones postales, fechas de nacimiento o contraseñas, ni contiene estos datos.`,
    failed: 'No se pudieron leer los documentos',
    tryAgain: 'Reintentar',
    columns: {
      pick: 'Sugerir',
      field: 'Campo',
      kind: 'Contiene',
      confidence: 'Certeza',
      why: 'Motivo',
      examples: 'Ejemplos',
    },
    kinds: {
      email: 'Dirección de correo',
      phone: 'Número de teléfono',
      card: 'Número de tarjeta',
      iban: 'IBAN',
      nationalId: 'Número de identidad',
      ip: 'Dirección IP',
      name: 'Nombre de persona',
      address: 'Dirección postal',
      birthDate: 'Fecha de nacimiento',
      secret: 'Contraseña o clave',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Alta', medium: 'Media', low: 'Baja' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(matched, 'es')} de ${formatNumber(values, 'es')} ${isOne(values, 'es') ? 'valor' : 'valores'}`,
    byName: 'su nombre lo indica',
    byNameOnly: 'Su nombre lo indica',
    pick: (field: string) => `Sugerir ${field} como dato personal`,
    notNameable:
      'Ninguna regla puede nombrar este campo: una clave con un punto, con $ al principio, con un carácter oculto o espacios alrededor, o una ruta demasiado larga',
    hidden: (n: number) =>
      `${isOne(n, 'es') ? 'Un campo ya está oculto' : `${formatNumber(n, 'es')} campos ya están ocultos`} para ti`,
    hiddenUnknown:
      'No se pudo saber a tiempo qué campos están ocultos para ti: los valores de un campo oculto siguen llegando como *** y no se toman por datos.',
    secrets:
      'Las contraseñas deben guardarse con hash y las claves en un almacén de secretos, nunca tal cual',
    secretsHint:
      'Una regla las oculta a la vista en la aplicación, no en la base de datos: guarda una contraseña como un hash lento (bcrypt, scrypt, Argon2) y una clave en un almacén de secretos.',
    onView: 'Los datos de una vista son los de su origen',
    onViewHint: 'Sugiere las reglas en la colección que lee: sus reglas alcanzan a la vista.',
    tooMany: (n: number) =>
      `Hay ${formatNumber(n, 'es')} campos elegidos: se sugieren los primeros ${MAX_SUGGEST} a la vez y los demás cuando estos se hayan añadido.`,
    suggested: (n: number) =>
      `La sección Datos personales muestra ${isOne(n, 'es') ? 'el campo' : `${formatNumber(n, 'es')} campos`} para añadir`,
    suggestedHint:
      'Añádelos allí uno por uno: desde entonces, quienes no pueden ver datos personales ven sus valores como ***.',
    suggestedMore: (n: number) =>
      `${isOne(n, 'es') ? 'Hay 1 campo más elegido: sugiérelo' : `Hay ${formatNumber(n, 'es')} campos más elegidos: sugiérelos`} cuando estos se hayan añadido.`,
    notAdmin: 'Solo un administrador de esta conexión añade reglas de datos personales',
    notAdminHint: 'Copia la lista y envíasela a uno.',
    suggestFailed: 'No se pudo abrir la sección Datos personales: ',
    copied: 'La lista está en el portapapeles.',
    copyFailed: 'No se pudo copiar: ',
    privacy:
      'Los valores se leen aquí solo para distinguirlos: ninguno se muestra salvo enmascarado, y ninguno se guarda ni se envía a ningún sitio.',
  },
  pt: {
    title: 'Encontrar dados pessoais',
    description: (coll: string) =>
      `Quais campos de ${coll} contêm dados pessoais, a partir de uma amostra aleatória dos documentos. Os valores são mostrados mascarados; nada é alterado.`,
    scan: 'Analisar novamente',
    suggest: 'Sugerir como regras',
    suggestHint:
      'Abre a seção Dados pessoais desta coleção com os campos escolhidos, para um administrador adicionar',
    copy: 'Copiar lista',
    copyHint: 'Copia os campos escolhidos, um por linha',
    reading: (n: number) => `Lendo uma amostra aleatória de ${n} documentos…`,
    found: (n: number, of: number) =>
      `${formatNumber(n, 'pt')} ${isOne(n, 'pt') ? 'campo parece' : 'campos parecem'} dados pessoais em ${formatNumber(of, 'pt')} ${isOne(of, 'pt') ? 'documento' : 'documentos'}`,
    noPlace: 'Abra uma coleção para procurar dados pessoais nela.',
    empty: 'Esta coleção não tem documentos',
    none: 'Nenhum dado pessoal encontrado na amostra',
    noneHint: (n: number) =>
      `Em ${formatNumber(n, 'pt')} ${isOne(n, 'pt') ? 'documento' : 'documentos'}, nenhum campo tem nome de endereço de e-mail, número de telefone, número de cartão, IBAN, número de identidade, endereço IP, nome, endereço, data de nascimento ou senha, nem contém esses dados.`,
    failed: 'Não foi possível ler os documentos',
    tryAgain: 'Tentar novamente',
    columns: {
      pick: 'Sugerir',
      field: 'Campo',
      kind: 'Contém',
      confidence: 'Certeza',
      why: 'Motivo',
      examples: 'Exemplos',
    },
    kinds: {
      email: 'Endereço de e-mail',
      phone: 'Número de telefone',
      card: 'Número de cartão',
      iban: 'IBAN',
      nationalId: 'Número de identidade',
      ip: 'Endereço IP',
      name: 'Nome de pessoa',
      address: 'Endereço',
      birthDate: 'Data de nascimento',
      secret: 'Senha ou chave',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Alta', medium: 'Média', low: 'Baixa' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(matched, 'pt')} de ${formatNumber(values, 'pt')} ${isOne(values, 'pt') ? 'valor' : 'valores'}`,
    byName: 'o nome também indica isso',
    byNameOnly: 'O nome indica isso',
    pick: (field: string) => `Sugerir ${field} como dado pessoal`,
    notNameable:
      'Nenhuma regra consegue nomear este campo: uma chave com ponto, com $ no início, com caractere oculto ou espaços nas pontas, ou um caminho longo demais',
    hidden: (n: number) =>
      `${isOne(n, 'pt') ? 'Um campo já está oculto' : `${formatNumber(n, 'pt')} campos já estão ocultos`} para você`,
    hiddenUnknown:
      'Não foi possível saber a tempo quais campos estão ocultos para você: os valores de um campo oculto continuam chegando como *** e não são tomados por dados.',
    secrets: 'Senhas devem ser guardadas como hash e chaves em um cofre de segredos, nunca como estão',
    secretsHint:
      'Uma regra as oculta da visualização no aplicativo, não no banco de dados: armazene uma senha como um hash lento (bcrypt, scrypt, Argon2) e uma chave em um cofre de segredos.',
    onView: 'Os dados de uma visualização são os de sua origem',
    onViewHint: 'Sugira as regras na coleção que ela lê: as regras dela alcançam a visualização.',
    tooMany: (n: number) =>
      `${formatNumber(n, 'pt')} campos escolhidos: os primeiros ${MAX_SUGGEST} são sugeridos de uma vez e os outros depois que estes forem adicionados.`,
    suggested: (n: number) =>
      `A seção Dados pessoais lista ${isOne(n, 'pt') ? 'o campo' : `${formatNumber(n, 'pt')} campos`} para adicionar`,
    suggestedHint:
      'Adicione cada um lá: a partir de então, quem não pode ver dados pessoais vê os valores como ***.',
    suggestedMore: (n: number) =>
      `${isOne(n, 'pt') ? 'Mais 1 campo escolhido: sugira-o' : `Mais ${formatNumber(n, 'pt')} campos escolhidos: sugira-os`} depois que estes forem adicionados.`,
    notAdmin: 'Somente um administrador desta conexão adiciona regras de dados pessoais',
    notAdminHint: 'Copie a lista e envie a um deles.',
    suggestFailed: 'Não foi possível abrir a seção Dados pessoais: ',
    copied: 'A lista está na área de transferência.',
    copyFailed: 'Não foi possível copiar: ',
    privacy:
      'Os valores são lidos aqui apenas para serem distinguidos: nenhum é mostrado, a não ser mascarado, e nenhum é guardado ou enviado a lugar algum.',
  },
  ko: {
    title: '개인 데이터 찾기',
    description: (coll: string) =>
      `${coll} 컬렉션에서 개인 데이터가 들어 있는 필드를 도큐먼트 무작위 샘플로 찾습니다. 값은 마스킹되어 표시되며 아무것도 변경되지 않습니다.`,
    scan: '다시 스캔',
    suggest: '규칙으로 제안',
    suggestHint: '선택한 필드와 함께 이 컬렉션의 개인 데이터 섹션을 엽니다. 관리자가 추가할 수 있습니다',
    copy: '목록 복사',
    copyHint: '선택한 필드를 한 줄에 하나씩 복사합니다',
    reading: (n: number) => `무작위 도큐먼트 ${n}개 샘플을 읽는 중…`,
    found: (n: number, of: number) =>
      `도큐먼트 ${formatNumber(of, 'ko')}개 중 ${formatNumber(n, 'ko')}개 필드가 개인 데이터로 보입니다`,
    noPlace: '개인 데이터를 찾으려면 컬렉션을 여세요.',
    empty: '이 컬렉션에는 도큐먼트가 없습니다',
    none: '샘플에서 개인 데이터를 찾지 못했습니다',
    noneHint: (n: number) =>
      `도큐먼트 ${formatNumber(n, 'ko')}개에서 이메일 주소, 전화번호, 카드 번호, IBAN, 신분증 번호, IP 주소, 이름, 주소, 생년월일, 비밀번호를 뜻하는 이름의 필드도, 이를 담은 필드도 없습니다.`,
    failed: '도큐먼트를 읽을 수 없습니다',
    tryAgain: '다시 시도',
    columns: {
      pick: '제안',
      field: '필드',
      kind: '내용',
      confidence: '확실도',
      why: '이유',
      examples: '예시',
    },
    kinds: {
      email: '이메일 주소',
      phone: '전화번호',
      card: '카드 번호',
      iban: 'IBAN',
      nationalId: '신분증 번호',
      ip: 'IP 주소',
      name: '사람 이름',
      address: '주소',
      birthDate: '생년월일',
      secret: '비밀번호 또는 키',
    } satisfies Record<Kind, string>,
    confidences: { high: '높음', medium: '보통', low: '낮음' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `값 ${formatNumber(values, 'ko')}개 중 ${formatNumber(matched, 'ko')}개`,
    byName: '이름도 이를 나타냄',
    byNameOnly: '이름이 이를 나타냄',
    pick: (field: string) => `${field} 필드를 개인 데이터로 제안`,
    notNameable:
      '어떤 규칙도 이 필드를 지정할 수 없습니다. 점이 있는 키, $로 시작하는 키, 숨은 문자나 앞뒤 공백이 있는 키 또는 너무 긴 경로입니다',
    hidden: (n: number) => `이미 사용자에게 숨겨진 필드가 ${formatNumber(n, 'ko')}개 있습니다`,
    hiddenUnknown:
      '사용자에게 숨겨진 필드를 제때 확인하지 못했습니다. 숨겨진 필드의 값은 여전히 ***로 도착하며 데이터로 간주되지 않습니다.',
    secrets: '비밀번호는 해시로, 키는 비밀 저장소에 보관해야 하며 원본 그대로 두면 안 됩니다',
    secretsHint:
      '규칙은 앱 화면에서만 숨길 뿐 데이터베이스에서는 숨기지 않습니다. 비밀번호는 느린 해시(bcrypt, scrypt, Argon2)로, 키는 비밀 저장소에 보관하세요.',
    onView: '뷰의 데이터는 원본의 데이터입니다',
    onViewHint: '뷰가 읽는 컬렉션에 규칙을 제안하세요. 그 규칙이 뷰에도 적용됩니다.',
    tooMany: (n: number) =>
      `${formatNumber(n, 'ko')}개 필드가 선택되었습니다. 한 번에 처음 ${MAX_SUGGEST}개가 제안되며 나머지는 이 필드들을 추가한 뒤 제안됩니다.`,
    suggested: (n: number) => `개인 데이터 섹션에 추가할 필드 ${formatNumber(n, 'ko')}개가 표시되었습니다`,
    suggestedHint:
      '그곳에서 각각 추가하세요. 그때부터 개인 데이터를 볼 수 없는 사용자에게는 값이 ***로 표시됩니다.',
    suggestedMore: (n: number) =>
      `${formatNumber(n, 'ko')}개 필드가 더 선택되었습니다. 이 필드들을 추가한 뒤 제안하세요.`,
    notAdmin: '개인 데이터 규칙은 이 연결의 관리자만 추가할 수 있습니다',
    notAdminHint: '목록을 복사해 관리자에게 보내세요.',
    suggestFailed: '개인 데이터 섹션을 열 수 없습니다: ',
    copied: '목록이 클립보드에 복사되었습니다.',
    copyFailed: '복사할 수 없습니다: ',
    privacy:
      '값은 서로 구별하기 위해서만 여기서 읽습니다. 마스킹된 값만 표시되며 아무것도 저장하거나 어디에도 보내지 않습니다.',
  },
  de: {
    title: 'Personenbezogene Daten finden',
    description: (coll: string) =>
      `Welche Felder von ${coll} personenbezogene Daten enthalten, anhand einer zufälligen Stichprobe ihrer Dokumente. Werte werden maskiert angezeigt; nichts wird geändert.`,
    scan: 'Erneut scannen',
    suggest: 'Als Regeln vorschlagen',
    suggestHint:
      'Öffnet den Bereich „Personenbezogene Daten“ dieser Collection mit den ausgewählten Feldern, damit ein Administrator sie hinzufügen kann',
    copy: 'Liste kopieren',
    copyHint: 'Kopiert die ausgewählten Felder, eines pro Zeile',
    reading: (n: number) => `Zufällige Stichprobe von ${n} Dokumenten wird gelesen…`,
    found: (n: number, of: number) =>
      `${formatNumber(n, 'de')} ${isOne(n, 'de') ? 'Feld sieht' : 'Felder sehen'} in ${formatNumber(of, 'de')} ${isOne(of, 'de') ? 'Dokument' : 'Dokumenten'} nach personenbezogenen Daten aus`,
    noPlace: 'Öffnen Sie eine Collection, um darin nach personenbezogenen Daten zu suchen.',
    empty: 'Diese Collection enthält keine Dokumente',
    none: 'Keine personenbezogenen Daten in der Stichprobe gefunden',
    noneHint: (n: number) =>
      `In ${formatNumber(n, 'de')} ${isOne(n, 'de') ? 'Dokument' : 'Dokumenten'} trägt kein Feld den Namen von E-Mail-Adressen, Telefonnummern, Kartennummern, IBANs, Ausweisnummern, IP-Adressen, Namen, Adressen, Geburtsdaten oder Passwörtern, und keines enthält solche Daten.`,
    failed: 'Die Dokumente konnten nicht gelesen werden',
    tryAgain: 'Erneut versuchen',
    columns: {
      pick: 'Vorschlagen',
      field: 'Feld',
      kind: 'Enthält',
      confidence: 'Sicherheit',
      why: 'Grund',
      examples: 'Beispiele',
    },
    kinds: {
      email: 'E-Mail-Adresse',
      phone: 'Telefonnummer',
      card: 'Kartennummer',
      iban: 'IBAN',
      nationalId: 'Ausweisnummer',
      ip: 'IP-Adresse',
      name: 'Personenname',
      address: 'Adresse',
      birthDate: 'Geburtsdatum',
      secret: 'Passwort oder Schlüssel',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(matched, 'de')} von ${formatNumber(values, 'de')} ${isOne(values, 'de') ? 'Wert' : 'Werten'}`,
    byName: 'der Name deutet darauf hin',
    byNameOnly: 'Der Name deutet darauf hin',
    pick: (field: string) => `${field} als personenbezogene Daten vorschlagen`,
    notNameable:
      'Keine Regel kann dieses Feld benennen: ein Schlüssel mit Punkt, mit $ am Anfang, mit verstecktem Zeichen oder Leerzeichen am Rand oder ein zu langer Pfad',
    hidden: (n: number) =>
      `${isOne(n, 'de') ? 'Ein Feld ist' : `${formatNumber(n, 'de')} Felder sind`} für Sie bereits verborgen`,
    hiddenUnknown:
      'Welche Felder für Sie verborgen sind, konnte nicht rechtzeitig ermittelt werden: Die Werte eines verborgenen Felds kommen weiterhin als *** an und werden nicht als Daten gewertet.',
    secrets: 'Passwörter gehören gehasht gespeichert und Schlüssel in einen Secret-Speicher, nie im Klartext',
    secretsHint:
      'Eine Regel verbirgt sie nur in der Ansicht der App, nicht in der Datenbank: Speichern Sie ein Passwort als langsamen Hash (bcrypt, scrypt, Argon2) und einen Schlüssel in einem Secret-Speicher.',
    onView: 'Die Daten einer View sind die ihrer Quelle',
    onViewHint:
      'Schlagen Sie Regeln für die Collection vor, die sie liest: Deren Regeln gelten auch für die View.',
    tooMany: (n: number) =>
      `${formatNumber(n, 'de')} Felder sind ausgewählt: Die ersten ${MAX_SUGGEST} werden auf einmal vorgeschlagen, die übrigen, sobald diese hinzugefügt sind.`,
    suggested: (n: number) =>
      `Der Bereich „Personenbezogene Daten“ listet ${isOne(n, 'de') ? 'das Feld' : `${formatNumber(n, 'de')} Felder`} zum Hinzufügen auf`,
    suggestedHint:
      'Fügen Sie jedes dort hinzu: Ab dann sehen alle, die keine personenbezogenen Daten sehen dürfen, deren Werte als ***.',
    suggestedMore: (n: number) =>
      `${isOne(n, 'de') ? 'Ein weiteres Feld ist' : `${formatNumber(n, 'de')} weitere Felder sind`} ausgewählt: Schlagen Sie ${isOne(n, 'de') ? 'es' : 'sie'} vor, sobald diese hinzugefügt sind.`,
    notAdmin: 'Nur ein Administrator dieser Verbindung kann Regeln für personenbezogene Daten hinzufügen',
    notAdminHint: 'Kopieren Sie die Liste und senden Sie sie an einen Administrator.',
    suggestFailed: 'Der Bereich „Personenbezogene Daten“ konnte nicht geöffnet werden: ',
    copied: 'Die Liste befindet sich in der Zwischenablage.',
    copyFailed: 'Kopieren nicht möglich: ',
    privacy:
      'Werte werden hier nur gelesen, um sie voneinander zu unterscheiden: Keiner wird unmaskiert angezeigt, keiner wird gespeichert oder irgendwohin gesendet.',
  },
  fr: {
    title: 'Rechercher les données personnelles',
    description: (coll: string) =>
      `Quels champs de la collection ${coll} contiennent des données personnelles, d’après un échantillon aléatoire de ses documents. Les valeurs sont affichées masquées ; rien n’est modifié.`,
    scan: 'Analyser à nouveau',
    suggest: 'Suggérer comme règles',
    suggestHint:
      'Ouvre la section Données personnelles de cette collection avec les champs choisis, pour qu’un administrateur les ajoute',
    copy: 'Copier la liste',
    copyHint: 'Copie les champs choisis, un par ligne',
    reading: (n: number) => `Lecture d’un échantillon aléatoire de ${n} documents…`,
    found: (n: number, of: number) =>
      `${formatNumber(n, 'fr')} ${isOne(n, 'fr') ? 'champ semble' : 'champs semblent'} contenir des données personnelles dans ${formatNumber(of, 'fr')} ${isOne(of, 'fr') ? 'document' : 'documents'}`,
    noPlace: 'Ouvrez une collection pour y rechercher des données personnelles.',
    empty: 'Cette collection ne contient aucun document',
    none: 'Aucune donnée personnelle trouvée dans l’échantillon',
    noneHint: (n: number) =>
      `Dans ${formatNumber(n, 'fr')} ${isOne(n, 'fr') ? 'document' : 'documents'}, aucun champ ne porte un nom évoquant des adresses e-mail, des numéros de téléphone, des numéros de carte, des IBAN, des numéros d’identité, des adresses IP, des noms, des adresses, des dates de naissance ou des mots de passe, et aucun n’en contient.`,
    failed: 'Impossible de lire les documents',
    tryAgain: 'Réessayer',
    columns: {
      pick: 'Suggérer',
      field: 'Champ',
      kind: 'Contient',
      confidence: 'Certitude',
      why: 'Raison',
      examples: 'Exemples',
    },
    kinds: {
      email: 'Adresse e-mail',
      phone: 'Numéro de téléphone',
      card: 'Numéro de carte',
      iban: 'IBAN',
      nationalId: 'Numéro d’identité',
      ip: 'Adresse IP',
      name: 'Nom de personne',
      address: 'Adresse',
      birthDate: 'Date de naissance',
      secret: 'Mot de passe ou clé',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Élevée', medium: 'Moyenne', low: 'Faible' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(matched, 'fr')} ${isOne(matched, 'fr') ? 'valeur' : 'valeurs'} sur ${formatNumber(values, 'fr')}`,
    byName: 'son nom l’indique aussi',
    byNameOnly: 'Son nom l’indique',
    pick: (field: string) => `Suggérer ${field} comme donnée personnelle`,
    notNameable:
      'Aucune règle ne peut nommer ce champ : une clé contenant un point, commençant par $, avec un caractère invisible ou des espaces autour, ou un chemin trop long',
    hidden: (n: number) =>
      `${isOne(n, 'fr') ? 'Un champ vous est' : `${formatNumber(n, 'fr')} champs vous sont`} déjà masqué${isOne(n, 'fr') ? '' : 's'}`,
    hiddenUnknown:
      'Impossible de déterminer à temps quels champs vous sont masqués : les valeurs d’un champ masqué arrivent toujours sous la forme ***, et ne sont pas prises pour des données.',
    secrets:
      'Les mots de passe doivent être hachés et les clés conservées dans un coffre de secrets, jamais en clair',
    secretsHint:
      'Une règle les masque à l’affichage dans l’application, pas dans la base de données : stockez un mot de passe sous forme de hachage lent (bcrypt, scrypt, Argon2) et une clé dans un coffre de secrets.',
    onView: 'Les données d’une vue sont celles de sa source',
    onViewHint: 'Suggérez les règles sur la collection qu’elle lit : ses règles s’appliquent aussi à la vue.',
    tooMany: (n: number) =>
      `${formatNumber(n, 'fr')} champs sont choisis : les ${MAX_SUGGEST} premiers sont suggérés en une fois, les autres une fois ceux-ci ajoutés.`,
    suggested: (n: number) =>
      `La section Données personnelles liste ${isOne(n, 'fr') ? 'le champ' : `${formatNumber(n, 'fr')} champs`} à ajouter`,
    suggestedHint:
      'Ajoutez-les un par un à cet endroit : dès lors, ceux qui ne peuvent pas voir les données personnelles en voient les valeurs sous la forme ***.',
    suggestedMore: (n: number) =>
      `${isOne(n, 'fr') ? `${formatNumber(n, 'fr')} champ de plus est choisi` : `${formatNumber(n, 'fr')} champs de plus sont choisis`} : suggérez-${isOne(n, 'fr') ? 'le' : 'les'} une fois ceux-ci ajoutés.`,
    notAdmin: 'Seul un administrateur de cette connexion peut ajouter des règles de données personnelles',
    notAdminHint: 'Copiez la liste et envoyez-la à un administrateur.',
    suggestFailed: 'Impossible d’ouvrir la section Données personnelles : ',
    copied: 'La liste est dans le presse-papiers.',
    copyFailed: 'Impossible de copier : ',
    privacy:
      'Les valeurs ne sont lues ici que pour être distinguées : aucune n’est affichée autrement que masquée, aucune n’est conservée ni envoyée où que ce soit.',
  },
  ru: {
    title: 'Поиск персональных данных',
    description: (coll: string) =>
      `Какие поля коллекции ${coll} содержат персональные данные, по случайной выборке ее документов. Значения показаны в скрытом виде; ничего не изменяется.`,
    scan: 'Сканировать снова',
    suggest: 'Предложить как правила',
    suggestHint:
      'Открывает раздел «Персональные данные» этой коллекции с выбранными полями, чтобы администратор их добавил',
    copy: 'Копировать список',
    copyHint: 'Копирует выбранные поля, по одному в строке',
    reading: (n: number) =>
      `Чтение случайной выборки из ${formatNumber(n, 'ru')} ${ru(n, 'документа', 'документов', 'документов')}…`,
    found: (n: number, of: number) =>
      `Вероятные персональные данные: ${formatNumber(n, 'ru')} ${ru(n, 'поле', 'поля', 'полей')} в выборке из ${formatNumber(of, 'ru')} ${ru(of, 'документа', 'документов', 'документов')}`,
    noPlace: 'Откройте коллекцию, чтобы найти в ней персональные данные.',
    empty: 'В этой коллекции нет документов',
    none: 'В выборке персональные данные не найдены',
    noneHint: (n: number) =>
      `В выборке из ${formatNumber(n, 'ru')} ${ru(n, 'документа', 'документов', 'документов')} ни одно поле не имеет имени, указывающего на адреса электронной почты, номера телефонов, номера карт, IBAN, номера удостоверений личности, IP-адреса, имена, адреса, даты рождения или пароли, и не содержит таких данных.`,
    failed: 'Не удалось прочитать документы',
    tryAgain: 'Повторить',
    columns: {
      pick: 'Предложить',
      field: 'Поле',
      kind: 'Содержит',
      confidence: 'Уверенность',
      why: 'Причина',
      examples: 'Примеры',
    },
    kinds: {
      email: 'Адрес электронной почты',
      phone: 'Номер телефона',
      card: 'Номер карты',
      iban: 'IBAN',
      nationalId: 'Номер удостоверения личности',
      ip: 'IP-адрес',
      name: 'Имя человека',
      address: 'Адрес',
      birthDate: 'Дата рождения',
      secret: 'Пароль или ключ',
    } satisfies Record<Kind, string>,
    confidences: { high: 'Высокая', medium: 'Средняя', low: 'Низкая' } satisfies Record<Confidence, string>,
    byValues: (matched: number, values: number) =>
      `${formatNumber(matched, 'ru')} из ${formatNumber(values, 'ru')} ${ru(values, 'значения', 'значений', 'значений')}`,
    byName: 'и имя поля на это указывает',
    byNameOnly: 'Имя поля на это указывает',
    pick: (field: string) => `Предложить поле ${field} как персональные данные`,
    notNameable:
      'Ни одно правило не может указать это поле: ключ с точкой, начинающийся с $, со скрытым символом или пробелами по краям либо слишком длинный путь',
    hidden: (n: number) =>
      ru(
        n,
        `${formatNumber(n, 'ru')} поле уже скрыто от вас`,
        `${formatNumber(n, 'ru')} поля уже скрыты от вас`,
        `${formatNumber(n, 'ru')} полей уже скрыто от вас`,
      ),
    hiddenUnknown:
      'Не удалось вовремя определить, какие поля скрыты от вас: значения скрытого поля по-прежнему приходят как *** и не считаются данными.',
    secrets: 'Пароли нужно хранить в виде хеша, а ключи — в хранилище секретов, но не в открытом виде',
    secretsHint:
      'Правило скрывает их только при просмотре в приложении, а не в базе данных: храните пароль в виде медленного хеша (bcrypt, scrypt, Argon2), а ключ — в хранилище секретов.',
    onView: 'Данные представления — это данные его источника',
    onViewHint:
      'Предлагайте правила для коллекции, которую оно читает: ее правила распространяются и на представление.',
    tooMany: (n: number) =>
      `Выбрано ${formatNumber(n, 'ru')} ${ru(n, 'поле', 'поля', 'полей')}: первые ${MAX_SUGGEST} предлагаются сразу, остальные — после того как эти будут добавлены.`,
    suggested: (n: number) =>
      `Раздел «Персональные данные» показывает ${n === 1 ? 'поле' : `${formatNumber(n, 'ru')} ${ru(n, 'поле', 'поля', 'полей')}`} для добавления`,
    suggestedHint:
      'Добавьте каждое из них там: с этого момента те, кому нельзя видеть персональные данные, будут видеть их значения как ***.',
    suggestedMore: (n: number) =>
      `Выбрано еще ${formatNumber(n, 'ru')} ${ru(n, 'поле', 'поля', 'полей')}: предложите ${n === 1 ? 'его' : 'их'} после того, как эти будут добавлены.`,
    notAdmin: 'Правила персональных данных может добавлять только администратор этого подключения',
    notAdminHint: 'Скопируйте список и отправьте его администратору.',
    suggestFailed: 'Не удалось открыть раздел «Персональные данные»: ',
    copied: 'Список в буфере обмена.',
    copyFailed: 'Не удалось скопировать: ',
    privacy:
      'Значения читаются здесь только для того, чтобы их различать: ни одно не показывается иначе как скрытым, ни одно не сохраняется и никуда не отправляется.',
  },
} satisfies Record<Language, Text>

type State =
  { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; error: unknown } | { kind: 'done'; scan: Scan }
type Outcome =
  | { kind: 'suggested'; n: number; more: number }
  | { kind: 'notAdmin' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'copied' }
  | { kind: 'copyFailed'; error: unknown }

const TONE: Record<Confidence, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  let outcome: Outcome | null = null
  /** The fields chosen: the likely ones to start with, then as the user ticks them. */
  let picked = new Set<string>()

  const scanButton = button({ label: text.scan, icon: 'refresh', id: 'scan' })
  const copyButton = button({ label: text.copy, icon: 'copy', id: 'copy', title: text.copyHint })
  const suggestButton = button({
    label: text.suggest,
    icon: 'arrowRight',
    variant: 'primary',
    id: 'suggest',
    title: text.suggestHint,
  })
  const header = pageHeader({
    icon: 'fingerprint',
    title: text.title,
    description: '',
    actions: [scanButton, copyButton, suggestButton],
  })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'pd-notes' })
  const results = h('div', { id: 'results', class: 'pd-results' })
  const privacy = h('p', { class: 'mm-status pd-privacy' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status), notes, results, privacy),
    ),
  )

  const findings = () => (state.kind === 'done' ? state.scan.findings : [])
  const chosen = () => findings().filter((f) => f.nameable && picked.has(f.field))
  /** Fields suggested already, in this scan. */
  const sent = new Set<string>()
  const unsent = () => chosen().filter((f) => !sent.has(f.field))
  const onView = () => !!ctx?.place?.view

  function applyText(): void {
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    setLabel(scanButton, text.scan)
    setLabel(copyButton, text.copy)
    setLabel(suggestButton, text.suggest)
    copyButton.title = text.copyHint
    suggestButton.title = text.suggestHint
    privacy.textContent = ctx?.place ? text.privacy : ''
  }

  function why(f: Finding): string {
    const values = text.byValues(f.matched, f.values)
    if (['name', 'address', 'birthDate', 'secret'].includes(f.kind)) return text.byNameOnly
    if (!f.values) return text.byNameOnly
    return f.named ? `${values}; ${text.byName}` : values
  }

  function render(): void {
    notes.replaceChildren()
    status.textContent = ''
    const none = chosen().length === 0
    copyButton.disabled = none
    suggestButton.disabled = none || onView()
    scanButton.disabled = !ctx?.place || state.kind === 'running'
    if (!ctx) return
    if (state.kind === 'failed')
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: askMessage(state.error, locale),
          action: ctx.place
            ? button({ label: text.tryAgain, icon: 'refresh', onClick: () => void scan() })
            : undefined,
        }),
      )
    if (!ctx.place) return void results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = text.reading(SAMPLE)
      return void results.replaceChildren(skeleton(5))
    }
    const { scan: found } = state
    if (outcome?.kind === 'suggested')
      notes.append(
        callout(
          'success',
          text.suggested(outcome.n),
          outcome.more ? `${text.suggestedHint} ${text.suggestedMore(outcome.more)}` : text.suggestedHint,
        ),
      )
    if (outcome?.kind === 'notAdmin') notes.append(callout('warning', text.notAdmin, text.notAdminHint))
    if (outcome?.kind === 'failed')
      notes.append(callout('danger', `${text.suggestFailed}${askMessage(outcome.error, locale)}`))
    if (outcome?.kind === 'copied') notes.append(callout('success', text.copied))
    if (outcome?.kind === 'copyFailed')
      notes.append(callout('danger', `${text.copyFailed}${askMessage(outcome.error, locale)}`))
    if (ctx.place.hidden === null) notes.append(callout('warning', text.hiddenUnknown))
    if (found.hidden.length)
      notes.append(callout('info', text.hidden(found.hidden.length), found.hidden.join(', ')))
    if (onView()) notes.append(callout('info', text.onView, text.onViewHint))
    if (found.findings.some((f) => f.kind === 'secret'))
      notes.append(callout('warning', text.secrets, text.secretsHint))
    if (!found.sampled)
      return void results.replaceChildren(emptyState({ icon: 'database', title: text.empty }))
    if (!found.findings.length)
      return void results.replaceChildren(
        emptyState({ icon: 'ok', title: text.none, hint: text.noneHint(found.sampled) }),
      )
    status.textContent = text.found(found.findings.length, found.sampled)
    // Said before Suggest, not after: the Personal data section takes the page then (review I5).
    if (unsent().length > MAX_SUGGEST) notes.append(callout('info', text.tooMany(unsent().length)))
    const t = table([
      { label: text.columns.pick, width: '1%' },
      { label: text.columns.field },
      { label: text.columns.kind },
      { label: text.columns.confidence },
      { label: text.columns.why },
      { label: text.columns.examples },
    ])
    for (const f of found.findings) {
      const box = h('input', {
        attrs: { type: 'checkbox', 'aria-label': text.pick(f.field) },
        data: { field: f.field },
        ...(f.nameable ? {} : { title: text.notNameable }),
      })
      box.checked = f.nameable && picked.has(f.field)
      box.disabled = !f.nameable
      box.addEventListener('change', () => {
        if (box.checked) picked.add(f.field)
        else picked.delete(f.field)
        outcome = null
        render()
        ;(
          results.querySelector(`input[data-field="${CSS.escape(f.field)}"]`) as HTMLInputElement | null
        )?.focus()
      })
      const row = t.row(
        box,
        h(
          'span',
          { class: 'pd-field' },
          h('span', { class: 'mm-key', text: f.field, title: f.field }),
          // Why it cannot be suggested, on the page (a title alone is no one's to read).
          f.nameable ? null : h('span', { class: 'mm-subtle pd-why-not', text: text.notNameable }),
        ),
        badge(text.kinds[f.kind], 'info'),
        badge(text.confidences[f.confidence], TONE[f.confidence]),
        h('span', { class: 'pd-why', text: why(f) }),
        h('span', { class: 'mm-mono pd-examples', text: f.examples.join('  ·  ') }),
      )
      row.dataset.finding = f.field
    }
    results.replaceChildren(h('div', { class: 'mm-table-wrap' }, t.el))
  }

  async function scan(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    outcome = null
    state = { kind: 'running' }
    setBusy(scanButton, true)
    render()
    try {
      const sample = async (size: number) =>
        (
          await client.ask<{ documents: unknown[] }>('documents.aggregate', {
            pipeline: [{ $sample: { size } }],
            limit: size,
          })
        ).documents
      let documents: unknown[]
      try {
        documents = await sample(SAMPLE)
      } catch (e) {
        // Large documents: fewer of them fit in one answer.
        if (!(e instanceof AskError && e.code === 'too_large')) throw e
        documents = await sample(SMALLER)
      }
      if (run !== running) return
      const result = findPersonalData(documents, ctx.place.hidden ?? [], ctx.place)
      picked = new Set(
        result.findings.filter((f) => f.nameable && f.confidence !== 'low').map((f) => f.field),
      )
      sent.clear()
      state = { kind: 'done', scan: result }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
    }
    setBusy(scanButton, false)
    render()
  }

  scanButton.addEventListener('click', () => void scan())
  suggestButton.addEventListener('click', () => {
    // The chosen fields not suggested yet go first: the next 50 after the first (review I2). When
    // all were, they go again (the section shows only those still to add).
    const left = unsent()
    const all = (left.length ? left : chosen()).map((f) => f.field)
    if (!all.length || onView()) return
    const fields = all.slice(0, MAX_SUGGEST)
    void client.ask('ui.suggestPersonalData', { fields }).then(
      () => {
        for (const f of fields) sent.add(f)
        outcome = { kind: 'suggested', n: fields.length, more: all.length - fields.length }
        render()
      },
      (error: unknown) => {
        outcome =
          error instanceof AskError && error.code === 'not_permitted'
            ? { kind: 'notAdmin' }
            : { kind: 'failed', error }
        render()
      },
    )
  })
  copyButton.addEventListener('click', () => {
    const list = chosen()
    if (!list.length || !ctx?.place) return
    const ns = `${ctx.place.db}.${ctx.place.coll}`
    const lines = list.map(
      (f) => `${ns}.${f.field}\t${text.kinds[f.kind]}\t${text.confidences[f.confidence]}`,
    )
    void client.ask('ui.copy', { text: `${lines.join('\n')}\n` }).then(
      () => {
        outcome = { kind: 'copied' }
        render()
      },
      (error: unknown) => {
        outcome = { kind: 'copyFailed', error }
        render()
      },
    )
  })

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } catch (e) {
      ctx = { place: null } as unknown as PluginContext
      state = { kind: 'failed', error: e }
      return render()
    }
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) return render()
    // Kept while the Personal data section shows, so the scan is there to suggest the next fields.
    void client.ask('ui.keepOpen').catch(() => {})
    void scan()
  })
  applyText()
  render()
}
