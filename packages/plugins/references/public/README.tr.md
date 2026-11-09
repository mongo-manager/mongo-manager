# Referanslar

Referanslar, bir veritabanındaki belgelerin ObjectId'ler aracılığıyla birbirine nasıl işaret ettiğini gösterir. Belgeler'de, `customerId` gibi bir kimliğin yanına başvurulan belgenin adını yazar; böylece bir satır bir dizi onaltılık rakam yerine "customer: Ada Lovelace" diye okunur. Sekmesi ise bir koleksiyonun hangi alanlarının başka belgelerin kimliklerini tuttuğunu, o belgelerin hangi koleksiyonlarda bulunduğunu ve hangi kimliklerin hiçbir şeye işaret etmediğini bulur.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Hücre değerleri:** Belgeler'de bir ObjectId'nin yanında bir ok ve başvurulan belgenin adı (`→ Ada Lovelace`); o kimliğe sahip bir belge yoksa `→ bulunamadı`.
- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Referanslar** sekmesi.
- **Belge eylemi:** bir belgenin eylemlerinde **Başvuranlar**, veritabanında ona başvuran belgeleri listeler.

## Kimliklerin yanındaki adlar

Bir hücre, alanı aynı veritabanındaki bir koleksiyon gibi adlandırılmışsa (tekil ya da çoğul, sonunda id eki olsun ya da olmasın) bir ad alır:

- `customerId`, `customer_id` ya da `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

Eklenti, sayfada gösterilen kimlikleri o koleksiyonda `_id` ile arar ve bulduklarının yalnızca adlandırma alanlarını okur. Ad, belgenin taşıdığı `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` ve `slug` alanlarından ilkidir; hiçbiri yoksa `_id` değeri gösterilir. Kimlikleri kendisine benzer adlı hiçbir koleksiyonda bulunmayan bir alan hiç metin almaz.

Uyarı olarak gösterilen `→ bulunamadı`, boşa düşen bir referansı işaretler: alan bir koleksiyona işaret ediyor, ama o koleksiyonda bu kimliğe sahip bir belge yok.

## Referanslar sekmesi

Bir koleksiyon açın, ardından **Referanslar** sekmesine geçin. Sekme açılır açılmaz aramaya başlar; **Referansları bul** yeniden arar.

1. Rastgele 200 belgelik bir örnek okur ve ObjectId tutan alanları toplar (belgelerin kendi `_id` alanı hariç).
2. Bu kimlikleri veritabanının diğer koleksiyonlarında `_id` ile arar; önce bir alana benzer adlı olanlarda.
3. Bulunan her ilişki için bir kart gösterir: alan, işaret ettiği koleksiyon, örnekteki kimliklerin orada bulunan oranı ve birkaç örnek ad.

Her kartta:

- **$lookup ile aç**, başvurulan belgeleri birleştiren bir `$lookup` aşamasını koleksiyonun Aggregation sekmesine koyar. Siz orada çalıştırana kadar hiçbir şey çalışmaz.
- **Bulunamayanları göster**, hedef koleksiyonda olmayan örnek kimliklerden birini tutan belgeler için Belgeler'e bir filtre koyar.

Hiçbir koleksiyonda bulunmayan ObjectId'leri tutan alanlar ayrıca listelenir.

## Başvuranlar

**Başvuranlar**, açıldığı belgeye başvuran belgeleri arar. Veritabanının modelini okur — Veritabanı sekmesinin çizdiği başvurular; bir alanın adından (`customerId` → `customers`), bu koleksiyonun kimlikleri olan örnek değerlerden ya da bir görünümdeki veya kayıtlı bir pipeline'daki `$lookup`'tan bulunur — ve bu koleksiyonun `_id`'sine başvuran her alanda bu belgenin kimliğini arar; onu taşıyan bir dizi de dahil.

Onu taşıyan her alan bir karttır: koleksiyon ve alan (`orders.customerId`), kaç belge olduğu (en fazla 20'si listelenir, daha fazlaysa "20+") ve adları. **orders içinde göster**, onları seçen bir filtreyi o koleksiyonun kendi sekmesindeki Belgeler sorgusuna koyar. Okunamayan bir alan bunu söyler; diğerleri yine listelenir.

## Örnek

`customers` ve `products` koleksiyonlarının yanında, `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }` biçiminde belgeleri olan bir `orders` koleksiyonu. Sekme iki ilişki gösterir, `customerId → customers` ve `productIds → products`; her birinde bulunan oran yazar (örneğin "Örnekteki 200 kimliğin 196 tanesi bulundu"). İlkinde **$lookup ile aç**, Aggregation'a şu aşamayı koyar:

```json
[
  {
    "$lookup": {
      "from": "customers",
      "localField": "customerId",
      "foreignField": "_id",
      "as": "customerId_ref"
    }
  }
]
```

## İzinler

- **Belgeleri okuma** (`documents:read`): açık koleksiyonun örneğini okumak için.
- **Aynı veritabanındaki diğer koleksiyonları okuma** (`database:read`): veritabanının koleksiyonlarını listelemek ve kimlikleri onlarda aramak için; **Başvuranlar** için veritabanının modelini okumak ve başka bir koleksiyonun Belgeler sorgusuna bir filtre koymak için. Diğer koleksiyonlardan yalnızca `_id` ve yukarıda sayılan adlandırma alanları okunur, belgelerin tamamı asla.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır: kullanıcının okuyamadığı bir koleksiyonu eklenti de okumaz; okuması reddedilen bir hücre 30 saniye sonra yeniden sorulur.

## Ayarlar

Yok.

## Sınırlar

- Yalnızca ObjectId'ler izlenir. Metin, sayı ya da UUID olarak saklanan kimliklere bakılmaz.
- Sekme rastgele 200 belgeden örnek alır; en çok farklı kimlik tutan 8 alanı, alan başına en fazla 20 ve toplamda en fazla 200 kimlikle tutar.
- Veritabanının en fazla 50 koleksiyonuna bakar ve her alan %80 ya da daha yüksek oranda bulununca erken durur. Görünümlere ve `system.` koleksiyonlarına asla bakılmaz.
- Bir ilişki, bir alanın örnekteki kimliklerinin çoğunu tutan koleksiyondur. Kimlikleri birkaç koleksiyona dağılmış bir alan için yalnızca en çoğunu tutan gösterilir.
- **Başvuranlar**, veritabanı modelinin bulduğu başvuruları bulur (model her koleksiyondan örnek alır): örneğinde görünmeyen bir alan sorulmaz. En fazla 20 alan sorulur ve her birinden en fazla 20 belge listelenir. Sorulan her alan, uygulamanın dakikalık okumalarından biridir: bunlar aşılınca kalan alanlar sorulmaz ve bu söylenir.
- Hücrelerde bir alan yalnızca kendisine benzer adlı ilk iki koleksiyonla eşleştirilir; kimlikler 200'er 200'er aranır ve bellekte en fazla 5.000 ad tutulur. Koleksiyon listesi bir dakika sonra yeniden okunur.
- 60 karakterden uzun adlar kısaltılır.
- Alanlar altı düzey derinliğe kadar izlenir.
