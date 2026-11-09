// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 1: the frame side of the bridge, shared by first-party plugins. Messages go to the app
 * that framed the page and only its messages are read; requests wait for the app's greeting (its
 * token) and carry it; failures keep the app's code.
 */

import { languageOf, type Language } from './i18n'
import { accentOf, type Accent } from './look'

export { accentOf, type Accent }

export interface PluginContext {
  plugin: { id: string; version: string }
  contribution: { kind: string; id: string }
  locale: string
  theme: 'light' | 'dark'
  /** The user's accent (plugin tabs redesign); read it through `accentOf`. */
  accent?: string
  place: {
    connectionId: string
    connectionName: string | null
    db: string
    coll: string
    documentId: unknown
    filter?: Record<string, unknown>
    /** A view: read as a collection, never written or exported (user request 2026-10-10). */
    view?: boolean
    /**
     * Plugins wave 3: the field paths personal-data rules hide from the user here, as key lists
     * (`['contact', 'phone']`; `'*'` one key, `'**'` any number of keys) — names only; a hidden
     * field's type is never told. `null` when they could not be told in time: a hidden field's
     * values still arrive as `"***"`, never its own.
     */
    hidden?: string[][] | null
  } | null
  settings: Record<string, string | boolean>
}

/**
 * User report 2026-11-07 (API logs of ~60 KB a document): one answer is at most 1 MB, and a bigger
 * one is `too_large`. `documents.find`, `documents.findIn` and `documents.aggregate` take
 * `fit: true`: the app then answers as many whole documents, in order, as one answer holds, and
 * `cut: true` says it left the rest out. A sample takes what came; a pager goes on after the last
 * document it got (a cut page is never the end). Not even the first document fitting is still
 * `too_large`. `fit` never reads more than was asked for.
 */
export interface FitParams {
  fit?: boolean
}
/** What `documents.find` and `documents.findIn` answer (`hasMore` from findIn only with `fit`). */
export interface FoundDocuments<T = Record<string, unknown>> {
  documents: T[]
  /** More documents match than were answered: true when the answer was cut. */
  hasMore?: boolean
  /** Asked with `fit: true` only: the answer holds fewer documents than were read, to fit. */
  cut?: boolean
}
/** What `documents.aggregate` answers. */
export interface PipelineDocuments<T = Record<string, unknown>> {
  documents: T[]
  /** More results than were answered (the limit, or the answer cut to fit). */
  truncated: boolean
  /** Asked with `fit: true` only: the answer holds fewer documents than came, to fit. */
  cut?: boolean
}

export class AskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The codes of the app's refusals a page can be told (review of the languages, minor 12). */
export const ASK_CODES = [
  'no_activation',
  'too_many',
  'busy',
  'blocked',
  'declined',
  'unanswered',
  'not_visible',
  'not_permitted',
  'no_collection',
  'timeout',
  'read_only',
  'not_found',
  'unavailable',
  'too_large',
] as const
export type AskCode = (typeof ASK_CODES)[number]

