// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { formatNumber, pick, pluralOf, shown, type Language } from '../../kit/src/ui'

/** The page's words, per language (a language with no words here reads English). */
const en = {
  title: 'Map',
  description: (coll: string) => `Where the documents of ${coll} are`,
  one: (coll: string) => `One document of ${coll}, on the map`,
  fit: 'Fit to the shapes',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fieldLabel: 'GeoJSON field',
  fieldTitle: 'The field the shapes are read from',
  allFields: 'All fields',
  loading: 'Reading documents…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${pluralOf(shapes, 'en') === 'one' ? 'shape' : 'shapes'} in ${formatNumber(docs, locale)} ${pluralOf(docs, 'en') === 'one' ? 'document' : 'documents'}`,
  more: (n: number) => `of the first ${formatNumber(n, 'en')} documents`,
  hint: 'A number is several places close together: click it to zoom in.',
  noneTitle: 'No places in these documents',
  noneHint: (n: number) =>
    `Looked for GeoJSON shapes and [lng, lat] pairs in ${formatNumber(n, 'en')} ${pluralOf(n, 'en') === 'one' ? 'document' : 'documents'}.`,
  noPlace: 'Open a collection to see its documents on the map.',
  failed: 'The documents could not be read.',
  open: 'Open',
  openTitle: 'Open the document',
  document: 'Document',
  close: 'Close',
  list: 'Shapes',
  columns: { document: 'Document', field: 'Field', type: 'Type' },
  locate: 'Show it on the map',
  firstRows: (first: number, total: number) =>
    `The first ${formatNumber(first, 'en')} of ${formatNumber(total, 'en')} ${pluralOf(total, 'en') === 'one' ? 'shape' : 'shapes'}.`,
  noTilesTitle: 'No map tiles',
  noTilesText:
    'An administrator can set a tile server in Plugins; until then, the map draws a grid of meridians and parallels.',
  dismiss: 'Dismiss',
  cluster: (n: string) => `${n} places here: zoom in`,
  point: (name: string) => `${name}: show its document`,
  here: (n: number) =>
    `${formatNumber(n, 'en')} ${pluralOf(n, 'en') === 'one' ? 'place' : 'places'} at this spot`,
  moreRows: (n: number) => `+${formatNumber(n, 'en')} more`,
  inField: (type: string, field: string) => `${type} in ${field}`,
  compass: { n: 'N', s: 'S', e: 'E', w: 'W' },
  mapLabel: 'Map: drag to move, scroll to zoom',
  drawArea: 'Draw an area to filter by',
  drawCircle: 'Draw a circle to filter by',
  inView: 'Filter by the area in view',
  drawFieldFirst: 'Choose the GeoJSON field to filter by first',
  drawCannot: (field: string) =>
    `The shapes of ${field} are under a key no filter can name (one with a dot or a $ in it, or an empty one)`,
  leftOut: (field: string) =>
    `Shapes of ${field} under a key no filter can name (with a dot or a $ in it, or empty) are left out.`,
  drawingArea: 'Click to add corners; click the first corner, double-click or press Enter to finish.',
  drawingCircle: 'Click the centre, then the edge.',
  drawingAreaKeys:
    'Space adds a corner at the map’s centre, Backspace takes the last one back, Esc gives up.',
  drawingCircleKeys: 'Space puts the centre, then the edge, at the map’s centre; Esc gives up.',
  cancel: 'Cancel',
  filtered: (field: string) => `The documents with a shape of ${field} in the area are in Documents.`,
  filterFailed: 'Could not put the filter in Documents: ',
  noArea: {
    corners: 'An area needs three corners at least.',
    empty: 'The corners are in a line: the area has no size.',
    crossing: 'The area’s edges cross or touch: draw it so that they do not.',
  },
}
export type Text = typeof en

