# Personal data finder

Personal data finder looks for the fields of a collection that hold personal data — e-mail addresses, phone numbers, card numbers, IBANs, identity numbers, IP addresses, names, addresses, birth dates, passwords and keys — so they can be hidden with personal data rules before anyone sees what they should not. It reads a random sample of the collection's documents and tells each field it finds by its values and by its name, with how sure it is and why.

The plugin only reads. No value is shown but masked (`u•••@e•••.com`, `+•• ••• ••• •• 67`), and none is kept or sent anywhere: values are read only to be told apart.

## Where it appears

- **Collection tab:** a **Find personal data** tab beside Documents, Aggregations and the other tabs of every collection.

## How to use it

Open a collection, then the **Find personal data** tab. It samples 300 random documents as soon as it opens (60 when that many large documents do not fit in one answer); **Scan again** draws a new sample.

Each field found is a row:

- **Holds:** what it looks like — an e-mail address, a phone number, a card number, an IBAN, an identity number, an IP address, a person's name, an address, a birth date, or a password or key.
- **How sure:** **High** when most of its values are of that kind (or its values and its name agree), **Medium** when many are or its name says so, **Low** when only some values are, or its name says so but its values do not look like it.
- **Why:** how many of its sampled values look like it, and whether its name says so.
- **Examples:** up to two of its values, masked.

The likely fields (high and medium) are chosen; tick or untick any. **Suggest as rules** opens the collection's **Personal data** section with the fields chosen listed as suggested by this plugin: an administrator of the connection adds each there (or all at once), and from then on those who may not see personal data see their values as `***`. Nothing is saved on the plugin's word. **Copy list** copies the fields chosen, one per line (`database.collection.field`, what it holds, how sure), to send to an administrator.

## How values are told

- **E-mail addresses** and **IP addresses** (IPv4 and IPv6; a time such as `12:30:45` is none).
- **Card numbers** in a card network's range and length (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy) that pass the Luhn check — the Luhn check alone would take one number in ten.
- **IBANs** that pass their mod-97 check (a Turkish one also 26 characters long).
- **Identity numbers:** Turkish identity numbers whose two check digits are right, and US social security numbers written `123-45-6789`.
- **Phone numbers** of 9 to 15 digits written as one: with a `+` or `00`, separators, or a leading 0 before 9 or 10 digits. A bare number, or a value stored as a number (a coordinate, an amount), is taken for one only in a field named like a phone, and then only a whole one.
- **Passwords and keys** written as what makes them writes them: bcrypt, Argon2 and scrypt hashes, JSON Web Tokens, AWS access keys, GitHub and Stripe tokens, private keys.
- **By name:** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, a person's `name` (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` and their kin, in English, Turkish and the app's other languages (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). A name about the data, not the data, is none: `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

A field inside an object or an array is named as a personal data rule names it: `contacts.email` for an e-mail in an array of contacts.

## Example

On a `users` collection:

```
Field       Holds            How sure   Why                                   Examples
email       E-mail address   High       200 of 200 values; its name says so   u•••@e•••.com
phone       Phone number     High       196 of 196 values; its name says so   +•• ••• ••• •• 67
apiToken    Password or key  High       Its name says so                      ••••••••
firstName   Person's name    Medium     Its name says so                      A•••
```

A password or key found gets a note: a rule hides it from view in the app, not in the database — a password belongs stored as a slow hash, a key in a secrets store. A field its name says is a password is shown as one whatever its values look like.

## On views

A view is read like a collection, but its data is its source's: rules are suggested on the collection it reads, whose rules reach the view. **Suggest as rules** is off on a view.

## Permissions

- **Read documents** (`documents:read`): to sample the collection's documents, and to suggest fields as personal data.

Reads go through the app with the signed-in user's rights and field masking: a field already hidden from you comes as `***`, is never taken for data, and is named as hidden already. Only an administrator of the connection (who may manage it) can be offered the suggested fields; for anyone else, **Suggest as rules** says so, and **Copy list** is there to send them on.

## Settings

None.

## Limits

- A sample: a field that holds personal data in few documents may not show in it. 200 values a field, 50 elements of an array and six levels deep are read.
- A field no rule can name — a key with a dot, a `$` first, a hidden character or spaces around it, or a rule past 512 bytes — is listed, with why, but cannot be chosen.
- At most 50 fields are suggested at once: the tab says so before you suggest, and stays open while the Personal data section shows, so you can come back for the others.
- The Personal data section offers only the suggested fields a sample of the collection holds; one it does not hold is listed as not offered.
- Names and addresses are told by the field's name only: a person's name in a field called `title` is not found.
