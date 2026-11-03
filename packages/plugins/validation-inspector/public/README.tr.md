# Doğrulama denetimi

Doğrulama denetimi bir koleksiyonun doğrulama kurallarını parçalarına ayırır ve belgelerini her kurala göre ayrı ayrı denetler: kurallara bir bütün olarak kaç belgenin uymadığını, her zorunlu alanı, her özelliği, her koşulu kaç belgenin bozduğunu söyler. Pek çok belgenin bozduğu bir kural, katı hale getirilmeden önce verisinde ya da kendisinde düzeltilmesi gereken bir kuraldır.

Eklenti yalnızca okur. Veritabanında ve kurallarda hiçbir şeyi değiştirmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun Belgeler, Aggregation ve diğer sekmelerinin yanında bir **Kural denetimi** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Kural denetimi** sekmesini. Sekme açılır açılmaz denetim rastgele 1.000 belge üzerinde çalışır. Daha fazlasını denetlemek için **Rastgele 10.000** ya da **Tümü**'nü seçin; **Denetle** denetimi yeniden çalıştırır.

Sekme kuralları en çok bozulandan başlayarak listeler. Her biri denetlenen belgelerden kaçının onu bozduğunu oranıyla söyler. **Belgelerde göster**, o belgeleri seçen bir filtreyi Belgeler sorgusuna koyar; böylece orada incelenip düzeltilebilirler. **Kurallara uymayanların hepsini göster** aynısını kuralların bütünü için yapar.

Doğrulama seviyesi ve eylemi adıyla söylenir. `moderate` seviyesi yalnızca kurallara zaten uyan belgeleri denetler; `warn` eylemi bozulan kuralı yazmayı reddetmek yerine günlüğe yazar. Bunlardan biri ayarlıysa sekme bunu söyler.

## Kurallar nasıl ayrılır

- **`$jsonSchema`:** `required` içindeki her alan bir kuraldır; `properties` içindeki her özellik bir kuraldır (denetimleri: tür, alt sınır, desen ve diğerleri); `true` dışındaki bir `additionalProperties`, `properties` ve `patternProperties` ile birlikte tek bir kuraldır: "şemadakiler dışında alan yok"; diğer her anahtar sözcük (`minProperties`, `dependencies`, `anyOf`, …) kendi başına bir kuraldır. `title` ve `description` bir belge hakkında bir şey söylemez ve dışarıda bırakılır; en üstteki `bsonType: "object"` da öyle.
- **Sorgu doğrulayıcısı:** her alanın koşulu bir kuraldır, en üstteki bir `$and`'in her maddesi de; `$or`, `$nor` ve `$expr` her biri tek bir kuraldır.

Bir belge bir kurala uymadığında o kuralı bozar: kullanılan filtre `{ $nor: [kural] }`'dır.

## Örnek

Doğrulayıcısı `email` alanını zorunlu tutan ve `age` alanının 0 ya da daha büyük bir int olmasını isteyen bir `customers` koleksiyonunda:

```
email zorunlu              12 belge (%1,2)
age  bsonType: 'int', minimum: 0     3 belge (%0,3)
name zorunlu               Bozan belge yok
```

İlkindeki **Belgelerde göster**, Belgeler'e `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` koyar.

## Görünümler

Bir görünümün kendine ait doğrulama kuralı yoktur: sekme bunu söyler ve okuduğu koleksiyonu gösterir.

## İzinler

- **Belgeleri okuma** (`documents:read`): her kuralı bozan belgeleri tek bir salt okunur aggregation ile saymak için.
- **Bu koleksiyonun tanımını okuma** (`collection:read`): doğrulama kurallarını okumak için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır. Bir kuralın, değerleri kullanıcıdan gizlenen bir alan hakkında söyledikleri eklentiye verilmez (alanın adı verilir): böyle bir kural denetlenmez ve sayılar gösterilen kurallarınkidir. Eklenti diğer koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Rastgele bir örnek, bir kuralın ne sıklıkla bozulduğunu söyler; toplamda kaç belgenin bozduğunu değil. Kesin sayılar için **Tümü**'nü seçin.
- Denetim, disk kullanmadan en fazla 10 saniye çalışan tek bir pipeline'dır. Büyük bir koleksiyonda **Tümü**'nün süresi dolabilir; bir örneğinki dolmaz.
- En fazla 40 kural sayılır; daha fazlası varsa sekme bunu söyler.
- Bir kural yazıldığı gibi sayılır. Yalnızca başka bir kuralla birlikte geçerli olan bir kural (örneğin özellikler arasında bir `anyOf`), MongoDB'nin denetlediği gibi bir bütün olarak sayılır.