const tr: Text = {
  title: 'Harita',
  description: (coll: string) => `${coll} belgelerinin haritadaki yerleri`,
  one: (coll: string) => `${coll} koleksiyonundan bir belge, haritada`,
  fit: 'Şekillere sığdır',
  zoomIn: 'Yakınlaştır',
  zoomOut: 'Uzaklaştır',
  fieldLabel: 'GeoJSON alanı',
  fieldTitle: 'Şekillerin okunduğu alan',
  allFields: 'Bütün alanlar',
  loading: 'Belgeler okunuyor…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(docs, locale)} belgede ${formatNumber(shapes, locale)} şekil`,
  more: (n: number) => `ilk ${formatNumber(n, 'tr')} belgeden`,
  hint: 'Sayılar birbirine yakın birkaç yeri gösterir: yakınlaştırmak için tıklayın.',
  noneTitle: 'Bu belgelerde konum yok',
  noneHint: (n: number) => `${formatNumber(n, 'tr')} belgede GeoJSON şekli ve [boylam, enlem] çifti arandı.`,
  noPlace: 'Belgelerini haritada görmek için bir koleksiyon açın.',
  failed: 'Belgeler okunamadı.',
  open: 'Aç',
  openTitle: 'Belgeyi aç',
  document: 'Belge',
  close: 'Kapat',
  list: 'Şekiller',
  columns: { document: 'Belge', field: 'Alan', type: 'Tür' },
  locate: 'Haritada göster',
  firstRows: (first: number, total: number) =>
    `${formatNumber(total, 'tr')} şeklin ilk ${formatNumber(first, 'tr')} tanesi.`,
  noTilesTitle: 'Harita döşemesi yok',
  noTilesText:
    'Bir yönetici Eklentiler sayfasından bir döşeme sunucusu ayarlayabilir; o zamana dek harita meridyen ve paralellerden bir ızgara çizer.',
  dismiss: 'Kapat',
  cluster: (n: string) => `Burada ${n} konum var: yakınlaştır`,
  point: (name: string) => `${name}: belgesini göster`,
  here: (n: number) => `Bu noktada ${formatNumber(n, 'tr')} konum`,
  moreRows: (n: number) => `+${formatNumber(n, 'tr')} tane daha`,
  inField: (type: string, field: string) => `${field} alanında ${type}`,
  compass: { n: 'K', s: 'G', e: 'D', w: 'B' },
  mapLabel: 'Harita: taşımak için sürükleyin, yakınlaştırmak için kaydırın',
  drawArea: 'Filtrelemek için bir bölge çizin',
  drawCircle: 'Filtrelemek için bir daire çizin',
  inView: 'Görünen bölgeye göre filtreleyin',
  drawFieldFirst: 'Önce filtrelenecek GeoJSON alanını seçin',
  drawCannot: (field: string) =>
    `${field} alanındaki şekiller, adında nokta ya da $ bulunan ya da adı boş bir anahtarın altında: hiçbir filtre onlara ulaşamaz`,
  leftOut: (field: string) =>
    `${field} alanının, adında nokta ya da $ bulunan ya da adı boş bir anahtarın altındaki şekilleri dışarıda kalır.`,
  drawingArea:
    'Köşe eklemek için tıklayın; bitirmek için ilk köşeye tıklayın, çift tıklayın ya da Enter’a basın.',
  drawingCircle: 'Önce merkeze, sonra kenara tıklayın.',
  drawingAreaKeys:
    'Boşluk tuşuyla haritanın ortasına köşe ekleyin, Backspace ile son köşeyi geri alın, Esc ile vazgeçin.',
  drawingCircleKeys: 'Boşluk tuşuyla önce merkezi, sonra kenarı haritanın ortasına koyun; Esc ile vazgeçin.',
  cancel: 'Vazgeç',
  filtered: (field: string) => `Çizilen bölgede ${field} alanında şekli olan belgeler Belgeler’de.`,
  filterFailed: 'Filtre Belgeler’e konamadı: ',
  noArea: {
    corners: 'Bir bölge için en az üç köşe gerekir.',
    empty: 'Köşeler aynı doğru üzerinde: bölgenin alanı yok.',
    crossing: 'Bölgenin kenarları kesişiyor ya da birbirine değiyor: kenarları kesişmeyecek şekilde çizin.',
  },
}

const zh: Text = {
  title: '地图',
  description: (coll: string) => `${coll} 中的文档所在的位置`,
  one: (coll: string) => `${coll} 中的一个文档，显示在地图上`,
  fit: '适应形状',
  zoomIn: '放大',
  zoomOut: '缩小',
  fieldLabel: 'GeoJSON 字段',
  fieldTitle: '读取形状所用的字段',
  allFields: '所有字段',
  loading: '正在读取文档…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(docs, locale)} 个文档中有 ${formatNumber(shapes, locale)} 个形状`,
  more: (n: number) => `来自前 ${formatNumber(n, 'zh')} 个文档`,
  hint: '数字表示相距很近的多个位置：点击即可放大。',
  noneTitle: '这些文档中没有位置',
  noneHint: (n: number) => `已在 ${formatNumber(n, 'zh')} 个文档中查找 GeoJSON 形状和 [lng, lat] 坐标对。`,
  noPlace: '打开一个集合，即可在地图上查看其文档。',
  failed: '无法读取文档。',
  open: '打开',
  openTitle: '打开文档',
  document: '文档',
  close: '关闭',
  list: '形状',
  columns: { document: '文档', field: '字段', type: '类型' },
  locate: '在地图上显示',
  firstRows: (first: number, total: number) =>
    `共 ${formatNumber(total, 'zh')} 个形状，显示前 ${formatNumber(first, 'zh')} 个。`,
  noTilesTitle: '没有地图瓦片',
  noTilesText: '管理员可以在“插件”中设置瓦片服务器；在此之前，地图将绘制经纬网格。',
  dismiss: '关闭',
  cluster: (n: string) => `此处有 ${n} 个位置：放大查看`,
  point: (name: string) => `${name}：显示其文档`,
  here: (n: number) => `此处有 ${formatNumber(n, 'zh')} 个位置`,
  moreRows: (n: number) => `另有 ${formatNumber(n, 'zh')} 个`,
  inField: (type: string, field: string) => `${field} 中的 ${type}`,
  compass: { n: '北', s: '南', e: '东', w: '西' },
  mapLabel: '地图：拖动可移动，滚动可缩放',
  drawArea: '绘制用于筛选的区域',
  drawCircle: '绘制用于筛选的圆',
  inView: '按当前视图区域筛选',
  drawFieldFirst: '请先选择用于筛选的 GeoJSON 字段',
  drawCannot: (field: string) => `${field} 的形状位于任何筛选都无法指向的键下（键名含点或 $，或为空）`,
  leftOut: (field: string) =>
    `${field} 中位于任何筛选都无法指向的键下（键名含点或 $，或为空）的形状已被排除。`,
  drawingArea: '点击添加角点；点击第一个角点、双击或按 Enter 完成。',
  drawingCircle: '先点击圆心，再点击圆的边缘。',
  drawingAreaKeys: '按空格键在地图中心添加角点，按 Backspace 撤销上一个角点，按 Esc 放弃。',
  drawingCircleKeys: '按空格键先将圆心、再将边缘放在地图中心；按 Esc 放弃。',
  cancel: '取消',
  filtered: (field: string) => `区域内含有 ${field} 形状的文档已显示在“文档”中。`,
  filterFailed: '无法将筛选条件应用到“文档”：',
  noArea: {
    corners: '区域至少需要三个角点。',
    empty: '这些角点在一条直线上：区域没有面积。',
    crossing: '区域的边相交或接触：请绘制成各边互不相交。',
  },
}

