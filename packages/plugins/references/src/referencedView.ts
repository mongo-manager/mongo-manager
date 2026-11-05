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
  langTag,
  pick,
  shown,
  h,
  type Language,
  pageHeader,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { shellText } from '../../kit/src/shell'
import { nameOf, type Doc } from './infer'
import { isOne, ru } from './plural'
import { findReferring, referringFilter, type Referred, type ReferringGroup } from './referenced'

/** The words of the page, one block per language (the compiler checks all ten are there). */
interface Text {
  title: string
  description: (coll: string) => string
  looking: string
  noDocument: string
  none: string
  noneHint: (n: number) => string
  found: (n: number) => string
  documents: (n: number, more: boolean) => string
  show: (coll: string) => string
  showHint: (coll: string) => string
  failed: string
  fieldFailed: (coll: string, path: string) => string
  limited: (n: number) => string
  noneAsked: string
  noneCouldAsk: string
  showFailed: string
  unnamed: string
}

/**
 * Referenced by (research 2026-10-28: CUSTOMER-I-6695), a document action: the documents of the
 * database that refer to this one — by the references its model finds — each field's listed by
 * name, and shown in Documents of their own collection on a click. Changes nothing.
 */
export const TEXT = {
  en: {
    title: 'Referenced by',
    description: (coll: string) => `The documents of this database that refer to this document of ${coll}.`,
    looking: 'Looking for the documents that refer to it…',
    noDocument: 'Open a document to see what refers to it.',
    none: 'Nothing refers to this document',
    noneHint: (n: number) =>
      n
        ? isOne(n, 'en')
          ? 'The 1 field that refers to this collection does not hold its id.'
          : `None of the ${n} fields that refer to this collection holds its id.`
        : 'The database’s model finds no field that refers to this collection (by its name, its values or a $lookup).',
    found: (n: number) => `${n} ${isOne(n, 'en') ? 'field refers' : 'fields refer'} to it`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${isOne(n, 'en') && !more ? 'document' : 'documents'}`,
    show: (coll: string) => `Show in ${coll}`,
    showHint: (coll: string) => `Puts a filter selecting these documents in the Documents query of ${coll}`,
    failed: 'It could not be looked for',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} could not be read`,
    limited: (n: number) =>
      `${n} ${isOne(n, 'en') ? 'field was' : 'fields were'} not asked: the app reads only so many a minute. Open it again in a minute.`,
    noneAsked: 'Nothing found in the fields it could ask',
    noneCouldAsk: 'None of the fields that refer to this collection could be asked',
    showFailed: 'Could not open Documents: ',
    unnamed: 'unnamed',
  },
  tr: {
    title: 'Başvuranlar',
    description: (coll: string) => `Bu veritabanında, ${coll} koleksiyonunun bu belgesine başvuran belgeler.`,
    looking: 'Ona başvuran belgeler aranıyor…',
    noDocument: 'Neyin başvurduğunu görmek için bir belge açın.',
    none: 'Bu belgeye hiçbir şey başvurmuyor',
    noneHint: (n: number) =>
      n
        ? `Bu koleksiyona başvuran ${n} alanın hiçbiri onun kimliğini taşımıyor.`
        : 'Veritabanının modeli bu koleksiyona başvuran bir alan bulmuyor (adından, değerlerinden ya da bir $lookup ile).',
    found: (n: number) => `${n} alan ona başvuruyor`,
    documents: (n: number, more: boolean) => `${more ? `${n}+` : n} belge`,
    show: (coll: string) => `${coll} içinde göster`,
    showHint: (coll: string) =>
      `Bu belgeleri seçen bir filtreyi ${coll} koleksiyonunun Belgeler sorgusuna koyar`,
    failed: 'Aranamadı',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} okunamadı`,
    limited: (n: number) =>
      `${n} alan sorulmadı: uygulama dakikada belli sayıda okuma yapar. Bir dakika sonra yeniden açın.`,
    noneAsked: 'Sorulabilen alanlarda hiçbir şey bulunmadı',
    noneCouldAsk: 'Bu koleksiyona başvuran alanların hiçbiri sorulamadı',
    showFailed: 'Belgeler açılamadı: ',
    unnamed: 'adsız',
  },
  zh: {
    title: '引用方',
    description: (coll: string) => `此数据库中引用了 ${coll} 里这个文档的文档。`,
    looking: '正在查找引用它的文档…',
    noDocument: '打开一个文档，查看哪些内容引用了它。',
    none: '没有任何内容引用此文档',
    noneHint: (n: number) =>
      n
        ? `引用此集合的 ${n} 个字段中，没有一个保存了它的 ID。`
        : '数据库的模型未找到引用此集合的字段（按名称、值或 $lookup）。',
    found: (n: number) => `${n} 个字段引用了它`,
    documents: (n: number, more: boolean) => `${more ? `${n}+` : n} 个文档`,
    show: (coll: string) => `在 ${coll} 中显示`,
    showHint: (coll: string) => `在 ${coll} 的文档查询中放入选中这些文档的筛选`,
    failed: '无法查找',
    fieldFailed: (coll: string, path: string) => `无法读取 ${coll}.${path}`,
    limited: (n: number) => `有 ${n} 个字段未查询：应用每分钟只能读取一定次数。请一分钟后再次打开。`,
    noneAsked: '在可查询的字段中未找到任何内容',
    noneCouldAsk: '引用此集合的字段都无法查询',
    showFailed: '无法打开文档：',
    unnamed: '未命名',
  },
  ja: {
    title: '参照元',
    description: (coll: string) =>
      `このデータベース内で、${coll} のこのドキュメントを参照しているドキュメント。`,
    looking: 'このドキュメントを参照しているドキュメントを検索中…',
    noDocument: 'ドキュメントを開くと、参照元を確認できます。',
    none: 'このドキュメントを参照しているものはありません',
    noneHint: (n: number) =>
      n
        ? `このコレクションを参照している ${n} 個のフィールドのいずれも、その ID を保持していません。`
        : 'データベースのモデルでは、このコレクションを参照するフィールドが見つかりません（名前、値、または $lookup による）。',
    found: (n: number) => `${n} 個のフィールドが参照しています`,
    documents: (n: number, more: boolean) => `${more ? `${n}+` : n} 件のドキュメント`,
    show: (coll: string) => `${coll} で表示`,
    showHint: (coll: string) =>
      `これらのドキュメントを選択するフィルターを、${coll} のドキュメントのクエリに入れます`,
    failed: '検索できませんでした',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} を読み取れませんでした`,
    limited: (n: number) =>
      `${n} 個のフィールドは問い合わせていません。アプリが 1 分間に読み取れる数には上限があります。1 分後にもう一度開いてください。`,
    noneAsked: '問い合わせできたフィールドには何も見つかりませんでした',
    noneCouldAsk: 'このコレクションを参照するフィールドは、いずれも問い合わせできませんでした',
    showFailed: 'ドキュメントを開けませんでした: ',
    unnamed: '名前なし',
  },
  es: {
    title: 'Referenciado por',
    description: (coll: string) =>
      `Los documentos de esta base de datos que hacen referencia a este documento de ${coll}.`,
    looking: 'Buscando los documentos que hacen referencia a él…',
    noDocument: 'Abre un documento para ver qué hace referencia a él.',
    none: 'Nada hace referencia a este documento',
    noneHint: (n: number) =>
      n
        ? isOne(n, 'es')
          ? 'El campo que hace referencia a esta colección no contiene su id.'
          : `Ninguno de los ${n} campos que hacen referencia a esta colección contiene su id.`
        : 'El modelo de la base de datos no encuentra ningún campo que haga referencia a esta colección (por su nombre, sus valores o un $lookup).',
    found: (n: number) => `${n} ${isOne(n, 'es') ? 'campo hace' : 'campos hacen'} referencia a él`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${isOne(n, 'es') && !more ? 'documento' : 'documentos'}`,
    show: (coll: string) => `Mostrar en ${coll}`,
    showHint: (coll: string) =>
      `Pone un filtro que selecciona estos documentos en la consulta de Documentos de ${coll}`,
    failed: 'No se pudo buscar',
    fieldFailed: (coll: string, path: string) => `No se pudo leer ${coll}.${path}`,
    limited: (n: number) =>
      `${isOne(n, 'es') ? `No se consultó ${n} campo` : `No se consultaron ${n} campos`}: la aplicación solo lee un número limitado por minuto. Ábrelo de nuevo en un minuto.`,
    noneAsked: 'No se encontró nada en los campos que se pudieron consultar',
    noneCouldAsk: 'No se pudo consultar ninguno de los campos que hacen referencia a esta colección',
    showFailed: 'No se pudo abrir Documentos: ',
    unnamed: 'sin nombre',
  },
  pt: {
    title: 'Referenciado por',
    description: (coll: string) =>
      `Os documentos deste banco de dados que fazem referência a este documento de ${coll}.`,
    looking: 'Procurando os documentos que fazem referência a ele…',
    noDocument: 'Abra um documento para ver o que faz referência a ele.',
    none: 'Nada faz referência a este documento',
    noneHint: (n: number) =>
      n
        ? isOne(n, 'pt')
          ? 'O campo que faz referência a esta coleção não contém o id dele.'
          : `Nenhum dos ${n} campos que fazem referência a esta coleção contém o id dele.`
        : 'O modelo do banco de dados não encontra nenhum campo que faça referência a esta coleção (pelo nome, pelos valores ou por um $lookup).',
    found: (n: number) => `${n} ${isOne(n, 'pt') ? 'campo faz' : 'campos fazem'} referência a ele`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${isOne(n, 'pt') && !more ? 'documento' : 'documentos'}`,
    show: (coll: string) => `Mostrar em ${coll}`,
    showHint: (coll: string) =>
      `Coloca um filtro que seleciona esses documentos na consulta de Documentos de ${coll}`,
    failed: 'Não foi possível procurar',
    fieldFailed: (coll: string, path: string) => `Não foi possível ler ${coll}.${path}`,
    limited: (n: number) =>
      `${isOne(n, 'pt') ? `${n} campo não foi consultado` : `${n} campos não foram consultados`}: o aplicativo lê apenas um número limitado por minuto. Abra de novo em um minuto.`,
    noneAsked: 'Nada encontrado nos campos que puderam ser consultados',
    noneCouldAsk: 'Nenhum dos campos que fazem referência a esta coleção pôde ser consultado',
    showFailed: 'Não foi possível abrir Documentos: ',
    unnamed: 'sem nome',
  },
  ko: {
    title: '참조하는 도큐먼트',
    description: (coll: string) => `이 데이터베이스에서 ${coll}의 이 도큐먼트를 참조하는 도큐먼트입니다.`,
    looking: '이 도큐먼트를 참조하는 도큐먼트를 찾는 중…',
    noDocument: '도큐먼트를 열면 이를 참조하는 항목을 볼 수 있습니다.',
    none: '이 도큐먼트를 참조하는 항목이 없습니다',
    noneHint: (n: number) =>
      n
        ? `이 컬렉션을 참조하는 필드 ${n}개 중 어느 것에도 이 도큐먼트의 id가 없습니다.`
        : '데이터베이스 모델에서 이 컬렉션을 참조하는 필드를 찾지 못했습니다(이름, 값 또는 $lookup 기준).',
    found: (n: number) => `이 도큐먼트를 참조하는 필드 ${n}개`,
    documents: (n: number, more: boolean) => `도큐먼트 ${more ? `${n}+` : n}개`,
    show: (coll: string) => `${coll}에서 보기`,
    showHint: (coll: string) => `${coll}의 도큐먼트 쿼리에 이 도큐먼트들을 선택하는 필터를 넣습니다`,
    failed: '검색할 수 없습니다',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} 읽기에 실패했습니다`,
    limited: (n: number) =>
      `필드 ${n}개를 조회하지 못했습니다. 앱은 분당 읽기 횟수가 제한되어 있습니다. 1분 뒤에 다시 여세요.`,
    noneAsked: '조회할 수 있었던 필드에서는 아무것도 찾지 못했습니다',
    noneCouldAsk: '이 컬렉션을 참조하는 필드를 하나도 조회할 수 없었습니다',
    showFailed: '도큐먼트를 열 수 없습니다: ',
    unnamed: '이름 없음',
  },
  de: {
    title: 'Referenziert von',
    description: (coll: string) =>
      `Die Dokumente dieser Datenbank, die auf dieses Dokument aus ${coll} verweisen.`,
    looking: 'Dokumente, die darauf verweisen, werden gesucht…',
    noDocument: 'Öffnen Sie ein Dokument, um zu sehen, was darauf verweist.',
    none: 'Nichts verweist auf dieses Dokument',
    noneHint: (n: number) =>
      n
        ? isOne(n, 'de')
          ? 'Das eine Feld, das auf diese Collection verweist, enthält die ID dieses Dokuments nicht.'
          : `Keines der ${n} Felder, die auf diese Collection verweisen, enthält die ID dieses Dokuments.`
        : 'Das Modell der Datenbank findet kein Feld, das auf diese Collection verweist (über Name, Werte oder ein $lookup).',
    found: (n: number) => `${n} ${isOne(n, 'de') ? 'Feld verweist' : 'Felder verweisen'} darauf`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${isOne(n, 'de') && !more ? 'Dokument' : 'Dokumente'}`,
    show: (coll: string) => `In ${coll} anzeigen`,
    showHint: (coll: string) =>
      `Setzt einen Filter, der diese Dokumente auswählt, in die Dokumente-Abfrage von ${coll}`,
    failed: 'Die Suche war nicht möglich',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} konnte nicht gelesen werden`,
    limited: (n: number) =>
      `${isOne(n, 'de') ? `${n} Feld wurde` : `${n} Felder wurden`} nicht abgefragt: Die App liest pro Minute nur eine begrenzte Anzahl. Öffnen Sie die Ansicht in einer Minute erneut.`,
    noneAsked: 'In den abfragbaren Feldern wurde nichts gefunden',
    noneCouldAsk: 'Keines der Felder, die auf diese Collection verweisen, konnte abgefragt werden',
    showFailed: 'Dokumente konnten nicht geöffnet werden: ',
    unnamed: 'ohne Namen',
  },
  fr: {
    title: 'Référencé par',
    description: (coll: string) =>
      `Les documents de cette base de données qui font référence à ce document de ${coll}.`,
    looking: 'Recherche des documents qui y font référence…',
    noDocument: 'Ouvrez un document pour voir ce qui y fait référence.',
    none: 'Rien ne fait référence à ce document',
    noneHint: (n: number) =>
      n
        ? isOne(n, 'fr')
          ? 'Le champ qui fait référence à cette collection ne contient pas l’identifiant de ce document.'
          : `Aucun des ${n} champs qui font référence à cette collection ne contient l’identifiant de ce document.`
        : 'Le modèle de la base de données ne trouve aucun champ qui fasse référence à cette collection (par son nom, ses valeurs ou un $lookup).',
    found: (n: number) => `${n} ${isOne(n, 'fr') ? 'champ y fait' : 'champs y font'} référence`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${isOne(n, 'fr') && !more ? 'document' : 'documents'}`,
    show: (coll: string) => `Afficher dans ${coll}`,
    showHint: (coll: string) =>
      `Place dans la requête Documents de ${coll} un filtre qui sélectionne ces documents`,
    failed: 'La recherche n’a pas pu être effectuée',
    fieldFailed: (coll: string, path: string) => `${coll}.${path} n’a pas pu être lu`,
    limited: (n: number) =>
      `${isOne(n, 'fr') ? `${n} champ n’a pas été interrogé` : `${n} champs n’ont pas été interrogés`} : l’application ne lit qu’un nombre limité d’éléments par minute. Rouvrez la vue dans une minute.`,
    noneAsked: 'Rien trouvé dans les champs qui ont pu être interrogés',
    noneCouldAsk: 'Aucun des champs qui font référence à cette collection n’a pu être interrogé',
    showFailed: 'Impossible d’ouvrir Documents : ',
    unnamed: 'sans nom',
  },
  ru: {
    title: 'Кто ссылается',
    description: (coll: string) =>
      `Документы этой базы данных, которые ссылаются на этот документ коллекции ${coll}.`,
    looking: 'Поиск документов, которые на него ссылаются…',
    noDocument: 'Откройте документ, чтобы увидеть, что на него ссылается.',
    none: 'Ничто не ссылается на этот документ',
    noneHint: (n: number) =>
      n
        ? `Ни одно из полей, ссылающихся на эту коллекцию (${n}), не содержит идентификатор этого документа.`
        : 'Модель базы данных не находит полей, которые ссылаются на эту коллекцию (по имени, значениям или через $lookup).',
    found: (n: number) => `${n} ${ru(n, 'поле ссылается', 'поля ссылаются', 'полей ссылаются')} на него`,
    documents: (n: number, more: boolean) =>
      `${more ? `${n}+` : n} ${more ? 'документов' : ru(n, 'документ', 'документа', 'документов')}`,
    show: (coll: string) => `Показать в ${coll}`,
    showHint: (coll: string) =>
      `Помещает в запрос раздела «Документы» коллекции ${coll} фильтр, выбирающий эти документы`,
    failed: 'Не удалось выполнить поиск',
    fieldFailed: (coll: string, path: string) => `Не удалось прочитать ${coll}.${path}`,
    limited: (n: number) =>
      `Не опрошено полей: ${n}. Приложение читает ограниченное число раз в минуту. Откройте снова через минуту.`,
    noneAsked: 'В полях, которые удалось опросить, ничего не найдено',
    noneCouldAsk: 'Ни одно из полей, ссылающихся на эту коллекцию, не удалось опросить',
    showFailed: 'Не удалось открыть «Документы»: ',
    unnamed: 'без имени',
  },
} satisfies Record<Language, Text>

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; found: Referred }

