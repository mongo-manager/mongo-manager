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
  chip,
  emptyState,
  langTag,
  pick,
  shown,
  formatNumber,
  type Language,
  h,
  icon,
  pageHeader,
  setBusy,
  setLabel,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { findReferences, SAMPLE, type Found, type Relation } from './find'
import { lookupStages, orphanFilter } from './infer'
import { isOne, ru, type Count } from './plural'

/** The words of the page, one block per language (the compiler checks all ten are there). */
interface Text {
  title: string
  description: (coll: string) => string
  find: string
  sampling: string
  looking: (n: Count, of: Count) => string
  relations: (n: Count) => string
  summary: (fields: Count, sampled: Count, looked: Count, of: Count) => string
  idleTitle: string
  idleHint: string
  noneTitle: string
  noFieldsHint: (n: Count) => string
  unmatchedHint: (paths: string, looked: Count) => string
  unmatchedTitle: string
  found: (matched: string, sampled: Count) => string
  missing: (n: Count) => string
  names: string
  share: string
  percent: (n: number) => string
  lookup: string
  lookupHint: string
  orphans: string
  orphansHint: (n: Count, coll: string) => string
  stopped: string
  failed: string
  handFailed: string
  noPlace: string
}

/**
 * References (plugins wave 2; redesigned 2026-10-10, spec plugin-tabs-redesign §2.6): the fields of
 * a collection holding other documents' ObjectIds and the collections those documents live in, one
 * card per relation. It looks on open (every read bounded and read-only); a relation goes to
 * Aggregations as a $lookup, and its sampled ids not found to Documents — nothing runs there until
 * the user asks.
 */
