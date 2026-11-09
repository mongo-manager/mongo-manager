# Harita

Harita, bir koleksiyonun belgelerinin nerede olduğunu kendine ait bir harita üzerinde çizer: GeoJSON şekillerini (noktalar, çizgiler, çokgenler ve bunların koleksiyonları) ve eski tip `[lng, lat]` koordinat çiftlerini. Birbirine yakın noktalar bir sayıyla kümelenir; bir şekle tıklamak, belgesi hakkında bir kart açar.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Harita** sekmesi.
- **Belge eylemi:** Belgeler'de bir belge satırının eylem menüsündeki **Haritada göster**, yalnızca o belgeyi çizer.
- **Hücre değerleri:** Belgeler'de bir GeoJSON noktasının yanında, konumu `lat, lng` olarak (beş ondalık basamakla), örneğin `41.00820, 28.97840`.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Harita** sekmesine geçin. Geçerli Belgeler sorgusunun belgeleri okunur ve şekilleri çizilir; harita kendini bu şekillere sığdırır.

- Taşımak için sürükleyin; yakınlaştırıp uzaklaştırmak için kaydırın ya da **Yakınlaştır** ve **Uzaklaştır** düğmelerini kullanın; her şeyi yeniden görmek için **Şekillere sığdır**.
- İçinde sayı olan bir daire, birbirine yakın birkaç yeri bir arada tutar: yakınlaştırmak için tıklayın.
- Kartını açmak için bir noktaya ya da şekle tıklayın: belgenin adı, birkaç alanı ve belgeyi uygulamada göstermek için **Aç**.
- **GeoJSON alanı**, belgeler birden fazla alanda şekil taşıyorsa (örneğin `pickup` ve `dropoff`) haritayı tek bir alanla sınırlar; **Bütün alanlar** hepsini gösterir.
- **Şekiller** çizilenleri listeler (belge, alan, tür). Haritada klavyeyle gezmenin yolu budur: **Haritada göster** bir şekli ortalar, **Aç** belgesini açar.

## Bir bölgeye göre filtreleme

Alan seçicinin yanındaki üç düğme belgeleri bir bölgeye göre filtreler:

- **Filtrelemek için bir bölge çiz:** köşe eklemek için haritaya tıklayın; bitirmek için ilk köşeye tıklayın, çift tıklayın ya da Enter'a basın. Backspace son köşeyi geri alır; Esc, odak nerede olursa olsun vazgeçer.
- **Filtrelemek için bir daire çiz:** önce merkezine, sonra kenarına tıklayın; yarıçapı siz hareket ettikçe görünür, çevresi de dünyanın onu tuttuğu gibidir (haritada kutuplara doğru genişler).
- **Görünen bölgeye göre filtrele:** haritanın gösterdiği bölge.

Klavyeyle: harita odaktayken oklar onu kaydırır, Boşluk tuşu da bir köşeyi (ya da dairenin önce merkezini, sonra kenarını) haritanın ortasına, bir artının göründüğü yere koyar. Kullanılan bir araca ikinci kez tıklamak onu bırakır; başka bir alan seçmek çizimi durdurur.

Bölgede bir şekli olan belgeler MongoDB'nin `$geoWithin`'i ile Belgeler sorgusuna konur. Her kenar haritada çizilen çizgiyi izler — MongoDB iki köşeyi dünya üzerindeki en kısa yoldan, bir kutba doğru eğilerek birleştirdiği için kenar boyunca köşeler eklenir — ve bir bölge 180. meridyeni aşabilir. GeoJSON şekillerinde de `[boylam, enlem]` çiftlerinde de çalışır, indeks gerektirmez. Bir Feature içindeki şekil geometrisine göre, bir FeatureCollection içindeki şekil koleksiyonun özelliklerine (features) göre (bir belge, şekillerinden biri bölgedeyse içeridedir), bir dizideki şekil de dizinin öğelerine göre filtrelenir. Bir alan şekillerini bunların birden fazlasıyla taşıyorsa filtre her birini alır. Hiçbir filtrenin adlandıramayacağı bir anahtarın (adında nokta ya da `$` bulunan ya da adı boş olan) altındaki şekiller dışarıda kalır; sayfa bunu filtrelemeden önce, araçların yanında söyler.

