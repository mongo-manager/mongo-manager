// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { findPersonalData, kindOfName, MAX_KEY, wordsOf, type Kind } from '../src/detect'
import * as X from '../src/vocab'

type Case = [string[] | string, Kind]
const kind = (k: string[] | string) => kindOfName(typeof k === 'string' ? [k] : k)

const POSITIVE: Record<string, Case[]> = {
  es: [
    ['correo', 'email'],
    ['correo_electronico', 'email'],
    ['telefono', 'phone'],
    ['numero_de_telefono', 'phone'],
    ['telefono_movil', 'phone'],
    ['Teléfono', 'phone'],
    ['nombre_completo', 'name'],
    ['apellido', 'name'],
    ['segundoApellido', 'name'],
    ['nombre_cliente', 'name'],
    ['direccion', 'address'],
    ['dirección_de_envío', 'address'],
    ['domicilio', 'address'],
    ['codigo_postal', 'address'],
    ['fecha_nacimiento', 'birthDate'],
    ['fechaDeNacimiento', 'birthDate'],
    ['lugar_nacimiento', 'address'],
    ['dni', 'nationalId'],
    ['curp', 'nationalId'],
    ['numero_tarjeta', 'card'],
    ['tarjeta_de_credito', 'card'],
    ['contraseña', 'secret'],
    ['claveApi', 'secret'],
  ],
  pt: [
    ['telefone', 'phone'],
    ['celular', 'phone'],
    ['numero_celular', 'phone'],
    ['nome_completo', 'name'],
    ['sobrenome', 'name'],
    ['nome_cliente', 'name'],
    ['endereco', 'address'],
    ['endereço_de_entrega', 'address'],
    ['logradouro', 'address'],
    ['data_nascimento', 'birthDate'],
    ['dataNascimento', 'birthDate'],
    ['cpf', 'nationalId'],
    ['cnpj', 'nationalId'],
    ['numero_cartao', 'card'],
    ['cartao_de_credito', 'card'],
    ['senha', 'secret'],
    ['senhaHash', 'secret'],
  ],
  de: [
    ['telefonnummer', 'phone'],
    ['handynummer', 'phone'],
    ['Mobiltelefon', 'phone'],
    ['emailadresse', 'email'],
    ['e_mail_adresse', 'email'],
    ['vorname', 'name'],
    ['nachname', 'name'],
    ['kundenname', 'name'],
    ['familienname', 'name'],
    ['strasse', 'address'],
    ['Straße', 'address'],
    ['lieferadresse', 'address'],
    ['anschrift', 'address'],
    ['postleitzahl', 'address'],
    ['plz', 'address'],
    ['geburtsdatum', 'birthDate'],
    ['geburtstag', 'birthDate'],
    ['geburtsort', 'address'],
    ['steuernummer', 'nationalId'],
    ['personalausweis', 'nationalId'],
    ['kreditkarte', 'card'],
    ['kartennummer', 'card'],
    ['passwort', 'secret'],
    ['kennwort', 'secret'],
  ],
  fr: [
    ['courriel', 'email'],
    ['adresse_mail', 'email'],
    ['telephone', 'phone'],
    ['numéro_de_téléphone', 'phone'],
    ['prenom', 'name'],
    ['prénom', 'name'],
    ['nom_famille', 'name'],
    ['nom_de_famille', 'name'],
    ['nom_client', 'name'],
    ['nom_de_naissance', 'name'],
    ['adresse', 'address'],
    ['adresse_livraison', 'address'],
    ['code_postal', 'address'],
    ['date_naissance', 'birthDate'],
    ['dateDeNaissance', 'birthDate'],
    ['lieu_naissance', 'address'],
    ['numero_securite_sociale', 'nationalId'],
    ['numero_carte', 'card'],
    ['carte_bancaire', 'card'],
    ['mot_de_passe', 'secret'],
    ['motDePasse', 'secret'],
  ],
  ru: [
    ['телефон', 'phone'],
    ['номер_телефона', 'phone'],
    ['мобильный', 'phone'],
    ['почта', 'email'],
    ['электронная_почта', 'email'],
    ['фамилия', 'name'],
    ['отчество', 'name'],
    ['имя_клиента', 'name'],
    ['ФИО', 'name'],
    ['адрес', 'address'],
    ['домашний_адрес', 'address'],
    ['почтовый_индекс', 'address'],
    ['дата_рождения', 'birthDate'],
    ['датаРождения', 'birthDate'],
    ['место_рождения', 'address'],
    ['паспорт', 'nationalId'],
    ['инн', 'nationalId'],
    ['снилс', 'nationalId'],
    ['номер_карты', 'card'],
    ['пароль', 'secret'],
    ['токен', 'secret'],
    // romanized
    ['familiya', 'name'],
    ['otchestvo', 'name'],
    ['imya_klienta', 'name'],
    ['data_rozhdeniya', 'birthDate'],
    ['nomer_karty', 'card'],
    ['parol', 'secret'],
  ],
  zh: [
    ['电话', 'phone'],
    ['手机号', 'phone'],
    ['电话号码', 'phone'],
    ['联系电话', 'phone'],
    ['邮箱', 'email'],
    ['电子邮件', 'email'],
    ['邮箱地址', 'email'],
    ['姓名', 'name'],
    ['真实姓名', 'name'],
    ['客户姓名', 'name'],
    ['用户名', 'name'],
    ['地址', 'address'],
    ['收货地址', 'address'],
    ['邮政编码', 'address'],
    ['出生日期', 'birthDate'],
    ['生日', 'birthDate'],
    ['出生地', 'address'],
    ['身份证号', 'nationalId'],
    ['身份证', 'nationalId'],
    ['银行卡号', 'card'],
    ['信用卡', 'card'],
    ['密码', 'secret'],
    ['用户密码', 'secret'],
    ['密钥', 'secret'],
    ['xingming', 'name'],
  ],
  ja: [
    ['電話番号', 'phone'],
    ['携帯', 'phone'],
    ['メールアドレス', 'email'],
    ['メール', 'email'],
    ['氏名', 'name'],
    ['顧客名', 'name'],
    ['フリガナ', 'name'],
    ['住所', 'address'],
    ['郵便番号', 'address'],
    ['生年月日', 'birthDate'],
    ['誕生日', 'birthDate'],
    ['マイナンバー', 'nationalId'],
    ['パスポート', 'nationalId'],
    ['カード番号', 'card'],
    ['クレジットカード', 'card'],
    ['パスワード', 'secret'],
    ['秘密鍵', 'secret'],
    ['denwa', 'phone'],
    ['shimei', 'name'],
  ],
  ko: [
    ['전화번호', 'phone'],
    ['휴대폰', 'phone'],
    ['이메일', 'email'],
    ['이메일주소', 'email'],
    ['성명', 'name'],
    ['고객이름', 'name'],
    ['고객명', 'name'],
    ['주소', 'address'],
    ['우편번호', 'address'],
    ['생년월일', 'birthDate'],
    ['생일', 'birthDate'],
    ['주민등록번호', 'nationalId'],
    ['여권번호', 'nationalId'],
    ['카드번호', 'card'],
    ['신용카드', 'card'],
    ['비밀번호', 'secret'],
    ['토큰', 'secret'],
  ],
}

