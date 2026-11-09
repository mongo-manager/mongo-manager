# SQL → MongoDB

SQL → MongoDB, bir SQL SELECT sorgusunu aynı işi yapan MongoDB sorgusuna çevirir; uygun düştüğü yerde bir `find`, diğer durumlarda bir aggregation pipeline. Sonucu mongosh kodu olarak ve her resmi sürücü için bir program olarak gösterir. Bir koleksiyonun SQL sekmesinde sorguyu salt okunur olarak çalıştırır ve satırları da gösterir.

Bir sorguyu çalıştırmak veriyi asla değiştirmez: bu eklenti hiçbir şey yazmaz.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **SQL** sekmesi.

## Nasıl kullanılır

1. Bir koleksiyon açın, ardından **SQL** sekmesine geçin. **Örnekler**, düzenleyiciyi bu koleksiyonun kendi alanlarıyla yazılmış sorgularla doldurur.
2. Düzenleyiciye bir SELECT yazın. Yazdıkça öneriler çıkar: anahtar sözcükler, koleksiyonun alanları (iç içe yollar da), `=` sonrasında ya da `IN (…)` içinde bir alanın taşıdığı değerler, fonksiyonlar ve FROM ya da JOIN sonrasında koleksiyonun adı. Enter vurgulanan öneriyi alır; Tab da, bir kısmını yazdıktan ya da öneriye geçtikten sonra aynısını yapar.
3. MongoDB kodu yazdıkça güncellenir. **Kod dili**, dili seçer: mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby ya da Rust. **Kodu kopyala** kodu kopyalar.
4. **Çalıştır** (Ctrl+Enter, Mac'te Cmd+Enter) sorguyu burada salt okunur çalıştırır ve **Sonuçlar** altında en fazla 50 satır gösterir. Bir satırdaki **Aç**, o belgeyi uygulamada gösterir. **Temizle** sonuçları boşaltır.
5. **Biçimlendir** (Shift+Alt+F) SQL'i düzenler: her satırda bir yan tümce, anahtar sözcükler büyük harfle. Sorgunun anlamını asla değiştirmez.
6. **Belgelerde kullan**, filtreyi, projeksiyonu ve sıralamayı koleksiyonun Belgeler sekmesine koyar; **Aggregation'da aç**, pipeline'ı Aggregation sekmesine koyar. Siz istemedikçe orada hiçbir şey çalışmaz.

Bir hata kendi satırında işaretlenir ve mesaj satırını ve sütununu belirtir; **Düzenleyicide göster** imleci oraya taşır.

## Örnek

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

şuna dönüşür:

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

Gruplanmış bir sorgu bir pipeline'a dönüşür:

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOIN'ler

Aynı veritabanındaki başka bir koleksiyonla tek bir INNER ya da LEFT JOIN, `$lookup` olarak çevrilir ve Çalıştır onu burada çalıştırır:

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

Sonuç sütunlarının başlıkları SELECT'te yazıldığı gibidir (`o.orderNo`, `c.name` ya da bir AS adı). Birleştirilen bir sütunun başlığının yanındaki küçük bir işaret, değerin geldiği koleksiyon alanını belirtir, örneğin `customers.name`. Birleştirilen koleksiyon da diğer her okuma gibi kullanıcının yetkileri ve alan maskelemesiyle okunur.

## Hangi SQL anlaşılır

- sütunlar, `*`, takma adlar (AS) ve DISTINCT ile SELECT
- `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT ile WHERE
- COUNT, SUM, AVG, MIN, MAX ile GROUP BY ve HAVING
- ORDER BY (ASC, DESC), LIMIT ve OFFSET
- bir alanın başka bir alana eşit olduğu tek bir INNER ya da LEFT JOIN … ON
- yorumlar, tırnak içindeki adlar ve çift tırnaklı değerler (MySQL'in okuduğu gibi metin olarak okunur)

Bunların dışındaki her şey neyin ve nerede olduğunu söyleyen bir mesajla reddedilir: CASE, alt sorgular, `COUNT(DISTINCT …)`, LIKE … ESCAPE, birden fazla JOIN, SELECT dışındaki ifadeler ve NULL ile karşılaştırmalar (onun yerine IS NULL yazın).

Bazı SQL kuralları bilerek korunur: `<>` ve NOT IN, SQL'de olduğu gibi alanın null ya da eksik olduğu belgeleri dışarıda bırakır; 9007199254740991'den büyük bir tam sayı yuvarlanmak yerine reddedilir.

## SQL dosyalarını içe ve dışa aktarma

SQL dökümü içe aktarma ve koleksiyonları SQL olarak dışa aktarma uygulamanın kendi işidir: kenar çubuğundaki **SQL ↔ MongoDB**, hangi bağlantı ve veritabanında çalıştığını gösteren bir sayfadır. Bu eklenti içe ya da dışa aktarma yapmaz.

## İzinler

- **Belgeleri okuma** (`documents:read`): sorguyu açık koleksiyonda çalıştırmak, öneriler ve örnekler için koleksiyondan bir örnek okumak için.
- **Aynı veritabanındaki diğer koleksiyonları okuma** (`database:read`): adını verdiği koleksiyonu okuyan bir JOIN çalıştırmak için. JOIN olmadan başka hiçbir koleksiyon okunmaz.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır.

## Ayarlar

Yok.

## Sınırlar

- Çalıştır en fazla 50 satır gösterir. Daha büyük bir LIMIT ya da LIMIT'siz bir sorgu ilk 50 satırı gösterir ve daha fazlasının eşleştiğini söyler.
- Çalıştır yalnızca burada açık olan koleksiyonu (ve bir JOIN'in adını verdiği koleksiyonu) okur. FROM'u başka bir koleksiyonu gösteren bir sorgu çevrilir ama çalıştırılmaz; çalıştırmak için o koleksiyonu açın.
- Belgelerde kullan, LIMIT ve OFFSET'i yalnızca kodda tutar: Belgeler sonuçlarını kendisi sayfalar.
- Alan ve değer önerileri koleksiyonun ilk 100 belgesinden gelir, alan başına en fazla 20 değer.
- Büyük belgelerde (örneğin API günlükleri) yalnızca sayfaya giden tek bir yanıtın (1 MB) alabileceği kadarı okunur: Çalıştır daha az satır gösterir ve daha fazlasının eşleştiğini söyler; öneriler de daha az belgeden gelir.
- Sorgu başına tek JOIN, düz bir `$lookup` olarak (localField ve foreignField). Bir JOIN asla bir sistem koleksiyonunu okumaz.
- Pipeline olarak çalışan bir sorgu (gruplanmış ya da birleştirilmiş) en fazla 10 saniye sürer ve disk kullanmaz. Çalıştırmalar asla kullanıcının son sorgularına eklenmez.
