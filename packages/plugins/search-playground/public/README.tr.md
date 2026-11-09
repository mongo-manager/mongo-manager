# Arama alanı

Atlas Search ve Vector Search, normal bir indeksin yanıtlayamadığı sorguları yanıtlar: yazım hatalı sözcükler, uygunluk skorları, vurgulanmış eşleşmeler, gömme vektörleri bir sorgununkine yakın belgeler. Bir indeksin ne verdiğini görmek için `$search` ya da `$vectorSearch` aşamasını elle yazmak zaman alır; Atlas'ın Search Tester'ı ve Compass'ın arama indeksi görünümü bir indeksi birkaç tıklamayla denemeni sağlar. Arama alanı bir koleksiyonun arama indeksleri için aynısını yapar.

## Nasıl kullanılır

Bir koleksiyonu ve onun **Arama** sekmesini aç. Sekme koleksiyonun arama indekslerini türleri (tam metin ya da vektör) ve durumlarıyla listeler; henüz sorgulanamayan bir indeks (oluşturuluyor, başarısız) işaretlenir ve çalıştırılamaz.

### Tam metin

- **Aranan**: sözcükler.
- **Nerede**: indeksin eşlediği metin alanlarından biri ya da **Tüm alanlar** (dinamik bir indeksin her alanı, değilse eşlediği her metin alanı).
- **İzin verilen yazım hatası**: yok, bir harf ya da iki harf (`fuzzy`).
- **Vurgular**: eşleşen bölümler, eşleşen sözcükler işaretli.
- **Sonuç**: 1 ile 100 arası.

### Vektör

- **Vektör alanı**: indeksin vektör alanlarından biri, boyutlarıyla.
- **Vektör**: yapıştırılan bir sorgu vektörü (`[0.1, 0.2, …]` ya da virgül veya boşlukla ayrılmış sayılar) ya da **Bir belgeye benzer**: koleksiyonun ilk 20 belgesinden biri; kendi vektörü benzerlerini bulur — bir sayı listesi ya da float32 veya int8 değerlerden oluşan bir BSON vektörü (binary alt türü 9). Vektörün boyutları indeksinkiyle aynı olmalıdır.
- **Aday**: MongoDB'nin göz önüne aldığı en yakın komşu sayısı (en az sonuç kadar, en fazla 10.000).
- **Filtre**: indeksin filtre alanlarında bir JSON nesnesi, örneğin `{ "year": { "$gte": 2000 } }`.

**Ara** boru hattını çalıştırır; her sonuç skorunu, vurgularını ve alanlarını gösterir. **Aggregations'da kullan** boru hattını Aggregations düzenleyicisine verir; orada aşama ekleyip kaydedebilirsin.

## Neye ihtiyaç duyar

Arama indeksleri Atlas'ta ve MongoDB Search (`mongot`) kurulu, MongoDB belgelerinin onun için listelediği bir sürümdeki kendi MongoDB sunucunuzda vardır. Arama etkin değilse ya da koleksiyonda arama indeksi yoksa sekme bunu söyler; koleksiyonun İndeksler sayfasında bir tane oluştur.

## Güvenlik

Uygulama boru hattını senin adına, salt okunur, arama aşaması ilk sırada olacak biçimde çalıştırır; yazan, başka bir koleksiyonu birleştiren ya da kod çalıştıran hiçbir şey yoktur. Vurgular işaretleme olarak değil, metin olarak gösterilir. Kişisel veri olarak senden gizlenen alanlar sunulmaz; kişisel verilerin gizlendiği bir kullanıcıya kuralların uzandığı yerde arama reddedilir (bulduklarından gizli değerleri söyleyebilirdi): sekme bunu aramadan önce söyler.

## İzinler

- **Belgeleri oku:** arama sonuçları ve bir vektörün alındığı belgeler.
- **Koleksiyon ayrıntılarını oku:** koleksiyonun arama indeksleri — adları, durumları ve eşledikleri alanlar, gizli olanlar asla.