const ja: Text = {
  title: 'マップ',
  description: (coll: string) => `${coll} のドキュメントの場所`,
  one: (coll: string) => `${coll} のドキュメント 1 件をマップに表示`,
  fit: 'シェイプに合わせる',
  zoomIn: 'ズームイン',
  zoomOut: 'ズームアウト',
  fieldLabel: 'GeoJSON フィールド',
  fieldTitle: 'シェイプの読み取り元のフィールド',
  allFields: 'すべてのフィールド',
  loading: 'ドキュメントを読み込んでいます…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(docs, locale)} 件のドキュメントに ${formatNumber(shapes, locale)} 個のシェイプ`,
  more: (n: number) => `最初の ${formatNumber(n, 'ja')} 件のドキュメントから`,
  hint: '数字は近接する複数の場所を表します。クリックするとズームインします。',
  noneTitle: 'これらのドキュメントに場所はありません',
  noneHint: (n: number) =>
    `${formatNumber(n, 'ja')} 件のドキュメントから GeoJSON シェイプと [lng, lat] のペアを探しました。`,
  noPlace: 'コレクションを開くと、そのドキュメントをマップに表示できます。',
  failed: 'ドキュメントを読み取れませんでした。',
  open: '開く',
  openTitle: 'ドキュメントを開く',
  document: 'ドキュメント',
  close: '閉じる',
  list: 'シェイプ',
  columns: { document: 'ドキュメント', field: 'フィールド', type: '型' },
  locate: 'マップに表示',
  firstRows: (first: number, total: number) =>
    `${formatNumber(total, 'ja')} 個のシェイプのうち、最初の ${formatNumber(first, 'ja')} 個です。`,
  noTilesTitle: 'マップタイルなし',
  noTilesText:
    '管理者はプラグインでタイルサーバーを設定できます。設定されるまでは、経線と緯線のグリッドを描画します。',
  dismiss: '閉じる',
  cluster: (n: string) => `ここに ${n} か所あります。ズームインしてください`,
  point: (name: string) => `${name}：ドキュメントを表示`,
  here: (n: number) => `この地点に ${formatNumber(n, 'ja')} か所`,
  moreRows: (n: number) => `ほか ${formatNumber(n, 'ja')} 件`,
  inField: (type: string, field: string) => `${field} の ${type}`,
  compass: { n: '北', s: '南', e: '東', w: '西' },
  mapLabel: 'マップ：ドラッグで移動、スクロールでズーム',
  drawArea: 'フィルター用の領域を描く',
  drawCircle: 'フィルター用の円を描く',
  inView: '表示中の領域でフィルター',
  drawFieldFirst: '先にフィルターする GeoJSON フィールドを選んでください',
  drawCannot: (field: string) =>
    `${field} のシェイプは、どのフィルターでも指定できないキー（ドットや $ を含む、または空のキー）の下にあります`,
  leftOut: (field: string) =>
    `${field} のシェイプのうち、どのフィルターでも指定できないキー（ドットや $ を含む、または空のキー）の下にあるものは除外されます。`,
  drawingArea:
    'クリックして頂点を追加します。最初の頂点をクリックするか、ダブルクリックまたは Enter で完了します。',
  drawingCircle: '中心をクリックし、次に端をクリックします。',
  drawingAreaKeys: 'Space でマップの中央に頂点を追加、Backspace で直前の頂点を取り消し、Esc で中止します。',
  drawingCircleKeys: 'Space で中心、次に端をマップの中央に置きます。Esc で中止します。',
  cancel: 'キャンセル',
  filtered: (field: string) =>
    `領域内に ${field} のシェイプがあるドキュメントをドキュメント画面に表示しました。`,
  filterFailed: 'フィルターをドキュメント画面に反映できませんでした：',
  noArea: {
    corners: '領域には 3 つ以上の頂点が必要です。',
    empty: '頂点が一直線上にあるため、領域の大きさがありません。',
    crossing: '領域の辺が交差または接しています。辺が交わらないように描いてください。',
  },
}

