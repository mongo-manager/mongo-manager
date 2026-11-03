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
  langTag,
  type Language,
  pick,
  pluralOf,
  pageHeader,
  shown,
  segmented,
  setLabel,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { FORMATS, writeScript, type CollectionIndexes, type Format, type ListedIndex } from './script'

/**
 * Index script (research 2026-10-28: CUSTOMER-I-6953): the indexes of a collection, or of its whole
 * database, as the commands that make them again — mongosh, Node.js, Python or JSON — to copy or to
 * save. It only reads; nothing runs.
 */
type Scope = 'collection' | 'database'
/** Collections of a database read at most (each one read of its indexes). */
export const MAX_COLLECTIONS = 100

const FORMAT_NAMES = { mongosh: 'mongosh', node: 'Node.js', python: 'Python', json: 'JSON' } satisfies Record<
  Format,
  string
>

interface Text {
  title: string
  description: (coll: string) => string
  scope: string
  scopes: Record<Scope, string>
  format: string
  formats: Record<Format, string>
  copy: string
  download: string
  reading: string
  readingOf: (n: number, of: number) => string
  counted: (indexes: number, colls: number) => string
  idNote: string
  none: string
  noneHint: string
  failed: string
  tryAgain: string
  hidden: (n: number) => string
  hiddenHint: string
  skipped: (names: string) => string
  skippedHint: string
  jsonWaits: string
  limited: string
  limitedHint: string
  unordered: (n: number) => string
  unorderedHint: string
  more: (n: number) => string
  copyFailed: string
  noPlace: string
  view: string
  script: string
}

