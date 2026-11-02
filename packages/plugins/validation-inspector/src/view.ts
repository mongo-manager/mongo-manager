import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  langTag,
  pick,
  pluralOf,
  shown,
  type Language,
  pageHeader,
  segmented,
  setBusy,
  setLabel,
  serialAsk,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { shellText } from '../../kit/src/shell'
import { breaking, checkPlan, readCheck, type CheckResult, type Doc, type Rule } from './rules'

/**
 * Validation inspector (research 2026-10-28: SERVER-20547, CUSTOMER-I-6820): the collection's
 * validation rules one by one, with how many of its documents break each — over a random sample or
 * the whole collection, in one read — and each rule's documents shown in Documents. Changes nothing.
 */
type Size = '1000' | '10000' | 'all'
const SIZES: Size[] = ['1000', '10000', 'all']

/** A value as the shell writes it, on one line and cut short. */
const brief = (v: unknown, max = 120): string => {
  const one = shellText(v).replace(/\s*\n\s*/g, ' ')
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
/** A property's checks ("bsonType: 'int', minimum: 0"), descriptions left out. */
const checksOf = (sub: unknown): string => {
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return brief(sub)
  return Object.entries(sub as Doc)
    .filter(([k]) => k !== 'description' && k !== 'title')
    .map(([k, v]) => `${k}: ${brief(v, 60)}`)
    .join(', ')
}

/** Whether a count takes the singular form of a language (French: 0 and 1 both). */
const isOne = (n: number, language: Language): boolean => pluralOf(n, language) === 'one'
/** A plural form of a language by the count's category (few and other fall back to many). */
const form = (n: number, language: Language, f: { one: string; few: string; many: string }): string => {
  const category = pluralOf(n, language)
  return category === 'one' ? f.one : category === 'few' ? f.few : f.many
}

const en = {
  title: 'Validation check',
  description: (coll: string) =>
    `Checks the documents of ${coll} against its validation rules one by one: how many break each rule. Changes nothing.`,
  check: 'Check',
  size: 'Documents to check',
  sizeSample: (n: string) => `${n} at random`,
  sizeAll: 'All',
  checking: 'Checking documents…',
  noPlace: 'Open a collection to check it.',
  view: 'A view has no validation rules of its own',
  viewHint: 'Its documents are those of the collection it reads; check that collection.',
  none: 'This collection has no validation rules',
  noneHint: 'Rules are added in the collection’s Validation section.',
  failed: 'The check could not run',
  tryAgain: 'Try again',
  read: (n: number, s: string) => `${s} ${isOne(n, 'en') ? 'document' : 'documents'} checked`,
  broken: (n: number, s: string, share: string) =>
    `${s} ${isOne(n, 'en') ? 'breaks' : 'break'} the rules (${share})`,
  clean: 'Every document checked follows the rules',
  cleanHint: (n: number, s: string) =>
    isOne(n, 'en')
      ? 'The document checked does not break a rule.'
      : `None of the ${s} documents checked breaks a rule.`,
  empty: 'No documents to check',
  emptyHint: 'This collection is empty.',
  level: (level: string, action: string) => `Level: ${level} · Action: ${action}`,
  levelNote: 'Writes that break the rules may still be made',
  levelHint:
    'Level “moderate” checks only documents that already follow the rules; action “warn” logs a broken rule instead of refusing the write.',
  hidden: 'Rules about fields hidden from you are not checked',
  hiddenHint:
    'What a rule says about a field whose values are hidden from you is not given to this plugin; the counts are those of the rules shown.',
  allHint: 'A whole collection may take longer than a check is given: choose a random sample.',
  deepHint: 'The validator is nested deeper than a plugin’s pipeline may be, so it cannot be checked here.',
  more: (n: number) => `The first ${n} rules are checked; the others are not counted.`,
  required: (name: string) => `${name} is required`,
  property: (name: string) => `${name}`,
  additional: 'No fields but the schema’s own',
  additionalHint: (names: string, patterns: string) =>
    [names ? `Allowed: ${names}` : 'No field is listed', patterns ? `and fields matching ${patterns}` : '']
      .filter(Boolean)
      .join(' '),
  keyword: (name: string) => `Schema keyword ${name}`,
  condition: 'Condition',
  documents: (n: number, s: string, share: string) =>
    `${s} ${isOne(n, 'en') ? 'document' : 'documents'} (${share})`,
  none0: 'No document breaks it',
  show: 'Show in Documents',
  showHint: 'Puts a filter selecting the documents that break this rule in the Documents query',
  showAll: 'Show all that break the rules',
  showFailed: 'Could not open Documents: ',
  sampleNote: 'A random sample: the counts are of the documents checked, not of the whole collection.',
}
type Text = typeof en

/** Every language has every entry: a missing one fails to compile. */
export const TEXT = {
  en,
  tr: {
    title: 'Doğrulama denetimi',
    description: (coll: string) =>
      `${coll} belgelerini doğrulama kurallarına göre tek tek denetler: her kuralı kaç belge bozuyor. Hiçbir şeyi değiştirmez.`,
    check: 'Denetle',
    size: 'Denetlenecek belgeler',
    sizeSample: (n: string) => `Rastgele ${n}`,
    sizeAll: 'Tümü',
    checking: 'Belgeler denetleniyor…',
    noPlace: 'Denetlemek için bir koleksiyon açın.',
    view: 'Bir görünümün kendine ait doğrulama kuralı yoktur',
    viewHint: 'Belgeleri okuduğu koleksiyonunkilerdir; o koleksiyonu denetleyin.',
    none: 'Bu koleksiyonun doğrulama kuralı yok',
    noneHint: 'Kurallar koleksiyonun Doğrulama bölümünden eklenir.',
    failed: 'Denetim çalışamadı',
    tryAgain: 'Yeniden dene',
    read: (_n: number, s: string) => `${s} belge denetlendi`,
    broken: (_n: number, s: string, share: string) => `${s} belge kurallara uymuyor (${share})`,
    clean: 'Denetlenen her belge kurallara uyuyor',
    cleanHint: (_n: number, s: string) => `Denetlenen ${s} belgeden hiçbiri bir kuralı bozmuyor.`,
    empty: 'Denetlenecek belge yok',
    emptyHint: 'Bu koleksiyon boş.',
    level: (level: string, action: string) => `Seviye: ${level} · Eylem: ${action}`,
    levelNote: 'Kurallara uymayan yazmalar yine de yapılabilir',
    levelHint:
      '“moderate” seviyesi yalnızca kurallara zaten uyan belgeleri denetler; “warn” eylemi bozulan kuralı yazmayı reddetmek yerine günlüğe yazar.',
    hidden: 'Sizden gizlenen alanlarla ilgili kurallar denetlenmez',
    hiddenHint:
      'Bir kuralın, değerleri sizden gizlenen bir alan hakkında söyledikleri bu eklentiye verilmez; sayılar gösterilen kurallarınkidir.',
    allHint: 'Bir koleksiyonun tamamı bir denetime verilen süreden uzun sürebilir: rastgele bir örnek seçin.',
    deepHint:
      'Doğrulayıcı, bir eklentinin pipeline’ının olabileceğinden daha derin iç içe; bu yüzden burada denetlenemez.',
    more: (n: number) => `İlk ${n} kural denetlenir; diğerleri sayılmaz.`,
    required: (name: string) => `${name} zorunlu`,
    property: (name: string) => `${name}`,
    additional: 'Şemadakiler dışında alan yok',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `İzin verilenler: ${names}` : 'Hiçbir alan listelenmemiş',
        patterns ? `ve ${patterns} desenine uyan alanlar` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Şema anahtar sözcüğü ${name}`,
    condition: 'Koşul',
    documents: (_n: number, s: string, share: string) => `${s} belge (${share})`,
    none0: 'Bozan belge yok',
    show: 'Belgelerde göster',
    showHint: 'Bu kuralı bozan belgeleri seçen bir filtreyi Belgeler sorgusuna koyar',
    showAll: 'Kurallara uymayanların hepsini göster',
    showFailed: 'Belgeler açılamadı: ',
    sampleNote: 'Rastgele bir örnek: sayılar denetlenen belgelerin, koleksiyonun tamamının değil.',
  },
  zh: {
    title: '验证检查',
    description: (coll: string) =>
      `按验证规则逐条检查 ${coll} 的文档：每条规则有多少文档违反。不会更改任何内容。`,
    check: '检查',
    size: '要检查的文档',
    sizeSample: (n: string) => `随机 ${n} 个`,
    sizeAll: '全部',
    checking: '正在检查文档…',
    noPlace: '打开一个集合以进行检查。',
    view: '视图本身没有验证规则',
    viewHint: '视图的文档来自它所读取的集合；请检查该集合。',
    none: '此集合没有验证规则',
    noneHint: '规则可在集合的“验证”部分添加。',
    failed: '检查无法运行',
    tryAgain: '重试',
    read: (_n: number, s: string) => `已检查 ${s} 个文档`,
    broken: (_n: number, s: string, share: string) => `${s} 个文档违反规则（${share}）`,
    clean: '所有已检查的文档都符合规则',
    cleanHint: (_n: number, s: string) => `已检查的 ${s} 个文档中没有违反任何规则的。`,
    empty: '没有可检查的文档',
    emptyHint: '此集合为空。',
    level: (level: string, action: string) => `级别：${level} · 操作：${action}`,
    levelNote: '违反规则的写入仍可能成功',
    levelHint: '级别“moderate”只检查已符合规则的文档；操作“warn”会在违反规则时记录日志，而不是拒绝写入。',
    hidden: '不会检查涉及对您隐藏的字段的规则',
    hiddenHint: '规则中关于值对您隐藏的字段的内容不会提供给此插件；统计的是所显示规则的结果。',
    allHint: '检查整个集合可能超出检查允许的时间：请选择随机采样。',
    deepHint: '验证器的嵌套层级超过了插件管道允许的深度，因此无法在此检查。',
    more: (n: number) => `仅检查前 ${n} 条规则；其余规则不计入。`,
    required: (name: string) => `${name} 为必填`,
    property: (name: string) => `${name}`,
    additional: '除模式自身定义的字段外，不允许其他字段',
    additionalHint: (names: string, patterns: string) =>
      [names ? `允许：${names}` : '未列出任何字段', patterns ? `以及匹配 ${patterns} 的字段` : '']
        .filter(Boolean)
        .join('，'),
    keyword: (name: string) => `模式关键字 ${name}`,
    condition: '条件',
    documents: (_n: number, s: string, share: string) => `${s} 个文档（${share}）`,
    none0: '没有文档违反',
    show: '在文档中显示',
    showHint: '在文档查询中放入一个筛选条件，用于选出违反此规则的文档',
    showAll: '显示所有违反规则的文档',
    showFailed: '无法打开文档：',
    sampleNote: '随机采样：统计的是已检查的文档，而非整个集合。',
  },
  ja: {
    title: '検証チェック',
    description: (coll: string) =>
      `${coll} のドキュメントを検証ルールに照らして 1 件ずつ確認し、ルールごとに違反しているドキュメント数を表示します。何も変更しません。`,
    check: 'チェック',
    size: 'チェックするドキュメント',
    sizeSample: (n: string) => `ランダムに ${n} 件`,
    sizeAll: 'すべて',
    checking: 'ドキュメントをチェックしています…',
    noPlace: 'チェックするにはコレクションを開いてください。',
    view: 'ビュー自体には検証ルールがありません',
    viewHint:
      'ビューのドキュメントは参照元のコレクションのものです。そのコレクションをチェックしてください。',
    none: 'このコレクションには検証ルールがありません',
    noneHint: 'ルールはコレクションの「検証」セクションで追加します。',
    failed: 'チェックを実行できませんでした',
    tryAgain: '再試行',
    read: (_n: number, s: string) => `${s} 件のドキュメントをチェックしました`,
    broken: (_n: number, s: string, share: string) =>
      `${s} 件のドキュメントがルールに違反しています（${share}）`,
    clean: 'チェックしたすべてのドキュメントがルールに適合しています',
    cleanHint: (_n: number, s: string) =>
      `チェックした ${s} 件のドキュメントに、ルールに違反するものはありません。`,
    empty: 'チェックするドキュメントがありません',
    emptyHint: 'このコレクションは空です。',
    level: (level: string, action: string) => `レベル: ${level} · アクション: ${action}`,
    levelNote: 'ルールに違反する書き込みも実行される場合があります',
    levelHint:
      'レベル「moderate」はすでにルールに適合しているドキュメントのみを検証します。アクション「warn」は、ルール違反時に書き込みを拒否せず、ログに記録します。',
    hidden: '非表示のフィールドに関するルールはチェックされません',
    hiddenHint:
      '値が非表示のフィールドについてルールが定めている内容は、このプラグインには渡されません。件数は表示されているルールのものです。',
    allHint:
      'コレクション全体のチェックは、許可された時間を超える場合があります。ランダムサンプルを選択してください。',
    deepHint:
      'バリデーターのネストがプラグインのパイプラインで許可される深さを超えているため、ここではチェックできません。',
    more: (n: number) => `最初の ${n} 件のルールをチェックします。残りはカウントされません。`,
    required: (name: string) => `${name} は必須です`,
    property: (name: string) => `${name}`,
    additional: 'スキーマで定義されたフィールド以外は不可',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `許可: ${names}` : 'フィールドが指定されていません',
        patterns ? `および ${patterns} に一致するフィールド` : '',
      ]
        .filter(Boolean)
        .join('、'),
    keyword: (name: string) => `スキーマキーワード ${name}`,
    condition: '条件',
    documents: (_n: number, s: string, share: string) => `${s} 件のドキュメント（${share}）`,
    none0: '違反するドキュメントはありません',
    show: 'ドキュメントで表示',
    showHint: 'このルールに違反するドキュメントを選択するフィルターをドキュメントのクエリに設定します',
    showAll: 'ルールに違反するものをすべて表示',
    showFailed: 'ドキュメントを開けませんでした: ',
    sampleNote: 'ランダムサンプル: 件数はコレクション全体ではなく、チェックしたドキュメントのものです。',
  },
  es: {
    title: 'Comprobación de validación',
    description: (coll: string) =>
      `Comprueba uno a uno los documentos de ${coll} con sus reglas de validación: cuántos incumplen cada regla. No cambia nada.`,
    check: 'Comprobar',
    size: 'Documentos que comprobar',
    sizeSample: (n: string) => `${n} al azar`,
    sizeAll: 'Todos',
    checking: 'Comprobando documentos…',
    noPlace: 'Abre una colección para comprobarla.',
    view: 'Una vista no tiene reglas de validación propias',
    viewHint: 'Sus documentos son los de la colección que lee; comprueba esa colección.',
    none: 'Esta colección no tiene reglas de validación',
    noneHint: 'Las reglas se añaden en la sección Validación de la colección.',
    failed: 'No se pudo ejecutar la comprobación',
    tryAgain: 'Reintentar',
    read: (n: number, s: string) =>
      `${s} ${isOne(n, 'es') ? 'documento comprobado' : 'documentos comprobados'}`,
    broken: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'es') ? 'incumple' : 'incumplen'} las reglas (${share})`,
    clean: 'Todos los documentos comprobados cumplen las reglas',
    cleanHint: (n: number, s: string) =>
      isOne(n, 'es')
        ? 'El documento comprobado no incumple ninguna regla.'
        : `Ninguno de los ${s} documentos comprobados incumple una regla.`,
    empty: 'No hay documentos que comprobar',
    emptyHint: 'Esta colección está vacía.',
    level: (level: string, action: string) => `Nivel: ${level} · Acción: ${action}`,
    levelNote: 'Aún se pueden hacer escrituras que incumplan las reglas',
    levelHint:
      'El nivel «moderate» solo comprueba los documentos que ya cumplen las reglas; la acción «warn» registra en el log una regla incumplida en lugar de rechazar la escritura.',
    hidden: 'No se comprueban las reglas sobre campos que se te ocultan',
    hiddenHint:
      'Lo que dice una regla sobre un campo cuyos valores se te ocultan no se entrega a este complemento; los recuentos son los de las reglas mostradas.',
    allHint:
      'Una colección entera puede tardar más de lo que se concede a una comprobación: elige una muestra al azar.',
    deepHint:
      'El validador está anidado a más profundidad de la que admite el pipeline de un complemento, por lo que no se puede comprobar aquí.',
    more: (n: number) => `Se comprueban las primeras ${n} reglas; las demás no se cuentan.`,
    required: (name: string) => `${name} es obligatorio`,
    property: (name: string) => `${name}`,
    additional: 'Ningún campo aparte de los del esquema',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `Permitidos: ${names}` : 'No se lista ningún campo',
        patterns ? `y los campos que coincidan con ${patterns}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Palabra clave del esquema ${name}`,
    condition: 'Condición',
    documents: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'es') ? 'documento' : 'documentos'} (${share})`,
    none0: 'Ningún documento la incumple',
    show: 'Mostrar en Documentos',
    showHint:
      'Coloca en la consulta de Documentos un filtro que selecciona los documentos que incumplen esta regla',
    showAll: 'Mostrar todos los que incumplen las reglas',
    showFailed: 'No se pudo abrir Documentos: ',
    sampleNote:
      'Una muestra al azar: los recuentos son de los documentos comprobados, no de toda la colección.',
  },
  pt: {
    title: 'Verificação de validação',
    description: (coll: string) =>
      `Verifica um a um os documentos de ${coll} com as regras de validação: quantos violam cada regra. Não altera nada.`,
    check: 'Verificar',
    size: 'Documentos a verificar',
    sizeSample: (n: string) => `${n} aleatórios`,
    sizeAll: 'Todos',
    checking: 'Verificando documentos…',
    noPlace: 'Abra uma coleção para verificá-la.',
    view: 'Uma visualização não tem regras de validação próprias',
    viewHint: 'Os documentos dela são os da coleção que ela lê; verifique essa coleção.',
    none: 'Esta coleção não tem regras de validação',
    noneHint: 'As regras são adicionadas na seção Validação da coleção.',
    failed: 'Não foi possível executar a verificação',
    tryAgain: 'Tentar novamente',
    read: (n: number, s: string) =>
      `${s} ${isOne(n, 'pt') ? 'documento verificado' : 'documentos verificados'}`,
    broken: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'pt') ? 'viola' : 'violam'} as regras (${share})`,
    clean: 'Todos os documentos verificados seguem as regras',
    cleanHint: (n: number, s: string) =>
      isOne(n, 'pt')
        ? 'O documento verificado não viola nenhuma regra.'
        : `Nenhum dos ${s} documentos verificados viola uma regra.`,
    empty: 'Não há documentos para verificar',
    emptyHint: 'Esta coleção está vazia.',
    level: (level: string, action: string) => `Nível: ${level} · Ação: ${action}`,
    levelNote: 'Gravações que violam as regras ainda podem ser feitas',
    levelHint:
      'O nível “moderate” verifica apenas documentos que já seguem as regras; a ação “warn” registra no log uma regra violada em vez de recusar a gravação.',
    hidden: 'Regras sobre campos ocultos para você não são verificadas',
    hiddenHint:
      'O que uma regra diz sobre um campo cujos valores estão ocultos para você não é entregue a este plugin; as contagens são as das regras exibidas.',
    allHint:
      'Uma coleção inteira pode levar mais tempo do que o concedido a uma verificação: escolha uma amostra aleatória.',
    deepHint:
      'O validador tem um aninhamento mais profundo do que o pipeline de um plugin permite, por isso não pode ser verificado aqui.',
    more: (n: number) => `As primeiras ${n} regras são verificadas; as demais não são contadas.`,
    required: (name: string) => `${name} é obrigatório`,
    property: (name: string) => `${name}`,
    additional: 'Nenhum campo além dos do esquema',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `Permitidos: ${names}` : 'Nenhum campo listado',
        patterns ? `e campos que correspondem a ${patterns}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Palavra-chave do esquema ${name}`,
    condition: 'Condição',
    documents: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'pt') ? 'documento' : 'documentos'} (${share})`,
    none0: 'Nenhum documento a viola',
    show: 'Mostrar em Documentos',
    showHint: 'Coloca na consulta de Documentos um filtro que seleciona os documentos que violam esta regra',
    showAll: 'Mostrar todos os que violam as regras',
    showFailed: 'Não foi possível abrir Documentos: ',
    sampleNote: 'Uma amostra aleatória: as contagens são dos documentos verificados, não de toda a coleção.',
  },
  ko: {
    title: '유효성 검사 점검',
    description: (coll: string) =>
      `${coll}의 도큐먼트를 유효성 검사 규칙별로 하나씩 점검합니다. 규칙마다 위반하는 도큐먼트가 몇 개인지 보여 줍니다. 아무것도 변경하지 않습니다.`,
    check: '점검',
    size: '점검할 도큐먼트',
    sizeSample: (n: string) => `무작위 ${n}개`,
    sizeAll: '전체',
    checking: '도큐먼트를 점검하는 중…',
    noPlace: '점검하려면 컬렉션을 여세요.',
    view: '뷰에는 자체 유효성 검사 규칙이 없습니다',
    viewHint: '뷰의 도큐먼트는 뷰가 읽어 오는 컬렉션의 도큐먼트입니다. 해당 컬렉션을 점검하세요.',
    none: '이 컬렉션에는 유효성 검사 규칙이 없습니다',
    noneHint: '규칙은 컬렉션의 유효성 검사 탭에서 추가합니다.',
    failed: '점검을 실행할 수 없습니다',
    tryAgain: '다시 시도',
    read: (_n: number, s: string) => `도큐먼트 ${s}개 점검됨`,
    broken: (_n: number, s: string, share: string) => `도큐먼트 ${s}개가 규칙을 위반합니다 (${share})`,
    clean: '점검한 모든 도큐먼트가 규칙을 따릅니다',
    cleanHint: (_n: number, s: string) => `점검한 도큐먼트 ${s}개 중 규칙을 위반하는 도큐먼트는 없습니다.`,
    empty: '점검할 도큐먼트가 없습니다',
    emptyHint: '이 컬렉션은 비어 있습니다.',
    level: (level: string, action: string) => `수준: ${level} · 동작: ${action}`,
    levelNote: '규칙을 위반하는 쓰기가 여전히 수행될 수 있습니다',
    levelHint:
      '수준 “moderate”는 이미 규칙을 따르는 도큐먼트만 점검하고, 동작 “warn”은 규칙 위반 시 쓰기를 거부하는 대신 로그에 기록합니다.',
    hidden: '숨겨진 필드에 대한 규칙은 점검하지 않습니다',
    hiddenHint:
      '값이 숨겨진 필드에 대해 규칙이 정의한 내용은 이 플러그인에 전달되지 않으며, 집계 수는 표시된 규칙 기준입니다.',
    allHint: '컬렉션 전체는 점검에 허용된 시간보다 오래 걸릴 수 있습니다. 무작위 샘플을 선택하세요.',
    deepHint:
      '유효성 검사기의 중첩이 플러그인 파이프라인에서 허용하는 깊이보다 깊어 여기서는 점검할 수 없습니다.',
    more: (n: number) => `처음 ${n}개 규칙만 점검하며, 나머지는 집계하지 않습니다.`,
    required: (name: string) => `필수 필드: ${name}`,
    property: (name: string) => `${name}`,
    additional: '스키마에 정의된 필드만 허용',
    additionalHint: (names: string, patterns: string) =>
      [names ? `허용: ${names}` : '나열된 필드 없음', patterns ? `및 ${patterns} 패턴과 일치하는 필드` : '']
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `스키마 키워드 ${name}`,
    condition: '조건',
    documents: (_n: number, s: string, share: string) => `도큐먼트 ${s}개 (${share})`,
    none0: '위반하는 도큐먼트 없음',
    show: '도큐먼트에서 보기',
    showHint: '이 규칙을 위반하는 도큐먼트를 선택하는 필터를 도큐먼트 쿼리에 넣습니다',
    showAll: '규칙을 위반하는 도큐먼트 모두 보기',
    showFailed: '도큐먼트를 열 수 없습니다: ',
    sampleNote: '무작위 샘플입니다. 집계 수는 컬렉션 전체가 아니라 점검한 도큐먼트 기준입니다.',
  },
  de: {
    title: 'Validierungsprüfung',
    description: (coll: string) =>
      `Prüft die Dokumente von ${coll} einzeln anhand der Validierungsregeln: wie viele Dokumente gegen die jeweilige Regel verstoßen. Ändert nichts.`,
    check: 'Prüfen',
    size: 'Zu prüfende Dokumente',
    sizeSample: (n: string) => `${n} zufällig`,
    sizeAll: 'Alle',
    checking: 'Dokumente werden geprüft…',
    noPlace: 'Öffnen Sie eine Collection, um sie zu prüfen.',
    view: 'Eine View hat keine eigenen Validierungsregeln',
    viewHint:
      'Ihre Dokumente sind die der Collection, aus der sie liest. Prüfen Sie stattdessen diese Collection.',
    none: 'Diese Collection hat keine Validierungsregeln',
    noneHint: 'Regeln werden im Tab „Validierung“ der Collection hinzugefügt.',
    failed: 'Die Prüfung konnte nicht ausgeführt werden',
    tryAgain: 'Erneut versuchen',
    read: (n: number, s: string) => `${s} ${isOne(n, 'de') ? 'Dokument' : 'Dokumente'} geprüft`,
    broken: (n: number, s: string, share: string) =>
      isOne(n, 'de')
        ? `${s} Dokument verstößt gegen die Regeln (${share})`
        : `${s} Dokumente verstoßen gegen die Regeln (${share})`,
    clean: 'Alle geprüften Dokumente halten die Regeln ein',
    cleanHint: (n: number, s: string) =>
      isOne(n, 'de')
        ? 'Das geprüfte Dokument verstößt gegen keine Regel.'
        : `Keines der ${s} geprüften Dokumente verstößt gegen eine Regel.`,
    empty: 'Keine Dokumente zu prüfen',
    emptyHint: 'Diese Collection ist leer.',
    level: (level: string, action: string) => `Level: ${level} · Aktion: ${action}`,
    levelNote: 'Schreibvorgänge, die gegen die Regeln verstoßen, sind weiterhin möglich',
    levelHint:
      'Das Level „moderate“ prüft nur Dokumente, die die Regeln bereits einhalten; die Aktion „warn“ protokolliert eine verletzte Regel, statt den Schreibvorgang abzulehnen.',
    hidden: 'Regeln zu Feldern, die vor Ihnen verborgen sind, werden nicht geprüft',
    hiddenHint:
      'Was eine Regel über ein Feld sagt, dessen Werte vor Ihnen verborgen sind, wird diesem Plugin nicht übergeben; die Zahlen beziehen sich auf die angezeigten Regeln.',
    allHint:
      'Eine ganze Collection kann länger dauern, als einer Prüfung zugestanden wird: Wählen Sie eine zufällige Stichprobe.',
    deepHint:
      'Der Validator ist tiefer verschachtelt, als die Pipeline eines Plugins sein darf, und kann hier daher nicht geprüft werden.',
    more: (n: number) => `Die ersten ${n} Regeln werden geprüft; die übrigen werden nicht gezählt.`,
    required: (name: string) => `${name} ist erforderlich`,
    property: (name: string) => `${name}`,
    additional: 'Keine Felder außer denen des Schemas',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `Erlaubt: ${names}` : 'Kein Feld aufgeführt',
        patterns ? `und Felder, die ${patterns} entsprechen` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Schema-Schlüsselwort ${name}`,
    condition: 'Bedingung',
    documents: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'de') ? 'Dokument' : 'Dokumente'} (${share})`,
    none0: 'Kein Dokument verstößt dagegen',
    show: 'In Dokumente anzeigen',
    showHint:
      'Setzt einen Filter in die Abfrage von Dokumente, der die Dokumente auswählt, die gegen diese Regel verstoßen',
    showAll: 'Alle Verstöße gegen die Regeln anzeigen',
    showFailed: 'Dokumente konnten nicht geöffnet werden: ',
    sampleNote:
      'Eine zufällige Stichprobe: Die Zahlen beziehen sich auf die geprüften Dokumente, nicht auf die gesamte Collection.',
  },
  fr: {
    title: 'Contrôle de validation',
    description: (coll: string) =>
      `Vérifie un à un les documents de ${coll} par rapport à ses règles de validation : combien enfreignent chaque règle. Ne modifie rien.`,
    check: 'Vérifier',
    size: 'Documents à vérifier',
    sizeSample: (n: string) => `${n} au hasard`,
    sizeAll: 'Tous',
    checking: 'Vérification des documents…',
    noPlace: 'Ouvrez une collection pour la vérifier.',
    view: 'Une vue n’a pas de règles de validation propres',
    viewHint: 'Ses documents sont ceux de la collection qu’elle lit ; vérifiez cette collection.',
    none: 'Cette collection n’a aucune règle de validation',
    noneHint: 'Les règles s’ajoutent dans l’onglet Validation de la collection.',
    failed: 'La vérification n’a pas pu s’exécuter',
    tryAgain: 'Réessayer',
    read: (n: number, s: string) => `${s} ${isOne(n, 'fr') ? 'document vérifié' : 'documents vérifiés'}`,
    broken: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'fr') ? 'document enfreint' : 'documents enfreignent'} les règles (${share})`,
    clean: 'Tous les documents vérifiés respectent les règles',
    cleanHint: (n: number, s: string) =>
      isOne(n, 'fr')
        ? 'Le document vérifié n’enfreint aucune règle.'
        : `Aucun des ${s} documents vérifiés n’enfreint une règle.`,
    empty: 'Aucun document à vérifier',
    emptyHint: 'Cette collection est vide.',
    level: (level: string, action: string) => `Niveau : ${level} · Action : ${action}`,
    levelNote: 'Les écritures qui enfreignent les règles restent possibles',
    levelHint:
      'Le niveau « moderate » ne vérifie que les documents qui respectent déjà les règles ; l’action « warn » consigne une règle enfreinte dans le journal au lieu de refuser l’écriture.',
    hidden: 'Les règles portant sur des champs qui vous sont masqués ne sont pas vérifiées',
    hiddenHint:
      'Ce qu’une règle dit d’un champ dont les valeurs vous sont masquées n’est pas transmis à ce plug-in ; les totaux sont ceux des règles affichées.',
    allHint:
      'Une collection entière peut prendre plus de temps que celui accordé à une vérification : choisissez un échantillon aléatoire.',
    deepHint:
      'Le validateur est imbriqué plus profondément que ne le permet le pipeline d’un plug-in ; il ne peut donc pas être vérifié ici.',
    more: (n: number) => `Les ${n} premières règles sont vérifiées ; les autres ne sont pas comptées.`,
    required: (name: string) => `${name} est obligatoire`,
    property: (name: string) => `${name}`,
    additional: 'Aucun champ en dehors de ceux du schéma',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `Autorisés : ${names}` : 'Aucun champ listé',
        patterns ? `et les champs correspondant à ${patterns}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Mot-clé du schéma ${name}`,
    condition: 'Condition',
    documents: (n: number, s: string, share: string) =>
      `${s} ${isOne(n, 'fr') ? 'document' : 'documents'} (${share})`,
    none0: 'Aucun document ne l’enfreint',
    show: 'Afficher dans Documents',
    showHint:
      'Place dans la requête de Documents un filtre qui sélectionne les documents enfreignant cette règle',
    showAll: 'Afficher tous les documents qui enfreignent les règles',
    showFailed: 'Impossible d’ouvrir Documents : ',
    sampleNote:
      'Un échantillon aléatoire : les totaux portent sur les documents vérifiés, pas sur toute la collection.',
  },
  ru: {
    title: 'Проверка валидации',
    description: (coll: string) =>
      `Проверяет документы коллекции ${coll} по одному на соответствие ее правилам валидации: сколько документов нарушает каждое правило. Ничего не изменяет.`,
    check: 'Проверить',
    size: 'Документы для проверки',
    sizeSample: (n: string) => `${n} случайных`,
    sizeAll: 'Все',
    checking: 'Проверка документов…',
    noPlace: 'Откройте коллекцию, чтобы проверить ее.',
    view: 'У представления нет собственных правил валидации',
    viewHint: 'Его документы — это документы коллекции, которую оно читает; проверьте эту коллекцию.',
    none: 'У этой коллекции нет правил валидации',
    noneHint: 'Правила добавляются на вкладке «Валидация» коллекции.',
    failed: 'Не удалось выполнить проверку',
    tryAgain: 'Повторить',
    read: (n: number, s: string) =>
      `${isOne(n, 'ru') ? 'Проверен' : 'Проверено'} ${s} ${form(n, 'ru', { one: 'документ', few: 'документа', many: 'документов' })}`,
    broken: (n: number, s: string, share: string) =>
      `${s} ${form(n, 'ru', { one: 'документ нарушает', few: 'документа нарушают', many: 'документов нарушают' })} правила (${share})`,
    clean: 'Все проверенные документы соответствуют правилам',
    cleanHint: (n: number, s: string) =>
      n === 1
        ? 'Проверенный документ не нарушает ни одного правила.'
        : `Ни один из ${s} ${isOne(n, 'ru') ? 'проверенного документа' : 'проверенных документов'} не нарушает правила.`,
    empty: 'Нет документов для проверки',
    emptyHint: 'Эта коллекция пуста.',
    level: (level: string, action: string) => `Уровень: ${level} · Действие: ${action}`,
    levelNote: 'Записи, нарушающие правила, все равно могут выполняться',
    levelHint:
      'Уровень «moderate» проверяет только документы, которые уже соответствуют правилам; действие «warn» записывает нарушенное правило в журнал вместо отклонения записи.',
    hidden: 'Правила для полей, скрытых от вас, не проверяются',
    hiddenHint:
      'То, что правило говорит о поле, значения которого скрыты от вас, не передается этому плагину; числа относятся к показанным правилам.',
    allHint:
      'Вся коллекция может обрабатываться дольше, чем отведено на проверку: выберите случайную выборку.',
    deepHint:
      'Вложенность валидатора больше допустимой для конвейера плагина, поэтому проверить его здесь нельзя.',
    more: (n: number) => `Проверяются только первые правила (${n}); остальные не учитываются.`,
    required: (name: string) => `${name}: обязательное поле`,
    property: (name: string) => `${name}`,
    additional: 'Нет полей, кроме определенных в схеме',
    additionalHint: (names: string, patterns: string) =>
      [
        names ? `Разрешены: ${names}` : 'Ни одно поле не указано',
        patterns ? `и поля, соответствующие ${patterns}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    keyword: (name: string) => `Ключевое слово схемы ${name}`,
    condition: 'Условие',
    documents: (n: number, s: string, share: string) =>
      `${s} ${form(n, 'ru', { one: 'документ', few: 'документа', many: 'документов' })} (${share})`,
    none0: 'Нарушающих документов нет',
    show: 'Показать в «Документах»',
    showHint: 'Помещает в запрос «Документов» фильтр, выбирающий документы, которые нарушают это правило',
    showAll: 'Показать все документы, нарушающие правила',
    showFailed: 'Не удалось открыть «Документы»: ',
    sampleNote: 'Случайная выборка: числа относятся к проверенным документам, а не ко всей коллекции.',
  },
} satisfies Record<Language, Text>

interface Validation {
  validator: Doc
  validationLevel?: string
  validationAction?: string
}
type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'none'; view: boolean }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; validation: Validation; result: CheckResult; more: boolean; sampled: boolean }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  // The language the words are in: numbers and the page follow it.
  let lang: Language = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  let showError: unknown = null
  const aggregate = serialAsk((params: unknown) =>
    client.ask<{ documents: unknown[] }>('documents.aggregate', params),
  )

  const number = (n: number) => formatNumber(n, lang)
  const sizes = (): Record<Size, string> => ({
    '1000': text.sizeSample(number(1000)),
    '10000': text.sizeSample(number(10000)),
    all: text.sizeAll,
  })

  const checkButton = button({ label: text.check, icon: 'play', variant: 'primary', id: 'check' })
  const size = segmented<Size>({
    label: text.size,
    id: 'size',
    value: '1000',
    options: SIZES.map((value) => ({ value, label: sizes()[value] })),
    onChange: () => void check(),
  })
  const header = pageHeader({
    icon: 'check',
    title: text.title,
    description: '',
    actions: [size.el, checkButton],
  })
  const summary = h('div', { id: 'summary', class: 'vi-summary' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'vi-notes' })
  const results = h('div', { id: 'rules', class: 'vi-rules' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, summary, status), notes, results),
    ),
  )

  // A share in the language's own percent style (Turkish writes the sign first: %1,5).
  const share = (n: number, of: number) => {
    const format = (fraction: number) =>
      new Intl.NumberFormat(langTag(lang), { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
    const percent = of ? (n / of) * 100 : 0
    return percent > 0 && percent < 0.1 ? `<${format(0.001)}` : format(of ? n / of : 0)
  }

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    setLabel(checkButton, text.check)
    size.relabel(sizes())
    size.el.setAttribute('aria-label', text.size)
  }

  function show(filter: Doc): void {
    const run = running
    void client.ask('ui.useQuery', { filter }).then(
      () => {
        if (run !== running || showError === null) return
        showError = null
        render()
      },
      (e: unknown) => {
        if (run !== running) return
        showError = e
        render()
      },
    )
  }

  function ruleTitle(rule: Rule): { title: string; detail: string | null } {
    switch (rule.kind) {
      case 'required':
        return { title: text.required(rule.name), detail: null }
      case 'property':
        return { title: text.property(rule.name), detail: checksOf(rule.detail) }
      case 'additional': {
        const { names, patterns } = rule.detail as { names: string[]; patterns: string[] }
        return { title: text.additional, detail: text.additionalHint(names.join(', '), patterns.join(', ')) }
      }
      case 'keyword':
        return { title: text.keyword(rule.name), detail: brief(rule.detail) }
      case 'condition':
        return { title: rule.name || text.condition, detail: brief(rule.detail) }
    }
  }

  function card(rule: Rule, broken: number, read: number): HTMLElement {
    const { title, detail } = ruleTitle(rule)
    const percent = read ? Math.min(100, (broken / read) * 100) : 0
    const showButton = broken
      ? button({
          label: text.show,
          icon: 'filter',
          size: 'sm',
          title: text.showHint,
          onClick: () => show(breaking(rule.filter)),
        })
      : null
    showButton?.setAttribute('data-show', '')
    // Set through the style object: the frame's policy allows no style attribute.
    const fill = h('span', { class: 'vi-meter-fill' })
    fill.style.width = `${percent}%`
    return h(
      'article',
      {
        class: `mm-card vi-card${broken ? ' vi-broken' : ''}`,
        data: { rule: rule.kind, broken: String(broken) },
      },
      h(
        'div',
        { class: 'vi-card-head' },
        h('h3', { class: 'vi-title', text: title }),
        broken
          ? badge(text.documents(broken, number(broken), share(broken, read)), 'danger')
          : badge(text.none0, 'success'),
      ),
      detail ? h('code', { class: 'mm-mono vi-detail', title: detail, text: detail }) : null,
      h('div', { class: 'vi-meter', attrs: { 'aria-hidden': 'true' } }, fill),
      showButton ? h('div', { class: 'vi-card-actions' }, showButton) : null,
    )
  }

  function render(): void {
    summary.replaceChildren()
    notes.replaceChildren()
    status.textContent = ''
    if (!ctx) return
    if (!ctx.place) return void results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = text.checking
      return void results.replaceChildren(skeleton(4))
    }
    if (state.kind === 'none')
      return void results.replaceChildren(
        state.view
          ? emptyState({ icon: 'layers', title: text.view, hint: text.viewHint })
          : emptyState({ icon: 'check', title: text.none, hint: text.noneHint }),
      )
    if (state.kind === 'failed') {
      const again = button({ label: text.tryAgain, icon: 'play', onClick: () => void check() })
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: [
            askMessage(state.error, locale),
            // The bridge refuses a pipeline nested past its bound (review, minor): say what that means.
            /deeply nested/i.test(askMessage(state.error, 'en')) ? text.deepHint : '',
            size.value() === 'all' ? text.allHint : '',
          ]
            .filter(Boolean)
            .join(' '),
          action: again,
        }),
      )
    }
    const { validation, result, more, sampled } = state
    const level = validation.validationLevel ?? 'strict'
    const action = validation.validationAction ?? 'error'
    summary.append(
      badge(text.level(level, action), level === 'strict' && action === 'error' ? 'neutral' : 'warning'),
    )
    status.textContent = [
      text.read(result.read, number(result.read)),
      result.read
        ? text.broken(result.broken, number(result.broken), share(result.broken, result.read))
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
    // The badge names them; the note says what they mean (review, minor: once each).
    if (level !== 'strict' || action !== 'error')
      notes.append(callout('info', text.levelNote, text.levelHint))
    // Review I2: a rule about a hidden field is not given to the plugin, so it is not counted.
    if (ctx.place.hidden === null || (ctx.place.hidden?.length ?? 0) > 0)
      notes.append(callout('info', text.hidden, text.hiddenHint))
    if (more) notes.append(callout('info', text.more(result.counts.length)))
    if (sampled && result.read) notes.append(h('p', { class: 'mm-status', text: text.sampleNote }))
    if (showError !== null)
      notes.append(callout('danger', `${text.showFailed}${askMessage(showError, locale)}`))
    if (!result.read)
      return void results.replaceChildren(
        emptyState({ icon: 'database', title: text.empty, hint: text.emptyHint }),
      )
    if (!result.broken && result.counts.every((c) => !c.broken))
      results.replaceChildren(
        emptyState({
          icon: 'ok',
          tone: 'success',
          title: text.clean,
          hint: text.cleanHint(result.read, number(result.read)),
        }),
      )
    else {
      const all = button({
        label: text.showAll,
        icon: 'filter',
        size: 'sm',
        id: 'show-all',
        onClick: () => show(breaking(validation.validator)),
      })
      results.replaceChildren(
        h('div', { class: 'vi-actions' }, all),
        ...result.counts.map((c) => card(c.rule, c.broken, result.read)),
      )
    }
  }

  async function check(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    showError = null
    setBusy(checkButton, true)
    state = { kind: 'running' }
    render()
    try {
      const validation = await client.ask<Validation | null>('validation.get')
      if (run !== running) return
      const validator = validation?.validator
      if (!validation || !validator || Object.keys(validator).length === 0) {
        state = { kind: 'none', view: !!ctx.place.view || validation === null }
      } else {
        const chosen = size.value()
        const plan = checkPlan(validator, chosen === 'all' ? null : Number(chosen))
        const answer = await aggregate({ pipeline: plan.pipeline, limit: 1 })
        if (run !== running) return
        state = {
          kind: 'done',
          validation,
          result: readCheck(plan, answer.documents),
          more: plan.more,
          sampled: chosen !== 'all',
        }
      }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
    }
    setBusy(checkButton, false)
    render()
  }

  checkButton.addEventListener('click', () => void check())

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    lang = shown(TEXT, locale)
    document.documentElement.lang = langTag(lang)
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    lang = shown(TEXT, locale)
    document.documentElement.lang = langTag(lang)
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) {
      checkButton.disabled = true
      render()
      return
    }
    // A sample of 1,000 is bounded: it runs on opening.
    void check()
  })
  applyText()
}
