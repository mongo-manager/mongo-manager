# Değer arama

Değer arama, bir değeri bir koleksiyonun bütün alanlarında tek seferde arar: bir ad, bir e-posta adresi, bir sipariş numarası, bir ObjectId, bir tarih. Bir değeri bildiğiniz ama hangi alanda tutulduğunu bilmediğiniz durumlar içindir. Bulunan her belge eşleşen alanlarını gösterir ve uygulamada açılabilir.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Ara** sekmesi.

## Nasıl kullanılır

1. Bir koleksiyon açın, ardından **Ara** sekmesine geçin. Sekme, alanlarını öğrenmek için önce koleksiyondan bir örnek okur; boş sayfa kaç alanda aranacağını söyler.
2. Aradığınızı **Aranacak** kutusuna yazın: bir metin, bir sayı, `2026-01-05` gibi bir tarih ya da bir ObjectId.
3. **Nasıl eşleşsin** seçin: **İçerir**, **Tam değer** ya da **Regex**.
4. İsterseniz **Büyük/küçük harfi yok say** seçeneğini ya da metni taşıyan alan adlarını da listelemek için **Alan adlarında da ara** seçeneğini açın.
5. **Nerede aransın** seçin: **Tüm koleksiyon** (varsayılan) ya da **Belgeler filtresi** (Belgeler sekmesindeki sorgu). **Aç**'ın orada bıraktığı, tek belgeyi `_id` ile seçen filtre sunulmaz.
6. **Ara** düğmesine (ya da Enter'a) basın.

Sonuç, bulunan belgeleri her birinin eşleşen alanları ve değerleriyle, eşleşme işaretlenmiş olarak listeler. **Bütün alanlar**, listeyi tek bir alanda eşleşen belgelerle daraltır. **Aç** bir belgeyi uygulamada gösterir; sekmeye döndüğünüzde arama ve sonuçları yerinde durur. **Belgelerde göster** aramayı bir filtre olarak Belgeler sorgusuna koyar; böylece eşleşen bütün belgeler orada sayfa sayfa gezilebilir.

## Her tür terim neyi bulur

- **Metin:** onu içeren (İçerir), ona eşit olan (Tam değer) ya da onunla eşleşen (Regex) metin alanları.
- **Sayı** (`1042` ya da `19.90` gibi): metin eşleşmesinin yanı sıra, saklandığı tip ne olursa olsun (int, long, double ya da decimal) o sayıyı taşıyan alanlar. `1042`, `1042`, `NumberLong(1042)` ve `1042.0` değerlerinin hepsini bulur; `524.66` de decimal `524.66` değerini bulur. **İçerir** ile, rakamları terimi içeren sayılar da bulunur: `524`, `524.66` ve `1524` değerlerini bulur.
- **ObjectId** (24 onaltılık rakam): metin eşleşmesinin yanı sıra, o ObjectId'yi taşıyan alanlar; örneğin belgeye verilen referanslar.
- **Tarih** (`2026-01-05`, `2026-01-05 14:30` ya da `2026-01-05T14:30:15`): metin eşleşmesinin yanı sıra, o gün, dakika ya da saniye içinde kalan tarih alanları, UTC olarak.

**Regex** ile terim, yazıldığı gibi sunucuda çalıştırılan bir düzenli ifadedir; sayı, ObjectId ve tarih eşleşmeleri eklenmez.

## Örnek

Bir `customers` koleksiyonunda `ada@example.com` değerini **İçerir** ve **Büyük/küçük harfi yok say** ile arayın. Sonuç şöyle olabilir:

```
2 belge · 38 alan · tüm koleksiyon
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**Belgelerde göster** ardından Belgeler'e buna benzer bir filtre koyar (aranan her alan için bir koşul):

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## İzinler

- **Belgeleri okuma** (`documents:read`): alanlarını öğrenmek için koleksiyondan bir örnek okumak ve aramayı çalıştırmak için.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Aranan alanlar, rastgele 200 belgelik bir örnekten gelir: en fazla 100 alan yolu, altı düzey derinliğe kadar. Örneklenen belgelerin hiçbirinde bulunmayan bir alanda aranmaz; başka bir örnek için daha sonra yeniden arayın ya da açık bir filtreyle Belgeler'i kullanın.
- En fazla 100 belge listelenir. Daha fazlası eşleşirse sayı "100+" olarak görünür; Belgelerde göster hepsini gösterir.
- Belge başına en fazla 20 eşleşen alan gösterilir.
- Bir düzenli ifade en fazla 200 karakterdir. Onu sunucu çalıştırır ve kendi çalışmasını kendisi sınırlar. Eşleşen alanları sayfa kendisi işaretler; ama sonsuza kadar geri izleme yapabilecek bir kalıpta (`(a+)+` gibi) ya da bir değerin ilk 1.000 karakterinin ötesinde bunu yapmaz; belge yine de listelenir.
- Arama, alan başına bir koşul içeren tek bir sorgudur; uygun indeksleri olmayan büyük bir koleksiyonda her belgeyi okur. En fazla 10 saniye, disk kullanmadan çalışır; zaman aşımına uğrarsa Belgeler filtresiyle daraltın.
- İçerir ve Regex yalnızca metinlerin içindeki metni bulur; bir sayı, tarih ya da ObjectId tüm değeriyle bulunur.
