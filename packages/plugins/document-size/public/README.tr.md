# Belge boyutu

Belge boyutu, bir koleksiyonun belgelerinin ne kadar büyük olduğunu ve baytlarının nereye gittiğini söyler: her boyut aralığına kaç belgenin düştüğünü, en büyüklerinin hangileri olduğunu, en büyüğün MongoDB'nin 16 MB sınırına ne kadar yakın olduğunu ve her alanın baytlardaki payını — alan alan, bir nesne alanının içine de girerek. Belgeleri büyüten alanı, büyümeyi sürdüren bir diziyi ya da değerlerinden çok yer kaplayan alan adlarını bulmak için kullanın.

Eklenti yalnızca okur. Sunucuda, salt okunur tek bir pipeline ile ölçer (MongoDB'nin belleği ilkini durdurursa ikinci bir pipeline ile, bkz. Sınırlar): sayfaya yalnızca boyutlar, alanların adları, türleri ve dizilerin uzunlukları ile en büyük belgelerin `_id` değerleri gelir, asla bir belge gelmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun Belgeler, Aggregation ve diğer sekmelerinin yanında bir **Belge boyutu** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Belge boyutu** sekmesine geçin. Sekme açılır açılmaz rastgele 1.000 belgeyi ölçer. Her belgeyi ölçmek için **Tümü**'nü seçin (büyük bir koleksiyon bir okumanın süresinden uzun sürebilir: sekme o zaman bir örneklem ölçmeyi söyler); **Yeniden ölç** yeni bir örneklem çeker. Ölçülen, sekme açık kaldıkça tutulur — bir alanın içine girip geri dönmek ya da **Tümü**'ne geçip dönmek aynı sayıları gösterir — ta ki **Yeniden ölç**'e kadar.

- **Boyutlar:** kaç belgenin 1 KB'ın altında, 1 ile 4 KB arasında olduğu ve böylece 16 MB'a kadar.
- **Baytlar nereye gidiyor:** her alan, en çok yer kaplayan en başta — türü (yanında bir dizinin ortalama öğe sayısı), belgelerin baytlarındaki payı, ortalama ve en büyük boyutu, kaç belgede olduğu ve adının (türünün baytıyla) her belgede kapladığı yer. Bir alanın baytları belgesinde kapladığı yerdir: türü, adı ve değeri.
- **En büyük belgeler:** en büyük on belge; her biri 16 MB sınırındaki payıyla ve onu Belgeler'de görmek için **Aç** ile (bir görünümün `_id`'si olmayan belgesi için yok).

Bir nesne alanının adı bir düğmedir: o nesnenin kendi alanlarını, nesne olduğu (nesne dizisi olmadığı) belgelerde ölçer; özetin üstündeki yol geri götürür, en fazla sekiz düzey derine. Orada 16 MB'daki pay gösterilmez: bir nesnenin boyutu onun hakkında bir şey söylemez. En büyük belge 16 MB sınırının yarısını aşınca sekme uyarır, çünkü bir belge onun ötesine büyüyemez; alan adları baytların beşte birini ya da daha fazlasını kaplıyorsa (listelenmeyenler dahil hepsi sayılır) bunu söyler, çünkü daha kısa adlar her belgeyi küçültür.

## Örnek

Bir `orders` koleksiyonunda, rastgele 1.000 belge:

```
1.000 belge · ortalama 15 KB · en büyüğü 9 MB · toplam 14,6 MB

En büyük belge 9 MB: MongoDB’nin 16 MB sınırının %56,3 kadarı

Alan                          Tür                Pay     Ortalama  En büyük  Bulunma oranı  Adı
items                         array ≈ 12,5 öğe   %78,1   11,7 KB   8,6 MB    %100           her biri 7 B
address                       object             %3,9    606 B     900 B     %99            her biri 9 B
customerReferenceIdentifier   string             %2,6    400 B     400 B     %100           her biri 29 B
```

## Kişisel veriler

Bir koleksiyonda kişisel veriler sizden gizleniyorsa belgelerinin boyutları gizli değerlerin uzunluğunu ele verirdi: sunucu orada hiçbir şey ölçmez; bu yüzden sekme hiçbir şey sormaz ve bunu söyler.

## İzinler

- **Belgeleri okuma** (`documents:read`): ölçüm pipeline'ını koleksiyonda çalıştırmak ve bir belgeyi açmak için.

Okumalar oturum açmış kullanıcının haklarıyla uygulama üzerinden yapılır.

## Ayarlar

Yok.

## Sınırlar

- Bir örneklem: tüm belgelerin en büyükleri onun içinde olmayabilir; **Tümü** her belgeyi okur. Büyük belgelerden oluşan bir koleksiyonda örneklem boyutlar ölçüldükten sonra çekilir; böylece MongoDB yalnızca onları sıralar.
- En çok yer kaplayan 50 alan listelenir; bir nesne dizisinin içindeki alan diziyle birlikte ölçülür.
- Nokta içeren ya da `$` ile başlayan bir anahtar listelenir ama içine girilmez.
- Her ölçüm, disk kullanmadan en fazla 10 saniyelik tek bir pipeline'dır: çok sayıda farklı alan adı taşıyan (anahtarları değer gibi kullanan) belgeler **Tümü** ile MongoDB'nin belleğini aşabilir; bir örneklem onları ölçer.