/** A document's id, as the shell writes it, on one line. */
const idText = (id: unknown) => shellText(id).replace(/\s*\n\s*/g, ' ')

export function mountReferenced(root: HTMLElement, client: PluginClient): void {
  let text: Text = pick<Text>(TEXT, 'en')
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let showError: unknown = null

  const header = pageHeader({ icon: 'link', title: text.title, description: '' })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'rf-notes' })
  const results = h('div', { id: 'referrers', class: 'rf-referrers' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status), notes, results),
    ),
  )

  const id = () => ctx?.place?.documentId

  function show(group: ReferringGroup): void {
    void client.ask('ui.useQueryIn', { coll: group.from, filter: referringFilter(group.path, id()) }).then(
      () => {
        if (showError === null) return
        showError = null
        render()
      },
      (e: unknown) => {
        showError = e
        render()
      },
    )
  }

  function card(group: ReferringGroup): HTMLElement {
    const names = group.documents.map((d: Doc) => nameOf(d) ?? `${text.unnamed} ${idText(d._id)}`)
    const showButton = button({
      label: text.show(group.from),
      icon: 'filter',
      size: 'sm',
      title: text.showHint(group.from),
      onClick: () => show(group),
    })
    showButton.setAttribute('data-show', '')
    return h(
      'article',
      { class: 'mm-card rf-card', data: { from: group.from, path: group.path } },
      h(
        'div',
        { class: 'rf-card-head' },
        h('code', { class: 'mm-mono rf-field', text: `${group.from}.${group.path}` }),
        badge(text.documents(group.documents.length, group.more), 'accent'),
      ),
      h('ul', { class: 'rf-names' }, ...names.map((n) => h('li', { text: n }))),
      h('div', { class: 'rf-actions' }, showButton),
    )
  }

  function render(): void {
    notes.replaceChildren()
    status.textContent = ''
    if (!ctx) return
    header.setText(text.title, text.description(ctx.place?.coll ?? ''))
    if (!ctx.place || id() === undefined || id() === null)
      return void results.replaceChildren(emptyState({ icon: 'link', title: text.noDocument }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = text.looking
      return void results.replaceChildren(skeleton(3))
    }
    if (state.kind === 'failed')
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: askMessage(state.error, locale),
        }),
      )
    const { found } = state
    for (const f of found.failed)
      notes.append(callout('warning', text.fieldFailed(f.from, f.path), askMessage(f.error, locale)))
    if (found.limited.length) notes.append(callout('warning', text.limited(found.limited.length)))
    if (showError !== null)
      notes.append(callout('danger', `${text.showFailed}${askMessage(showError, locale)}`))
    if (!found.groups.length)
      return void results.replaceChildren(
        found.failed.length || found.limited.length
          ? emptyState({
              icon: 'link',
              title:
                found.failed.length + found.limited.length >= found.asked
                  ? text.noneCouldAsk
                  : text.noneAsked,
            })
          : emptyState({ icon: 'link', title: text.none, hint: text.noneHint(found.asked) }),
      )
    status.textContent = text.found(found.groups.length)
    results.replaceChildren(...found.groups.map(card))
  }

  async function look(): Promise<void> {
    if (!ctx?.place || id() === undefined || id() === null) return
    state = { kind: 'running' }
    render()
    try {
      state = { kind: 'done', found: await findReferring((m, p) => client.ask(m, p), ctx.place.coll, id()) }
    } catch (e) {
      state = { kind: 'failed', error: e }
    }
    render()
  }

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    render()
    void look()
  })
}