// Names that look alike but hold nothing personal.
const NEGATIVE: Record<string, Array<string[] | string>> = {
  es: [
    'nombre_producto',
    'telefono_verificado',
    'correo_enviado',
    'fecha_creacion',
    'tarjeta_embarque',
    'estado',
    'direccion_mac',
    'clave_primaria',
    'pais',
    'codigo_pais',
  ],
  pt: [
    'nome_produto',
    'telefone_verificado',
    'data_criacao',
    'senha_atualizada_em',
    'endereco_mac',
    'cartao_status',
  ],
  de: [
    'produktname',
    'telefon_status',
    'email_bestatigt',
    'macadresse',
    'strassenkarte_typ',
    'erstellt_am',
    'datum',
  ],
  fr: [
    'nom_produit',
    'nom_fichier',
    'telephone_verifie',
    'date_creation',
    'adresse_mac',
    'true',
    'statut',
    'code_pays',
  ],
  ru: ['имя_файла', 'телефон_подтвержден', 'дата_создания', 'статус', 'индекс', 'ключ', 'название'],
  zh: ['产品名称', '电话验证', '创建日期', '状态', '订单号', '密码修改时间', '邮箱验证'],
  ja: ['商品名', '電話確認', '作成日', '状態', '注文番号', 'パスワード変更日', 'メール確認'],
  ko: ['상품명', '전화인증', '생성일', '상태', '주문번호', '이메일인증'],
}

