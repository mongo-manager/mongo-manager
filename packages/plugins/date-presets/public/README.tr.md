# Tarih filtreleri

Tarih filtreleri, insanların filtrelediği tarih aralıklarını — bugün, son 7 gün, bu ay — tek tıkla Belgeler sorgusuna koyar; böylece `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }` elle yazılmak zorunda kalmaz.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez: Belgeler sorgusuna bir filtre yazar; o da yazdığınız herhangi bir sorgu gibi çalışır.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun ve görünümün Belgeler, Aggregation ve diğer sekmelerinin yanında bir **Tarihler** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Tarihler** sekmesini. Eklenti tarih taşıyan alanları bulmak için rastgele 200 belge okur ve en sık olanı seçer; **Alan** diğerlerini sunar, herhangi bir alan da yazılabilir.

Bir aralık seçin:

- **Hızlı aralıklar:** Bugün, Dün, Son 24 saat, Son 7 gün, Son 30 gün, Bu hafta, Geçen hafta, Bu ay, Geçen ay, Bu yıl. Her biri kapsadığı günleri gösterir.
- **Son:** son n saat (şu ana kadar), bugünün sonuna kadar son n gün ya da hafta (her biri 7 gün), ya da son n ay — içinde bulunulan dahil, bütün takvim ayları.
- **İki gün arası:** bir günün başından bir başka günün sonuna kadar.

Bir tıklama, aralığı alanda seçen bir filtreyi Belgeler sorgusuna koyar ve sorgu çalışır.

**Gün başlangıcı**, günlerin tarayıcının saatinde mi yoksa UTC'de mi gece yarısı başladığını söyler. Haftalar pazartesi başlar (ISO 8601).

## _id üzerinde

`_id` ObjectId taşıyorsa o da sunulur: bir ObjectId oluşturulduğu saniyeyle başlar; bu yüzden `_id` üzerindeki bir aralık, içinde oluşturulan belgeleri seçer — tarih alanı olmayan bir koleksiyonda bile. `_id` indeksini de kullanır.

## Örnek

28 Ekim 2026 Çarşamba günü, `createdAt` üzerinde **Bu hafta** Belgeler'e şunu koyar:

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(UTC'de; tarayıcının saatinde, aynı günler onun gece yarılarından).

## İzinler

- **Belgeleri okuma** (`documents:read`): tarih alanlarını bulan örneği okumak ve Belgeler sorgusuna bir filtre koymak için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır: gizlenen bir değer eklentinin görebileceği bir tarih değildir. Eklenti diğer koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Tarih alanları rastgele 200 belgelik bir örnekte bulunur; nadir biri sunulmayabilir ama yazılabilir.
- Büyük belgelerde (örneğin API günlükleri) örnek, sayfaya giden tek bir yanıta (1 MB) sığacak kadar belgeyle sınırlıdır.
- Bir aralık her belge için aynıdır: metin olarak ya da saniye sayısı olarak saklanmış bir tarih onun için tarih değildir.
- Aralıklar düğmeye tıklandığı anınkilerdir.