export const TEXT = {
  en: {
    title: 'Index script',
    description: (coll: string) =>
      `The indexes of ${coll}, or of its database, as the commands that make them again. Nothing runs.`,
    scope: 'Indexes of',
    scopes: { collection: 'This collection', database: 'The whole database' } satisfies Record<Scope, string>,
    format: 'Written for',
    formats: FORMAT_NAMES,
    copy: 'Copy',
    download: 'Download',
    reading: 'Reading the indexes…',
    readingOf: (n: number, of: number) =>
      `Reading the indexes of ${n} of ${of} ${pluralOf(of, 'en') === 'one' ? 'collection' : 'collections'}…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'en')} ${pluralOf(indexes, 'en') === 'one' ? 'index' : 'indexes'} in ${formatNumber(colls, 'en')} ${pluralOf(colls, 'en') === 'one' ? 'collection' : 'collections'}`,
    idNote: 'The default _id index (or a clustered one) is made with its collection and is left out.',
    none: 'No index to write',
    noneHint: 'Only the default _id index is here: it is made with the collection.',
    failed: 'The indexes could not be read',
    tryAgain: 'Try again',
    hidden: (n: number) =>
      `${pluralOf(n, 'en') === 'one' ? 'An index holds' : `${n} indexes hold`} values hidden from you`,
    hiddenHint: 'They are written as "***" and marked: such a script does not make the index as it is.',
    skipped: (names: string) => `Could not be read: ${names}`,
    skippedHint: 'The script names them at its top: it does not make their indexes.',
    jsonWaits: 'JSON cannot say what is missing: Copy and Download are off until every collection is read.',
    limited: 'Stopped before the whole database was read',
    limitedHint: 'The app reads only so many definitions a minute. Try again in a minute.',
    unordered: (n: number) =>
      `${pluralOf(n, 'en') === 'one' ? 'An index’s key' : `${n} indexes’ keys`} may list ${pluralOf(n, 'en') === 'one' ? 'its' : 'their'} fields in another order`,
    unorderedHint:
      'Field names that are numbers ("2") come first once read, so the order they were made in is lost: check those keys.',
    more: (n: number) => `The first ${n} collections are read; the others are left out.`,
    copyFailed: 'Could not copy or save: ',
    noPlace: 'Open a collection to write its indexes.',
    view: 'A view has no indexes of its own',
    script: 'Script',
  },
  tr: {
    title: 'İndeks betiği',
    description: (coll: string) =>
      `${coll} koleksiyonunun ya da veritabanının indeksleri, onları yeniden oluşturan komutlar olarak. Hiçbir şey çalışmaz.`,
    scope: 'İndeksler',
    scopes: { collection: 'Bu koleksiyon', database: 'Tüm veritabanı' } satisfies Record<Scope, string>,
    format: 'Biçim',
    formats: FORMAT_NAMES,
    copy: 'Kopyala',
    download: 'İndir',
    reading: 'İndeksler okunuyor…',
    readingOf: (n: number, of: number) => `${of} koleksiyondan ${n} tanesinin indeksleri okunuyor…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(colls, 'tr')} koleksiyonda ${formatNumber(indexes, 'tr')} indeks`,
    idNote:
      'Varsayılan _id indeksi (ya da kümelenmiş bir indeks) koleksiyonuyla birlikte oluşturulur ve dışarıda bırakılır.',
    none: 'Yazılacak indeks yok',
    noneHint: 'Burada yalnızca varsayılan _id indeksi var: koleksiyonla birlikte oluşturulur.',
    failed: 'İndeksler okunamadı',
    tryAgain: 'Yeniden dene',
    hidden: (n: number) => `${n} indeks sizden gizlenen değerler taşıyor`,
    hiddenHint: 'Bunlar "***" olarak yazılır ve işaretlenir: böyle bir betik indeksi olduğu gibi oluşturmaz.',
    skipped: (names: string) => `Okunamayanlar: ${names}`,
    skippedHint: 'Betik bunları en üstte adlandırır: onların indekslerini oluşturmaz.',
    jsonWaits: 'JSON eksik olanı söyleyemez: Kopyala ve İndir, her koleksiyon okunana kadar kapalıdır.',
    limited: 'Tüm veritabanı okunmadan durduruldu',
    limitedHint: 'Uygulama dakikada belli sayıda tanım okur. Bir dakika sonra yeniden deneyin.',
    unordered: (n: number) => `${n} indeksin anahtarları alanlarını başka bir sırayla listeliyor olabilir`,
    unorderedHint:
      'Adı sayı olan alanlar ("2") okununca öne geçer, bu yüzden oluşturuldukları sıra kaybolur: bu anahtarları denetleyin.',
    more: (n: number) => `İlk ${n} koleksiyon okunur; diğerleri dışarıda kalır.`,
    copyFailed: 'Kopyalanamadı ya da kaydedilemedi: ',
    noPlace: 'İndekslerini yazmak için bir koleksiyon açın.',
    view: 'Bir görünümün kendine ait indeksi yoktur',
    script: 'Betik',
  },
  zh: {
    title: '索引脚本',
    description: (coll: string) =>
      `${coll} 或其所在数据库的索引，以重新创建它们的命令形式呈现。不会执行任何操作。`,
    scope: '索引范围',
    scopes: { collection: '此集合', database: '整个数据库' } satisfies Record<Scope, string>,
    format: '输出格式',
    formats: FORMAT_NAMES,
    copy: '复制',
    download: '下载',
    reading: '正在读取索引…',
    readingOf: (n: number, of: number) => `正在读取 ${of} 个集合中的第 ${n} 个的索引…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(colls, 'zh')} 个集合中共 ${formatNumber(indexes, 'zh')} 个索引`,
    idNote: '默认的 _id 索引（或聚簇索引）随集合一同创建，因此不包含在内。',
    none: '没有可写出的索引',
    noneHint: '这里只有默认的 _id 索引：它随集合一同创建。',
    failed: '无法读取索引',
    tryAgain: '重试',
    hidden: (n: number) => `${n} 个索引包含对您隐藏的值`,
    hiddenHint: '这些值会写成 "***" 并加以标记：这样的脚本无法原样创建该索引。',
    skipped: (names: string) => `无法读取：${names}`,
    skippedHint: '脚本会在顶部列出它们：不会创建这些集合的索引。',
    jsonWaits: 'JSON 无法说明缺少了什么：在所有集合读取完成之前，复制和下载均不可用。',
    limited: '在读取完整个数据库之前已停止',
    limitedHint: '应用每分钟只能读取一定数量的定义。请一分钟后重试。',
    unordered: (n: number) => `${n} 个索引的键中字段的顺序可能不同`,
    unorderedHint: '名称为数字（"2"）的字段在读取后会排到最前面，因此创建时的顺序已丢失：请检查这些键。',
    more: (n: number) => `已读取前 ${n} 个集合；其余的已略过。`,
    copyFailed: '无法复制或保存：',
    noPlace: '打开一个集合以写出它的索引。',
    view: '视图没有自己的索引',
    script: '脚本',
  },
  ja: {
    title: 'インデックススクリプト',
    description: (coll: string) =>
      `${coll} またはそのデータベースのインデックスを、再作成するコマンドとして表示します。何も実行されません。`,
    scope: '対象',
    scopes: { collection: 'このコレクション', database: 'データベース全体' } satisfies Record<Scope, string>,
    format: '出力形式',
    formats: FORMAT_NAMES,
    copy: 'コピー',
    download: 'ダウンロード',
    reading: 'インデックスを読み取っています…',
    readingOf: (n: number, of: number) => `${of} 件中 ${n} 件のコレクションのインデックスを読み取っています…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(colls, 'ja')} 件のコレクションに ${formatNumber(indexes, 'ja')} 件のインデックス`,
    idNote:
      'デフォルトの _id インデックス（またはクラスター化インデックス）はコレクションと同時に作成されるため、含まれません。',
    none: '出力するインデックスがありません',
    noneHint: 'ここにはデフォルトの _id インデックスしかありません。これはコレクションと同時に作成されます。',
    failed: 'インデックスを読み取れませんでした',
    tryAgain: '再試行',
    hidden: (n: number) => `${n} 件のインデックスに、あなたには非表示の値が含まれています`,
    hiddenHint:
      'これらは "***" として出力され、印が付きます。このスクリプトではインデックスをそのまま作成できません。',
    skipped: (names: string) => `読み取れなかったもの: ${names}`,
    skippedHint: 'スクリプトの先頭にそれらの名前が記されます。これらのインデックスは作成されません。',
    jsonWaits:
      'JSON では欠けているものを示せません。すべてのコレクションを読み取るまで、コピーとダウンロードは無効です。',
    limited: 'データベース全体を読み取る前に停止しました',
    limitedHint: 'アプリが 1 分間に読み取れる定義の数には上限があります。1 分後にもう一度お試しください。',
    unordered: (n: number) => `${n} 件のインデックスのキーでは、フィールドの順序が異なる可能性があります`,
    unorderedHint:
      '名前が数字のフィールド（"2"）は読み取り後に先頭へ移るため、作成時の順序が失われています。これらのキーを確認してください。',
    more: (n: number) => `最初の ${n} 件のコレクションを読み取りました。残りは含まれていません。`,
    copyFailed: 'コピーまたは保存できませんでした: ',
    noPlace: 'インデックスを出力するには、コレクションを開いてください。',
    view: 'ビューには独自のインデックスがありません',
    script: 'スクリプト',
  },
  es: {
    title: 'Script de índices',
    description: (coll: string) =>
      `Los índices de ${coll}, o de su base de datos, como los comandos que los vuelven a crear. No se ejecuta nada.`,
    scope: 'Índices de',
    scopes: { collection: 'Esta colección', database: 'Toda la base de datos' } satisfies Record<
      Scope,
      string
    >,
    format: 'Escrito para',
    formats: FORMAT_NAMES,
    copy: 'Copiar',
    download: 'Descargar',
    reading: 'Leyendo los índices…',
    readingOf: (n: number, of: number) =>
      `Leyendo los índices de ${n} de ${of} ${pluralOf(of, 'es') === 'one' ? 'colección' : 'colecciones'}…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'es')} ${pluralOf(indexes, 'es') === 'one' ? 'índice' : 'índices'} en ${formatNumber(colls, 'es')} ${pluralOf(colls, 'es') === 'one' ? 'colección' : 'colecciones'}`,
    idNote: 'El índice _id predeterminado (o uno clustered) se crea con su colección y se omite.',
    none: 'No hay ningún índice que escribir',
    noneHint: 'Solo está el índice _id predeterminado: se crea junto con la colección.',
    failed: 'No se pudieron leer los índices',
    tryAgain: 'Reintentar',
    hidden: (n: number) =>
      `${pluralOf(n, 'es') === 'one' ? 'Un índice contiene' : `${n} índices contienen`} valores ocultos para ti`,
    hiddenHint: 'Se escriben como "***" y se marcan: un script así no crea el índice tal como es.',
    skipped: (names: string) => `No se pudieron leer: ${names}`,
    skippedHint: 'El script los nombra al principio: no crea sus índices.',
    jsonWaits:
      'JSON no puede indicar lo que falta: Copiar y Descargar están desactivados hasta que se lean todas las colecciones.',
    limited: 'Se detuvo antes de leer toda la base de datos',
    limitedHint:
      'La aplicación solo lee cierto número de definiciones por minuto. Inténtalo de nuevo en un minuto.',
    unordered: (n: number) =>
      `${pluralOf(n, 'es') === 'one' ? 'La clave de un índice puede' : `Las claves de ${n} índices pueden`} listar sus campos en otro orden`,
    unorderedHint:
      'Los nombres de campo que son números ("2") pasan al principio al leerse, por lo que se pierde el orden en que se crearon: revisa esas claves.',
    more: (n: number) => `Se leen las primeras ${n} colecciones; las demás se omiten.`,
    copyFailed: 'No se pudo copiar ni guardar: ',
    noPlace: 'Abre una colección para escribir sus índices.',
    view: 'Una vista no tiene índices propios',
    script: 'Script',
  },
  pt: {
    title: 'Script de índices',
    description: (coll: string) =>
      `Os índices de ${coll}, ou do banco de dados dela, como os comandos que os criam novamente. Nada é executado.`,
    scope: 'Índices de',
    scopes: { collection: 'Esta coleção', database: 'O banco de dados inteiro' } satisfies Record<
      Scope,
      string
    >,
    format: 'Escrito para',
    formats: FORMAT_NAMES,
    copy: 'Copiar',
    download: 'Baixar',
    reading: 'Lendo os índices…',
    readingOf: (n: number, of: number) =>
      `Lendo os índices de ${n} de ${of} ${pluralOf(of, 'pt') === 'one' ? 'coleção' : 'coleções'}…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'pt')} ${pluralOf(indexes, 'pt') === 'one' ? 'índice' : 'índices'} em ${formatNumber(colls, 'pt')} ${pluralOf(colls, 'pt') === 'one' ? 'coleção' : 'coleções'}`,
    idNote: 'O índice _id padrão (ou um clusterizado) é criado com a coleção e fica de fora.',
    none: 'Nenhum índice para escrever',
    noneHint: 'Só há o índice _id padrão aqui: ele é criado junto com a coleção.',
    failed: 'Não foi possível ler os índices',
    tryAgain: 'Tentar novamente',
    hidden: (n: number) =>
      `${pluralOf(n, 'pt') === 'one' ? 'Um índice contém' : `${n} índices contêm`} valores ocultos para você`,
    hiddenHint: 'Eles são escritos como "***" e marcados: um script assim não cria o índice como ele é.',
    skipped: (names: string) => `Não foi possível ler: ${names}`,
    skippedHint: 'O script os cita no início: ele não cria os índices deles.',
    jsonWaits:
      'O JSON não consegue dizer o que falta: Copiar e Baixar ficam desativados até que todas as coleções sejam lidas.',
    limited: 'Interrompido antes de ler o banco de dados inteiro',
    limitedHint: 'O app lê apenas um certo número de definições por minuto. Tente novamente em um minuto.',
    unordered: (n: number) =>
      `${pluralOf(n, 'pt') === 'one' ? 'A chave de um índice pode' : `As chaves de ${n} índices podem`} listar os campos em outra ordem`,
    unorderedHint:
      'Nomes de campo que são números ("2") vêm primeiro depois de lidos, então a ordem em que foram criados se perde: confira essas chaves.',
    more: (n: number) => `As primeiras ${n} coleções são lidas; as demais ficam de fora.`,
    copyFailed: 'Não foi possível copiar ou salvar: ',
    noPlace: 'Abra uma coleção para escrever os índices dela.',
    view: 'Uma visualização não tem índices próprios',
    script: 'Script',
  },
  ko: {
    title: '인덱스 스크립트',
    description: (coll: string) =>
      `${coll}의 인덱스 또는 해당 데이터베이스 전체의 인덱스를 다시 만드는 명령으로 작성합니다. 아무것도 실행되지 않습니다.`,
    scope: '인덱스 범위',
    scopes: { collection: '이 컬렉션', database: '데이터베이스 전체' } satisfies Record<Scope, string>,
    format: '작성 대상',
    formats: FORMAT_NAMES,
    copy: '복사',
    download: '다운로드',
    reading: '인덱스를 읽는 중…',
    readingOf: (n: number, of: number) => `컬렉션 ${of}개 중 ${n}개의 인덱스를 읽는 중…`,
    counted: (indexes: number, colls: number) =>
      `컬렉션 ${formatNumber(colls, 'ko')}개에 인덱스 ${formatNumber(indexes, 'ko')}개`,
    idNote: '기본 _id 인덱스(또는 클러스터형 인덱스)는 컬렉션과 함께 만들어지므로 제외됩니다.',
    none: '작성할 인덱스가 없습니다',
    noneHint: '기본 _id 인덱스만 있습니다. 이 인덱스는 컬렉션과 함께 만들어집니다.',
    failed: '인덱스를 읽을 수 없습니다',
    tryAgain: '다시 시도',
    hidden: (n: number) => `인덱스 ${n}개에 사용자에게 숨겨진 값이 들어 있습니다`,
    hiddenHint:
      '해당 값은 "***"로 기록되고 표시됩니다. 이런 스크립트는 인덱스를 원래 그대로 만들지 않습니다.',
    skipped: (names: string) => `읽을 수 없음: ${names}`,
    skippedHint: '스크립트 맨 위에 해당 컬렉션이 명시되며, 그 인덱스는 만들어지지 않습니다.',
    jsonWaits:
      'JSON은 누락된 항목을 표시할 수 없으므로 모든 컬렉션을 읽을 때까지 복사와 다운로드를 사용할 수 없습니다.',
    limited: '데이터베이스 전체를 읽기 전에 중단되었습니다',
    limitedHint: '앱은 분당 읽을 수 있는 정의 수가 제한되어 있습니다. 1분 후에 다시 시도하세요.',
    unordered: (n: number) => `인덱스 ${n}개의 키에서 필드 순서가 다르게 표시될 수 있습니다`,
    unorderedHint:
      '숫자인 필드 이름("2")은 읽을 때 앞으로 정렬되어 만든 순서가 사라집니다. 해당 키를 확인하세요.',
    more: (n: number) => `처음 ${n}개 컬렉션만 읽으며 나머지는 제외됩니다.`,
    copyFailed: '복사하거나 저장할 수 없습니다: ',
    noPlace: '인덱스를 작성하려면 컬렉션을 여세요.',
    view: '뷰에는 자체 인덱스가 없습니다',
    script: '스크립트',
  },
  de: {
    title: 'Index-Skript',
    description: (coll: string) =>
      `Die Indizes von ${coll} oder der gesamten Datenbank als Befehle, die sie neu erstellen. Es wird nichts ausgeführt.`,
    scope: 'Indizes von',
    scopes: { collection: 'Diese Collection', database: 'Gesamte Datenbank' } satisfies Record<Scope, string>,
    format: 'Geschrieben für',
    formats: FORMAT_NAMES,
    copy: 'Kopieren',
    download: 'Herunterladen',
    reading: 'Indizes werden gelesen…',
    readingOf: (n: number, of: number) =>
      `Indizes von ${n} von ${of} ${pluralOf(of, 'de') === 'one' ? 'Collection' : 'Collections'} werden gelesen…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'de')} ${pluralOf(indexes, 'de') === 'one' ? 'Index' : 'Indizes'} in ${formatNumber(colls, 'de')} ${pluralOf(colls, 'de') === 'one' ? 'Collection' : 'Collections'}`,
    idNote:
      'Der Standardindex _id (oder ein geclusterter) wird mit seiner Collection erstellt und ausgelassen.',
    none: 'Kein Index zum Schreiben',
    noneHint: 'Es ist nur der Standardindex _id vorhanden: Er wird mit der Collection erstellt.',
    failed: 'Die Indizes konnten nicht gelesen werden',
    tryAgain: 'Erneut versuchen',
    hidden: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? 'Ein Index enthält Werte, die vor Ihnen verborgen sind'
        : `${n} Indizes enthalten Werte, die vor Ihnen verborgen sind`,
    hiddenHint:
      'Sie werden als "***" geschrieben und markiert: Ein solches Skript erstellt den Index nicht unverändert.',
    skipped: (names: string) => `Nicht lesbar: ${names}`,
    skippedHint: 'Das Skript nennt sie am Anfang: Es erstellt ihre Indizes nicht.',
    jsonWaits:
      'JSON kann nicht angeben, was fehlt: Kopieren und Herunterladen sind deaktiviert, bis alle Collections gelesen sind.',
    limited: 'Angehalten, bevor die gesamte Datenbank gelesen war',
    limitedHint:
      'Die App liest nur eine bestimmte Anzahl von Definitionen pro Minute. Versuchen Sie es in einer Minute erneut.',
    unordered: (n: number) =>
      pluralOf(n, 'de') === 'one'
        ? 'Der Schlüssel eines Index kann seine Felder in anderer Reihenfolge auflisten'
        : `Die Schlüssel von ${n} Indizes können ihre Felder in anderer Reihenfolge auflisten`,
    unorderedHint:
      'Feldnamen, die Zahlen sind ("2"), stehen nach dem Lesen zuerst, sodass die Reihenfolge ihrer Erstellung verloren geht: Prüfen Sie diese Schlüssel.',
    more: (n: number) => `Die ersten ${n} Collections werden gelesen; die übrigen werden ausgelassen.`,
    copyFailed: 'Kopieren oder Speichern nicht möglich: ',
    noPlace: 'Öffnen Sie eine Collection, um ihre Indizes zu schreiben.',
    view: 'Eine View hat keine eigenen Indizes',
    script: 'Skript',
  },
  fr: {
    title: 'Script d’index',
    description: (coll: string) =>
      `Les index de ${coll}, ou de sa base de données, sous forme de commandes qui les recréent. Rien n’est exécuté.`,
    scope: 'Index de',
    scopes: { collection: 'Cette collection', database: 'Toute la base de données' } satisfies Record<
      Scope,
      string
    >,
    format: 'Écrit pour',
    formats: FORMAT_NAMES,
    copy: 'Copier',
    download: 'Télécharger',
    reading: 'Lecture des index…',
    readingOf: (n: number, of: number) =>
      `Lecture des index de ${n} ${pluralOf(n, 'fr') === 'one' ? 'collection' : 'collections'} sur ${of}…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'fr')} index dans ${formatNumber(colls, 'fr')} ${pluralOf(colls, 'fr') === 'one' ? 'collection' : 'collections'}`,
    idNote: 'L’index _id par défaut (ou un index en cluster) est créé avec sa collection et est omis.',
    none: 'Aucun index à écrire',
    noneHint: 'Seul l’index _id par défaut est présent : il est créé avec la collection.',
    failed: 'Impossible de lire les index',
    tryAgain: 'Réessayer',
    hidden: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? 'Un index contient des valeurs qui vous sont masquées'
        : `${n} index contiennent des valeurs qui vous sont masquées`,
    hiddenHint: 'Elles sont écrites "***" et signalées : un tel script ne crée pas l’index tel quel.',
    skipped: (names: string) => `Lecture impossible : ${names}`,
    skippedHint: 'Le script les nomme en tête : il ne crée pas leurs index.',
    jsonWaits:
      'JSON ne peut pas indiquer ce qui manque : Copier et Télécharger sont désactivés tant que toutes les collections ne sont pas lues.',
    limited: 'Arrêté avant la lecture de toute la base de données',
    limitedHint:
      'L’application ne lit qu’un certain nombre de définitions par minute. Réessayez dans une minute.',
    unordered: (n: number) =>
      pluralOf(n, 'fr') === 'one'
        ? 'La clé d’un index peut lister ses champs dans un autre ordre'
        : `Les clés de ${n} index peuvent lister leurs champs dans un autre ordre`,
    unorderedHint:
      'Les noms de champ qui sont des nombres ("2") passent en premier à la lecture, si bien que l’ordre de création est perdu : vérifiez ces clés.',
    more: (n: number) => `Les ${n} premières collections sont lues ; les autres sont omises.`,
    copyFailed: 'Impossible de copier ou d’enregistrer : ',
    noPlace: 'Ouvrez une collection pour écrire ses index.',
    view: 'Une vue n’a pas d’index propre',
    script: 'Script',
  },
  ru: {
    title: 'Скрипт индексов',
    description: (coll: string) =>
      `Индексы коллекции ${coll} или всей ее базы данных в виде команд, которые создают их заново. Ничего не выполняется.`,
    scope: 'Индексы',
    scopes: { collection: 'Эта коллекция', database: 'Вся база данных' } satisfies Record<Scope, string>,
    format: 'Скрипт для',
    formats: FORMAT_NAMES,
    copy: 'Копировать',
    download: 'Скачать',
    reading: 'Чтение индексов…',
    readingOf: (n: number, of: number) => `Чтение индексов коллекций: ${n} из ${of}…`,
    counted: (indexes: number, colls: number) =>
      `${formatNumber(indexes, 'ru')} ${pluralOf(indexes, 'ru') === 'one' ? 'индекс' : pluralOf(indexes, 'ru') === 'few' ? 'индекса' : 'индексов'} в ${formatNumber(colls, 'ru')} ${pluralOf(colls, 'ru') === 'one' ? 'коллекции' : 'коллекциях'}`,
    idNote: 'Индекс _id по умолчанию (или кластеризованный) создается вместе с коллекцией и не включается.',
    none: 'Нет индексов для записи',
    noneHint: 'Здесь только индекс _id по умолчанию: он создается вместе с коллекцией.',
    failed: 'Не удалось прочитать индексы',
    tryAgain: 'Повторить',
    hidden: (n: number) =>
      n === 1
        ? 'Индекс содержит значения, скрытые от вас'
        : `${n} ${pluralOf(n, 'ru') === 'one' ? 'индекс содержит' : pluralOf(n, 'ru') === 'few' ? 'индекса содержат' : 'индексов содержат'} значения, скрытые от вас`,
    hiddenHint: 'Они записываются как "***" и помечаются: такой скрипт не создает индекс в исходном виде.',
    skipped: (names: string) => `Не удалось прочитать: ${names}`,
    skippedHint: 'Скрипт перечисляет их в начале: он не создает их индексы.',
    jsonWaits:
      'JSON не может указать, чего не хватает: «Копировать» и «Скачать» отключены, пока не прочитаны все коллекции.',
    limited: 'Остановлено до того, как прочитана вся база данных',
    limitedHint:
      'Приложение читает лишь ограниченное число определений в минуту. Повторите попытку через минуту.',
    unordered: (n: number) =>
      n === 1
        ? 'Ключ индекса может перечислять поля в другом порядке'
        : `Ключи ${n} ${pluralOf(n, 'ru') === 'one' ? 'индекса' : 'индексов'} могут перечислять поля в другом порядке`,
    unorderedHint:
      'Имена полей, являющиеся числами ("2"), после чтения идут первыми, поэтому порядок их создания теряется: проверьте эти ключи.',
    more: (n: number) => `Читаются коллекции: первые ${n}; остальные не включаются.`,
    copyFailed: 'Не удалось скопировать или сохранить: ',
    noPlace: 'Откройте коллекцию, чтобы записать ее индексы.',
    view: 'У представления нет собственных индексов',
    script: 'Скрипт',
  },
} satisfies Record<Language, Text>