const es: Text = {
  title: 'Mapa',
  description: (coll: string) => `Dónde están los documentos de ${coll}`,
  one: (coll: string) => `Un documento de ${coll}, en el mapa`,
  fit: 'Ajustar a las formas',
  zoomIn: 'Acercar',
  zoomOut: 'Alejar',
  fieldLabel: 'Campo GeoJSON',
  fieldTitle: 'El campo del que se leen las formas',
  allFields: 'Todos los campos',
  loading: 'Leyendo documentos…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${pluralOf(shapes, 'es') === 'one' ? 'forma' : 'formas'} en ${formatNumber(docs, locale)} ${pluralOf(docs, 'es') === 'one' ? 'documento' : 'documentos'}`,
  more: (n: number) => `de los primeros ${formatNumber(n, 'es')} documentos`,
  hint: 'Un número indica varios lugares cercanos entre sí: haz clic para acercar.',
  noneTitle: 'No hay lugares en estos documentos',
  noneHint: (n: number) =>
    `Se buscaron formas GeoJSON y pares [lng, lat] en ${formatNumber(n, 'es')} ${pluralOf(n, 'es') === 'one' ? 'documento' : 'documentos'}.`,
  noPlace: 'Abre una colección para ver sus documentos en el mapa.',
  failed: 'No se pudieron leer los documentos.',
  open: 'Abrir',
  openTitle: 'Abrir el documento',
  document: 'Documento',
  close: 'Cerrar',
  list: 'Formas',
  columns: { document: 'Documento', field: 'Campo', type: 'Tipo' },
  locate: 'Mostrar en el mapa',
  firstRows: (first: number, total: number) =>
    `Formas mostradas: ${formatNumber(first, 'es')} de ${formatNumber(total, 'es')}.`,
  noTilesTitle: 'Sin teselas de mapa',
  noTilesText:
    'Un administrador puede configurar un servidor de teselas en Complementos; hasta entonces, el mapa dibuja una cuadrícula de meridianos y paralelos.',
  dismiss: 'Descartar',
  cluster: (n: string) => `${n} lugares aquí: acerca`,
  point: (name: string) => `${name}: mostrar su documento`,
  here: (n: number) =>
    `${formatNumber(n, 'es')} ${pluralOf(n, 'es') === 'one' ? 'lugar' : 'lugares'} en este punto`,
  moreRows: (n: number) => `+${formatNumber(n, 'es')} más`,
  inField: (type: string, field: string) => `${type} en ${field}`,
  compass: { n: 'N', s: 'S', e: 'E', w: 'O' },
  mapLabel: 'Mapa: arrastra para mover, desplázate para acercar',
  drawArea: 'Dibujar un área para filtrar',
  drawCircle: 'Dibujar un círculo para filtrar',
  inView: 'Filtrar por el área visible',
  drawFieldFirst: 'Elige primero el campo GeoJSON por el que filtrar',
  drawCannot: (field: string) =>
    `Las formas de ${field} están bajo una clave que ningún filtro puede nombrar (con un punto o un $, o vacía)`,
  leftOut: (field: string) =>
    `Las formas de ${field} bajo una clave que ningún filtro puede nombrar (con un punto o un $, o vacía) quedan fuera.`,
  drawingArea:
    'Haz clic para añadir esquinas; haz clic en la primera esquina, doble clic o pulsa Intro para terminar.',
  drawingCircle: 'Haz clic en el centro y luego en el borde.',
  drawingAreaKeys:
    'La barra espaciadora añade una esquina en el centro del mapa, Retroceso quita la última y Esc cancela.',
  drawingCircleKeys:
    'La barra espaciadora pone el centro y luego el borde en el centro del mapa; Esc cancela.',
  cancel: 'Cancelar',
  filtered: (field: string) => `Los documentos con una forma de ${field} en el área están en Documentos.`,
  filterFailed: 'No se pudo poner el filtro en Documentos: ',
  noArea: {
    corners: 'Un área necesita al menos tres esquinas.',
    empty: 'Las esquinas están en línea recta: el área no tiene tamaño.',
    crossing: 'Los bordes del área se cruzan o se tocan: dibújala de modo que no lo hagan.',
  },
}

