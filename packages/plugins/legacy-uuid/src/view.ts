// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
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
  setBusy,
  setLabel,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { scanUuids, wellFormed, type UuidField } from './scan'
import { ENCODINGS, LEGACY, filterFor, formatUuid, parseUuid, reorder, shellOf, type Encoding } from './uuid'

/**
 * Legacy UUIDs (research 2026-10-28): the UUIDs a collection holds — from a random sample, each
 * field with how many are legacy (subtype 3) or standard, and the driver whose byte order reads the
 * legacy ones as well-formed UUIDs — and a finder that writes a UUID as each driver stored it and
 * selects its documents in Documents. Changes nothing.
 */
export const SAMPLE = 1000
type Choice = Encoding | 'any'
const CHOICES: Choice[] = ['any', ...ENCODINGS]

/** A count's texts also get the number itself (n is formatted for the reader), for singular and plural. */
export type Text = {
  title: string
  description: (coll: string) => string
  scan: string
  scanning: string
  noPlace: string
  find: string
  uuid: string
  field: string
  storedAs: string
  choices: Record<Choice, string>
  names: Record<Encoding, string>
  notUuid: string
  needField: string
  stored: string
  copy: string
  copyHint: (e: Encoding, name: string) => string
  copyLabel: (name: string) => string
  show: string
  showHint: string
  failed: string
  fields: string
  sampled: (n: string, count: number) => string
  none: string
  noneHint: (n: string, count: number) => string
  empty: string
  emptyHint: string
  scanFailed: string
  tryAgain: string
  counts: (legacy: string, standard: string, legacyCount: number, standardCount: number) => string
  likelyOne: (name: string) => string
  likelyMany: (names: string) => string
  likelyNone: string
  likelyHint: string
  example: string
  use: string
}