/** Why the app did not take a request, in the app's languages (wave 1 review Minor 10). */
const ASK_TEXT: Record<Language, Record<AskCode, string>> = {
  en: {
    no_activation: 'Click the button again: the app takes this only right after a click.',
    too_many: 'Too many requests in a minute: try again shortly.',
    busy: 'An earlier request is still waiting.',
    blocked: 'The app stopped taking these after you said no twice: reopen the plugin to try again.',
    declined: 'Nothing was done: you said no.',
    unanswered: 'No answer came in time: nothing was done.',
    not_visible: 'This cannot be done from here.',
    not_permitted: 'The plugin is not allowed to do this.',
    no_collection: 'Open a collection first.',
    timeout: 'The app did not answer in time.',
    read_only: 'This is a view, which is read-only: nothing was changed.',
    not_found: 'It was not found: it may have been deleted or moved.',
    unavailable: 'This is not available here.',
    too_large: 'This is too large to send: ask for less at a time.',
  },
  tr: {
    no_activation: 'Düğmeye yeniden tıkla: uygulama bunu yalnızca bir tıklamanın hemen ardından kabul eder.',
    too_many: 'Bir dakikada çok fazla istek: biraz sonra yeniden dene.',
    busy: 'Önceki bir istek hâlâ bekliyor.',
    blocked: 'İki kez hayır dediğin için uygulama bunları artık almıyor: denemek için eklentiyi yeniden aç.',
    declined: 'Hiçbir şey yapılmadı: hayır dedin.',
    unanswered: 'Zamanında yanıt gelmedi: hiçbir şey yapılmadı.',
    not_visible: 'Bu, buradan yapılamaz.',
    not_permitted: 'Eklentinin bunu yapmasına izin verilmiyor.',
    no_collection: 'Önce bir koleksiyon aç.',
    timeout: 'Uygulama zamanında yanıt vermedi.',
    read_only: 'Bu bir görünüm, salt okunur: hiçbir şey değişmedi.',
    not_found: 'Bulunamadı: silinmiş ya da taşınmış olabilir.',
    unavailable: 'Bu, burada kullanılamıyor.',
    too_large: 'Bu, göndermek için fazla büyük: tek seferde daha azını iste.',
  },
  zh: {
    no_activation: '请再次点击按钮：应用只在点击之后立即接受此操作。',
    too_many: '一分钟内的请求过多：请稍后再试。',
    busy: '之前的请求仍在等待。',
    blocked: '您已拒绝两次，应用不再接受此类请求：请重新打开插件后再试。',
    declined: '未执行任何操作：您选择了拒绝。',
    unanswered: '未及时收到答复：未执行任何操作。',
    not_visible: '无法在此处执行此操作。',
    not_permitted: '插件无权执行此操作。',
    no_collection: '请先打开一个集合。',
    timeout: '应用未及时响应。',
    read_only: '这是一个视图，只读：未做任何更改。',
    not_found: '未找到：它可能已被删除或移动。',
    unavailable: '此处不可用。',
    too_large: '内容太大，无法发送：请每次请求更少的内容。',
  },
  ja: {
    no_activation:
      'もう一度ボタンをクリックしてください。アプリはクリックの直後にのみこの操作を受け付けます。',
    too_many: '1 分間のリクエストが多すぎます。しばらくしてからもう一度お試しください。',
    busy: '前のリクエストがまだ待機中です。',
    blocked:
      '2 回拒否されたため、アプリはこの種類のリクエストを受け付けなくなりました。もう一度試すにはプラグインを開き直してください。',
    declined: '何も実行されませんでした。拒否が選択されました。',
    unanswered: '時間内に応答がありませんでした。何も実行されていません。',
    not_visible: 'ここからは実行できません。',
    not_permitted: 'このプラグインにはこの操作が許可されていません。',
    no_collection: '先にコレクションを開いてください。',
    timeout: 'アプリが時間内に応答しませんでした。',
    read_only: 'これはビューのため読み取り専用です。何も変更されていません。',
    not_found: '見つかりませんでした。削除または移動された可能性があります。',
    unavailable: 'ここでは利用できません。',
    too_large: '大きすぎて送信できません。一度に求める量を減らしてください。',
  },
  es: {
    no_activation:
      'Vuelve a hacer clic en el botón: la aplicación solo acepta esto justo después de un clic.',
    too_many: 'Demasiadas solicitudes en un minuto: vuelve a intentarlo en breve.',
    busy: 'Una solicitud anterior sigue esperando.',
    blocked:
      'La aplicación dejó de aceptar estas solicitudes después de que dijeras que no dos veces: vuelve a abrir el plugin para intentarlo de nuevo.',
    declined: 'No se hizo nada: dijiste que no.',
    unanswered: 'No llegó ninguna respuesta a tiempo: no se hizo nada.',
    not_visible: 'Esto no se puede hacer desde aquí.',
    not_permitted: 'El plugin no tiene permiso para hacer esto.',
    no_collection: 'Abre primero una colección.',
    timeout: 'La aplicación no respondió a tiempo.',
    read_only: 'Es una vista, de solo lectura: no se cambió nada.',
    not_found: 'No se encontró: puede que se haya eliminado o movido.',
    unavailable: 'Esto no está disponible aquí.',
    too_large: 'Es demasiado grande para enviarlo: pide menos cada vez.',
  },
  pt: {
    no_activation: 'Clique no botão novamente: o aplicativo só aceita isso logo após um clique.',
    too_many: 'Solicitações demais em um minuto: tente novamente em instantes.',
    busy: 'Uma solicitação anterior ainda está aguardando.',
    blocked:
      'O aplicativo parou de aceitar essas solicitações depois que você disse não duas vezes: abra o plugin novamente para tentar de novo.',
    declined: 'Nada foi feito: você disse não.',
    unanswered: 'Nenhuma resposta chegou a tempo: nada foi feito.',
    not_visible: 'Isso não pode ser feito daqui.',
    not_permitted: 'O plugin não tem permissão para fazer isso.',
    no_collection: 'Abra uma coleção primeiro.',
    timeout: 'O aplicativo não respondeu a tempo.',
    read_only: 'Isto é uma view, somente leitura: nada foi alterado.',
    not_found: 'Não foi encontrado: pode ter sido excluído ou movido.',
    unavailable: 'Isso não está disponível aqui.',
    too_large: 'É grande demais para enviar: peça menos de cada vez.',
  },
  ko: {
    no_activation: '버튼을 다시 클릭하세요. 앱은 클릭 직후에만 이 작업을 받습니다.',
    too_many: '1분 동안 요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    busy: '이전 요청이 아직 대기 중입니다.',
    blocked: '두 번 거절하여 앱이 이 요청을 더 이상 받지 않습니다. 다시 시도하려면 플러그인을 다시 여세요.',
    declined: '아무 작업도 하지 않았습니다. 거절을 선택했습니다.',
    unanswered: '제시간에 응답이 없어 아무 작업도 하지 않았습니다.',
    not_visible: '여기에서는 할 수 없습니다.',
    not_permitted: '플러그인에 이 작업 권한이 없습니다.',
    no_collection: '먼저 컬렉션을 여세요.',
    timeout: '앱이 제시간에 응답하지 않았습니다.',
    read_only: '뷰는 읽기 전용이라 아무것도 변경되지 않았습니다.',
    not_found: '찾을 수 없습니다. 삭제되었거나 이동되었을 수 있습니다.',
    unavailable: '여기에서는 사용할 수 없습니다.',
    too_large: '너무 커서 보낼 수 없습니다. 한 번에 더 적게 요청하세요.',
  },
  de: {
    no_activation:
      'Klicken Sie erneut auf die Schaltfläche: Die App nimmt dies nur direkt nach einem Klick an.',
    too_many: 'Zu viele Anfragen in einer Minute: Versuchen Sie es gleich noch einmal.',
    busy: 'Eine frühere Anfrage wartet noch.',
    blocked:
      'Die App nimmt diese Anfragen nicht mehr an, nachdem Sie zweimal abgelehnt haben: Öffnen Sie das Plugin erneut, um es noch einmal zu versuchen.',
    declined: 'Es wurde nichts getan: Sie haben abgelehnt.',
    unanswered: 'Es kam keine rechtzeitige Antwort: Es wurde nichts getan.',
    not_visible: 'Das ist von hier aus nicht möglich.',
    not_permitted: 'Das Plugin darf dies nicht tun.',
    no_collection: 'Öffnen Sie zuerst eine Collection.',
    timeout: 'Die App hat nicht rechtzeitig geantwortet.',
    read_only: 'Das ist eine View und nur lesbar: Es wurde nichts geändert.',
    not_found: 'Nicht gefunden: Es wurde vielleicht gelöscht oder verschoben.',
    unavailable: 'Das ist hier nicht verfügbar.',
    too_large: 'Das ist zu groß zum Senden: Fragen Sie jeweils nach weniger.',
  },
  fr: {
    no_activation: 'Cliquez de nouveau sur le bouton : l’application n’accepte cela que juste après un clic.',
    too_many: 'Trop de demandes en une minute : réessayez dans un instant.',
    busy: 'Une demande précédente est toujours en attente.',
    blocked: 'L’application n’accepte plus ces demandes après deux refus : rouvrez le plugin pour réessayer.',
    declined: 'Rien n’a été fait : vous avez refusé.',
    unanswered: 'Aucune réponse n’est arrivée à temps : rien n’a été fait.',
    not_visible: 'Cela ne peut pas être fait d’ici.',
    not_permitted: 'Le plugin n’est pas autorisé à faire cela.',
    no_collection: 'Ouvrez d’abord une collection.',
    timeout: 'L’application n’a pas répondu à temps.',
    read_only: 'C’est une vue, en lecture seule : rien n’a été modifié.',
    not_found: 'Introuvable : cela a peut-être été supprimé ou déplacé.',
    unavailable: 'Ce n’est pas disponible ici.',
    too_large: 'C’est trop volumineux pour être envoyé : demandez-en moins à la fois.',
  },
  ru: {
    no_activation: 'Нажмите кнопку еще раз: приложение принимает это только сразу после нажатия.',
    too_many: 'Слишком много запросов за минуту: повторите попытку чуть позже.',
    busy: 'Предыдущий запрос все еще ожидает ответа.',
    blocked:
      'После двух ваших отказов приложение больше не принимает такие запросы: откройте плагин заново, чтобы попробовать снова.',
    declined: 'Ничего не сделано: вы отказались.',
    unanswered: 'Ответ не пришел вовремя: ничего не сделано.',
    not_visible: 'Отсюда это сделать нельзя.',
    not_permitted: 'Плагину не разрешено это делать.',
    no_collection: 'Сначала откройте коллекцию.',
    timeout: 'Приложение не ответило вовремя.',
    read_only: 'Это представление, оно только для чтения: ничего не изменено.',
    not_found: 'Не найдено: возможно, это удалено или перемещено.',
    unavailable: 'Здесь это недоступно.',
    too_large: 'Слишком большой объем для отправки: запрашивайте меньше за раз.',
  },
}