const pt: Text = {
  title: 'Mapa',
  description: (coll: string) => `Onde estão os documentos de ${coll}`,
  one: (coll: string) => `Um documento de ${coll}, no mapa`,
  fit: 'Ajustar às formas',
  zoomIn: 'Aumentar zoom',
  zoomOut: 'Diminuir zoom',
  fieldLabel: 'Campo GeoJSON',
  fieldTitle: 'O campo de onde as formas são lidas',
  allFields: 'Todos os campos',
  loading: 'Lendo documentos…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${pluralOf(shapes, 'pt') === 'one' ? 'forma' : 'formas'} em ${formatNumber(docs, locale)} ${pluralOf(docs, 'pt') === 'one' ? 'documento' : 'documentos'}`,
  more: (n: number) => `dos primeiros ${formatNumber(n, 'pt')} documentos`,
  hint: 'Um número indica vários lugares próximos entre si: clique para aumentar o zoom.',
  noneTitle: 'Não há lugares nestes documentos',
  noneHint: (n: number) =>
    `Foram procuradas formas GeoJSON e pares [lng, lat] em ${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'documento' : 'documentos'}.`,
  noPlace: 'Abra uma coleção para ver seus documentos no mapa.',
  failed: 'Não foi possível ler os documentos.',
  open: 'Abrir',
  openTitle: 'Abrir o documento',
  document: 'Documento',
  close: 'Fechar',
  list: 'Formas',
  columns: { document: 'Documento', field: 'Campo', type: 'Tipo' },
  locate: 'Mostrar no mapa',
  firstRows: (first: number, total: number) =>
    `Formas mostradas: ${formatNumber(first, 'pt')} de ${formatNumber(total, 'pt')}.`,
  noTilesTitle: 'Sem blocos de mapa',
  noTilesText:
    'Um administrador pode configurar um servidor de blocos em Plugins; até lá, o mapa desenha uma grade de meridianos e paralelos.',
  dismiss: 'Dispensar',
  cluster: (n: string) => `${n} lugares aqui: aumente o zoom`,
  point: (name: string) => `${name}: mostrar o documento`,
  here: (n: number) =>
    `${formatNumber(n, 'pt')} ${pluralOf(n, 'pt') === 'one' ? 'lugar' : 'lugares'} neste ponto`,
  moreRows: (n: number) => `+${formatNumber(n, 'pt')} a mais`,
  inField: (type: string, field: string) => `${type} em ${field}`,
  compass: { n: 'N', s: 'S', e: 'L', w: 'O' },
  mapLabel: 'Mapa: arraste para mover, role para dar zoom',
  drawArea: 'Desenhar uma área para filtrar',
  drawCircle: 'Desenhar um círculo para filtrar',
  inView: 'Filtrar pela área visível',
  drawFieldFirst: 'Escolha primeiro o campo GeoJSON pelo qual filtrar',
  drawCannot: (field: string) =>
    `As formas de ${field} estão sob uma chave que nenhum filtro consegue nomear (com ponto ou $, ou vazia)`,
  leftOut: (field: string) =>
    `As formas de ${field} sob uma chave que nenhum filtro consegue nomear (com ponto ou $, ou vazia) ficam de fora.`,
  drawingArea:
    'Clique para adicionar vértices; clique no primeiro vértice, clique duas vezes ou pressione Enter para concluir.',
  drawingCircle: 'Clique no centro e depois na borda.',
  drawingAreaKeys:
    'A barra de espaço adiciona um vértice no centro do mapa, Backspace desfaz o último e Esc cancela.',
  drawingCircleKeys: 'A barra de espaço coloca o centro e depois a borda no centro do mapa; Esc cancela.',
  cancel: 'Cancelar',
  filtered: (field: string) => `Os documentos com uma forma de ${field} na área estão em Documentos.`,
  filterFailed: 'Não foi possível colocar o filtro em Documentos: ',
  noArea: {
    corners: 'Uma área precisa de pelo menos três vértices.',
    empty: 'Os vértices estão em linha reta: a área não tem tamanho.',
    crossing: 'As bordas da área se cruzam ou se tocam: desenhe-a de modo que isso não aconteça.',
  },
}

const ko: Text = {
  title: '지도',
  description: (coll: string) => `${coll} 도큐먼트의 위치`,
  one: (coll: string) => `도큐먼트 1개를 지도에 표시: ${coll}`,
  fit: '도형에 맞추기',
  zoomIn: '확대',
  zoomOut: '축소',
  fieldLabel: 'GeoJSON 필드',
  fieldTitle: '도형을 읽어 올 필드',
  allFields: '모든 필드',
  loading: '도큐먼트를 읽는 중…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(docs, locale)}개 도큐먼트에 도형 ${formatNumber(shapes, locale)}개`,
  more: (n: number) => `처음 ${formatNumber(n, 'ko')}개 도큐먼트 기준`,
  hint: '숫자는 서로 가까운 여러 장소를 나타냅니다. 클릭하면 확대합니다.',
  noneTitle: '이 도큐먼트에는 위치가 없습니다',
  noneHint: (n: number) =>
    `GeoJSON 도형과 [lng, lat] 쌍을 도큐먼트 ${formatNumber(n, 'ko')}개에서 찾아보았습니다.`,
  noPlace: '컬렉션을 열면 해당 도큐먼트를 지도에서 볼 수 있습니다.',
  failed: '도큐먼트를 읽을 수 없습니다.',
  open: '열기',
  openTitle: '도큐먼트 열기',
  document: '도큐먼트',
  close: '닫기',
  list: '도형',
  columns: { document: '도큐먼트', field: '필드', type: '유형' },
  locate: '지도에 표시',
  firstRows: (first: number, total: number) =>
    `도형 ${formatNumber(total, 'ko')}개 중 처음 ${formatNumber(first, 'ko')}개입니다.`,
  noTilesTitle: '지도 타일 없음',
  noTilesText:
    '관리자는 플러그인에서 타일 서버를 설정할 수 있습니다. 설정하기 전까지는 지도에 경선과 위선 격자를 그립니다.',
  dismiss: '닫기',
  cluster: (n: string) => `이곳에 ${n}곳이 있습니다. 확대하세요`,
  point: (name: string) => `${name}: 도큐먼트 표시`,
  here: (n: number) => `이 지점에 ${formatNumber(n, 'ko')}곳`,
  moreRows: (n: number) => `+${formatNumber(n, 'ko')}개 더`,
  inField: (type: string, field: string) => `${field} 필드: ${type}`,
  compass: { n: '북', s: '남', e: '동', w: '서' },
  mapLabel: '지도: 드래그하여 이동, 스크롤하여 확대/축소',
  drawArea: '필터링할 영역 그리기',
  drawCircle: '필터링할 원 그리기',
  inView: '현재 보이는 영역으로 필터링',
  drawFieldFirst: '먼저 필터링할 GeoJSON 필드를 선택하세요',
  drawCannot: (field: string) =>
    `${field} 필드의 도형이 어떤 필터로도 지정할 수 없는 키(점이나 $가 들어 있거나 비어 있는 키) 아래에 있습니다`,
  leftOut: (field: string) =>
    `${field} 필드의 도형 중 어떤 필터로도 지정할 수 없는 키(점이나 $가 들어 있거나 비어 있는 키) 아래에 있는 것은 제외됩니다.`,
  drawingArea:
    '클릭하여 꼭짓점을 추가하세요. 첫 번째 꼭짓점을 클릭하거나 더블 클릭 또는 Enter를 눌러 완료합니다.',
  drawingCircle: '중심을 클릭한 다음 가장자리를 클릭하세요.',
  drawingAreaKeys:
    'Space는 지도 중앙에 꼭짓점을 추가하고, Backspace는 마지막 꼭짓점을 되돌리며, Esc는 취소합니다.',
  drawingCircleKeys: 'Space로 중심과 가장자리를 차례로 지도 중앙에 놓습니다. Esc는 취소합니다.',
  cancel: '취소',
  filtered: (field: string) => `영역 안에 ${field} 도형이 있는 도큐먼트가 도큐먼트 탭에 표시되었습니다.`,
  filterFailed: '도큐먼트 탭에 필터를 적용할 수 없습니다: ',
  noArea: {
    corners: '영역에는 꼭짓점이 3개 이상 필요합니다.',
    empty: '꼭짓점이 일직선 위에 있어 영역의 크기가 없습니다.',
    crossing: '영역의 변이 교차하거나 맞닿아 있습니다. 변이 겹치지 않게 그리세요.',
  },
}

