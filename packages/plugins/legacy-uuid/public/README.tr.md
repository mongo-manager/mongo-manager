# Eski UUID'ler

MongoDB'nin standart bir UUID türü (ikili alt tür 4) olmadan önce sürücüler UUID'leri ikili alt tür 3 olarak, her biri kendi bayt sırasıyla saklardı: Java sürücüsü baytların her yarısını ters çevirirdi, C# sürücüsü (.NET'in `Guid`'i) ilk üç grubu ters çevirirdi, Python sürücüsü sırayı korurdu. Bu yüzden aynı 16 bayt üç farklı UUID olarak okunur ve aranan bir UUID, onu saklayan sürücünün sırasıyla yazılmalıdır. Bu eklenti onları her sırayla okur, bir alanın hangi sırayla yazıldığını söyler ve bir UUID'yi nasıl saklanmış olursa olsun bulur.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Belgeler'de:** eski bir UUID'nin (alt türü 3 olan 16 baytlık bir ikili veri) üzerine gelmek onu Java, C# ve Python sıralarıyla okunmuş gösterir.
- **Koleksiyon sekmesi:** her koleksiyonun ve görünümün Belgeler, Aggregation ve diğer sekmelerinin yanında bir **UUID'ler** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **UUID'ler** sekmesini. Sekme açılır açılmaz rastgele 1.000 belgelik bir örnek okunur; **Yeniden tara** başka bir örnek okur.

**UUID alanları**, örnekte UUID taşıyan her alanı — iç içe alanlar ve diziler de — kaçının eski, kaçının standart olduğuyla listeler. Eski UUID'ler taşıyan bir alan için, bayt sırası her değeri iyi biçimli bir UUID olarak okuyan sürücüyü adlandırır: bir UUID'nin sürüm basamağı ve varyant bitleri sabit yerlerdedir; yanlış sırayla okununca neredeyse hiç oraya düşmezler. Alanın ilk değerini her sırayla okunmuş gösterir. **Bu alanda bul**, bulucuyu o alan ve o sürücüyle doldurur.

**Bir UUID bul**, bir UUID'yi insanların yazdığı gibi alır — tireli ya da tiresiz, süslü parantezli ya da parantezsiz 32 onaltılık basamak, ya da `UUID("…")` — aranacak alanı ve nasıl saklandığını: **Bunlardan herhangi biri**, standart alt tür, ya da Java, C# veya Python eski sırası. Değeri her sürücünün sakladığı gibi, kabuğun yazdığı biçimde (`BinData(3, "…")`, `UUID("…")`) gösterir; her birini kopyalamak için bir düğmeyle. **Belgelerde göster**, o UUID'yi taşıyan belgeleri seçen bir filtreyi Belgeler sorgusuna koyar; **Bunlardan herhangi biri** ile herhangi bir sürücünün değerini bulur.

## Örnek

`00112233-4455-6677-8899-aabbccddeeff` UUID'si, her sürücünün sakladığı gibi:

```
Standart  UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## İzinler

- **Belgeleri okuma** (`documents:read`): örneği okumak ve Belgeler sorgusuna bir filtre koymak için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır: gizlenen bir değer, eklentinin okuyabileceği bir UUID değildir. Eklenti diğer koleksiyonları okuyamaz. Bir hücre çiziciye bir ikili değerin yalnızca ilk baytları, alt türü ve uzunluğu gönderilir.

## Ayarlar

Yok.

## Sınırlar

- Alanlar rastgele 1.000 belgelik bir örnekte bulunur; nadir bir alan örnekte olmayabilir.
- Büyük belgelerde (örneğin API günlükleri) örnek, sayfaya giden tek bir yanıta (1 MB) sığacak kadar belgeyle sınırlıdır.
- Değerleri birden fazla sürücüden gelen bir alan tek bir sıraya uymaz: sekme bunu söyler. Değer azsa birden fazla sıra uyabilir: hepsi adlandırılır.
- Yalnızca alt türü 3 ya da 4 olan 16 baytlık ikili veriler UUID olarak okunur.