export const TEXT = {
  en: {
    title: 'UUIDs',
    description: (coll: string) =>
      `The UUIDs ${coll} holds, the legacy ones read in each driver’s byte order, and a finder for a UUID however it was stored. Changes nothing.`,
    scan: 'Scan again',
    scanning: 'Sampling documents…',
    noPlace: 'Open a collection to look at its UUIDs.',
    find: 'Find a UUID',
    uuid: 'UUID',
    field: 'Field',
    storedAs: 'Stored as',
    choices: {
      any: 'Any of these',
      standard: 'Standard (subtype 4)',
      java: 'Java legacy (subtype 3)',
      csharp: 'C# legacy (subtype 3)',
      python: 'Python legacy (subtype 3)',
    },
    names: { standard: 'Standard', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'Not a UUID: write its 32 hexadecimal digits, with or without dashes.',
    needField: 'Name the field to look in.',
    stored: 'As each driver stored it',
    copy: 'Copy',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Copy the standard value, as the shell writes it'
        : `Copy the value as the ${name} driver stored it, as the shell writes it`,
    copyLabel: (name: string) => `Copy the ${name} value`,
    show: 'Show in Documents',
    showHint: 'Puts a filter selecting the documents holding this UUID in the Documents query',
    failed: 'Could not do it: ',
    fields: 'UUID fields',
    sampled: (n: string, count: number) =>
      pluralOf(count, 'en') === 'one' ? `${n} document sampled` : `${n} documents sampled`,
    none: 'No UUIDs in the sample',
    noneHint: (n: string, count: number) =>
      pluralOf(count, 'en') === 'one'
        ? 'The sampled document holds no 16-byte binary of subtype 3 or 4.'
        : `None of the ${n} sampled documents holds a 16-byte binary of subtype 3 or 4.`,
    empty: 'No documents to sample',
    emptyHint: 'This collection is empty.',
    scanFailed: 'The sample could not be read',
    tryAgain: 'Try again',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `${legacy} legacy` : null, standard !== '0' ? `${standard} standard` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Stored in ${name}’s order`,
    likelyMany: (names: string) => `Fits more than one order: ${names}`,
    likelyNone: 'No one order reads every value: values from more than one driver, or not UUIDs',
    likelyHint:
      'A UUID’s version digit and variant sit in fixed places; read in the wrong order they almost never land there.',
    example: 'First value, read in each order',
    use: 'Find in this field',
  },
  tr: {
    title: "UUID'ler",
    description: (coll: string) =>
      `${coll} koleksiyonunun taşıdığı UUID'ler; eskiler her sürücünün bayt sırasıyla okunur. Bir UUID nasıl saklanmış olursa olsun bulunur. Hiçbir şeyi değiştirmez.`,
    scan: 'Yeniden tara',
    scanning: 'Belgelerden örnek alınıyor…',
    noPlace: "UUID'lerine bakmak için bir koleksiyon açın.",
    find: 'Bir UUID bul',
    uuid: 'UUID',
    field: 'Alan',
    storedAs: 'Saklanış biçimi',
    choices: {
      any: 'Bunlardan herhangi biri',
      standard: 'Standart (alt tür 4)',
      java: 'Java eski (alt tür 3)',
      csharp: 'C# eski (alt tür 3)',
      python: 'Python eski (alt tür 3)',
    },
    names: { standard: 'Standart', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'UUID değil: 32 onaltılık basamağını tireli ya da tiresiz yazın.',
    needField: 'Aranacak alanı yazın.',
    stored: 'Her sürücünün sakladığı biçimiyle',
    copy: 'Kopyala',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Standart değeri kabuğun yazdığı biçimde kopyalar'
        : `Değeri ${name} sürücüsünün sakladığı gibi, kabuğun yazdığı biçimde kopyalar`,
    copyLabel: (name: string) => `${name} değerini kopyala`,
    show: 'Belgelerde göster',
    showHint: "Bu UUID'yi taşıyan belgeleri seçen bir filtreyi Belgeler sorgusuna koyar",
    failed: 'Yapılamadı: ',
    fields: 'UUID alanları',
    sampled: (n: string) => `${n} belgeden örnek alındı`,
    none: 'Örnekte UUID yok',
    noneHint: (n: string, count: number) =>
      count === 1
        ? 'Örneklenen belge alt türü 3 ya da 4 olan 16 baytlık bir ikili veri taşımıyor.'
        : `Örneklenen ${n} belgenin hiçbiri alt türü 3 ya da 4 olan 16 baytlık bir ikili veri taşımıyor.`,
    empty: 'Örnek alınacak belge yok',
    emptyHint: 'Bu koleksiyon boş.',
    scanFailed: 'Örnek okunamadı',
    tryAgain: 'Yeniden dene',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `${legacy} eski` : null, standard !== '0' ? `${standard} standart` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `${name} sırasıyla saklanmış`,
    likelyMany: (names: string) => `Birden fazla sıraya uyuyor: ${names}`,
    likelyNone: 'Hiçbir sıra her değeri okumuyor: birden fazla sürücünün değerleri ya da UUID olmayanlar',
    likelyHint:
      "Bir UUID'nin sürüm basamağı ve varyantı sabit yerlerdedir; yanlış sırayla okununca neredeyse hiç oraya düşmezler.",
    example: 'İlk değer, her sırayla okunuşu',
    use: 'Bu alanda bul',
  },
  zh: {
    title: 'UUID',
    description: (coll: string) =>
      `${coll} 中的 UUID，其中旧版 UUID 按各驱动程序的字节顺序读取，并可查找以任意方式存储的 UUID。不会更改任何内容。`,
    scan: '重新扫描',
    scanning: '正在对文档采样…',
    noPlace: '打开一个集合以查看其 UUID。',
    find: '查找 UUID',
    uuid: 'UUID',
    field: '字段',
    storedAs: '存储方式',
    choices: {
      any: '以上任意一种',
      standard: '标准（子类型 4）',
      java: 'Java 旧版（子类型 3）',
      csharp: 'C# 旧版（子类型 3）',
      python: 'Python 旧版（子类型 3）',
    },
    names: { standard: '标准', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: '不是 UUID：请输入其 32 位十六进制数字，可带或不带连字符。',
    needField: '请填写要查找的字段。',
    stored: '各驱动程序的存储形式',
    copy: '复制',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? '复制标准值，格式与 shell 中一致'
        : `复制 ${name} 驱动程序存储的值，格式与 shell 中一致`,
    copyLabel: (name: string) => `复制 ${name} 值`,
    show: '在文档中显示',
    showHint: '在文档查询中放入一个筛选条件，用于选出包含此 UUID 的文档',
    failed: '无法完成：',
    fields: 'UUID 字段',
    sampled: (n: string) => `已采样 ${n} 个文档`,
    none: '样本中没有 UUID',
    noneHint: (n: string) => `已采样的 ${n} 个文档中，没有包含子类型为 3 或 4 的 16 字节二进制值。`,
    empty: '没有可采样的文档',
    emptyHint: '此集合为空。',
    scanFailed: '无法读取样本',
    tryAgain: '重试',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `${legacy} 个旧版` : null, standard !== '0' ? `${standard} 个标准` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `按 ${name} 的顺序存储`,
    likelyMany: (names: string) => `符合多种顺序：${names}`,
    likelyNone: '没有一种顺序能读取所有值：值来自多个驱动程序，或并非 UUID',
    likelyHint: 'UUID 的版本位和变体位位于固定位置；按错误的顺序读取时，几乎不会落在这些位置。',
    example: '第一个值，按各顺序读取',
    use: '在此字段中查找',
  },
  ja: {
    title: 'UUID',
    description: (coll: string) =>
      `${coll} に含まれる UUID です。旧形式のものは各ドライバーのバイト順で読み取り、どの形式で保存された UUID も検索できます。何も変更しません。`,
    scan: '再スキャン',
    scanning: 'ドキュメントをサンプリング中…',
    noPlace: 'UUID を表示するにはコレクションを開いてください。',
    find: 'UUID を検索',
    uuid: 'UUID',
    field: 'フィールド',
    storedAs: '保存形式',
    choices: {
      any: 'いずれか',
      standard: '標準（サブタイプ 4）',
      java: 'Java 旧形式（サブタイプ 3）',
      csharp: 'C# 旧形式（サブタイプ 3）',
      python: 'Python 旧形式（サブタイプ 3）',
    },
    names: { standard: '標準', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'UUID ではありません。16 進数 32 桁を、ハイフンの有無を問わず入力してください。',
    needField: '検索するフィールドを入力してください。',
    stored: '各ドライバーでの保存形式',
    copy: 'コピー',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? '標準の値をシェルでの表記でコピーします'
        : `${name} ドライバーが保存した値をシェルでの表記でコピーします`,
    copyLabel: (name: string) => `${name} の値をコピー`,
    show: 'ドキュメントで表示',
    showHint: 'この UUID を持つドキュメントを選ぶフィルターをドキュメントのクエリに設定します',
    failed: '実行できませんでした: ',
    fields: 'UUID フィールド',
    sampled: (n: string) => `${n} 件のドキュメントをサンプリングしました`,
    none: 'サンプルに UUID はありません',
    noneHint: (n: string) =>
      `サンプリングした ${n} 件のドキュメントに、サブタイプ 3 または 4 の 16 バイトのバイナリはありません。`,
    empty: 'サンプリングするドキュメントがありません',
    emptyHint: 'このコレクションは空です。',
    scanFailed: 'サンプルを読み取れませんでした',
    tryAgain: '再試行',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `旧形式 ${legacy}` : null, standard !== '0' ? `標準 ${standard}` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `${name} の順序で保存`,
    likelyMany: (names: string) => `複数の順序に一致します: ${names}`,
    likelyNone: 'すべての値を読み取れる順序がありません: 複数のドライバーの値、または UUID ではない値です',
    likelyHint:
      'UUID のバージョン桁とバリアントは決まった位置にあります。誤った順序で読むと、ほとんどその位置に収まりません。',
    example: '最初の値を各順序で読み取った結果',
    use: 'このフィールドで検索',
  },
  es: {
    title: 'UUID',
    description: (coll: string) =>
      `Los UUID de ${coll}: los heredados se leen en el orden de bytes de cada controlador, y un buscador encuentra un UUID sea cual sea su forma de almacenamiento. No cambia nada.`,
    scan: 'Volver a analizar',
    scanning: 'Tomando una muestra de documentos…',
    noPlace: 'Abre una colección para ver sus UUID.',
    find: 'Buscar un UUID',
    uuid: 'UUID',
    field: 'Campo',
    storedAs: 'Almacenado como',
    choices: {
      any: 'Cualquiera de estos',
      standard: 'Estándar (subtipo 4)',
      java: 'Heredado de Java (subtipo 3)',
      csharp: 'Heredado de C# (subtipo 3)',
      python: 'Heredado de Python (subtipo 3)',
    },
    names: { standard: 'Estándar', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'No es un UUID: escribe sus 32 dígitos hexadecimales, con o sin guiones.',
    needField: 'Indica el campo en el que buscar.',
    stored: 'Tal como lo almacenó cada controlador',
    copy: 'Copiar',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Copia el valor estándar, tal como lo escribe el shell'
        : `Copia el valor tal como lo almacenó el controlador de ${name}, como lo escribe el shell`,
    copyLabel: (name: string) => `Copiar el valor de ${name}`,
    show: 'Mostrar en Documentos',
    showHint: 'Coloca en la consulta de Documentos un filtro que selecciona los documentos con este UUID',
    failed: 'No se pudo completar: ',
    fields: 'Campos UUID',
    sampled: (n: string, count: number) =>
      pluralOf(count, 'es') === 'one' ? `${n} documento en la muestra` : `${n} documentos en la muestra`,
    none: 'No hay UUID en la muestra',
    noneHint: (n: string, count: number) =>
      pluralOf(count, 'es') === 'one'
        ? 'El documento de la muestra no contiene un binario de 16 bytes de subtipo 3 o 4.'
        : `Ninguno de los ${n} documentos de la muestra contiene un binario de 16 bytes de subtipo 3 o 4.`,
    empty: 'No hay documentos de los que tomar muestra',
    emptyHint: 'Esta colección está vacía.',
    scanFailed: 'No se pudo leer la muestra',
    tryAgain: 'Reintentar',
    counts: (legacy: string, standard: string, legacyCount: number) =>
      [
        legacy !== '0'
          ? `${legacy} ${pluralOf(legacyCount, 'es') === 'one' ? 'heredado' : 'heredados'}`
          : null,
        standard !== '0' ? `${standard} estándar` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Almacenado en el orden de ${name}`,
    likelyMany: (names: string) => `Encaja con más de un orden: ${names}`,
    likelyNone: 'Ningún orden lee todos los valores: son de más de un controlador o no son UUID',
    likelyHint:
      'El dígito de versión y la variante de un UUID están en posiciones fijas; leídos en el orden equivocado, casi nunca caen ahí.',
    example: 'Primer valor, leído en cada orden',
    use: 'Buscar en este campo',
  },
  pt: {
    title: 'UUIDs',
    description: (coll: string) =>
      `Os UUIDs de ${coll}: os legados são lidos na ordem de bytes de cada driver, e um localizador encontra um UUID independentemente de como foi armazenado. Não altera nada.`,
    scan: 'Verificar novamente',
    scanning: 'Coletando amostra de documentos…',
    noPlace: 'Abra uma coleção para ver os UUIDs dela.',
    find: 'Localizar um UUID',
    uuid: 'UUID',
    field: 'Campo',
    storedAs: 'Armazenado como',
    choices: {
      any: 'Qualquer um destes',
      standard: 'Padrão (subtipo 4)',
      java: 'Legado do Java (subtipo 3)',
      csharp: 'Legado do C# (subtipo 3)',
      python: 'Legado do Python (subtipo 3)',
    },
    names: { standard: 'Padrão', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'Não é um UUID: escreva os 32 dígitos hexadecimais, com ou sem hifens.',
    needField: 'Informe o campo onde procurar.',
    stored: 'Como cada driver armazenou',
    copy: 'Copiar',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Copia o valor padrão, como o shell o escreve'
        : `Copia o valor como o driver ${name} o armazenou, como o shell o escreve`,
    copyLabel: (name: string) => `Copiar o valor ${name}`,
    show: 'Mostrar em Documentos',
    showHint: 'Coloca na consulta de Documentos um filtro que seleciona os documentos com este UUID',
    failed: 'Não foi possível concluir: ',
    fields: 'Campos UUID',
    sampled: (n: string, count: number) =>
      pluralOf(count, 'pt') === 'one' ? `${n} documento na amostra` : `${n} documentos na amostra`,
    none: 'Nenhum UUID na amostra',
    noneHint: (n: string, count: number) =>
      pluralOf(count, 'pt') === 'one'
        ? 'O documento da amostra não contém um binário de 16 bytes de subtipo 3 ou 4.'
        : `Nenhum dos ${n} documentos da amostra contém um binário de 16 bytes de subtipo 3 ou 4.`,
    empty: 'Não há documentos para amostrar',
    emptyHint: 'Esta coleção está vazia.',
    scanFailed: 'Não foi possível ler a amostra',
    tryAgain: 'Tentar novamente',
    counts: (legacy: string, standard: string, legacyCount: number) =>
      [
        legacy !== '0' ? `${legacy} ${pluralOf(legacyCount, 'pt') === 'one' ? 'legado' : 'legados'}` : null,
        standard !== '0' ? `${standard} padrão` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Armazenado na ordem de ${name}`,
    likelyMany: (names: string) => `Corresponde a mais de uma ordem: ${names}`,
    likelyNone: 'Nenhuma ordem lê todos os valores: são de mais de um driver ou não são UUIDs',
    likelyHint:
      'O dígito de versão e a variante de um UUID ficam em posições fixas; lidos na ordem errada, quase nunca caem ali.',
    example: 'Primeiro valor, lido em cada ordem',
    use: 'Localizar neste campo',
  },
  ko: {
    title: 'UUID',
    description: (coll: string) =>
      `${coll}의 UUID입니다. 레거시 UUID는 각 드라이버의 바이트 순서로 읽으며, UUID는 저장된 방식과 관계없이 찾을 수 있습니다. 아무것도 변경하지 않습니다.`,
    scan: '다시 스캔',
    scanning: '도큐먼트 샘플링 중…',
    noPlace: 'UUID를 보려면 컬렉션을 여세요.',
    find: 'UUID 찾기',
    uuid: 'UUID',
    field: '필드',
    storedAs: '저장 방식',
    choices: {
      any: '이 중 아무거나',
      standard: '표준(서브타입 4)',
      java: 'Java 레거시(서브타입 3)',
      csharp: 'C# 레거시(서브타입 3)',
      python: 'Python 레거시(서브타입 3)',
    },
    names: { standard: '표준', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'UUID가 아닙니다. 16진수 32자리를 하이픈 유무와 관계없이 입력하세요.',
    needField: '검색할 필드를 입력하세요.',
    stored: '각 드라이버가 저장한 방식',
    copy: '복사',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? '표준 값을 셸에서 표기하는 형식으로 복사합니다'
        : `${name} 드라이버가 저장한 값을 셸에서 표기하는 형식으로 복사합니다`,
    copyLabel: (name: string) => `${name} 값 복사`,
    show: '도큐먼트에서 보기',
    showHint: '이 UUID를 가진 도큐먼트를 선택하는 필터를 도큐먼트 쿼리에 넣습니다',
    failed: '수행하지 못했습니다: ',
    fields: 'UUID 필드',
    sampled: (n: string) => `도큐먼트 ${n}개를 샘플링했습니다`,
    none: '샘플에 UUID가 없습니다',
    noneHint: (n: string) =>
      `샘플링한 도큐먼트 ${n}개 중 서브타입이 3 또는 4인 16바이트 바이너리를 가진 것이 없습니다.`,
    empty: '샘플링할 도큐먼트가 없습니다',
    emptyHint: '이 컬렉션은 비어 있습니다.',
    scanFailed: '샘플을 읽을 수 없습니다',
    tryAgain: '다시 시도',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `레거시 ${legacy}` : null, standard !== '0' ? `표준 ${standard}` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `${name} 순서로 저장됨`,
    likelyMany: (names: string) => `둘 이상의 순서와 일치합니다: ${names}`,
    likelyNone: '모든 값을 읽을 수 있는 순서가 없습니다. 둘 이상의 드라이버에서 온 값이거나 UUID가 아닙니다',
    likelyHint:
      'UUID의 버전 자리와 변형(variant)은 고정된 위치에 있어, 잘못된 순서로 읽으면 거의 그 위치에 오지 않습니다.',
    example: '첫 번째 값을 각 순서로 읽은 결과',
    use: '이 필드에서 찾기',
  },
  de: {
    title: 'UUIDs',
    description: (coll: string) =>
      `Die UUIDs von ${coll}: Legacy-UUIDs werden in der Byte-Reihenfolge des jeweiligen Treibers gelesen, und eine Suche findet eine UUID, wie auch immer sie gespeichert wurde. Ändert nichts.`,
    scan: 'Erneut scannen',
    scanning: 'Stichprobe der Dokumente wird gezogen…',
    noPlace: 'Öffnen Sie eine Collection, um ihre UUIDs anzusehen.',
    find: 'UUID suchen',
    uuid: 'UUID',
    field: 'Feld',
    storedAs: 'Gespeichert als',
    choices: {
      any: 'Eine davon',
      standard: 'Standard (Subtyp 4)',
      java: 'Java-Legacy (Subtyp 3)',
      csharp: 'C#-Legacy (Subtyp 3)',
      python: 'Python-Legacy (Subtyp 3)',
    },
    names: { standard: 'Standard', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'Keine UUID: Geben Sie die 32 Hexadezimalziffern mit oder ohne Bindestriche ein.',
    needField: 'Geben Sie das Feld an, in dem gesucht werden soll.',
    stored: 'So hat jeder Treiber sie gespeichert',
    copy: 'Kopieren',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Kopiert den Standardwert so, wie die Shell ihn schreibt'
        : `Kopiert den Wert so, wie der ${name}-Treiber ihn gespeichert hat, in der Schreibweise der Shell`,
    copyLabel: (name: string) => `${name}-Wert kopieren`,
    show: 'In Dokumenten anzeigen',
    showHint: 'Setzt einen Filter, der die Dokumente mit dieser UUID auswählt, in die Abfrage von Dokumente',
    failed: 'Nicht möglich: ',
    fields: 'UUID-Felder',
    sampled: (n: string, count: number) =>
      pluralOf(count, 'de') === 'one'
        ? `${n} Dokument in der Stichprobe`
        : `${n} Dokumente in der Stichprobe`,
    none: 'Keine UUIDs in der Stichprobe',
    noneHint: (n: string, count: number) =>
      pluralOf(count, 'de') === 'one'
        ? 'Das untersuchte Dokument enthält kein 16-Byte-Binary vom Subtyp 3 oder 4.'
        : `Keines der ${n} untersuchten Dokumente enthält ein 16-Byte-Binary vom Subtyp 3 oder 4.`,
    empty: 'Keine Dokumente für die Stichprobe',
    emptyHint: 'Diese Collection ist leer.',
    scanFailed: 'Die Stichprobe konnte nicht gelesen werden',
    tryAgain: 'Erneut versuchen',
    counts: (legacy: string, standard: string) =>
      [legacy !== '0' ? `${legacy} Legacy` : null, standard !== '0' ? `${standard} Standard` : null]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Gespeichert in der Reihenfolge von ${name}`,
    likelyMany: (names: string) => `Passt zu mehr als einer Reihenfolge: ${names}`,
    likelyNone: 'Keine Reihenfolge liest alle Werte: Werte von mehr als einem Treiber oder keine UUIDs',
    likelyHint:
      'Versionsziffer und Variante einer UUID stehen an festen Stellen; in der falschen Reihenfolge gelesen, landen sie dort fast nie.',
    example: 'Erster Wert, in jeder Reihenfolge gelesen',
    use: 'In diesem Feld suchen',
  },
  fr: {
    title: 'UUID',
    description: (coll: string) =>
      `Les UUID de ${coll} : les UUID hérités sont lus dans l’ordre d’octets de chaque pilote, et une recherche trouve un UUID quelle que soit la façon dont il a été stocké. Ne modifie rien.`,
    scan: 'Analyser de nouveau',
    scanning: 'Échantillonnage des documents…',
    noPlace: 'Ouvrez une collection pour voir ses UUID.',
    find: 'Rechercher un UUID',
    uuid: 'UUID',
    field: 'Champ',
    storedAs: 'Stocké comme',
    choices: {
      any: 'N’importe lequel',
      standard: 'Standard (sous-type 4)',
      java: 'Hérité de Java (sous-type 3)',
      csharp: 'Hérité de C# (sous-type 3)',
      python: 'Hérité de Python (sous-type 3)',
    },
    names: { standard: 'Standard', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'Ce n’est pas un UUID : saisissez ses 32 chiffres hexadécimaux, avec ou sans tirets.',
    needField: 'Indiquez le champ dans lequel chercher.',
    stored: 'Tel que chaque pilote l’a stocké',
    copy: 'Copier',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Copie la valeur standard, telle que le shell l’écrit'
        : `Copie la valeur telle que le pilote ${name} l’a stockée, comme le shell l’écrit`,
    copyLabel: (name: string) => `Copier la valeur ${name}`,
    show: 'Afficher dans Documents',
    showHint: 'Place dans la requête de Documents un filtre qui sélectionne les documents contenant cet UUID',
    failed: 'Action impossible : ',
    fields: 'Champs UUID',
    sampled: (n: string, count: number) =>
      pluralOf(count, 'fr') === 'one' ? `${n} document échantillonné` : `${n} documents échantillonnés`,
    none: 'Aucun UUID dans l’échantillon',
    noneHint: (n: string, count: number) =>
      pluralOf(count, 'fr') === 'one'
        ? 'Le document échantillonné ne contient aucun binaire de 16 octets de sous-type 3 ou 4.'
        : `Aucun des ${n} documents échantillonnés ne contient un binaire de 16 octets de sous-type 3 ou 4.`,
    empty: 'Aucun document à échantillonner',
    emptyHint: 'Cette collection est vide.',
    scanFailed: 'Impossible de lire l’échantillon',
    tryAgain: 'Réessayer',
    counts: (legacy: string, standard: string, legacyCount: number) =>
      [
        legacy !== '0' ? `${legacy} ${pluralOf(legacyCount, 'fr') === 'one' ? 'hérité' : 'hérités'}` : null,
        standard !== '0' ? `${standard} standard` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Stocké dans l’ordre de ${name}`,
    likelyMany: (names: string) => `Correspond à plus d’un ordre : ${names}`,
    likelyNone:
      'Aucun ordre ne lit toutes les valeurs : valeurs de plusieurs pilotes, ou qui ne sont pas des UUID',
    likelyHint:
      'Le chiffre de version et la variante d’un UUID se trouvent à des emplacements fixes ; lus dans le mauvais ordre, ils n’y tombent presque jamais.',
    example: 'Première valeur, lue dans chaque ordre',
    use: 'Rechercher dans ce champ',
  },
  ru: {
    title: 'UUID',
    description: (coll: string) =>
      `UUID в ${coll}: устаревшие читаются в порядке байтов каждого драйвера, а поиск находит UUID независимо от способа хранения. Ничего не изменяет.`,
    scan: 'Сканировать снова',
    scanning: 'Выборка документов…',
    noPlace: 'Откройте коллекцию, чтобы посмотреть ее UUID.',
    find: 'Найти UUID',
    uuid: 'UUID',
    field: 'Поле',
    storedAs: 'Способ хранения',
    choices: {
      any: 'Любой из них',
      standard: 'Стандартный (подтип 4)',
      java: 'Устаревший Java (подтип 3)',
      csharp: 'Устаревший C# (подтип 3)',
      python: 'Устаревший Python (подтип 3)',
    },
    names: { standard: 'Стандартный', java: 'Java', csharp: 'C#', python: 'Python' },
    notUuid: 'Это не UUID: введите его 32 шестнадцатеричные цифры, с дефисами или без.',
    needField: 'Укажите поле для поиска.',
    stored: 'Как хранит каждый драйвер',
    copy: 'Копировать',
    copyHint: (e: Encoding, name: string) =>
      e === 'standard'
        ? 'Копирует стандартное значение в том виде, в каком его записывает оболочка'
        : `Копирует значение так, как его хранил драйвер ${name}, в том виде, в каком его записывает оболочка`,
    copyLabel: (name: string) => `Копировать значение (${name})`,
    show: 'Показать в Документах',
    showHint: 'Помещает в запрос вкладки «Документы» фильтр, выбирающий документы с этим UUID',
    failed: 'Не удалось выполнить: ',
    fields: 'Поля UUID',
    sampled: (n: string, count: number) => {
      const form = pluralOf(count, 'ru')
      return `${n} ${form === 'one' ? 'документ' : form === 'few' ? 'документа' : 'документов'} в выборке`
    },
    none: 'В выборке нет UUID',
    noneHint: (n: string, count: number) =>
      `В выборке из ${n} ${pluralOf(count, 'ru') === 'one' ? 'документа' : 'документов'} нет двоичных данных длиной 16 байт с подтипом 3 или 4.`,
    empty: 'Нет документов для выборки',
    emptyHint: 'Эта коллекция пуста.',
    scanFailed: 'Не удалось прочитать выборку',
    tryAgain: 'Повторить',
    counts: (legacy: string, standard: string, legacyCount: number, standardCount: number) =>
      [
        legacy !== '0'
          ? `${legacy} ${pluralOf(legacyCount, 'ru') === 'one' ? 'устаревший' : 'устаревших'}`
          : null,
        standard !== '0'
          ? `${standard} ${pluralOf(standardCount, 'ru') === 'one' ? 'стандартный' : 'стандартных'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    likelyOne: (name: string) => `Хранится в порядке ${name}`,
    likelyMany: (names: string) => `Подходит более чем один порядок: ${names}`,
    likelyNone: 'Ни один порядок не читает все значения: значения от нескольких драйверов или не UUID',
    likelyHint:
      'Цифра версии и вариант UUID находятся в фиксированных местах; при чтении в неверном порядке они почти никогда туда не попадают.',
    example: 'Первое значение, прочитанное в каждом порядке',
    use: 'Искать в этом поле',
  },
} satisfies Record<Language, Text>

type Scan =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; docs: number; fields: UuidField[] }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = pick<Text>(TEXT, 'en')
  let locale = 'en'
  let ctx: PluginContext | null = null
  let scan: Scan = { kind: 'idle' }
  let running = 0
  let problem: unknown = null

  const scanButton = button({ label: text.scan, icon: 'refresh', id: 'scan' })
  const header = pageHeader({ icon: 'search', title: text.title, description: '', actions: [scanButton] })

  // ---- the finder
  const uuidLabel = h('span', { class: 'mm-label' })
  const uuidInput = h('input', {
    id: 'uuid',
    class: 'mm-input mm-mono',
    attrs: {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: '00112233-4455-6677-8899-aabbccddeeff',
    },
  })
  const fieldLabel = h('span', { class: 'mm-label' })
  const fieldList = h('datalist', { id: 'uuid-fields' })
  const fieldInput = h('input', {
    id: 'field',
    class: 'mm-input mm-mono',
    attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', list: 'uuid-fields' },
  })
  const choiceLabel = h('span', { class: 'mm-label' })
  const choiceSelect = h('select', { id: 'stored-as', class: 'mm-select' })
  const findTitle = h('h2', { class: 'mm-section-title' })
  const findHint = h('p', { id: 'find-hint', class: 'mm-status', attrs: { 'aria-live': 'polite' } })
  const storedTitle = h('h3', { class: 'lu-subtitle' })
  const storedList = h('div', { id: 'stored', class: 'lu-stored' })
  const showButton = button({ label: text.show, icon: 'filter', variant: 'primary', id: 'show' })
  const finder = h(
    'section',
    { class: 'mm-card lu-finder', attrs: { 'aria-labelledby': 'find-title' } },
    findTitle,
    h(
      'div',
      { class: 'lu-inputs' },
      h('label', { class: 'mm-field lu-uuid' }, uuidLabel, uuidInput),
      h('label', { class: 'mm-field' }, fieldLabel, fieldInput, fieldList),
      h('label', { class: 'mm-field' }, choiceLabel, choiceSelect),
    ),
    findHint,
    h('div', { class: 'lu-stored-wrap' }, storedTitle, storedList),
    h('div', { class: 'lu-actions' }, showButton),
  )
  findTitle.id = 'find-title'

  // ---- the fields of a sample
  const fieldsTitle = h('h2', { class: 'mm-section-title' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'lu-notes' })
  const results = h('div', { id: 'fields', class: 'lu-fields' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h(
        'div',
        { class: 'mm-body' },
        notes,
        finder,
        h('div', { class: 'mm-summary' }, fieldsTitle, status),
        results,
      ),
    ),
  )

  const number = (n: number) => formatNumber(n, shown(TEXT, locale))

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    setLabel(scanButton, text.scan)
    setLabel(showButton, text.show)
    showButton.title = text.showHint
    findTitle.textContent = text.find
    uuidLabel.textContent = text.uuid
    fieldLabel.textContent = text.field
    choiceLabel.textContent = text.storedAs
    storedTitle.textContent = text.stored
    fieldsTitle.textContent = text.fields
    const chosen = choiceSelect.value || 'any'
    choiceSelect.replaceChildren(
      ...CHOICES.map((c) => h('option', { attrs: { value: c }, text: text.choices[c] })),
    )
    choiceSelect.value = chosen
    renderFinder()
  }

  const choice = (): Choice =>
    CHOICES.includes(choiceSelect.value as Choice) ? (choiceSelect.value as Choice) : 'any'

  function act(ask: Promise<unknown>): void {
    const run = running
    void ask.then(
      () => {
        if (run !== running || problem === null) return
        problem = null
        renderNotes()
      },
      (e: unknown) => {
        if (run !== running) return
        problem = e
        renderNotes()
      },
    )
  }

  function renderNotes(): void {
    notes.replaceChildren(
      ...(problem !== null ? [callout('danger', `${text.failed}${askMessage(problem, locale)}`)] : []),
    )
  }

  function renderFinder(): void {
    const typed = uuidInput.value.trim()
    const uuid = typed ? parseUuid(typed) : null
    const field = fieldInput.value.trim()
    findHint.textContent = typed && !uuid ? text.notUuid : uuid && !field ? text.needField : ''
    uuidInput.setAttribute('aria-invalid', String(!!typed && !uuid))
    showButton.disabled = !uuid || !field
    if (!uuid) {
      storedList.replaceChildren()
      storedList.parentElement!.hidden = true
      return
    }
    storedList.parentElement!.hidden = false
    const chosen = choice()
    storedList.replaceChildren(
      ...ENCODINGS.map((e) => {
        const shell = shellOf(uuid, e)
        const copy = button({
          label: text.copyLabel(text.names[e]),
          icon: 'copy',
          size: 'sm',
          iconOnly: true,
          title: text.copyHint(e, text.names[e]),
          onClick: () => act(client.ask('ui.copy', { text: shell })),
        })
        return h(
          'div',
          { class: `lu-row${chosen === e || chosen === 'any' ? ' lu-chosen' : ''}`, data: { encoding: e } },
          h('span', { class: 'lu-name', text: text.names[e] }),
          h('code', { class: 'mm-mono lu-value', text: shell, title: shell }),
          copy,
        )
      }),
    )
  }

  function show(): void {
    const uuid = parseUuid(uuidInput.value)
    const field = fieldInput.value.trim()
    if (!uuid || !field) return
    act(client.ask('ui.useQuery', { filter: filterFor(field, uuid, choice()) }))
  }

  function use(f: UuidField): void {
    fieldInput.value = f.path
    choiceSelect.value =
      f.legacy === 0 ? 'standard' : f.likely.length === 1 && f.standard === 0 ? f.likely[0]! : 'any'
    renderFinder()
    uuidInput.focus()
  }

  function card(f: UuidField): HTMLElement {
    const names = (list: Encoding[]) => list.map((e) => text.names[e]).join(', ')
    const verdict = f.legacy
      ? f.likely.length === 1
        ? badge(text.likelyOne(text.names[f.likely[0]!]), 'success')
        : f.likely.length > 1
          ? badge(text.likelyMany(names(f.likely)), 'warning')
          : badge(text.likelyNone, 'danger')
      : null
    const example = f.examples[0]
    const readingsList = example
      ? h(
          'div',
          { class: 'lu-readings', attrs: { 'aria-label': text.example } },
          h('p', { class: 'mm-status', text: text.example }),
          ...LEGACY.map((e) => {
            const read = reorder(example, e)
            return h(
              'div',
              { class: `lu-row${f.likely.includes(e) ? ' lu-chosen' : ''}`, data: { reading: e } },
              h('span', { class: 'lu-name', text: text.names[e] }),
              h('code', {
                class: `mm-mono lu-value${wellFormed(read) ? '' : ' lu-odd'}`,
                text: formatUuid(read),
              }),
            )
          }),
        )
      : null
    return h(
      'article',
      { class: 'mm-card lu-card', data: { field: f.path } },
      h(
        'div',
        { class: 'lu-card-head' },
        h('code', { class: 'mm-mono lu-path', text: f.path, title: f.path }),
        h('span', {
          class: 'lu-counts',
          text: text.counts(number(f.legacy), number(f.standard), f.legacy, f.standard),
        }),
        verdict,
      ),
      f.legacy ? h('p', { class: 'lu-hint', text: text.likelyHint }) : null,
      readingsList,
      h(
        'div',
        { class: 'lu-actions' },
        button({ label: text.use, icon: 'search', size: 'sm', onClick: () => use(f) }),
      ),
    )
  }

  function renderScan(): void {
    status.textContent = ''
    if (!ctx) return
    if (!ctx.place) {
      finder.hidden = true
      return void results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    }
    if (scan.kind === 'idle') return void results.replaceChildren()
    if (scan.kind === 'running') {
      status.textContent = text.scanning
      return void results.replaceChildren(skeleton(3))
    }
    if (scan.kind === 'failed')
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.scanFailed,
          hint: askMessage(scan.error, locale),
          action: button({ label: text.tryAgain, icon: 'refresh', onClick: () => void sample() }),
        }),
      )
    status.textContent = text.sampled(number(scan.docs), scan.docs)
    fieldList.replaceChildren(...scan.fields.map((f) => h('option', { attrs: { value: f.path } })))
    if (!scan.docs)
      return void results.replaceChildren(
        emptyState({ icon: 'database', title: text.empty, hint: text.emptyHint }),
      )
    if (!scan.fields.length)
      return void results.replaceChildren(
        emptyState({ icon: 'search', title: text.none, hint: text.noneHint(number(scan.docs), scan.docs) }),
      )
    results.replaceChildren(...scan.fields.map(card))
  }

  async function sample(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    problem = null
    renderNotes()
    setBusy(scanButton, true)
    scan = { kind: 'running' }
    renderScan()
    try {
      const answer = await client.ask<{ documents: unknown[] }>('documents.aggregate', {
        pipeline: [{ $sample: { size: { $numberInt: String(SAMPLE) } } }],
        limit: SAMPLE,
      })
      if (run !== running) return
      scan = { kind: 'done', docs: answer.documents.length, fields: scanUuids(answer.documents) }
      // One field of UUIDs is the one to look in.
      if (!fieldInput.value && scan.fields.length === 1) use(scan.fields[0]!)
    } catch (e) {
      if (run !== running) return
      scan = { kind: 'failed', error: e }
    }
    setBusy(scanButton, false)
    renderScan()
  }

  uuidInput.addEventListener('input', renderFinder)
  fieldInput.addEventListener('input', renderFinder)
  choiceSelect.addEventListener('change', renderFinder)
  for (const input of [uuidInput, fieldInput])
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && !showButton.disabled) show()
    })
  showButton.addEventListener('click', show)
  scanButton.addEventListener('click', () => void sample())

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    renderNotes()
    renderScan()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) {
      scanButton.disabled = true
      renderScan()
      return
    }
    // A sample of 1,000 is bounded: it runs on opening.
    void sample()
  })
  applyText()
}
