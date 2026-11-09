# Yinelenen kayıt bulucu

Yinelenen kayıt bulucu, bir koleksiyonda benzersiz olması gereken alanlarda birden fazla belgenin paylaştığı değerleri listeler: bir e-posta adresi, bir sipariş numarası, bir ad ve soyad birlikte. Her değerin yanında onu kaç belgenin paylaştığı yazar, en çok paylaşılan başta gelir; belgelerin kendisi bir tık uzaktadır.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Yinelenenler** sekmesi.

## Nasıl kullanılır

1. Bir koleksiyon açın, ardından **Yinelenenler** sekmesine geçin.
2. **Benzersiz olması gereken alanlar** altında bir alan adı yazıp Enter'a basın ya da **Bu koleksiyonda** altında önerilen alanlardan birine tıklayın. İç içe bir alan için yolunu yazın: `address.city`. Virgülle ayrılarak bir kerede yazılan birden fazla alan birlikte eklenir.
3. Birlikte denetlemek için en fazla beş alan ekleyin: belgeler ancak bu alanların hepsi aynı olduğunda yinelenen sayılır.
4. Aşağıda anlatılan seçenekleri ayarlayın, ardından **Yinelenenleri bul** düğmesine basın.

Seçenekler:

- **Büyük/küçük harfi yok say:** `Ada@Example.com` ile `ada@example.com` aynı değer sayılır. Varsayılan olarak kapalıdır.
- **Alanı olmayan belgeleri dışarıda bırak:** seçilen bir alanı eksik ya da null olan belgeler gruplanmaz. Varsayılan olarak açıktır; alanı taşımayan kaç belge olduğunu görmek için kapatın.
- **Nerede aransın:** **Tüm koleksiyon** (varsayılan) ya da yalnızca **Belgeler filtresi** içindeki belgeler.

Sonuç, kaç yinelenen değer bulunduğunu ve kaç belgenin ilgili olduğunu söyler. Her satır bir değeri ve sayısını gösterir:

- **Belgeleri listele** satırı açar ve belgelerinin ilk 20'sini gösterir; **Aç** bunlardan birini uygulamada gösterir.
- **Göster** (ya da **Hepsini Belgelerde göster**), o değerin belgelerini seçen bir filtreyi Belgeler sorgusuna koyar; orada hepsi sayfa sayfa gezilebilir.

## Örnek

`email` alanının benzersiz olması gereken bir `users` koleksiyonu. `email` alanını seçin, **Büyük/küçük harfi yok say** seçeneğini açın ve **Yinelenenleri bul** düğmesine basın. Şöyle bir satır:

```
ada@example.com     3 belge
```

üç kullanıcının bu adresi bir yazımıyla paylaştığı anlamına gelir. **Göster**, bu üç belgeyi seçen bir filtreyi Belgeler'e koyar; hangisini tutacağınıza orada karar verebilirsiniz.

İki kez girilmiş kişileri bulmak için `firstName` ve `lastName` alanlarını birlikte seçin: yalnızca iki alanı da eşleşen belgeler gruplanır.

## Nasıl çalışır

Gruplama sunucuda, salt okunur tek bir aggregation pipeline olarak çalışır: filtre için (ve dışarıda bırakılıyorsa eksik alanlar için) bir `$match`, seçilen alanlar üzerinde bir `$group`, ardından birden fazla belgesi olan gruplar, sayıya göre sıralı. Tarayıcıya yalnızca gruplar döner, koleksiyonun tamamı asla.

Büyük/küçük harf yok sayıldığında metin değerleri küçük harfe çevrilerek (`$toLower`) karşılaştırılır; diğer tipler olduğu gibi karşılaştırılır.

## İzinler

- **Belgeleri okuma** (`documents:read`): gruplama pipeline'ını çalıştırmak, alan önerileri için birkaç belge okumak ve bir grubun belgelerini listelemek için.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Aynı anda en fazla 5 alan.
- En fazla 200 yinelenen değer listelenir, en çok paylaşılan başta. Daha fazlası varsa sayı "200+" olarak görünür ve bir not yalnızca en çok paylaşılan 200 değerin listelendiğini söyler.
- Bir grup ilk 20 belgesini listeler; Göster hepsini Belgeler'e koyar.
- Önerilen alanlar koleksiyonun ilk 50 belgesinden gelir (en fazla 12 öneri); başka herhangi bir alan yazılabilir.
- Büyük belgelerde (örneğin API günlükleri) yalnızca sayfaya giden tek bir yanıtın (1 MB) alabileceği kadarı okunur: öneriler daha az belgeden gelir, daha az uzun değer listelenir (bir not bunu söyler) ve bir grup sığan ilk belgelerle açılır.
- Değerler, yok sayıldığında büyük/küçük harf dışında, tam olarak saklandıkları gibi karşılaştırılır. Metin olarak saklanmış bir sayı ile sayı olarak saklanmış aynı sayı farklı değerlerdir.
- Pipeline en fazla 10 saniye, disk kullanmadan çalışır. Çok büyük bir koleksiyonda Belgeler filtresiyle daraltın.
