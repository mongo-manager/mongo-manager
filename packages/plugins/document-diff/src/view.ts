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
  icon,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  shown,
  segmented,
  setBusy,
  setLabel,
  skeleton,
  valueView,
  type IconName,
  type Language,
  type Tone,
} from '../../kit/src/ui'
import { changesAsJson, diffDocuments, idInput, parseId, type Diff, type Doc } from './diff'

/**
 * Document diff (plugins wave 2; redesigned 2026-10-10, spec plugin-tabs-redesign §2.8). Opened from
 * a document's menu: that document beside another of its collection (an _id typed, or one picked
 * from the first of the collection), compared field by field; the sides can be swapped and the
 * changes copied as JSON.
 */
type Kind = 'changed' | 'removed' | 'added' | 'same'
type Show = 'changes' | 'all'
const KINDS: Kind[] = ['changed', 'removed', 'added', 'same']
const KIND_TONE: Record<Kind, Tone> = {
  changed: 'warning',
  removed: 'danger',
  added: 'success',
  same: 'neutral',
}
const KIND_ICON: Record<Kind, IconName> = {
  changed: 'arrowRight',
  removed: 'minus',
  added: 'plus',
  same: 'check',
}
const NAMES = ['name', 'title', 'label', 'displayName', 'fullName', 'username', 'email', 'code', 'slug']

/** A count's plural category in the language shown (the kit's pluralOf). */
type Plural = Intl.LDMLPluralRule

/** One language's words. A count template gets the number as written and its plural category. */
export type Text = {
  title: string
  description: string
  left: string
  right: string
  notPicked: string
  otherLabel: string
  placeholder: string
  listLabel: string
  pick: string
  compare: string
  swap: string
  copy: string
  filterLabel: string
  shows: Record<Show, string>
  field: string
  counts: Record<Kind, (written: string, plural: Plural) => string>
  kinds: Record<Kind, string>
  missing: string
  idleTitle: string
  idleHint: string
  sameTitle: string
  sameHint: (written: string, plural: Plural) => string
  showAll: string
  selfTitle: string
  selfHint: string
  notFound: string
  goneTitle: string
  noDocument: string
  failed: string
  listFailed: string
  copyFailed: string
  empty: string
}

const EN = {
  title: 'Compare documents',
  description: 'Field by field, nested values and arrays included; the _id aside.',
  left: 'Left',
  right: 'Right',
  notPicked: 'Not picked yet',
  otherLabel: 'Other document’s _id',
  placeholder: 'Other document’s _id: an ObjectId, a number, a string or Extended JSON',
  listLabel: 'Or one of this collection',
  pick: 'Pick one of this collection…',
  compare: 'Compare',
  swap: 'Swap sides',
  copy: 'Copy changes as JSON',
  filterLabel: 'Which fields',
  shows: { changes: 'Changes only', all: 'All fields' },
  field: 'Field',
  counts: {
    changed: (n) => `${n} changed`,
    removed: (n) => `${n} only left`,
    added: (n) => `${n} only right`,
    same: (n) => `${n} same`,
  },
  kinds: { changed: 'Changed', removed: 'Only left', added: 'Only right', same: 'Same' },
  missing: 'Not in this document',
  idleTitle: 'Pick a document to compare with',
  idleHint: 'Type its _id above, or pick one of this collection.',
  sameTitle: 'The two documents are the same',
  sameHint: (n, p) => `${n} ${p === 'one' ? 'field' : 'fields'}, the _id aside.`,
  showAll: 'Show all fields',
  selfTitle: 'That is this document',
  selfHint: 'Pick another one to compare with.',
  notFound: 'No document of this collection has this _id.',
  goneTitle: 'This document is no longer in the collection.',
  noDocument: 'Open this from a document’s menu to compare it.',
  failed: 'The documents could not be compared',
  listFailed: 'The documents of this collection could not be listed',
  copyFailed: 'Could not copy: ',
  empty: 'Type an _id, or pick a document.',
} satisfies Text