export const TEXT = {
  en: {
    title: 'References',
    description: (coll: string) =>
      `Which fields of ${coll} hold other documents’ ObjectIds, and where those documents live.`,
    find: 'Find references',
    sampling: 'Reading a sample…',
    looking: (n: Count, of: Count) =>
      `Looking in ${n.s} of ${of.s} ${isOne(of.n, 'en') ? 'collection' : 'collections'}…`,
    relations: (n: Count) => `${n.s} ${isOne(n.n, 'en') ? 'relation' : 'relations'}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${isOne(fields.n, 'en') ? 'field holds' : 'fields hold'} ObjectIds · ${sampled.s} sampled ${isOne(sampled.n, 'en') ? 'document' : 'documents'} · looked in ${looked.s} of ${of.s} ${isOne(of.n, 'en') ? 'collection' : 'collections'}`,
    idleTitle: 'Find the fields that point to other collections',
    idleHint: `A sample of ${SAMPLE} documents is read, and the ObjectIds in its fields are looked up by _id in the other collections of this database.`,
    noneTitle: 'No references found',
    noFieldsHint: (n: Count) =>
      isOne(n.n, 'en')
        ? 'No field of the 1 sampled document holds an ObjectId (its own _id aside). Ids kept as text are not looked at.'
        : `No field of the ${n.s} sampled documents holds an ObjectId (their own _id aside). Ids kept as text are not looked at.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'en')
        ? `These fields hold ObjectIds, but the collection looked in does not hold them: ${paths}.`
        : `These fields hold ObjectIds, but none of the ${looked.s} collections looked in holds them: ${paths}.`,
    unmatchedTitle: 'No collection of this database holds the ids of',
    found: (matched: string, sampled: Count) =>
      `${matched} of ${sampled.s} sampled ${isOne(sampled.n, 'en') ? 'id' : 'ids'} found`,
    missing: (n: Count) => `${n.s} not found`,
    names: 'For example',
    share: 'Share found',
    percent: (n: number) => `${n}%`,
    lookup: 'Open with $lookup',
    lookupHint: 'Puts a $lookup joining these documents in Aggregations; nothing runs until you do.',
    orphans: 'Show orphans',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'en')
        ? `Shows in Documents the documents holding the sampled id ${coll} does not hold.`
        : `Shows in Documents the documents holding one of the ${n.s} sampled ids ${coll} does not hold.`,
    stopped: 'Stopped early; what was found so far is shown',
    failed: 'The references could not be found: ',
    handFailed: 'This could not be done: ',
    noPlace: 'Open a collection to find its references.',
  },
  tr: {
    title: 'Referanslar',
    description: (coll: string) =>
      `${coll} koleksiyonunda başka belgelerin ObjectId’lerini tutan alanlar ve o belgelerin bulunduğu koleksiyonlar.`,
    find: 'Referansları bul',
    sampling: 'Bir örnek okunuyor…',
    looking: (n: Count, of: Count) => `${of.s} koleksiyondan ${n.s}. koleksiyona bakılıyor…`,
    relations: (n: Count) => `${n.s} ilişki`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ObjectId tutan ${fields.s} alan · ${sampled.s} örnek belge · ${of.s} koleksiyondan ${looked.s} tanesine bakıldı`,
    idleTitle: 'Başka koleksiyonlara işaret eden alanları bulun',
    idleHint: `${SAMPLE} belgelik bir örnek okunur ve alanlarındaki ObjectId’ler bu veritabanının diğer koleksiyonlarında _id ile aranır.`,
    noneTitle: 'Referans bulunamadı',
    noFieldsHint: (n: Count) =>
      `Örnekteki ${n.s} belgenin hiçbir alanı (kendi _id’si dışında) ObjectId tutmuyor. Metin olarak saklanan kimliklere bakılmaz.`,
    unmatchedHint: (paths: string, looked: Count) =>
      `Bu alanlar ObjectId tutuyor, ama bakılan ${looked.s} koleksiyonun hiçbirinde bu kimlikler yok: ${paths}.`,
    unmatchedTitle: 'Bu veritabanında kimliklerini tutan bir koleksiyon olmayan alanlar',
    found: (matched: string, sampled: Count) => `Örnekteki ${sampled.s} kimliğin ${matched} tanesi bulundu`,
    missing: (n: Count) => `${n.s} bulunamadı`,
    names: 'Örneğin',
    share: 'Bulunan oran',
    percent: (n: number) => `%${n}`,
    lookup: '$lookup ile aç',
    lookupHint:
      'Bu belgeleri birleştiren bir $lookup’ı Aggregation bölümüne koyar; siz çalıştırana kadar hiçbir şey çalışmaz.',
    orphans: 'Bulunamayanları göster',
    orphansHint: (n: Count, coll: string) =>
      `${coll} koleksiyonunda olmayan örnek kimliklerden (${n.s}) birini tutan belgeleri Belgeler’de gösterir.`,
    stopped: 'Erken durdu; o ana kadar bulunanlar gösteriliyor',
    failed: 'Referanslar aranamadı: ',
    handFailed: 'Bu yapılamadı: ',
    noPlace: 'Referanslarını bulmak için bir koleksiyon açın.',
  },
  zh: {
    title: '引用',
    description: (coll: string) => `${coll} 中哪些字段保存了其他文档的 ObjectId，以及这些文档位于何处。`,
    find: '查找引用',
    sampling: '正在读取采样…',
    looking: (n: Count, of: Count) => `正在查找集合（${n.s}/${of.s}）…`,
    relations: (n: Count) => `${n.s} 个关系`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} 个字段保存 ObjectId · 采样 ${sampled.s} 个文档 · 已查找 ${looked.s}/${of.s} 个集合`,
    idleTitle: '查找指向其他集合的字段',
    idleHint: `读取 ${SAMPLE} 个文档的采样，并按 _id 在此数据库的其他集合中查找其字段里的 ObjectId。`,
    noneTitle: '未找到引用',
    noFieldsHint: (n: Count) =>
      `采样的 ${n.s} 个文档中，没有字段保存 ObjectId（文档自身的 _id 除外）。以文本保存的 ID 不会被查找。`,
    unmatchedHint: (paths: string, looked: Count) =>
      `这些字段保存了 ObjectId，但已查找的 ${looked.s} 个集合中都没有这些 ID：${paths}。`,
    unmatchedTitle: '此数据库中没有集合保存其 ID 的字段',
    found: (matched: string, sampled: Count) => `采样的 ${sampled.s} 个 ID 中找到 ${matched} 个`,
    missing: (n: Count) => `${n.s} 个未找到`,
    names: '例如',
    share: '找到的比例',
    percent: (n: number) => `${n}%`,
    lookup: '用 $lookup 打开',
    lookupHint: '在聚合中放入关联这些文档的 $lookup；手动运行前不会执行任何操作。',
    orphans: '显示孤立项',
    orphansHint: (n: Count, coll: string) =>
      `在文档中显示保存了 ${coll} 中没有的采样 ID（共 ${n.s} 个）之一的文档。`,
    stopped: '已提前停止；显示目前找到的结果',
    failed: '无法查找引用：',
    handFailed: '无法完成此操作：',
    noPlace: '打开一个集合以查找其引用。',
  },
  ja: {
    title: '参照',
    description: (coll: string) =>
      `${coll} のどのフィールドが他のドキュメントの ObjectId を保持し、それらのドキュメントがどこにあるか。`,
    find: '参照を検索',
    sampling: 'サンプルを読み取り中…',
    looking: (n: Count, of: Count) => `${of.s} 個中 ${n.s} 個のコレクションを検索中…`,
    relations: (n: Count) => `${n.s} 件の関係`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ObjectId を保持するフィールド ${fields.s} 個 · サンプル ${sampled.s} 件のドキュメント · ${of.s} 個中 ${looked.s} 個のコレクションを検索`,
    idleTitle: '他のコレクションを指すフィールドを検索',
    idleHint: `${SAMPLE} 件のドキュメントのサンプルを読み取り、そのフィールド内の ObjectId を、このデータベースの他のコレクションで _id により検索します。`,
    noneTitle: '参照が見つかりません',
    noFieldsHint: (n: Count) =>
      `サンプルの ${n.s} 件のドキュメントに、ObjectId を保持するフィールドはありません（ドキュメント自身の _id を除く）。テキストとして保存された ID は対象外です。`,
    unmatchedHint: (paths: string, looked: Count) =>
      `これらのフィールドは ObjectId を保持していますが、検索した ${looked.s} 個のコレクションのどれにも該当する ID がありません: ${paths}。`,
    unmatchedTitle: 'ID を保持するコレクションがこのデータベースにないフィールド',
    found: (matched: string, sampled: Count) =>
      `サンプルの ${sampled.s} 件の ID のうち ${matched} 件が見つかりました`,
    missing: (n: Count) => `${n.s} 件が見つかりません`,
    names: '例',
    share: '見つかった割合',
    percent: (n: number) => `${n}%`,
    lookup: '$lookup で開く',
    lookupHint: 'これらのドキュメントを結合する $lookup を集計に入れます。実行するまで何も実行されません。',
    orphans: '孤立を表示',
    orphansHint: (n: Count, coll: string) =>
      `${coll} にないサンプル ID（${n.s} 件）のいずれかを保持するドキュメントを、ドキュメントに表示します。`,
    stopped: '途中で停止しました。ここまでに見つかった結果を表示しています',
    failed: '参照を検索できませんでした: ',
    handFailed: 'この操作を実行できませんでした: ',
    noPlace: 'コレクションを開くと、その参照を検索できます。',
  },
  es: {
    title: 'Referencias',
    description: (coll: string) =>
      `Qué campos de ${coll} contienen ObjectId de otros documentos y dónde están esos documentos.`,
    find: 'Buscar referencias',
    sampling: 'Leyendo una muestra…',
    looking: (n: Count, of: Count) =>
      `Buscando en ${n.s} de ${of.s} ${isOne(of.n, 'es') ? 'colección' : 'colecciones'}…`,
    relations: (n: Count) => `${n.s} ${isOne(n.n, 'es') ? 'relación' : 'relaciones'}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${isOne(fields.n, 'es') ? 'campo contiene' : 'campos contienen'} ObjectId · ${sampled.s} ${isOne(sampled.n, 'es') ? 'documento' : 'documentos'} de muestra · se buscó en ${looked.s} de ${of.s} ${isOne(of.n, 'es') ? 'colección' : 'colecciones'}`,
    idleTitle: 'Encuentra los campos que apuntan a otras colecciones',
    idleHint: `Se lee una muestra de ${SAMPLE} documentos y los ObjectId de sus campos se buscan por _id en las demás colecciones de esta base de datos.`,
    noneTitle: 'No se encontraron referencias',
    noFieldsHint: (n: Count) =>
      isOne(n.n, 'es')
        ? 'Ningún campo del documento de la muestra contiene un ObjectId (salvo su propio _id). Los ids guardados como texto no se revisan.'
        : `Ningún campo de los ${n.s} documentos de la muestra contiene un ObjectId (salvo su propio _id). Los ids guardados como texto no se revisan.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'es')
        ? `Estos campos contienen ObjectId, pero la colección revisada no los contiene: ${paths}.`
        : `Estos campos contienen ObjectId, pero ninguna de las ${looked.s} colecciones revisadas los contiene: ${paths}.`,
    unmatchedTitle: 'Ninguna colección de esta base de datos contiene los ids de',
    found: (matched: string, sampled: Count) =>
      isOne(sampled.n, 'es')
        ? `${matched} de ${sampled.s} id de la muestra encontrado`
        : `${matched} de ${sampled.s} ids de la muestra encontrados`,
    missing: (n: Count) => `${n.s} ${isOne(n.n, 'es') ? 'no encontrado' : 'no encontrados'}`,
    names: 'Por ejemplo',
    share: 'Proporción encontrada',
    percent: (n: number) => `${n} %`,
    lookup: 'Abrir con $lookup',
    lookupHint:
      'Pone en Agregaciones un $lookup que une estos documentos; no se ejecuta nada hasta que lo hagas tú.',
    orphans: 'Mostrar huérfanos',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'es')
        ? `Muestra en Documentos los documentos que contienen el id de la muestra que ${coll} no contiene.`
        : `Muestra en Documentos los documentos que contienen alguno de los ${n.s} ids de la muestra que ${coll} no contiene.`,
    stopped: 'Se detuvo antes de tiempo; se muestra lo encontrado hasta ahora',
    failed: 'No se pudieron encontrar las referencias: ',
    handFailed: 'No se pudo hacer esto: ',
    noPlace: 'Abre una colección para encontrar sus referencias.',
  },
  pt: {
    title: 'Referências',
    description: (coll: string) =>
      `Quais campos de ${coll} contêm ObjectIds de outros documentos e onde esses documentos estão.`,
    find: 'Encontrar referências',
    sampling: 'Lendo uma amostra…',
    looking: (n: Count, of: Count) =>
      `Procurando em ${n.s} de ${of.s} ${isOne(of.n, 'pt') ? 'coleção' : 'coleções'}…`,
    relations: (n: Count) => `${n.s} ${isOne(n.n, 'pt') ? 'relação' : 'relações'}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${isOne(fields.n, 'pt') ? 'campo contém' : 'campos contêm'} ObjectIds · ${sampled.s} ${isOne(sampled.n, 'pt') ? 'documento' : 'documentos'} na amostra · procurou em ${looked.s} de ${of.s} ${isOne(of.n, 'pt') ? 'coleção' : 'coleções'}`,
    idleTitle: 'Encontre os campos que apontam para outras coleções',
    idleHint: `Uma amostra de ${SAMPLE} documentos é lida e os ObjectIds de seus campos são procurados por _id nas outras coleções deste banco de dados.`,
    noneTitle: 'Nenhuma referência encontrada',
    noFieldsHint: (n: Count) =>
      isOne(n.n, 'pt')
        ? 'Nenhum campo do documento da amostra contém um ObjectId (exceto o próprio _id). Ids guardados como texto não são verificados.'
        : `Nenhum campo dos ${n.s} documentos da amostra contém um ObjectId (exceto o próprio _id). Ids guardados como texto não são verificados.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'pt')
        ? `Estes campos contêm ObjectIds, mas a coleção verificada não os contém: ${paths}.`
        : `Estes campos contêm ObjectIds, mas nenhuma das ${looked.s} coleções verificadas os contém: ${paths}.`,
    unmatchedTitle: 'Nenhuma coleção deste banco de dados contém os ids de',
    found: (matched: string, sampled: Count) =>
      isOne(sampled.n, 'pt')
        ? `${matched} de ${sampled.s} id da amostra encontrado`
        : `${matched} de ${sampled.s} ids da amostra encontrados`,
    missing: (n: Count) => `${n.s} ${isOne(n.n, 'pt') ? 'não encontrado' : 'não encontrados'}`,
    names: 'Por exemplo',
    share: 'Proporção encontrada',
    percent: (n: number) => `${n}%`,
    lookup: 'Abrir com $lookup',
    lookupHint:
      'Coloca em Agregações um $lookup que une esses documentos; nada é executado até você executar.',
    orphans: 'Mostrar órfãos',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'pt')
        ? `Mostra em Documentos os documentos que contêm o id da amostra que ${coll} não contém.`
        : `Mostra em Documentos os documentos que contêm um dos ${n.s} ids da amostra que ${coll} não contém.`,
    stopped: 'Parou antes do fim; o que foi encontrado até agora é mostrado',
    failed: 'Não foi possível encontrar as referências: ',
    handFailed: 'Não foi possível fazer isso: ',
    noPlace: 'Abra uma coleção para encontrar suas referências.',
  },
  ko: {
    title: '참조',
    description: (coll: string) =>
      `${coll}에서 다른 도큐먼트의 ObjectId를 가진 필드와 그 도큐먼트가 있는 컬렉션입니다.`,
    find: '참조 찾기',
    sampling: '샘플을 읽는 중…',
    looking: (n: Count, of: Count) => `컬렉션 ${of.s}개 중 ${n.s}개를 검색하는 중…`,
    relations: (n: Count) => `관계 ${n.s}개`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ObjectId를 가진 필드 ${fields.s}개 · 샘플 도큐먼트 ${sampled.s}개 · 컬렉션 ${of.s}개 중 ${looked.s}개에서 검색`,
    idleTitle: '다른 컬렉션을 가리키는 필드 찾기',
    idleHint: `도큐먼트 ${SAMPLE}개의 샘플을 읽고, 그 필드에 있는 ObjectId를 이 데이터베이스의 다른 컬렉션에서 _id로 조회합니다.`,
    noneTitle: '참조를 찾지 못했습니다',
    noFieldsHint: (n: Count) =>
      n.n === 1
        ? '샘플 도큐먼트 1개의 어떤 필드에도 ObjectId가 없습니다(자체 _id 제외). 텍스트로 저장된 id는 확인하지 않습니다.'
        : `샘플 도큐먼트 ${n.s}개의 어떤 필드에도 ObjectId가 없습니다(각자의 _id 제외). 텍스트로 저장된 id는 확인하지 않습니다.`,
    unmatchedHint: (paths: string, looked: Count) =>
      `이 필드에는 ObjectId가 있지만, 검색한 컬렉션 ${looked.s}개 중 어느 것에도 해당 도큐먼트가 없습니다: ${paths}.`,
    unmatchedTitle: '이 데이터베이스의 어떤 컬렉션에도 다음 필드의 id가 없습니다',
    found: (matched: string, sampled: Count) => `샘플 id ${sampled.s}개 중 ${matched}개 찾음`,
    missing: (n: Count) => `${n.s}개 찾지 못함`,
    names: '예시',
    share: '찾은 비율',
    percent: (n: number) => `${n}%`,
    lookup: '$lookup으로 열기',
    lookupHint:
      '이 도큐먼트를 조인하는 $lookup을 집계에 넣습니다. 직접 실행하기 전에는 아무것도 실행되지 않습니다.',
    orphans: '고아 항목 표시',
    orphansHint: (n: Count, coll: string) =>
      `${coll}에 없는 샘플 id(${n.s}개) 중 하나를 가진 도큐먼트를 도큐먼트 탭에 표시합니다.`,
    stopped: '중간에 중단되었습니다. 지금까지 찾은 결과를 표시합니다',
    failed: '참조를 찾을 수 없습니다: ',
    handFailed: '이 작업을 수행할 수 없습니다: ',
    noPlace: '컬렉션을 열면 해당 참조를 찾을 수 있습니다.',
  },
  de: {
    title: 'Referenzen',
    description: (coll: string) =>
      `Welche Felder von ${coll} ObjectIds anderer Dokumente enthalten und wo diese Dokumente liegen.`,
    find: 'Referenzen suchen',
    sampling: 'Stichprobe wird gelesen…',
    looking: (n: Count, of: Count) =>
      `Suche in ${n.s} von ${of.s} ${isOne(of.n, 'de') ? 'Collection' : 'Collections'}…`,
    relations: (n: Count) => `${n.s} ${isOne(n.n, 'de') ? 'Beziehung' : 'Beziehungen'}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${isOne(fields.n, 'de') ? 'Feld enthält' : 'Felder enthalten'} ObjectIds · ${sampled.s} ${isOne(sampled.n, 'de') ? 'Dokument' : 'Dokumente'} in der Stichprobe · in ${looked.s} von ${of.s} ${isOne(of.n, 'de') ? 'Collection' : 'Collections'} gesucht`,
    idleTitle: 'Felder finden, die auf andere Collections verweisen',
    idleHint: `Es wird eine Stichprobe von ${SAMPLE} Dokumenten gelesen, und die ObjectIds in ihren Feldern werden per _id in den anderen Collections dieser Datenbank nachgeschlagen.`,
    noneTitle: 'Keine Referenzen gefunden',
    noFieldsHint: (n: Count) =>
      isOne(n.n, 'de')
        ? 'Kein Feld des Dokuments in der Stichprobe enthält eine ObjectId (außer der eigenen _id). Als Text gespeicherte IDs werden nicht berücksichtigt.'
        : `Kein Feld der ${n.s} Dokumente in der Stichprobe enthält eine ObjectId (außer der jeweils eigenen _id). Als Text gespeicherte IDs werden nicht berücksichtigt.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'de')
        ? `Diese Felder enthalten ObjectIds, aber die durchsuchte Collection enthält sie nicht: ${paths}.`
        : `Diese Felder enthalten ObjectIds, aber keine der ${looked.s} durchsuchten Collections enthält sie: ${paths}.`,
    unmatchedTitle: 'Keine Collection dieser Datenbank enthält die IDs von',
    found: (matched: string, sampled: Count) =>
      `${matched} von ${sampled.s} ${isOne(sampled.n, 'de') ? 'ID' : 'IDs'} aus der Stichprobe gefunden`,
    missing: (n: Count) => `${n.s} nicht gefunden`,
    names: 'Zum Beispiel',
    share: 'Anteil gefunden',
    percent: (n: number) => `${n} %`,
    lookup: 'Mit $lookup öffnen',
    lookupHint:
      'Legt ein $lookup, das diese Dokumente verknüpft, in Aggregationen ab; es wird nichts ausgeführt, bevor Sie es tun.',
    orphans: 'Verwaiste anzeigen',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'de')
        ? `Zeigt in Dokumente die Dokumente an, die die ID aus der Stichprobe enthalten, die ${coll} nicht enthält.`
        : `Zeigt in Dokumente die Dokumente an, die eine der ${n.s} IDs aus der Stichprobe enthalten, die ${coll} nicht enthält.`,
    stopped: 'Vorzeitig beendet; bisher Gefundenes wird angezeigt',
    failed: 'Die Referenzen konnten nicht gefunden werden: ',
    handFailed: 'Das konnte nicht ausgeführt werden: ',
    noPlace: 'Öffnen Sie eine Collection, um ihre Referenzen zu finden.',
  },
  fr: {
    title: 'Références',
    description: (coll: string) =>
      `Quels champs de ${coll} contiennent des ObjectId d’autres documents, et où se trouvent ces documents.`,
    find: 'Rechercher les références',
    sampling: 'Lecture d’un échantillon…',
    looking: (n: Count, of: Count) =>
      `Recherche dans ${n.s} ${isOne(n.n, 'fr') ? 'collection' : 'collections'} sur ${of.s}…`,
    relations: (n: Count) => `${n.s} ${isOne(n.n, 'fr') ? 'relation' : 'relations'}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${isOne(fields.n, 'fr') ? 'champ contient' : 'champs contiennent'} des ObjectId · ${sampled.s} ${isOne(sampled.n, 'fr') ? 'document' : 'documents'} dans l’échantillon · recherche dans ${looked.s} ${isOne(looked.n, 'fr') ? 'collection' : 'collections'} sur ${of.s}`,
    idleTitle: 'Trouver les champs qui pointent vers d’autres collections',
    idleHint: `Un échantillon de ${SAMPLE} documents est lu, et les ObjectId de ses champs sont recherchés par _id dans les autres collections de cette base de données.`,
    noneTitle: 'Aucune référence trouvée',
    noFieldsHint: (n: Count) =>
      isOne(n.n, 'fr')
        ? 'Aucun champ du document de l’échantillon ne contient d’ObjectId (hors son propre _id). Les identifiants stockés sous forme de texte ne sont pas examinés.'
        : `Aucun champ des ${n.s} documents de l’échantillon ne contient d’ObjectId (hors leur propre _id). Les identifiants stockés sous forme de texte ne sont pas examinés.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'fr')
        ? `Ces champs contiennent des ObjectId, mais la collection examinée ne les contient pas : ${paths}.`
        : `Ces champs contiennent des ObjectId, mais aucune des ${looked.s} collections examinées ne les contient : ${paths}.`,
    unmatchedTitle: 'Aucune collection de cette base de données ne contient les identifiants de',
    found: (matched: string, sampled: Count) =>
      isOne(sampled.n, 'fr')
        ? `${matched} sur ${sampled.s} identifiant de l’échantillon trouvé`
        : `${matched} sur ${sampled.s} identifiants de l’échantillon trouvés`,
    missing: (n: Count) => `${n.s} ${isOne(n.n, 'fr') ? 'introuvable' : 'introuvables'}`,
    names: 'Par exemple',
    share: 'Part trouvée',
    percent: (n: number) => `${n} %`,
    lookup: 'Ouvrir avec $lookup',
    lookupHint:
      'Place dans Agrégations un $lookup qui joint ces documents ; rien n’est exécuté tant que vous ne l’exécutez pas.',
    orphans: 'Afficher les orphelins',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'fr')
        ? `Affiche dans Documents les documents qui contiennent l’identifiant de l’échantillon que ${coll} ne contient pas.`
        : `Affiche dans Documents les documents qui contiennent l’un des ${n.s} identifiants de l’échantillon que ${coll} ne contient pas.`,
    stopped: 'Arrêté prématurément ; les résultats trouvés jusqu’ici sont affichés',
    failed: 'Impossible de trouver les références : ',
    handFailed: 'Impossible d’effectuer cette action : ',
    noPlace: 'Ouvrez une collection pour trouver ses références.',
  },
  ru: {
    title: 'Ссылки',
    description: (coll: string) =>
      `Какие поля коллекции ${coll} содержат ObjectId других документов и где находятся эти документы.`,
    find: 'Найти ссылки',
    sampling: 'Чтение выборки…',
    looking: (n: Count, of: Count) => `Поиск в коллекциях: ${n.s} из ${of.s}…`,
    relations: (n: Count) => `${n.s} ${ru(n.n, 'связь', 'связи', 'связей')}`,
    summary: (fields: Count, sampled: Count, looked: Count, of: Count) =>
      ` · ${fields.s} ${ru(fields.n, 'поле содержит', 'поля содержат', 'полей содержат')} ObjectId · ${sampled.s} ${ru(sampled.n, 'документ', 'документа', 'документов')} в выборке · просмотрено коллекций: ${looked.s} из ${of.s}`,
    idleTitle: 'Поиск полей, которые указывают на другие коллекции',
    idleHint: `Читается выборка из ${SAMPLE} документов, и ObjectId из ее полей ищутся по _id в других коллекциях этой базы данных.`,
    noneTitle: 'Ссылки не найдены',
    noFieldsHint: (n: Count) =>
      `Ни одно поле в выборке из ${n.s} ${isOne(n.n, 'ru') ? 'документа' : 'документов'} не содержит ObjectId (кроме собственного _id документа). Идентификаторы, хранящиеся как текст, не проверяются.`,
    unmatchedHint: (paths: string, looked: Count) =>
      isOne(looked.n, 'ru')
        ? `Эти поля содержат ObjectId, но просмотренная коллекция их не содержит: ${paths}.`
        : `Эти поля содержат ObjectId, но просмотренные коллекции (${looked.s}) их не содержат: ${paths}.`,
    unmatchedTitle: 'Ни одна коллекция этой базы данных не содержит идентификаторы из полей',
    found: (matched: string, sampled: Count) =>
      `Найдено идентификаторов из выборки: ${matched} из ${sampled.s}`,
    missing: (n: Count) => `не найдено: ${n.s}`,
    names: 'Например',
    share: 'Доля найденных',
    percent: (n: number) => `${n} %`,
    lookup: 'Открыть с $lookup',
    lookupHint:
      'Помещает в Агрегации $lookup, который соединяет эти документы; ничего не выполняется, пока вы сами этого не сделаете.',
    orphans: 'Показать потерянные',
    orphansHint: (n: Count, coll: string) =>
      isOne(n.n, 'ru')
        ? `Показывает в «Документах» документы, содержащие идентификатор из выборки, которого нет в ${coll}.`
        : `Показывает в «Документах» документы, содержащие идентификаторы из выборки, которых нет в ${coll} (всего ${n.s}).`,
    stopped: 'Остановлено досрочно; показано то, что найдено к этому моменту',
    failed: 'Не удалось найти ссылки: ',
    handFailed: 'Не удалось выполнить действие: ',
    noPlace: 'Откройте коллекцию, чтобы найти ее ссылки.',
  },
} satisfies Record<Language, Text>

type State =
  | { kind: 'idle' }
  | { kind: 'running'; step: { looking: number; of: number } | null }
  | { kind: 'done'; found: Found }
  | { kind: 'failed'; error: unknown }

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = pick<Text>(TEXT, 'en')
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0

  const n = (v: number) => formatNumber(v, shown(TEXT, locale), 0)
  /** A count for the texts: the number for the plural rules, its formatted text for the reader. */
  const c = (v: number): Count => ({ n: v, s: n(v) })

  // ---- the page
  const findButton = button({ label: text.find, icon: 'search', variant: 'primary', id: 'find' })
  const header = pageHeader({ icon: 'link', title: text.title, description: '', actions: [findButton] })
  const status = statusLine('status')
  const notice = h('p', {
    id: 'notice',
    class: 'mm-status ref-notice',
    attrs: { role: 'alert' },
    hidden: true,
  })
  const results = h('div', { id: 'results', class: 'ref-results' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status, notice), results),
    ),
  )

  function applyText(): void {
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    setLabel(findButton, text.find)
  }

  /** A failure handing something to the app, said beside the summary (the cards stay). */
  const handFailed = (e: unknown) => {
    notice.hidden = false
    notice.textContent = `${text.handFailed}${askMessage(e, locale)}`
  }

  function relationCard(r: Relation): HTMLElement {
    const pct = Math.round(r.share * 100)
    const fill = h('div', { class: 'ref-bar-fill' })
    fill.style.width = `${pct}%`
    const meter = h(
      'div',
      {
        class: `ref-bar${r.missing.length ? '' : ' ref-bar-full'}`,
        attrs: {
          role: 'meter',
          'aria-label': text.share,
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(pct),
          'aria-valuetext': text.percent(pct),
        },
      },
      fill,
    )
    const lookup = button({
      label: text.lookup,
      icon: 'layers',
      size: 'sm',
      title: text.lookupHint,
      onClick: () => {
        notice.hidden = true
        void client.ask('ui.useAggregation', { stages: lookupStages(r.path, r.coll) }).catch(handFailed)
      },
    })
    const filter = orphanFilter(r.path, r.missing)
    const orphans = filter
      ? button({
          label: text.orphans,
          icon: 'filter',
          variant: 'ghost',
          size: 'sm',
          title: text.orphansHint(c(r.missing.length), r.coll),
          onClick: () => {
            notice.hidden = true
            void client.ask('ui.useQuery', { filter }).catch(handFailed)
          },
        })
      : null
    return h(
      'article',
      { class: 'mm-card mm-card-pad ref-card', data: { relation: r.path } },
      h(
        'div',
        { class: 'ref-route' },
        h('span', { class: 'ref-field mm-mono', title: r.path, text: r.path }),
        h('span', { class: 'ref-arrow' }, icon('arrowRight', 14)),
        h(
          'span',
          { class: 'ref-target', title: r.coll },
          icon('link', 14),
          h('span', { class: 'ref-coll', text: r.coll }),
        ),
      ),
      h('div', { class: 'ref-share' }, meter, h('span', { class: 'ref-pct', text: text.percent(pct) })),
      h(
        'div',
        { class: 'ref-count' },
        h('span', { class: 'mm-status', text: text.found(n(r.matched), c(r.sampled)) }),
        r.missing.length ? badge(text.missing(c(r.missing.length)), 'warning') : null,
      ),
      r.names.length
        ? h(
            'div',
            { class: 'ref-names' },
            h('span', { class: 'mm-label', text: text.names }),
            ...r.names.map((name) => chip({ label: name })),
          )
        : null,
      h('div', { class: 'ref-actions' }, lookup, orphans),
    )
  }

  function render(): void {
    // Before the app greeted the page, nothing is known yet: no "open a collection" flash.
    if (!ctx) return void results.replaceChildren()
    if (!ctx.place) {
      status.textContent = ''
      results.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
      return
    }
    if (state.kind === 'idle') {
      status.textContent = ''
      results.replaceChildren(emptyState({ icon: 'link', title: text.idleTitle, hint: text.idleHint }))
      return
    }
    if (state.kind === 'running') {
      const step = state.step
      status.textContent = step ? text.looking(c(step.looking), c(step.of)) : text.sampling
      results.replaceChildren(skeleton(4))
      return
    }
    if (state.kind === 'failed') {
      status.textContent = ''
      results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: `${text.failed}${askMessage(state.error, locale)}`,
        }),
      )
      return
    }
    const f = state.found
    const stopped = f.stopped ? callout('warning', text.stopped, askMessage(f.stopped, locale)) : null
    if (!f.relations.length) {
      status.textContent = ''
      const hint = f.fields
        ? text.unmatchedHint(f.unmatched.join(', '), c(f.looked))
        : text.noFieldsHint(c(f.sampled))
      results.replaceChildren(
        ...(stopped ? [stopped] : []),
        emptyState({ icon: 'link', title: text.noneTitle, hint }),
      )
      return
    }
    status.replaceChildren(
      h('strong', { text: text.relations(c(f.relations.length)) }),
      document.createTextNode(text.summary(c(f.fields), c(f.sampled), c(f.looked), c(f.of))),
    )
    results.replaceChildren(
      ...(stopped ? [stopped] : []),
      h('div', { class: 'mm-cards ref-cards' }, ...f.relations.map(relationCard)),
      ...(f.unmatched.length
        ? [
            h(
              'div',
              { id: 'unmatched' },
              callout(
                'info',
                text.unmatchedTitle,
                undefined,
                h('div', { class: 'ref-lost' }, ...f.unmatched.map((p) => chip({ label: p, mono: true }))),
              ),
            ),
          ]
        : []),
    )
  }

  async function find(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    setBusy(findButton, true)
    notice.hidden = true
    state = { kind: 'running', step: null }
    render()
    try {
      const found = await findReferences(
        (method, params) => client.ask(method, params),
        (step) => {
          if (run !== running) return
          state = { kind: 'running', step }
          render()
        },
      )
      if (run !== running) return
      state = { kind: 'done', found }
    } catch (error) {
      if (run !== running) return
      state = { kind: 'failed', error }
    } finally {
      if (run === running) setBusy(findButton, false)
    }
    render()
  }

  findButton.addEventListener('click', () => void find())
  client.onContext((next, theme, accent) => {
    locale = next
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    // A failure said earlier was in the other language: gone rather than mixed.
    notice.hidden = true
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) {
      findButton.disabled = true
      render()
      return
    }
    // Bounded and read-only, so it looks right away rather than asking for a click.
    void find()
  })
  applyText()
  render()
}