describe('personal-data field names in the app languages', () => {
  for (const [lang, cases] of Object.entries(POSITIVE))
    it(`suggests ${lang} names`, () => {
      for (const [k, expected] of cases) expect(kind(k), `${lang}: ${k}`).toBe(expected)
    })

  for (const [lang, names] of Object.entries(NEGATIVE))
    it(`does not suggest similar ${lang} names that hold nothing personal`, () => {
      for (const k of names) expect(kind(k), `${lang}: ${k}`).toBeNull()
    })

  it('reads a nested owner in another language (cliente.nombre, 客户.名)', () => {
    expect(kindOfName(['cliente', 'nombre'])).toBe('name')
    expect(kindOfName(['kunde', 'name'])).toBe('name')
    expect(kindOfName(['producto', 'nombre'])).toBeNull()
  })

  it('folds accents, full-width letters and Cyrillic, and cuts CJK runs into words', () => {
    expect(wordsOf('Numéro_de_Téléphone')).toEqual(['numero', 'de', 'telephone'])
    expect(wordsOf('Straße')).toEqual(['strasse'])
    expect(wordsOf('ＰＨＯＮＥ')).toEqual(['phone'])
    expect(wordsOf('ИмяКлиента')).toEqual(['имя', 'клиента'])
    expect(wordsOf('подтверждён')).toEqual(['подтвержден'])
    expect(wordsOf('電話番号')).toEqual(['電話', '番号'])
    expect(wordsOf('ip地址')).toEqual(['ip', '地址'])
  })

  it('still finds them in a sample, by name', () => {
    // Fictional numbers: no Chinese mobile number starts with 100.
    const docs = [
      { 电话: '100 0000 0001', 姓名: '张三', 備考: 'x', fecha_nacimiento: { $date: '1990-01-01T00:00:00Z' } },
      { 电话: '100 0000 0002', 姓名: '李四', 備考: 'y', fecha_nacimiento: { $date: '1991-01-01T00:00:00Z' } },
    ]
    const found = Object.fromEntries(findPersonalData(docs, []).findings.map((f) => [f.field, f.kind]))
    expect(found['电话']).toBe('phone')
    expect(found['姓名']).toBe('name')
    expect(found['fecha_nacimiento']).toBe('birthDate')
    expect(found['備考']).toBeUndefined()
  })
})

