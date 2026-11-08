# Yeniden şekillendir

Bir uygulama büyüdükçe koleksiyonun şekli değişir: `fullName`, `name.full` olur; bir `address` nesnesi bir rapor için düz sütunlara dönüşür; metin olarak saklanan bir fiyatın sayı olması gerekir. Yeniden şekillendir bu değişiklikleri adımlar olarak kurar, sizin belgelerinizde gösterir ve onları bir boru hattı olarak Aggregations'a verir — bir taşıma betiği olmadan ve koleksiyona dokunmadan. Studio 3T ("Reschema") ve NoSQLBooster ("Collection re-schema tool") da aynısını sunar.

## Nasıl kullanılır

1. Bir koleksiyonu ve onun **Yeniden şekillendir** sekmesini açın. Alanları bilmek için 50 belgelik bir örnek okur.
2. **Adımları** sırayla ekleyin:
   - **Yeniden adlandır ya da taşı:** yeni bir ad; `a.b` alanı bir nesnenin içine taşır.
   - **Bir nesneyi düzleştir:** `address.city`, `address_city` olur (ayırıcıyı siz seçersiniz; `.` ya da `$` içeremez). Nesneden yalnızca taşınan anahtarlar çıkar: örneklemin görmediği bir anahtar nesnede kalır, nesne olmayan bir değer olduğu gibi kalır, taşıma sonucu boş kalan bir nesne kaldırılır (önceden boş olan kalır).
   - **Bir nesneye yerleştir:** listesinde işaretlenen alanlar yeni bir alanın altında toplanır (`lat`, `lng` → `location`) ve orada ne varsa onun yerini alır; aynı adla biten iki alan reddedilir, çünkü biri kaybolur; bir alan ve onun içindeki bir alan da reddedilir.
   - **Türünü dönüştür:** int, long, double, decimal, string, date, bool ya da ObjectId'ye; dönüştürülemeyen bir değer null olur ya da olduğu gibi kalır. Olmayan bir alan yine olmaz, null yine null kalır.
   - **Yoksa varsayılan değer** (ya da **yoksa ya da null ise**): olmayan bir alana ya da olmayan veya null olan bir alana bir değer — seçim sizin; adım da buna göre adlanır.
   - **Kaldır**, **Metni listeye böl**, **Listeyi metne birleştir** (nesne gibi metne çevrilemeyen bir öğe boş olarak birleşir).
3. **Önizleme**, düzenlemeyi bıraktığınızda MongoDB'nin kendisi tarafından çalıştırılarak aynı beş örnek belgeyi önce ve sonra gösterir. Var olan bir alanın üzerine yazan bir adım bunu söyler, bir belge listesinin içine yazan bir adım değerin her belgede ayarlanacağını söyler; sorunlu bir adım sorununu söyler ve aşamalara alınmaz; adları henüz verilmemiş bir adım tamamlanmamış sayılır ve tamamlanana kadar alınmaz.
4. En fazla 48 aşama önizlenir ve verilir; bunun ötesinde önizleme, Sonra'yı neden göstermediğini söyler.
5. **Aggregations'ta kullan** aşamaları verir (uygulama önce size sorar). Sonucu yazmak için orada yeni bir koleksiyonu adlandıran bir `$out` aşaması ekleyin: Aggregations yazmanın ne yapacağını gösterir ve çalışmadan önce size sorar. **Aşamaları kopyala** onları panoya koyar.

## Asla yapmadıkları

- Koleksiyonu asla değiştirmez: yalnızca okuyan `$set` ve `$unset` aşamaları kurar; kendisi asla bir `$out` ya da `$merge` kurmaz.
- `_id` asla yeniden adlandırılmaz, taşınmaz ya da kaldırılmaz. Kişisel veri olarak sizden gizlenen alanlar ve onları tutan nesneler sunulmaz; birini — yazdığınız bir adla da — okuyacak, taşıyacak, üzerine yazacak ya da kaldıracak bir adım reddedilir. Örneklemin yalnızca değer olarak gördüğü bir alan, bir kural altındaki bir alanı kendi adıyla adlandırıyorsa (`profile.ssn`) geri tutulur; bir kural ona yalnızca `*` ile ulaşıyorsa (`*.ssn`) tutulmaz, yoksa hiçbir alan kalmazdı. Uygulama hangi alanların gizlendiğini zamanında anlayamazsa, **Yeniden dene** bunu öğrenene kadar hiçbir alan sunulmaz.
- Bir alanın alamayacağı bir ad (boş, `$` içeren, `a..b`) reddedilir; kendi içine taşınan bir alan da.
- Bir varsayılan değer ya da ayırıcı her zaman bir değerdir; asla bir alan ya da işleç olarak okunmaz.

## İzinler

- **Belgeleri okuma:** alanları bilmek için bir örnek ve önizlemenin belgeleri; sizin yetkilerinizle, gizli alanlarınız gizli kalarak.
