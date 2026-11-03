# Belge karşılaştırma

Belge karşılaştırma, bir belgeyi aynı koleksiyondaki başka bir belgeyle alan alan karşılaştırır ve neyin eklendiğini, kaldırıldığını ya da değiştiğini listeler. İç içe nesneler alan alan, diziler öğe öğe karşılaştırılır; böylece belgenin derinlerindeki bir değişiklik kendi yolunda gösterilir.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Belge eylemi:** Belgeler'de bir belge satırının eylem menüsünde **Şununla karşılaştır…**. Koleksiyonun üzerinde bir iletişim kutusunda açılır.

## Nasıl kullanılır

1. Belgeler'de karşılaştırmak istediğiniz belgenin menüsünü açın ve **Şununla karşılaştır…** seçeneğini seçin. Bu belge **Sol** taraftır.
2. **Sağ** tarafı belirtin: kutuya `_id` değerini yazın ya da **Ya da bu koleksiyondan biri** listesinden bir belge seçin.
3. **Karşılaştır** düğmesine basın.

Sonuç bir özetle başlar (kaç alanın değiştiği, yalnız solda, yalnız sağda ya da aynı olduğu) ve değişen alanları listeler. **Hangi alanlar**, **Yalnız farklar** ile **Bütün alanlar** arasında geçiş yapar. **Tarafları değiştir**, Sol ile Sağ'ı yer değiştirir. **Farkları JSON olarak kopyala**, değişiklik listesini panoya kopyalar.

## `_id` yazmak

Kutu, yazdığınızı kastettiğiniz biçimde okur:

- 24 onaltılık rakam bir ObjectId'dir: `652f1c0e9b1e8a3d4c5b6a79`
- bir tam sayı sayıdır (bir int, daha büyükse bir long): `1042`
- ondalıklı bir sayı double'dır: `3.5`
- `{`, `[` ya da çift tırnakla başlayan metin Extended JSON olarak okunur: `{ "$uuid": "…" }` ya da `"A-100"`
- geri kalan her şey metindir (string): `A-100`

## Örnek

Sol:

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Sağ:

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

Karşılaştırma şunları listeler: `tags.1` değeri `"b"` iken `"c"` olmuş, `address.city` değişmiş, `address.zip` yalnızca sağda var; `name` aynı. `_id` alanları dışarıda bırakılır: iki belge orada her zaman farklıdır.

## Değerler nasıl karşılaştırılır

- Nesneler alana göre, diziler sıraya göre (0, 1, 2… konumları) karşılaştırılır.
- Diğer her değer, Extended JSON hâliyle bütün olarak karşılaştırılır. Bir tarafta int, diğer tarafta double olarak saklanan bir sayı değişiklik sayılır; `"5"` metni ile `5` sayısı da öyle.
- Her satır türünü yalnızca renkle değil, sözle de belirtir (Değişti, Yalnız solda, Yalnız sağda, Aynı).

## İzinler

- **Belgeleri okuma** (`documents:read`): iki belgeyi okumak ve seçim için koleksiyonun belgelerini listelemek için.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- İki belge de aynı koleksiyonda olmalıdır.
- Seçim listesi, geçerli Belgeler sorgusunun en fazla 50 belgesini içerir (belgenin kendisi hariç); her belge `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` ve `slug` arasından taşıdığı ilk alanla adlandırılır. Başka herhangi bir belge, `_id` değeri yazılarak karşılaştırılabilir.
- İç içelik 100 düzeye kadar izlenir; daha derinde değer bütün olarak karşılaştırılır.
- Uzun değerler tabloda kısaltılır; daha fazlasını görmek için imleci üzerine getirin (en fazla 2.000 karakter).
- Menü açıldıktan sonra sol belge silinmişse, iletişim kutusu bunu söyler ve hiçbir şey karşılaştırmaz.