/** A failure as the person reads it: the app's code in their language, else its own message. */
export function askMessage(error: unknown, locale: string): string {
  if (error instanceof AskError) {
    const words = ASK_TEXT[languageOf(locale)]
    if (Object.hasOwn(words, error.code)) return words[error.code as AskCode]
  }
  return error instanceof Error ? error.message : String(error)
}

/** Where the values are (wave 2): the collection the app asked about, for a renderer that reads. */
export interface CellPlace {
  connectionId: string
  db: string
  coll: string
}

export type CellsAnswer = (
  renderer: string,
  values: unknown[],
  locale: string,
  paths: Array<string | null>,
  place: CellPlace | null,
) => unknown[] | Promise<unknown[]>

export interface PluginClient {
  /** Asks the app; answered by id, or given up after a while. */
  ask<T>(method: string, params?: unknown): Promise<T>
  /** Called once, when the app greeted the page (requests may go from then on). */
  onReady(fn: () => void): void
  /**
   * The app's language, theme or accent changed (an accent it does not know is Emerald) — or, for a
   * plugin with documents:read, the Documents filter: ask `context.get` again for it.
   */
  onContext(fn: (locale: string, theme: 'light' | 'dark', accent: Accent) => void): void
  /**
   * Answers the app's cell questions (a cell renderer), in the language the app asks in; each
   * value's column path beside it (wave 2), null where the app did not say.
   */
  onCells(fn: CellsAnswer): void
  /** The contribution this page shows (`#<kind>=<id>`). */
  readonly contribution: { kind: string; id: string }
}

