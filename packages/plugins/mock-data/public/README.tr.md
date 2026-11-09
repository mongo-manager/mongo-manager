# Test verisi

Bir dizini, bir sorguyu, bir grafiği ya da bir ekranı denemek belge ister — elle yazabileceğinizden fazla ve hiçbiri gerçek olmayan. Test verisi, koleksiyonunuzun belgelerine benzeyen gerçekçi belgeler üretir ve onları uygulamanın İçe aktarma sihirbazına verir; orada kontrol edip içe aktarmayı siz başlatırsınız. NoSQLBooster aynısını "Test Data Generator" olarak sunar.

## Nasıl kullanılır

1. Bir koleksiyonu ve onun **Test verisi** sekmesini açın. Eklenti 100 belgelik bir örnek okur ve alanlarını listeler (`_id` sunucuya bırakılır).
2. Her alan adına ve türüne göre seçilmiş **test değerleri** alır — `email` e-posta adresleri, `createdAt` geçen yıl içinden tarihler, `price` fiyatlar, `status` koleksiyonda zaten bulunan değerlerden birini, bir GeoJSON `location` bir nokta alır. Ad, bir alanın türünü asla değiştirmez: metin olarak tutulan bir tarih metin tarihler, bayt olarak tutulan bir resim küçük PNG görseller alır. Herhangi birini gruplanmış 100'den fazla şablondan değiştirin: kişi, internet, konum, şirket, ticaret, finans, tarih ve saat, sayı, metin, kimlik, doğru ya da yanlış, diğer ("bu metin", null, boş).
3. Bir alanı dışarıda bırakmak için işaretini kaldırın ya da yeni bir alan ekleyin (biri içindeki için `profile.phone`; `items[].qty` gibi nesne dizileri bir ile üç arasında eleman alır).
4. Kaç belge üretileceğini (en fazla 5.000), alanların ne kadarının boş bırakılacağını (her alanı taşımayan belgeler için), sözcüklerin dilini (uygulamanın on dilinden biri) ve bir **tohum** seçin: sekme açık kaldıkça aynı tohum aynı belgeleri yeniden üretir (tarihler sekmenin açıldığı andan geriye sayılır). Hiçbir belge alansız kalmaz.
5. **Önizlemeyi** kontrol edin, sonra **İçe aktar…**: İçe aktarma sihirbazı koleksiyonda, belgeler dosyası olarak açılır. Orada içe aktarmayı kendi yetkilerinizle başlatana kadar hiçbir şey yazılmaz. **JSON indir** bunun yerine belgeleri kaydeder.

## Asla üretilmeyenler

- E-postalar ve web adresleri yalnızca ayrılmış örnek alan adlarını (`example.com`, `example.org`, `example.net`, `.test`), IP adresleri belgeleme aralıklarını, telefon numaraları kurgu için ayrılmış aralığı (`+1 2xx-555-01xx`) ya da hiçbir hattın olmadığı bir aralığı (`+90 000 …`) kullanır. Şirket adları uydurmadır.
- Bir kişiyi ya da bir şeyi ayırt eden hiçbir değer koleksiyondan kopyalanmaz: "var olan değerlerden biri" yalnızca bir kategori için adlandırılmış (durum, ülke) ya da kimlik (id, numara, kod, pasaport…) veya kişi (sahip, müşteri, yazar, kullanıcı…) gibi okunmayan bir alan için ve yalnızca görebildiğiniz birkaç kısa değerin her biri örneklemde en az iki kez geçtiğinde sunulur. Bir kişinin adı, e-postası, telefonu ya da adresi asla — `email2` ve `phone1` dahil.
- Kişisel veri olarak sizden gizlenen bir alan gizli olarak, türü bilinmeden listelenir: test değerleri siz başkasını seçene dek metindir (nedeni denetimleriyle birlikte okunur) ve İçe aktarma sihirbazı, orada dahil etmedikçe onu dışarıda bırakır. Uygulama neyin sizden gizlendiğini zamanında anlayamazsa, **Yeniden dene**'yi seçene dek her alan gizli sayılır.
- Yeni bir alan asla bir belge listesinin içine konmaz (`items[].qty` yanında `items.note`) ve `$` ya da köşeli ayraç içermez.
- Belgeler, uygulamanın aldığı gibi ölçülür: bir aktarım ya da indirme en fazla 1.000.000 karakter ve gönderildiği hâliyle 1,04 MB alır. Uygulamanın sorusuna hayır demek bir hata değil, kısa bir not bırakır.
- Hiçbir IBAN, hesap ya da kart numarası gerçek değildir: bu şablonlar sahte olarak işaretlidir (`XX00 TEST …`).

## İzinler

- **Belgeleri okuma:** alanlarını bilmek için koleksiyondan bir örnek. İçe aktarmanın kendisi uygulamanındır, sihirbazı üzerinden.