const de: Text = {
  title: 'Karte',
  description: (coll: string) => `Wo die Dokumente von ${coll} liegen`,
  one: (coll: string) => `Ein Dokument von ${coll} auf der Karte`,
  fit: 'An Formen anpassen',
  zoomIn: 'Vergrößern',
  zoomOut: 'Verkleinern',
  fieldLabel: 'GeoJSON-Feld',
  fieldTitle: 'Das Feld, aus dem die Formen gelesen werden',
  allFields: 'Alle Felder',
  loading: 'Dokumente werden gelesen…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${pluralOf(shapes, 'de') === 'one' ? 'Form' : 'Formen'} in ${formatNumber(docs, locale)} ${pluralOf(docs, 'de') === 'one' ? 'Dokument' : 'Dokumenten'}`,
  more: (n: number) => `der ersten ${formatNumber(n, 'de')} Dokumente`,
  hint: 'Eine Zahl steht für mehrere nahe beieinanderliegende Orte: Zum Vergrößern anklicken.',
  noneTitle: 'Keine Orte in diesen Dokumenten',
  noneHint: (n: number) =>
    `Gesucht wurde nach GeoJSON-Formen und [lng, lat]-Paaren in ${formatNumber(n, 'de')} ${pluralOf(n, 'de') === 'one' ? 'Dokument' : 'Dokumenten'}.`,
  noPlace: 'Öffnen Sie eine Collection, um ihre Dokumente auf der Karte zu sehen.',
  failed: 'Die Dokumente konnten nicht gelesen werden.',
  open: 'Öffnen',
  openTitle: 'Dokument öffnen',
  document: 'Dokument',
  close: 'Schließen',
  list: 'Formen',
  columns: { document: 'Dokument', field: 'Feld', type: 'Typ' },
  locate: 'Auf der Karte anzeigen',
  firstRows: (first: number, total: number) =>
    `${formatNumber(first, 'de')} von ${formatNumber(total, 'de')} ${pluralOf(total, 'de') === 'one' ? 'Form' : 'Formen'} angezeigt.`,
  noTilesTitle: 'Keine Kartenkacheln',
  noTilesText:
    'Ein Administrator kann unter Plugins einen Kachelserver festlegen; bis dahin zeichnet die Karte ein Gitter aus Längen- und Breitenkreisen.',
  dismiss: 'Ausblenden',
  cluster: (n: string) => `${n} Orte hier: Zum Vergrößern anklicken`,
  point: (name: string) => `${name}: Dokument anzeigen`,
  here: (n: number) =>
    `${formatNumber(n, 'de')} ${pluralOf(n, 'de') === 'one' ? 'Ort' : 'Orte'} an dieser Stelle`,
  moreRows: (n: number) => `+${formatNumber(n, 'de')} weitere`,
  inField: (type: string, field: string) => `${type} in ${field}`,
  compass: { n: 'N', s: 'S', e: 'O', w: 'W' },
  mapLabel: 'Karte: Zum Verschieben ziehen, zum Zoomen scrollen',
  drawArea: 'Bereich zum Filtern zeichnen',
  drawCircle: 'Kreis zum Filtern zeichnen',
  inView: 'Nach dem sichtbaren Bereich filtern',
  drawFieldFirst: 'Wählen Sie zuerst das GeoJSON-Feld zum Filtern aus',
  drawCannot: (field: string) =>
    `Die Formen von ${field} liegen unter einem Schlüssel, den kein Filter benennen kann (mit Punkt oder $ im Namen oder leer)`,
  leftOut: (field: string) =>
    `Formen von ${field} unter einem Schlüssel, den kein Filter benennen kann (mit Punkt oder $ im Namen oder leer), bleiben ausgeschlossen.`,
  drawingArea:
    'Klicken Sie, um Eckpunkte zu setzen; zum Abschließen auf den ersten Eckpunkt klicken, doppelklicken oder die Eingabetaste drücken.',
  drawingCircle: 'Klicken Sie auf den Mittelpunkt, dann auf den Rand.',
  drawingAreaKeys:
    'Mit der Leertaste setzen Sie einen Eckpunkt in der Kartenmitte, mit der Rücktaste nehmen Sie den letzten zurück, mit Esc brechen Sie ab.',
  drawingCircleKeys:
    'Mit der Leertaste setzen Sie zuerst den Mittelpunkt, dann den Rand in die Kartenmitte; mit Esc brechen Sie ab.',
  cancel: 'Abbrechen',
  filtered: (field: string) => `Die Dokumente mit einer Form von ${field} im Bereich stehen unter Dokumente.`,
  filterFailed: 'Der Filter konnte nicht in Dokumente übernommen werden: ',
  noArea: {
    corners: 'Ein Bereich braucht mindestens drei Eckpunkte.',
    empty: 'Die Eckpunkte liegen auf einer Linie: Der Bereich hat keine Fläche.',
    crossing:
      'Die Kanten des Bereichs überschneiden oder berühren sich: Zeichnen Sie ihn so, dass sie es nicht tun.',
  },
}