/** A place as the app sends it, or null. */
function placeOf(v: unknown): CellPlace | null {
  if (!v || typeof v !== 'object') return null
  const { connectionId, db, coll } = v as Record<string, unknown>
  return typeof connectionId === 'string' && typeof db === 'string' && typeof coll === 'string'
    ? { connectionId, db, coll }
    : null
}

/**
 * Wave 3 second review: the requests the app may ask the user about first (a change, stages put in
 * place, a copy, a file, documents for the wizard) wait as long as the question can stay — the app
 * ends its question sooner (APP_QUESTION_MS there), so the page never gives up while the user may
 * still say yes.
 */
export const QUESTION_METHODS: ReadonlySet<string> = new Set([
  'documents.update',
  'ui.useAggregation',
  'ui.copy',
  'ui.download',
  'ui.importDocuments',
])
export const QUESTION_TIMEOUT_MS = 180_000
/**
 * Plugins wave 4 (final review I5): what may run long once the user said yes — compact answers when
 * it ends, which on a large collection may be hours; the app runs one per collection at a time.
 */
export const LONG_METHODS: ReadonlyMap<string, number> = new Map([['ui.compact', 12 * 3_600_000]])

export function createClient(timeoutMs = 15_000): PluginClient {
  const host = window.parent
  let token: string | null = null
  let counter = 0
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const ready: Array<() => void> = []
  const contexts: Array<(locale: string, theme: 'light' | 'dark', accent: Accent) => void> = []
  let cells: CellsAnswer | null = null
  const [kind = '', id = ''] = location.hash.slice(1).split('=')

  window.addEventListener('message', (event) => {
    if (event.source !== host) return
    const m = event.data as {
      mm?: number
      type?: string
      token?: string
      id?: unknown
      method?: string
      params?: { renderer?: unknown; values?: unknown; locale?: unknown; paths?: unknown; place?: unknown }
      result?: unknown
      error?: { code: string; message: string }
      locale?: string
      theme?: 'light' | 'dark'
      accent?: unknown
    }
    if (!m || m.mm !== 1) return
    if (m.type === 'hello' && typeof m.token === 'string' && token === null) {
      token = m.token
      for (const fn of ready.splice(0)) fn()
      return
    }
    if (m.type === 'context.changed') {
      if (typeof m.locale === 'string' && (m.theme === 'light' || m.theme === 'dark'))
        for (const fn of contexts) fn(m.locale, m.theme, accentOf(m.accent))
      return
    }
    if (m.method === 'cells.render' && typeof m.id === 'string') {
      const values = Array.isArray(m.params?.values) ? m.params.values.slice(0, 200) : []
      const renderer = typeof m.params?.renderer === 'string' ? m.params.renderer : ''
      const locale = typeof m.params?.locale === 'string' ? m.params.locale : ''
      const given = Array.isArray(m.params?.paths) ? (m.params.paths as unknown[]) : []
      const paths = values.map((_, i) => (typeof given[i] === 'string' ? (given[i] as string) : null))
      const place = placeOf(m.params?.place)
      const id = m.id
      // A renderer may read before it answers (wave 2); one that fails answers nothing, and the app
      // shows the plain values.
      void (async () => {
        let result: unknown[]
        try {
          result = cells ? await cells(renderer, values, locale, paths, place) : []
          if (!Array.isArray(result)) result = []
        } catch {
          result = []
        }
        host.postMessage({ mm: 1, id, token, result }, '*')
      })()
      return
    }
    const pending = typeof m.id === 'number' ? waiting.get(m.id) : undefined
    if (!pending) return
    waiting.delete(m.id as number)
    if (m.error) pending.reject(new AskError(m.error.code, m.error.message))
    else pending.resolve(m.result)
  })

  return {
    contribution: { kind, id: decodeURIComponent(id) },
    ask<T>(method: string, params?: unknown) {
      const n = ++counter
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            waiting.delete(n)
            reject(new AskError('timeout', 'No answer'))
          },
          LONG_METHODS.get(method) ??
            (QUESTION_METHODS.has(method) ? Math.max(timeoutMs, QUESTION_TIMEOUT_MS) : timeoutMs),
        )
        waiting.set(n, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v as T)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        // Sent once the app greeted the page: before, it would carry no token (review M9).
        const send = () => host.postMessage({ mm: 1, id: n, method, params, token }, '*')
        if (token !== null) send()
        else ready.push(send)
      })
    },
    onReady(fn) {
      if (token !== null) fn()
      else ready.push(fn)
    },
    onContext(fn) {
      contexts.push(fn)
    },
    onCells(fn) {
      cells = fn
    },
  }
}