type State =
  | { kind: 'idle' }
  | { kind: 'running'; looking?: [number, number] }
  | { kind: 'failed'; error: unknown }
  | {
      kind: 'done'
      collections: CollectionIndexes[]
      /** Collections whose indexes could not be read, and why (review I2). */
      skipped: Array<{ coll: string; error: unknown }>
      more: boolean
    }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  let problem: unknown = null

  const copyButton = button({ label: text.copy, icon: 'copy', id: 'copy' })
  const downloadButton = button({ label: text.download, icon: 'download', id: 'download' })
  const header = pageHeader({
    icon: 'code',
    title: text.title,
    description: '',
    actions: [copyButton, downloadButton],
  })
  const scope = segmented<Scope>({
    label: text.scope,
    id: 'scope',
    value: 'collection',
    options: (['collection', 'database'] as Scope[]).map((value) => ({ value, label: text.scopes[value] })),
    onChange: () => void read(),
  })
  const format = segmented<Format>({
    label: text.format,
    id: 'format',
    value: 'mongosh',
    options: FORMATS.map((value) => ({ value, label: text.formats[value] })),
    onChange: () => render(),
  })
  const scopeLabel = h('span', { class: 'mm-label' })
  const formatLabel = h('span', { class: 'mm-label' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'is-notes' })
  const output = h('pre', { id: 'script', class: 'mm-mono is-script', attrs: { tabindex: '0' } })
  const results = h('div', { id: 'results', class: 'is-results' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h(
        'div',
        { class: 'mm-body' },
        h(
          'div',
          { class: 'is-controls' },
          h('div', { class: 'mm-field' }, scopeLabel, scope.el),
          h('div', { class: 'mm-field' }, formatLabel, format.el),
        ),
        h('div', { class: 'mm-summary' }, status),
        notes,
        results,
      ),
    ),
  )

  const script = () =>
    state.kind === 'done'
      ? writeScript(
          state.collections,
          format.value(),
          state.skipped.map((s) => s.coll),
        )
      : null
  /** JSON has no place to say what is missing: it is not copied or saved without it (review I2). */
  const jsonWaits = () => state.kind === 'done' && state.skipped.length > 0 && format.value() === 'json'

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    setLabel(copyButton, text.copy)
    setLabel(downloadButton, text.download)
    scopeLabel.textContent = text.scope
    formatLabel.textContent = text.format
    scope.relabel(text.scopes)
    format.relabel(text.formats)
    scope.el.setAttribute('aria-label', text.scope)
    format.el.setAttribute('aria-label', text.format)
    output.setAttribute('aria-label', text.script)
  }

  function act(ask: Promise<unknown>): void {
    void ask.then(
      () => {
        if (problem === null) return
        problem = null
        render()
      },
      (e: unknown) => {
        problem = e
        render()
      },
    )
  }

  function render(): void {
    notes.replaceChildren()
    status.textContent = ''
    const done = script()
    copyButton.disabled = downloadButton.disabled = !done || done.count === 0 || jsonWaits()
    if (!ctx) return
    if (!ctx.place) return void results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = state.looking ? text.readingOf(...state.looking) : text.reading
      return void results.replaceChildren(skeleton(4))
    }
    if (state.kind === 'failed') {
      // Stopped part way through a database: one collection's read says it in the app's words.
      const limited =
        state.error instanceof AskError && state.error.code === 'too_many' && scope.value() === 'database'
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: limited ? text.limited : text.failed,
          hint: limited ? text.limitedHint : askMessage(state.error, locale),
          action: button({ label: text.tryAgain, icon: 'refresh', onClick: () => void read() }),
        }),
      )
    }
    if (problem !== null) notes.append(callout('danger', `${text.copyFailed}${askMessage(problem, locale)}`))
    if (state.skipped.length)
      notes.append(
        callout(
          'warning',
          text.skipped(state.skipped.map((s) => `${s.coll} (${askMessage(s.error, locale)})`).join('; ')),
          jsonWaits() ? text.jsonWaits : text.skippedHint,
        ),
      )
    if (state.more) notes.append(callout('info', text.more(MAX_COLLECTIONS)))
    if (!done || done.count === 0) {
      const view = scope.value() === 'collection' && ctx.place.view
      return void results.replaceChildren(
        emptyState({
          icon: 'code',
          title: view ? text.view : text.none,
          hint: view ? undefined : text.noneHint,
        }),
      )
    }
    status.textContent = text.counted(
      done.count,
      state.collections.filter((c) => c.indexes.some((i) => i.name !== '_id_')).length,
    )
    if (done.hidden.length) notes.append(callout('warning', text.hidden(done.hidden.length), text.hiddenHint))
    if (done.unordered.length)
      notes.append(
        callout(
          'warning',
          text.unordered(done.unordered.length),
          `${text.unorderedHint} ${done.unordered.join(', ')}`,
        ),
      )
    output.textContent = done.text
    results.replaceChildren(output, h('p', { class: 'mm-status', text: text.idNote }))
  }

  async function read(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    problem = null
    state = { kind: 'running' }
    render()
    try {
      if (scope.value() === 'collection') {
        const indexes = await client.ask<ListedIndex[]>('indexes.list')
        if (run !== running) return
        state = { kind: 'done', collections: [{ coll: ctx.place.coll, indexes }], skipped: [], more: false }
      } else {
        const listed = await client.ask<Array<{ name: string; type: string }>>('collections.list')
        // A view has no indexes of its own.
        const names = listed.filter((c) => c.type !== 'view').map((c) => c.name)
        const asked = names.slice(0, MAX_COLLECTIONS)
        const collections: CollectionIndexes[] = []
        const skipped: Array<{ coll: string; error: unknown }> = []
        for (const [n, coll] of asked.entries()) {
          if (run !== running) return
          state = { kind: 'running', looking: [n + 1, asked.length] }
          render()
          try {
            collections.push({ coll, indexes: await client.ask<ListedIndex[]>('indexes.list', { coll }) })
          } catch (e) {
            // Past the minute's reads, the rest would fail too: the run stops and says why (review I2).
            if (e instanceof AskError && e.code === 'too_many') throw e
            skipped.push({ coll, error: e })
          }
        }
        if (run !== running) return
        state = { kind: 'done', collections, skipped, more: names.length > asked.length }
      }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
    }
    render()
  }

  copyButton.addEventListener('click', () => {
    const done = script()
    if (done?.count) act(client.ask('ui.copy', { text: done.text }))
  })
  downloadButton.addEventListener('click', () => {
    const done = script()
    if (!done?.count || !ctx?.place) return
    const json = format.value() === 'json'
    const base = scope.value() === 'database' ? ctx.place.db : `${ctx.place.db}.${ctx.place.coll}`
    act(
      client.ask('ui.download', {
        type: json ? 'json' : 'text',
        name: `${base}-indexes-${format.value()}`,
        text: done.text,
      }),
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
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    render()
    void read()
  })
  applyText()
}