const fr: Text = {
  title: 'Carte',
  description: (coll: string) => `Où se trouvent les documents de ${coll}`,
  one: (coll: string) => `Un document de ${coll}, sur la carte`,
  fit: 'Ajuster aux formes',
  zoomIn: 'Zoom avant',
  zoomOut: 'Zoom arrière',
  fieldLabel: 'Champ GeoJSON',
  fieldTitle: 'Le champ dont les formes sont lues',
  allFields: 'Tous les champs',
  loading: 'Lecture des documents…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${pluralOf(shapes, 'fr') === 'one' ? 'forme' : 'formes'} dans ${formatNumber(docs, locale)} ${pluralOf(docs, 'fr') === 'one' ? 'document' : 'documents'}`,
  more: (n: number) => `parmi les ${formatNumber(n, 'fr')} premiers documents`,
  hint: 'Un nombre représente plusieurs lieux proches les uns des autres : cliquez pour zoomer.',
  noneTitle: 'Aucun lieu dans ces documents',
  noneHint: (n: number) =>
    `Recherche de formes GeoJSON et de paires [lng, lat] dans ${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'document' : 'documents'}.`,
  noPlace: 'Ouvrez une collection pour voir ses documents sur la carte.',
  failed: 'Impossible de lire les documents.',
  open: 'Ouvrir',
  openTitle: 'Ouvrir le document',
  document: 'Document',
  close: 'Fermer',
  list: 'Formes',
  columns: { document: 'Document', field: 'Champ', type: 'Type' },
  locate: 'Afficher sur la carte',
  firstRows: (first: number, total: number) =>
    `Formes affichées : ${formatNumber(first, 'fr')} sur ${formatNumber(total, 'fr')}.`,
  noTilesTitle: 'Aucune tuile de carte',
  noTilesText:
    'Un administrateur peut définir un serveur de tuiles dans Plug-ins ; d’ici là, la carte dessine une grille de méridiens et de parallèles.',
  dismiss: 'Ignorer',
  cluster: (n: string) => `${n} lieux ici : zoomez`,
  point: (name: string) => `${name} : afficher son document`,
  here: (n: number) =>
    `${formatNumber(n, 'fr')} ${pluralOf(n, 'fr') === 'one' ? 'lieu' : 'lieux'} à cet endroit`,
  moreRows: (n: number) => `+${formatNumber(n, 'fr')} de plus`,
  inField: (type: string, field: string) => `${type} dans ${field}`,
  compass: { n: 'N', s: 'S', e: 'E', w: 'O' },
  mapLabel: 'Carte : faites glisser pour déplacer, faites défiler pour zoomer',
  drawArea: 'Dessiner une zone pour filtrer',
  drawCircle: 'Dessiner un cercle pour filtrer',
  inView: 'Filtrer selon la zone visible',
  drawFieldFirst: 'Choisissez d’abord le champ GeoJSON à filtrer',
  drawCannot: (field: string) =>
    `Les formes de ${field} sont sous une clé qu’aucun filtre ne peut nommer (avec un point ou un $, ou vide)`,
  leftOut: (field: string) =>
    `Les formes de ${field} sous une clé qu’aucun filtre ne peut nommer (avec un point ou un $, ou vide) sont exclues.`,
  drawingArea:
    'Cliquez pour ajouter des sommets ; cliquez sur le premier sommet, double-cliquez ou appuyez sur Entrée pour terminer.',
  drawingCircle: 'Cliquez sur le centre, puis sur le bord.',
  drawingAreaKeys:
    'La barre d’espace ajoute un sommet au centre de la carte, Retour arrière retire le dernier, Échap abandonne.',
  drawingCircleKeys:
    'La barre d’espace place le centre, puis le bord, au centre de la carte ; Échap abandonne.',
  cancel: 'Annuler',
  filtered: (field: string) => `Les documents ayant une forme de ${field} dans la zone sont dans Documents.`,
  filterFailed: 'Impossible de placer le filtre dans Documents : ',
  noArea: {
    corners: 'Une zone doit avoir au moins trois sommets.',
    empty: 'Les sommets sont alignés : la zone n’a pas de surface.',
    crossing:
      'Les côtés de la zone se croisent ou se touchent : dessinez-la de façon qu’ils ne le fassent pas.',
  },
}