describe('the review of the languages (2026-10-29)', () => {
  it('takes clave and senha for a secret only as whole words, never inside another word', () => {
    for (const k of [
      'clave',
      'claves',
      'claveApi',
      'claveprivada',
      'clave_secreta',
      'claveAcceso',
      'senha',
      'senhas',
      'senhaHash',
      'senhahash',
      'senha_usuario',
      'contraseña',
    ])
      expect(kind(k), k).toBe('secret')
    for (const k of [
      'palabra_clave',
      'palabrasClave',
      'palabraclave',
      'enclave',
      'sgxEnclave',
      'autoclave',
      'conclave',
      'resenha',
      'resenha_livro',
      'resenhas',
      'clave_primaria',
      'senha_alterada_em',
    ])
      expect(kind(k), k).toBeNull()
  })

  it('reads data, em and en as no word about the data on their own (passwordData is a password)', () => {
    for (const k of [
      'passwordData',
      'password_data',
      'passwordEn',
      'password_em',
      'sifre_data',
      'senha_data',
    ])
      expect(kind(k), k).toBe('secret')
    for (const k of [
      'senha_atualizada_em',
      'senha_alterado_em',
      'senha_criada_em',
      'contrasena_actualizada_en',
      'passwort_geaendert_am',
      'telefone_atualizado_em',
    ])
      expect(kind(k), k).toBeNull()
    // A birth date still ends with data.
    expect(kind('nascimento_data')).toBe('birthDate')
  })

  it('looks no key’s word up on an object’s prototype', () => {
    for (const k of [
      'constructor_principal',
      'constructorPro',
      'constructor',
      'toString_x',
      '__proto__x',
      'hasOwnProperty_fijo',
      '__proto___casa',
    ])
      expect(kind(k), k).toBeNull()
    expect(kind('telefono_casa')).toBe('phone')
  })

  it('takes an electronic thing for no e-mail, and a laptop for no phone', () => {
    for (const k of [
      'correo_electronico',
      'correoElectronico',
      'courrier_electronique',
      'adresse_courrier_electronique',
      'correio_eletronico',
      'endereco_eletronico',
      'direccion_de_correo_electronico',
    ])
      expect(kind(k), k).toBe('email')
    for (const k of ['factureElectronique', 'comercio_electronico', 'documento_eletronico', 'electronique'])
      expect(kind(k), k).toBeNull()
    for (const k of [
      'telephone_portable',
      'numero_portable',
      'numero_de_portable',
      'portable_number',
      'tel_portable',
    ])
      expect(kind(k), k).toBe('phone')
    for (const k of ['ordinateur_portable', 'portable', 'hotel_portable', 'ordinateur_portable_numero'])
      expect(kind(k), k).toBeNull()
  })

  it('takes a server’s, a link’s or a wallet’s address for no postal one', () => {
    for (const k of [
      '服务器地址',
      '回调地址',
      '钱包地址',
      '链接地址',
      '서버주소',
      '웹주소',
      '지갑주소',
      'mac_адрес',
      'callbackAddress',
      'linkAddress',
      'callbackadresse',
    ])
      expect(kind(k), k).toBeNull()
    for (const k of ['地址', '收货地址', '주소', '배송주소', 'адрес', 'domicilio'])
      expect(kind(k), k).toBe('address')
    // An IP address and an e-mail address are one.
    expect(kind('ip_адрес')).toBe('ip')
    expect(kind('邮箱地址')).toBe('email')
    expect(kind('이메일주소')).toBe('email')
  })

  it('takes no one-character CJK word for the first word of a name', () => {
    expect(kind('명예회원')).toBeNull()
    expect(kind('名誉会员')).toBeNull()
    expect(kind('고객명')).toBe('name')
    expect(kind('회원이름')).toBe('name')
  })

  it('takes num_ for no number word, a document’s number for no identity, and finds a passport’s', () => {
    for (const k of [
      'num_card',
      'num_tax',
      'dokumentNummer',
      'dokument_nummer',
      'номер_документа',
      'документ_номер',
    ])
      expect(kind(k), k).toBeNull()
    for (const k of ['номер_паспорта', 'серия_паспорта', 'nomer_pasporta', 'паспорт'])
      expect(kind(k), k).toBe('nationalId')
    expect(kind('numero_tarjeta')).toBe('card')
    expect(kind('nro_tarjeta')).toBe('card')
  })

  it('reads 会員, fax numbers and prenom_nom; a page token is no one’s; Eメール is an e-mail', () => {
    expect(kind('会員名')).toBe('name')
    expect(kind('会員番号')).toBeNull()
    for (const k of ['faxnummer', 'telefax', 'Telefaxnummer', 'fax_nummer']) expect(kind(k), k).toBe('phone')
    expect(kind('prenom_nom')).toBe('name')
    expect(kind('nom_prenom')).toBe('name')
    for (const k of ['ページトークン', '次ページトークン', '페이지토큰', 'nextPageToken'])
      expect(kind(k), k).toBeNull()
    expect(kind('トークン')).toBe('secret')
    expect(kind('Eメール')).toBe('email')
    expect(kind('Eメールアドレス')).toBe('email')
  })

  it('holds every word of its vocabulary as a key folds it, so each can match', () => {
    for (const [name, v] of Object.entries(X)) {
      const words = Array.isArray(v) ? v : v instanceof Set ? [...v] : v instanceof Map ? [...v.keys()] : []
      for (const w of words as string[]) expect(wordsOf(w).join(''), `${name}: ${w}`).toBe(w)
    }
  })

  it('reads a long key quickly, its first 256 characters only', () => {
    for (const key of ['A'.repeat(60_000), 'aB'.repeat(30_000), 'é'.repeat(60_000), '電'.repeat(60_000)]) {
      const start = performance.now()
      kindOfName([key])
      wordsOf(key)
      expect(performance.now() - start, key.slice(0, 4)).toBeLessThan(250)
    }
    expect(wordsOf(`${'x'.repeat(MAX_KEY)}Password`)).toEqual(['x'.repeat(MAX_KEY)])
  })
})