Bölge kullanılan Belgeler filtresinin yanına konur: diğer koşulları korunur, aynı alanda zaten bulunan bir bölge (daha önceki bir çizimin ya da sizin yazdığınız) ise değiştirilir. Belgeler sıralaması ve projeksiyonu, bir eklentinin oraya koyduğu her sorguda olduğu gibi sıfırlanır. Kenarları kesişen, birbirine değen ya da geri dönen veya köşeleri aynı doğru üzerinde olan bir çokgen bir bölge oluşturmaz: sayfa nedenini söyler. Belgeler birkaç alanda şekil taşıyorsa önce filtrelenecek olanı seçin; sayfa bunu düğmelerin yanında söyler. **Haritada göster** (tek belge) çizim araçlarını içermez.

## Neler konum olarak okunur

- Herhangi bir alandaki GeoJSON geometrisi: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` ya da `GeometryCollection`.
- Bir GeoJSON `Feature` ya da `FeatureCollection`.
- Eski tip `[lng, lat]` çifti; MongoDB'nin sakladığı gibi önce boylam. Ama yalnızca konum adı taşıyan bir alanda: `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` ve bunların çoğulları ya da yakın biçimleri. Başka yerlerdeki iki sayı (bir sürüm, bir boyut) konum sayılmaz. `latlng` adlı bir alan okunmaz, çünkü genellikle önce enlemi taşır.

Alanlar altı düzey derinliğe kadar ve dizilerin içinde de aranır. Geçerli GeoJSON olmayan bir şekil bütünüyle dışarıda bırakılır.

## Örnek

Bir `stores` koleksiyonu:

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

İkisi de Harita sekmesinde görünür. Belgeler'de ilk belgenin `location` hücresi, değerin yanında `40.99030, 29.02750` gösterir.

## Harita döşemeleri

Varsayılan olarak hiçbir harita döşemesi yüklenmez ve hiçbir döşeme sunucusuna bağlanılmaz: harita meridyen ve paralellerden bir ızgara çizer ve bir not, bir yöneticinin döşeme sunucusu ayarlayabileceğini söyler. Bir döşeme sunucusu ayarlandığında şekiller gerçek harita döşemelerinin üzerine çizilir.

## İzinler

- **Belgeleri okuma** (`documents:read`): geçerli sorgunun belgelerini ve Haritada göster'in tek belgesini okumak için.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları okuyamaz.

## Ayarlar

Yöneticiler bunları Eklentiler sayfasından ayarlar. Eklentiyi kullanan herkes bu ayarları görebilir; bu yüzden buraya asla bir sır (örneğin özel bir API anahtarı) yazmayın.

- **Harita döşemeleri** (`tileUrl`): raster döşemeler için bir http ya da https adres şablonu. `{z}`, `{x}` ve `{y}` her döşeme için doldurulur, `{-y}` satırları güneyden sayar (TMS), `{s}` bir alt alan adı seçer (`a`, `b` ya da `c`) ve `{r}` boş bırakılır. Örnek: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (önce döşeme sağlayıcısının kullanım koşullarını kontrol edin).
- **Döşeme kaynağı** (`tileAttribution`): haritada gösterilen kaynak satırı, düz metin olarak; örneğin `© OpenStreetMap contributors`. Boş bırakılırsa döşeme sunucusunun alan adı gösterilir.

Döşeme sunucusunun alan adı, yalnızca o alan adı, eklentinin çerçevesinin yükleyebileceği görsellere eklenir. Kimlik bilgisi içeren bir adres ya da alışılmadık bir alan adı reddedilir.

## Sınırlar

- Geçerli sorgunun en fazla ilk 1.000 belgesi, `_id` sırasıyla, uygulamanın 1 MB'lık mesaj sınırına sığan sayfalar hâlinde okunur. Daha fazlası varsa özet "ilk 1.000 belgeden" der; diğerlerini görmek için Belgeler filtresini daraltın.
- Bir belgeden en fazla 50 şekil alınır.
- 10.000'den fazla köşesi olan bir şekil seyreltilerek çizilir (her n'inci nokta ve uçlar korunur); çok parçalı bir şeklin en fazla 1.000 parçası çizilir.
- Şekiller listesi ilk 200 satırını gösterir.
- Yakınlaştırma 19. düzeye kadar gider; tek bir noktanın sokak düzeyinde çizilmemesi için sığdırma 15. düzeyde durur.
- Harita Web Mercator izdüşümünü kullanır: kuzeyde ya da güneyde yaklaşık 85 dereceden ötedeki enlemler kenarda çizilir.