/** A Russian count's word: one (1, 21…), few (2–4, 22–24…), many (0, 5–20…) or other (a decimal). */
const ruForm = (n: number, forms: Record<'one' | 'few' | 'many' | 'other', string>): string =>
  forms[pluralOf(n, 'ru') as 'one' | 'few' | 'many' | 'other']

const ru: Text = {
  title: 'Карта',
  description: (coll: string) => `Где находятся документы коллекции ${coll}`,
  one: (coll: string) => `Один документ коллекции ${coll} на карте`,
  fit: 'Показать все фигуры',
  zoomIn: 'Увеличить',
  zoomOut: 'Уменьшить',
  fieldLabel: 'Поле GeoJSON',
  fieldTitle: 'Поле, из которого читаются фигуры',
  allFields: 'Все поля',
  loading: 'Чтение документов…',
  shapes: (docs: number, shapes: number, locale: string) =>
    `${formatNumber(shapes, locale)} ${ruForm(shapes, { one: 'фигура', few: 'фигуры', many: 'фигур', other: 'фигуры' })} в ${formatNumber(docs, locale)} ${ruForm(docs, { one: 'документе', few: 'документах', many: 'документах', other: 'документах' })}`,
  more: (n: number) =>
    `из первых ${formatNumber(n, 'ru')} ${ruForm(n, { one: 'документа', few: 'документов', many: 'документов', other: 'документа' })}`,
  hint: 'Число обозначает несколько близких мест: нажмите, чтобы увеличить.',
  noneTitle: 'В этих документах нет мест',
  noneHint: (n: number) =>
    `Поиск фигур GeoJSON и пар [lng, lat] выполнен в ${formatNumber(n, 'ru')} ${ruForm(n, { one: 'документе', few: 'документах', many: 'документах', other: 'документах' })}.`,
  noPlace: 'Откройте коллекцию, чтобы увидеть ее документы на карте.',
  failed: 'Не удалось прочитать документы.',
  open: 'Открыть',
  openTitle: 'Открыть документ',
  document: 'Документ',
  close: 'Закрыть',
  list: 'Фигуры',
  columns: { document: 'Документ', field: 'Поле', type: 'Тип' },
  locate: 'Показать на карте',
  firstRows: (first: number, total: number) =>
    `Показано ${formatNumber(first, 'ru')} из ${formatNumber(total, 'ru')} ${ruForm(total, { one: 'фигуры', few: 'фигур', many: 'фигур', other: 'фигуры' })}.`,
  noTilesTitle: 'Нет тайлов карты',
  noTilesText:
    'Администратор может указать сервер тайлов в разделе «Плагины»; до тех пор карта рисует сетку меридианов и параллелей.',
  dismiss: 'Скрыть',
  cluster: (n: string) => `Мест здесь: ${n}. Увеличьте масштаб`,
  point: (name: string) => `${name}: показать документ`,
  here: (n: number) =>
    `В этой точке: ${formatNumber(n, 'ru')} ${ruForm(n, { one: 'место', few: 'места', many: 'мест', other: 'места' })}`,
  moreRows: (n: number) => `еще ${formatNumber(n, 'ru')}`,
  inField: (type: string, field: string) => `${type} в поле ${field}`,
  compass: { n: 'С', s: 'Ю', e: 'В', w: 'З' },
  mapLabel: 'Карта: перетащите, чтобы сдвинуть, прокрутите, чтобы изменить масштаб',
  drawArea: 'Нарисовать область для фильтра',
  drawCircle: 'Нарисовать круг для фильтра',
  inView: 'Фильтр по видимой области',
  drawFieldFirst: 'Сначала выберите поле GeoJSON для фильтра',
  drawCannot: (field: string) =>
    `Фигуры поля ${field} лежат под ключом, который не может указать ни один фильтр (с точкой или $ в имени либо пустым)`,
  leftOut: (field: string) =>
    `Фигуры поля ${field} под ключом, который не может указать ни один фильтр (с точкой или $ в имени либо пустым), исключаются.`,
  drawingArea:
    'Нажимайте, чтобы добавить углы; чтобы закончить, нажмите на первый угол, дважды щелкните или нажмите Enter.',
  drawingCircle: 'Нажмите на центр, затем на край.',
  drawingAreaKeys: 'Пробел добавляет угол в центре карты, Backspace убирает последний, Esc отменяет.',
  drawingCircleKeys: 'Пробел помещает в центр карты сначала центр круга, затем его край; Esc отменяет.',
  cancel: 'Отмена',
  filtered: (field: string) => `Документы с фигурой поля ${field} в области показаны в разделе «Документы».`,
  filterFailed: 'Не удалось передать фильтр в «Документы»: ',
  noArea: {
    corners: 'Для области нужно не менее трех углов.',
    empty: 'Углы лежат на одной прямой: у области нет площади.',
    crossing: 'Стороны области пересекаются или соприкасаются: нарисуйте ее так, чтобы этого не было.',
  },
}

export const TEXT = { en, tr, zh, ja, es, pt, ko, de, fr, ru } satisfies Record<Language, Text>

/** The language the page's words are in (English when the reader's has none). */
export const wordsLanguage = (locale: string): Language => shown(TEXT, locale)

/** The words in the reader's language (English when there are none). */
export const textFor = (locale: string): Text => pick(TEXT, locale)
