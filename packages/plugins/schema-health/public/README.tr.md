# Şema sağlığı

Şema sağlığı, bir koleksiyonu MongoDB belgelerinde tanımlanan şema hatalarına (anti-pattern) karşı denetler: fazla büyüyen belgeler ve diziler, derin iç içelik, çok sayıda alanı olan belgeler, birden fazla tip taşıyan alanlar ve sayıca fazla, kullanılmayan ya da gereksiz indeksler. Her bulgu neyin bulunduğunu, neden önemli olduğunu ve ne yapılması gerektiğini söyler.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez: öneride bulunur, kararı siz verirsiniz.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Sağlık** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Sağlık** sekmesine geçin. Denetim sekme açılır açılmaz çalışır; **Denetle** onu yeniden çalıştırır, örneğin veriyi ya da indeksleri değiştirdikten sonra.

Okuma, her biri çalışırken gösterilen üç adımda yapılır:

1. diziler, iç içelik, alan sayıları ve tipler için en fazla 1.000 belgelik rastgele bir örnek;
2. sunucunun ölçtüğü, en fazla 10.000 rastgele belgenin boyutu;
3. koleksiyonun indeksleri ve kullanım sayaçları.

Bulgular önem derecesine göre listelenir: önce **Yüksek risk**, sonra **Uyarı**, sonra **Bilgi**. Her biri ilgili alanı ya da indeksi, neyin bulunduğunu, neden önemli olduğunu ve ne yapılması gerektiğini belirtir. Bir filtre, bir bulgunun ilgili olduğu belgeleri tam olarak seçebiliyorsa, **Belgelerde göster** bu filtreyi Belgeler sorgusuna koyar.

Sekmede tıklayınca açılan **Neler denetlenir** bölümü, kullanılan eşikleri MongoDB'nin kendi sınırlarıyla yan yana listeler.

## Denetimler

- **Büyük belgeler:** 1 MB üstü uyarı, 8 MB üstü yüksek risktir. MongoDB 16 MB üstü belgeleri reddeder.
- **Büyük dizi:** örneklenen bir belgede 1.000'den fazla öğeli bir dizi uyarı, 10.000'den fazlası yüksek risktir. Bu tür en fazla 10 dizi listelenir.
- **Derin iç içelik:** 20 düzeyden daha derin iç içe belgeler (MongoDB'nin sınırı 100'dür).
- **Çok fazla alanlı belgeler:** 200'den fazla alanı olan örneklenmiş bir belge.
- **Karışık tipler:** örnek genelinde, null dışında birden fazla tip taşıyan bir alan (örneğin belgelerin çoğunda sayı, bazılarında metin). Bu tür en fazla 20 alan listelenir.
- **Çok fazla indeks:** koleksiyonda 20'den fazla indeks (MongoDB 64'e izin verir).
- **Kullanılmayan indeks:** sunucunun saymaya başladığı andan (son yeniden başlatmadan) beri hiç kullanıldığını saymadığı bir indeks. `_id` indeksi, unique indeksler ve TTL indeksleri asla kullanılmayan olarak bildirilmez: bunlar sorgu olmadan da iş görür.
- **Gereksiz indeks:** anahtarları, aynı ya da ters yönde, başka bir indeksin anahtarlarının başı olan bir indeks; diğer indeks onun sorgularına hizmet edebilir. Onu kapsayan indeks olarak yalnızca aynı collation'a sahip, ne sparse ne partial olan görünür bir indeks sayılır.

## Örnek

Bir `orders` koleksiyonunda denetim şunları bildirebilir:

```
Yüksek risk   Büyük dizi         items: örneklenen bir belgede 12.400 öğeye kadar.
Bilgi         Karışık tipler     total: örnekte 981 belgede number, 19 belgede string.
Bilgi         Gereksiz indeks    customerId_1: anahtarları, customerId_1_createdAt_-1 indeksinin anahtarlarının başı.
```

Karışık tipler bulgusundaki **Belgelerde göster**, Belgeler'e `{ "total": { "$type": "string" } }` filtresini koyar; böylece 19 aykırı belge düzeltilebilir.

## Görünümlerde

Bir görünümün kendi indeksleri yoktur. Eklenti bir görünümde hiçbir indeks okumaz ve indeksler hakkında bir şey söylemez; örnek ve belge boyutları bir koleksiyondaki gibi denetlenir.

## İzinler

- **Belgeleri okuma** (`documents:read`): örneği okumak ve belge boyutlarını ölçmek için; ikisi de salt okunur aggregation pipeline'larıyla yapılır.
- **Bu koleksiyonun indekslerini okuma** (`collection:read`): indeksleri, seçeneklerini ve kullanım sayaçlarını listelemek için.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Diziler, iç içelik, alan sayıları ve tipler 1.000 belgelik rastgele bir örneğe göre değerlendirilir; nadir bir sorun örnekte yer almayabilir. Başka bir örnek için denetimi yeniden çalıştırın.
- Boyutlar 10.000 belgelik rastgele bir örnek üzerinde ölçülür. Ölçüm için MongoDB 4.4 ya da sonrası gerekir (`$bsonSize`); daha eski bir sunucuda diğer denetimler yine çalışır ve sekme boyutların ölçülemediğini söyler.
- Büyük belgeler iki örneği de küçültür: örnek, uygulamanın sayfaya verdiği tek bir yanıta (yaklaşık 1 MB) sığan belgeleri alır; boyutlar için MongoDB disk kullanmadan izin verdiğinden fazla bellek isterse 1.000, sonra 100 belgelik bir örnek ölçülür. Durum satırı gerçekte kaç belgenin örneklendiğini ve ölçüldüğünü söyler. Tek bir belge bile bir yanıta sığmazsa ölçülen boyutlar yine gösterilir ve sekme belgelerin örneklenemediğini söyler.
- Kullanım sayaçları sunucu yeniden başlayınca sıfırlanır ve bir replica set'in her üyesi kendi sayımını tutar. Yalnızca başka bir üyede ya da yalnızca bir yeniden başlatmadan önce kullanılmış bir indeks, kullanılmayan olarak bildirilebilir. Bir indeksi silmeden önce gizleyin ve yavaş sorguları izleyin.
- Her pipeline en fazla 10 saniye, disk kullanmadan çalışır.
- Eşikler bu eklentinin kendi varsayılanlarıdır, ayar değildir; MongoDB, Atlas'ın kullandığı eşikleri yayımlamıyor.