/** Exported for the tests: every language keeps the same keys as English. */
export const TEXT = {
  en: EN,
  tr: {
    title: 'Belgeleri karşılaştır',
    description: 'Alan alan; iç içe değerler ve diziler dahil, _id dışında.',
    left: 'Sol',
    right: 'Sağ',
    notPicked: 'Henüz seçilmedi',
    otherLabel: 'Diğer belgenin _id’si',
    placeholder: 'Diğer belgenin _id’si: bir ObjectId, sayı, metin ya da Extended JSON',
    listLabel: 'Ya da bu koleksiyondan biri',
    pick: 'Bu koleksiyondan birini seçin…',
    compare: 'Karşılaştır',
    swap: 'Tarafları değiştir',
    copy: 'Farkları JSON olarak kopyala',
    filterLabel: 'Hangi alanlar',
    shows: { changes: 'Yalnız farklar', all: 'Bütün alanlar' },
    field: 'Alan',
    counts: {
      changed: (n) => `${n} değişen`,
      removed: (n) => `${n} yalnız solda`,
      added: (n) => `${n} yalnız sağda`,
      same: (n) => `${n} aynı`,
    },
    kinds: { changed: 'Değişti', removed: 'Yalnız solda', added: 'Yalnız sağda', same: 'Aynı' },
    missing: 'Bu belgede yok',
    idleTitle: 'Karşılaştırılacak belgeyi seçin',
    idleHint: 'Yukarıya _id’sini yazın ya da bu koleksiyondan birini seçin.',
    sameTitle: 'İki belge aynı',
    sameHint: (n) => `${n} alan, _id dışında.`,
    showAll: 'Bütün alanları göster',
    selfTitle: 'Bu, bu belgenin kendisi',
    selfHint: 'Karşılaştırmak için başka bir belge seçin.',
    notFound: 'Bu koleksiyonda bu _id’ye sahip bir belge yok.',
    goneTitle: 'Bu belge artık koleksiyonda yok.',
    noDocument: 'Karşılaştırmak için bunu bir belgenin menüsünden açın.',
    failed: 'Belgeler karşılaştırılamadı',
    listFailed: 'Bu koleksiyonun belgeleri listelenemedi',
    copyFailed: 'Kopyalanamadı: ',
    empty: 'Bir _id yazın ya da bir belge seçin.',
  },
  zh: {
    title: '比较文档',
    description: '逐字段比较，包括嵌套值和数组；_id 除外。',
    left: '左',
    right: '右',
    notPicked: '尚未选择',
    otherLabel: '另一个文档的 _id',
    placeholder: '另一个文档的 _id：ObjectId、数字、字符串或 Extended JSON',
    listLabel: '或选择此集合中的一个',
    pick: '选择此集合中的一个…',
    compare: '比较',
    swap: '交换两侧',
    copy: '将差异复制为 JSON',
    filterLabel: '显示哪些字段',
    shows: { changes: '仅差异', all: '所有字段' },
    field: '字段',
    counts: {
      changed: (n) => `${n} 个已更改`,
      removed: (n) => `${n} 个仅在左侧`,
      added: (n) => `${n} 个仅在右侧`,
      same: (n) => `${n} 个相同`,
    },
    kinds: { changed: '已更改', removed: '仅在左侧', added: '仅在右侧', same: '相同' },
    missing: '此文档中没有',
    idleTitle: '请选择要比较的文档',
    idleHint: '在上方输入其 _id，或选择此集合中的一个。',
    sameTitle: '两个文档相同',
    sameHint: (n) => `${n} 个字段，_id 除外。`,
    showAll: '显示所有字段',
    selfTitle: '这就是当前文档',
    selfHint: '请选择另一个文档进行比较。',
    notFound: '此集合中没有该 _id 的文档。',
    goneTitle: '此文档已不在集合中。',
    noDocument: '请从文档的菜单中打开此功能进行比较。',
    failed: '无法比较这些文档',
    listFailed: '无法列出此集合的文档',
    copyFailed: '无法复制：',
    empty: '请输入 _id，或选择一个文档。',
  },
  ja: {
    title: 'ドキュメントを比較',
    description: 'フィールドごとに比較します。ネストされた値や配列も対象で、_id は除きます。',
    left: '左',
    right: '右',
    notPicked: '未選択',
    otherLabel: '比較先ドキュメントの _id',
    placeholder: '比較先ドキュメントの _id: ObjectId、数値、文字列、または Extended JSON',
    listLabel: 'またはこのコレクションから選択',
    pick: 'このコレクションから選択…',
    compare: '比較',
    swap: '左右を入れ替え',
    copy: '差分を JSON としてコピー',
    filterLabel: '表示するフィールド',
    shows: { changes: '差分のみ', all: 'すべてのフィールド' },
    field: 'フィールド',
    counts: {
      changed: (n) => `変更 ${n} 件`,
      removed: (n) => `左のみ ${n} 件`,
      added: (n) => `右のみ ${n} 件`,
      same: (n) => `同一 ${n} 件`,
    },
    kinds: { changed: '変更あり', removed: '左のみ', added: '右のみ', same: '同一' },
    missing: 'このドキュメントにはありません',
    idleTitle: '比較するドキュメントを選択してください',
    idleHint: '上に _id を入力するか、このコレクションから選択してください。',
    sameTitle: '2 つのドキュメントは同一です',
    sameHint: (n) => `${n} 件のフィールド（_id を除く）。`,
    showAll: 'すべてのフィールドを表示',
    selfTitle: 'これは現在のドキュメント自身です',
    selfHint: '比較する別のドキュメントを選択してください。',
    notFound: 'このコレクションに、この _id のドキュメントはありません。',
    goneTitle: 'このドキュメントはすでにコレクションにありません。',
    noDocument: '比較するには、ドキュメントのメニューからこれを開いてください。',
    failed: 'ドキュメントを比較できませんでした',
    listFailed: 'このコレクションのドキュメントを一覧表示できませんでした',
    copyFailed: 'コピーできませんでした： ',
    empty: '_id を入力するか、ドキュメントを選択してください。',
  },
  es: {
    title: 'Comparar documentos',
    description: 'Campo por campo, con valores anidados y arreglos incluidos; salvo el _id.',
    left: 'Izquierda',
    right: 'Derecha',
    notPicked: 'Aún sin elegir',
    otherLabel: '_id del otro documento',
    placeholder: '_id del otro documento: un ObjectId, un número, una cadena o Extended JSON',
    listLabel: 'O uno de esta colección',
    pick: 'Elige uno de esta colección…',
    compare: 'Comparar',
    swap: 'Intercambiar lados',
    copy: 'Copiar los cambios como JSON',
    filterLabel: 'Qué campos',
    shows: { changes: 'Solo cambios', all: 'Todos los campos' },
    field: 'Campo',
    counts: {
      changed: (n, p) => `${n} ${p === 'one' ? 'cambiado' : 'cambiados'}`,
      removed: (n) => `${n} solo a la izquierda`,
      added: (n) => `${n} solo a la derecha`,
      same: (n, p) => `${n} ${p === 'one' ? 'igual' : 'iguales'}`,
    },
    kinds: {
      changed: 'Cambiado',
      removed: 'Solo a la izquierda',
      added: 'Solo a la derecha',
      same: 'Igual',
    },
    missing: 'No está en este documento',
    idleTitle: 'Elige un documento con el que comparar',
    idleHint: 'Escribe arriba su _id o elige uno de esta colección.',
    sameTitle: 'Los dos documentos son iguales',
    sameHint: (n, p) => `${n} ${p === 'one' ? 'campo' : 'campos'}, salvo el _id.`,
    showAll: 'Mostrar todos los campos',
    selfTitle: 'Ese es este mismo documento',
    selfHint: 'Elige otro documento con el que comparar.',
    notFound: 'Ningún documento de esta colección tiene este _id.',
    goneTitle: 'Este documento ya no está en la colección.',
    noDocument: 'Ábrelo desde el menú de un documento para compararlo.',
    failed: 'No se pudieron comparar los documentos',
    listFailed: 'No se pudieron listar los documentos de esta colección',
    copyFailed: 'No se pudo copiar: ',
    empty: 'Escribe un _id o elige un documento.',
  },
  pt: {
    title: 'Comparar documentos',
    description: 'Campo a campo, incluindo valores aninhados e arrays; exceto o _id.',
    left: 'Esquerda',
    right: 'Direita',
    notPicked: 'Ainda não escolhido',
    otherLabel: '_id do outro documento',
    placeholder: '_id do outro documento: um ObjectId, um número, uma string ou Extended JSON',
    listLabel: 'Ou um desta coleção',
    pick: 'Escolha um desta coleção…',
    compare: 'Comparar',
    swap: 'Trocar os lados',
    copy: 'Copiar as diferenças como JSON',
    filterLabel: 'Quais campos',
    shows: { changes: 'Somente diferenças', all: 'Todos os campos' },
    field: 'Campo',
    counts: {
      changed: (n, p) => `${n} ${p === 'one' ? 'alterado' : 'alterados'}`,
      removed: (n) => `${n} somente à esquerda`,
      added: (n) => `${n} somente à direita`,
      same: (n, p) => `${n} ${p === 'one' ? 'igual' : 'iguais'}`,
    },
    kinds: {
      changed: 'Alterado',
      removed: 'Somente à esquerda',
      added: 'Somente à direita',
      same: 'Igual',
    },
    missing: 'Não está neste documento',
    idleTitle: 'Escolha um documento para comparar',
    idleHint: 'Digite o _id dele acima ou escolha um desta coleção.',
    sameTitle: 'Os dois documentos são iguais',
    sameHint: (n, p) => `${n} ${p === 'one' ? 'campo' : 'campos'}, exceto o _id.`,
    showAll: 'Mostrar todos os campos',
    selfTitle: 'Este é o próprio documento',
    selfHint: 'Escolha outro documento para comparar.',
    notFound: 'Nenhum documento desta coleção tem este _id.',
    goneTitle: 'Este documento não está mais na coleção.',
    noDocument: 'Abra isto pelo menu de um documento para compará-lo.',
    failed: 'Não foi possível comparar os documentos',
    listFailed: 'Não foi possível listar os documentos desta coleção',
    copyFailed: 'Não foi possível copiar: ',
    empty: 'Digite um _id ou escolha um documento.',
  },
  ko: {
    title: '도큐먼트 비교',
    description: '필드 단위로 비교합니다. 중첩 값과 배열도 포함하며 _id는 제외합니다.',
    left: '왼쪽',
    right: '오른쪽',
    notPicked: '아직 선택 안 함',
    otherLabel: '상대 도큐먼트의 _id',
    placeholder: '상대 도큐먼트의 _id: ObjectId, 숫자, 문자열 또는 Extended JSON',
    listLabel: '또는 이 컬렉션의 도큐먼트 중 선택',
    pick: '이 컬렉션에서 선택…',
    compare: '비교',
    swap: '좌우 바꾸기',
    copy: '변경 사항을 JSON으로 복사',
    filterLabel: '표시할 필드',
    shows: { changes: '변경 사항만', all: '모든 필드' },
    field: '필드',
    counts: {
      changed: (n) => `${n}개 변경됨`,
      removed: (n) => `왼쪽에만 ${n}개`,
      added: (n) => `오른쪽에만 ${n}개`,
      same: (n) => `${n}개 동일`,
    },
    kinds: { changed: '변경됨', removed: '왼쪽에만 있음', added: '오른쪽에만 있음', same: '동일' },
    missing: '이 도큐먼트에 없음',
    idleTitle: '비교할 도큐먼트를 선택하세요',
    idleHint: '위에 _id를 입력하거나 이 컬렉션에서 선택하세요.',
    sameTitle: '두 도큐먼트가 동일합니다',
    sameHint: (n) => `필드 ${n}개(_id 제외).`,
    showAll: '모든 필드 표시',
    selfTitle: '현재 도큐먼트 자신입니다',
    selfHint: '비교할 다른 도큐먼트를 선택하세요.',
    notFound: '이 컬렉션에 이 _id를 가진 도큐먼트가 없습니다.',
    goneTitle: '이 도큐먼트는 더 이상 컬렉션에 없습니다.',
    noDocument: '비교하려면 도큐먼트의 메뉴에서 여세요.',
    failed: '도큐먼트를 비교할 수 없습니다',
    listFailed: '이 컬렉션의 도큐먼트를 나열할 수 없습니다',
    copyFailed: '복사할 수 없습니다: ',
    empty: '_id를 입력하거나 도큐먼트를 선택하세요.',
  },
  de: {
    title: 'Dokumente vergleichen',
    description: 'Feld für Feld, einschließlich verschachtelter Werte und Arrays; ohne die _id.',
    left: 'Links',
    right: 'Rechts',
    notPicked: 'Noch nicht ausgewählt',
    otherLabel: '_id des anderen Dokuments',
    placeholder: '_id des anderen Dokuments: ObjectId, Zahl, String oder Extended JSON',
    listLabel: 'Oder eines aus dieser Collection',
    pick: 'Eines aus dieser Collection auswählen…',
    compare: 'Vergleichen',
    swap: 'Seiten tauschen',
    copy: 'Änderungen als JSON kopieren',
    filterLabel: 'Welche Felder',
    shows: { changes: 'Nur Änderungen', all: 'Alle Felder' },
    field: 'Feld',
    counts: {
      changed: (n) => `${n} geändert`,
      removed: (n) => `${n} nur links`,
      added: (n) => `${n} nur rechts`,
      same: (n) => `${n} gleich`,
    },
    kinds: { changed: 'Geändert', removed: 'Nur links', added: 'Nur rechts', same: 'Gleich' },
    missing: 'Nicht in diesem Dokument',
    idleTitle: 'Wählen Sie ein Dokument zum Vergleichen aus',
    idleHint: 'Geben Sie oben die _id ein oder wählen Sie eines aus dieser Collection.',
    sameTitle: 'Die beiden Dokumente sind gleich',
    sameHint: (n, p) => `${n} ${p === 'one' ? 'Feld' : 'Felder'}, ohne die _id.`,
    showAll: 'Alle Felder anzeigen',
    selfTitle: 'Das ist dieses Dokument selbst',
    selfHint: 'Wählen Sie ein anderes Dokument zum Vergleichen aus.',
    notFound: 'Kein Dokument dieser Collection hat diese _id.',
    goneTitle: 'Dieses Dokument ist nicht mehr in der Collection.',
    noDocument: 'Öffnen Sie dies über das Menü eines Dokuments, um es zu vergleichen.',
    failed: 'Die Dokumente konnten nicht verglichen werden',
    listFailed: 'Die Dokumente dieser Collection konnten nicht aufgelistet werden',
    copyFailed: 'Kopieren nicht möglich: ',
    empty: 'Geben Sie eine _id ein oder wählen Sie ein Dokument aus.',
  },
  fr: {
    title: 'Comparer des documents',
    description: 'Champ par champ, valeurs imbriquées et tableaux compris ; hors _id.',
    left: 'Gauche',
    right: 'Droite',
    notPicked: 'Pas encore choisi',
    otherLabel: '_id de l’autre document',
    placeholder: '_id de l’autre document : un ObjectId, un nombre, une chaîne ou de l’Extended JSON',
    listLabel: 'Ou un document de cette collection',
    pick: 'Choisir un document de cette collection…',
    compare: 'Comparer',
    swap: 'Inverser les côtés',
    copy: 'Copier les changements en JSON',
    filterLabel: 'Quels champs',
    shows: { changes: 'Changements seuls', all: 'Tous les champs' },
    field: 'Champ',
    counts: {
      changed: (n, p) => `${n} ${p === 'one' ? 'modifié' : 'modifiés'}`,
      removed: (n) => `${n} uniquement à gauche`,
      added: (n) => `${n} uniquement à droite`,
      same: (n, p) => `${n} ${p === 'one' ? 'identique' : 'identiques'}`,
    },
    kinds: {
      changed: 'Modifié',
      removed: 'Uniquement à gauche',
      added: 'Uniquement à droite',
      same: 'Identique',
    },
    missing: 'Absent de ce document',
    idleTitle: 'Choisissez un document à comparer',
    idleHint: 'Saisissez son _id ci-dessus ou choisissez un document de cette collection.',
    sameTitle: 'Les deux documents sont identiques',
    sameHint: (n, p) => `${n} ${p === 'one' ? 'champ' : 'champs'}, hors _id.`,
    showAll: 'Afficher tous les champs',
    selfTitle: 'C’est ce document lui-même',
    selfHint: 'Choisissez un autre document à comparer.',
    notFound: 'Aucun document de cette collection n’a cet _id.',
    goneTitle: 'Ce document n’est plus dans la collection.',
    noDocument: 'Ouvrez ceci depuis le menu d’un document pour le comparer.',
    failed: 'Impossible de comparer les documents',
    listFailed: 'Impossible de lister les documents de cette collection',
    copyFailed: 'Impossible de copier : ',
    empty: 'Saisissez un _id ou choisissez un document.',
  },
  ru: {
    title: 'Сравнение документов',
    description: 'Поле за полем, включая вложенные значения и массивы; кроме _id.',
    left: 'Слева',
    right: 'Справа',
    notPicked: 'Пока не выбран',
    otherLabel: '_id другого документа',
    placeholder: '_id другого документа: ObjectId, число, строка или Extended JSON',
    listLabel: 'Или один из этой коллекции',
    pick: 'Выберите документ из этой коллекции…',
    compare: 'Сравнить',
    swap: 'Поменять стороны',
    copy: 'Копировать изменения как JSON',
    filterLabel: 'Какие поля',
    shows: { changes: 'Только изменения', all: 'Все поля' },
    field: 'Поле',
    counts: {
      changed: (n) => `Изменено: ${n}`,
      removed: (n) => `${n} только слева`,
      added: (n) => `${n} только справа`,
      same: (n) => `${n} без изменений`,
    },
    kinds: { changed: 'Изменено', removed: 'Только слева', added: 'Только справа', same: 'Совпадает' },
    missing: 'Нет в этом документе',
    idleTitle: 'Выберите документ для сравнения',
    idleHint: 'Введите его _id выше или выберите документ из этой коллекции.',
    sameTitle: 'Документы совпадают',
    sameHint: (n, p) => `${n} ${p === 'one' ? 'поле' : p === 'few' ? 'поля' : 'полей'}, кроме _id.`,
    showAll: 'Показать все поля',
    selfTitle: 'Это сам документ',
    selfHint: 'Выберите другой документ для сравнения.',
    notFound: 'В этой коллекции нет документа с таким _id.',
    goneTitle: 'Этого документа больше нет в коллекции.',
    noDocument: 'Откройте это из меню документа, чтобы сравнить его.',
    failed: 'Не удалось сравнить документы',
    listFailed: 'Не удалось получить список документов этой коллекции',
    copyFailed: 'Не удалось скопировать: ',
    empty: 'Введите _id или выберите документ.',
  },
} satisfies Record<Language, Text>
type State =
  | { kind: 'loading' }
  | { kind: 'noDocument' }
  | { kind: 'gone' }
  | { kind: 'idle' }
  | { kind: 'comparing' }
  | { kind: 'empty' }
  | { kind: 'notFound' }
  | { kind: 'self' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done' }

/** An _id as one line shows it. */
function idText(id: unknown): string {
  if (typeof id === 'string') return JSON.stringify(id)
  if (id && typeof id === 'object') {
    const o = id as Record<string, unknown>
    for (const k of ['$oid', '$numberInt', '$numberLong', '$numberDouble'])
      if (typeof o[k] === 'string') return o[k] as string
  }
  return JSON.stringify(id) ?? ''
}
const nameOf = (d: Doc) => {
  const n = NAMES.map((k) => d[k]).find((v) => typeof v === 'string' && v.trim())
  return typeof n === 'string' ? n.slice(0, 40) : ''
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** An array or an object of fields, not a value wrapper such as { $oid }. */
const isNested = (v: unknown) => {
  if (Array.isArray(v)) return true
  if (!v || typeof v !== 'object') return false
  const keys = Object.keys(v)
  return !keys.length || !keys.every((k) => k.startsWith('$'))
}

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = EN
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'loading' }
  let mine: Doc | null = null
  let picked: Doc[] = []
  let sides: { left: Doc; right: Doc } | null = null
  let show: Show = 'changes'
  // Failures kept as they came, put in words when shown: a language change re-words them.
  let listError: unknown = null
  let copyError: unknown = null
  let running = 0

  // ---- the page
  const swapButton = button({ label: text.swap, icon: 'compare', size: 'sm', id: 'swap' })
  const copyButton = button({ label: text.copy, icon: 'copy', size: 'sm', variant: 'ghost', id: 'copy' })
  swapButton.hidden = true
  copyButton.hidden = true
  const header = pageHeader({
    icon: 'compare',
    title: text.title,
    description: text.description,
    actions: [copyButton, swapButton],
  })
  const side = (which: 'left' | 'right') => {
    const label = h('span', { class: 'dd-side-label' })
    const id = h('span', { id: `${which}-id`, class: 'mm-mono dd-side-id' })
    const name = h('span', { class: 'dd-side-name' })
    return { el: h('div', { class: `dd-side dd-side-${which}` }, label, id, name), label, id, name }
  }
  const leftSide = side('left')
  const rightSide = side('right')
  const sidesRow = h(
    'div',
    { class: 'dd-sides' },
    leftSide.el,
    h('span', { class: 'dd-sides-arrow' }, icon('compare', 16)),
    rightSide.el,
  )
  const other = h('input', {
    id: 'other',
    class: 'mm-input dd-other',
    attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' },
  })
  const otherLabel = h('label', { class: 'mm-sr', attrs: { for: 'other' } })
  const compareButton = button({ label: text.compare, icon: 'compare', variant: 'primary', id: 'compare' })
  const list = h('select', { id: 'list', class: 'mm-select dd-list' })
  const listLabel = h('label', { class: 'mm-sr', attrs: { for: 'list' } })
  const filter = segmented<Show>({
    label: text.filterLabel,
    id: 'filter',
    options: [
      { value: 'changes', label: text.shows.changes },
      { value: 'all', label: text.shows.all },
    ],
    value: 'changes',
    onChange: (next) => {
      show = next
      render()
    },
  })
  const status = h('div', {
    id: 'status',
    class: 'dd-counts',
    attrs: { role: 'status', 'aria-live': 'polite' },
  })
  const notes = h('div', { class: 'dd-notes' })
  const results = h('div', { id: 'results', class: 'dd-results' })
  const summaryRow = h('div', { class: 'mm-summary' }, status, h('span', { class: 'mm-spacer' }), filter.el)
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h(
        'div',
        { class: 'mm-toolbar' },
        h('div', { class: 'mm-toolbar-row' }, sidesRow),
        h('div', { class: 'mm-toolbar-row' }, otherLabel, other, compareButton, listLabel, list),
      ),
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, summaryRow, notes, results),
    ),
  )

  const language = () => shown(TEXT, locale)
  const number = (n: number) => formatNumber(n, language())

  function applyText(): void {
    header.setText(text.title, text.description)
    setLabel(swapButton, text.swap)
    setLabel(copyButton, text.copy)
    otherLabel.textContent = text.otherLabel
    other.placeholder = text.placeholder
    setLabel(compareButton, text.compare)
    listLabel.textContent = text.listLabel
    filter.relabel(text.shows)
    filter.el.setAttribute('aria-label', text.filterLabel)
    fillList()
  }

  function fillList(): void {
    const chosen = list.value
    list.replaceChildren(
      h('option', { attrs: { value: '' }, text: text.pick }),
      ...picked.map((d, i) => {
        const name = nameOf(d)
        return h('option', {
          attrs: { value: String(i) },
          text: name ? `${idText(d._id)} — ${name}` : idText(d._id),
        })
      }),
    )
    list.value = chosen
  }

  function paintSides(): void {
    const left = sides?.left ?? mine
    const right = sides?.right ?? null
    leftSide.label.textContent = text.left
    rightSide.label.textContent = text.right
    leftSide.id.textContent = left ? idText(left._id) : ''
    leftSide.name.textContent = left ? nameOf(left) : ''
    rightSide.id.textContent = right ? idText(right._id) : ''
    rightSide.name.textContent = right ? nameOf(right) : text.notPicked
    rightSide.el.classList.toggle('dd-side-empty', !right)
  }

  /** A value as a cell shows it: in its type's colour, a nested one as compact JSON. */
  function valueCell(v: unknown, present: boolean): HTMLElement {
    if (!present) return h('span', { class: 'dd-missing', title: text.missing }, '—')
    if (isNested(v)) {
      const json = JSON.stringify(v)
      const cut = json.length > 300 ? `${json.slice(0, 299)}…` : json
      return h(
        'span',
        { class: 'mm-value mm-v-object dd-json', ...(cut !== json ? { title: json.slice(0, 2000) } : {}) },
        cut,
      )
    }
    return valueView(v, 300)
  }

  function table(diff: Diff): HTMLElement {
    const body = h('tbody')
    const rows = [
      ...diff.changes.map((c) => ({ kind: c.kind as Kind, path: c.path, left: c.left, right: c.right })),
      ...(show === 'all'
        ? diff.same.map((s) => ({ kind: 'same' as Kind, path: s.path, left: s.value, right: s.value }))
        : []),
    ]
    for (const r of rows)
      body.append(
        h(
          'tr',
          { class: `dd-row dd-${r.kind}`, data: { kind: r.kind } },
          h(
            'td',
            {},
            h(
              'div',
              { class: 'dd-field' },
              // The kind in words, not by colour alone (review M6).
              h(
                'span',
                { class: 'dd-mark', title: text.kinds[r.kind] },
                icon(KIND_ICON[r.kind], 13),
                h('span', { class: 'mm-sr', text: text.kinds[r.kind] }),
              ),
              h('span', { class: 'mm-mono dd-path', text: r.path }),
            ),
          ),
          h('td', { class: 'dd-value' }, valueCell(r.left, r.kind !== 'added')),
          h('td', { class: 'dd-value' }, valueCell(r.right, r.kind !== 'removed')),
        ),
      )
    const head = (label: string, id: unknown) =>
      h(
        'th',
        { attrs: { scope: 'col' } },
        label,
        h('span', { class: 'mm-mono dd-head-id', text: idText(id) }),
      )
    return h(
      'div',
      { class: 'mm-table-wrap' },
      h(
        'table',
        { id: 'diff', class: 'mm-table dd-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { attrs: { scope: 'col' }, text: text.field }),
            head(text.left, sides!.left._id),
            head(text.right, sides!.right._id),
          ),
        ),
        body,
      ),
    )
  }

  function render(): void {
    paintSides()
    status.replaceChildren()
    notes.replaceChildren()
    if (listError !== null) notes.append(callout('warning', text.listFailed, askMessage(listError, locale)))
    if (copyError !== null)
      notes.append(callout('danger', `${text.copyFailed}${askMessage(copyError, locale)}`))
    const done = state.kind === 'done' && sides !== null
    swapButton.hidden = !done
    copyButton.hidden = true
    filter.el.hidden = !done
    switch (state.kind) {
      case 'loading':
      case 'comparing':
        return void results.replaceChildren(skeleton(5))
      case 'noDocument':
        return void results.replaceChildren(emptyState({ icon: 'database', title: text.noDocument }))
      case 'gone':
        return void results.replaceChildren(
          emptyState({ icon: 'warning', tone: 'warning', title: text.goneTitle }),
        )
      case 'idle':
        return void results.replaceChildren(
          emptyState({ icon: 'compare', title: text.idleTitle, hint: text.idleHint }),
        )
      case 'empty':
        return void results.replaceChildren(
          emptyState({ icon: 'compare', tone: 'warning', title: text.empty }),
        )
      case 'notFound':
        return void results.replaceChildren(
          emptyState({ icon: 'search', tone: 'warning', title: text.notFound }),
        )
      case 'self':
        return void results.replaceChildren(
          emptyState({ icon: 'info', title: text.selfTitle, hint: text.selfHint }),
        )
      case 'failed':
        return void results.replaceChildren(
          emptyState({
            icon: 'error',
            tone: 'danger',
            title: text.failed,
            hint: askMessage(state.error, locale),
          }),
        )
    }
    if (!sides) return
    const diff = diffDocuments(sides.left, sides.right)
    const count = (k: Kind) =>
      k === 'same' ? diff.same.length : diff.changes.filter((c) => c.kind === k).length
    for (const k of KINDS) {
      const n = count(k)
      status.append(badge(text.counts[k](number(n), pluralOf(n, language())), n ? KIND_TONE[k] : 'neutral'))
    }
    copyButton.hidden = !diff.changes.length
    if (!diff.changes.length && show === 'changes') {
      const all = button({
        label: text.showAll,
        onClick: () => {
          filter.set('all')
          show = 'all'
          render()
        },
      })
      results.replaceChildren(
        emptyState({
          icon: 'ok',
          tone: 'success',
          title: text.sameTitle,
          hint: text.sameHint(number(diff.same.length), pluralOf(diff.same.length, language())),
          ...(diff.same.length ? { action: all } : {}),
        }),
      )
      return
    }
    results.replaceChildren(table(diff))
  }

  async function compareWith(id: unknown): Promise<void> {
    if (!mine) return
    const run = ++running
    copyError = null
    // Whatever this request is, it is the latest: an earlier read still out stops showing busy.
    setBusy(compareButton, false)
    if (id === null) {
      state = { kind: 'empty' }
      sides = null
      return render()
    }
    if (same(id, mine._id)) {
      state = { kind: 'self' }
      sides = null
      return render()
    }
    state = { kind: 'comparing' }
    setBusy(compareButton, true)
    render()
    try {
      const right = await client.ask<Doc | null>('documents.get', { id })
      if (run !== running) return
      if (!right) {
        state = { kind: 'notFound' }
        sides = null
      } else {
        state = { kind: 'done' }
        sides = { left: mine, right }
      }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
      sides = null
    }
    setBusy(compareButton, false)
    render()
  }

  compareButton.addEventListener('click', () => void compareWith(parseId(other.value)))
  other.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void compareWith(parseId(other.value))
  })
  list.addEventListener('change', () => {
    const d = picked[Number(list.value)]
    if (!list.value || !d) return
    // Shown so that it reads back as this very _id (review M10).
    other.value = idInput(d._id)
    void compareWith(d._id)
  })
  swapButton.addEventListener('click', () => {
    if (!sides) return
    sides = { left: sides.right, right: sides.left }
    render()
  })
  copyButton.addEventListener('click', () => {
    if (!sides) return
    const run = running
    void client.ask('ui.copy', { text: changesAsJson(diffDocuments(sides.left, sides.right)) }).then(
      () => {
        if (run !== running || copyError === null) return
        copyError = null
        render()
      },
      (e: unknown) => {
        // A copy of a comparison since replaced says nothing.
        if (run !== running) return
        copyError = e
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
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    const id = ctx.place?.documentId
    if (!ctx.place || id === null || id === undefined) {
      state = { kind: 'noDocument' }
      for (const c of [compareButton, other, list]) c.disabled = true
      return render()
    }
    render()
    try {
      mine = await client.ask<Doc | null>('documents.get', { id })
    } catch (e) {
      // Nothing to compare: Compare would only do nothing.
      state = { kind: 'failed', error: e }
      for (const c of [compareButton, other, list]) c.disabled = true
      return render()
    }
    if (!mine) {
      state = { kind: 'gone' }
      for (const c of [compareButton, other, list]) c.disabled = true
      return render()
    }
    // No focus taken: inside the dialog's frame it would keep Escape from closing the dialog.
    state = { kind: 'idle' }
    render()
    try {
      const projection = Object.fromEntries([['_id', 1], ...NAMES.map((n) => [n, 1])])
      const found = await client.ask<{ documents: Doc[] }>('documents.find', {
        filter: ctx.place.filter ?? {},
        projection,
        limit: 51,
      })
      const own = JSON.stringify(mine._id)
      picked = found.documents.filter((d) => JSON.stringify(d._id) !== own).slice(0, 50)
      fillList()
    } catch (e) {
      listError = e
      render()
    }
  })
  applyText()
  render()
}
