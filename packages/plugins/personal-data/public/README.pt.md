# Localizador de dados pessoais

O localizador de dados pessoais procura os campos de uma coleção que contêm dados pessoais (endereços de e-mail, números de telefone, números de cartão, IBANs, números de identidade, endereços IP, nomes, endereços, datas de nascimento, senhas e chaves) para que possam ser ocultados com regras de dados pessoais antes que alguém veja o que não deve. Ele lê uma amostra aleatória dos documentos da coleção e identifica cada campo encontrado pelos valores e pelo nome, com o grau de certeza e o motivo.

O plugin apenas lê. Nenhum valor é mostrado, a não ser mascarado (`u•••@e•••.com`, `+•• ••• ••• •• 67`), e nenhum é guardado ou enviado a lugar algum: os valores são lidos apenas para serem distinguidos.

## Onde aparece

- **Aba da coleção:** uma aba **Encontrar dados pessoais** ao lado de Documentos, Agregações e das outras abas de cada coleção.

## Como usar

Abra uma coleção e, depois, a aba **Encontrar dados pessoais**. Ela coleta uma amostra de 300 documentos aleatórios assim que abre (60 quando tantos documentos grandes não cabem em uma única resposta); **Analisar novamente** obtém uma nova amostra.

Cada campo encontrado é uma linha:

- **Contém:** com o que se parece: um endereço de e-mail, um número de telefone, um número de cartão, um IBAN, um número de identidade, um endereço IP, um nome de pessoa, um endereço, uma data de nascimento, ou uma senha ou chave.
- **Certeza:** **Alta** quando a maioria dos valores é desse tipo (ou os valores e o nome concordam), **Média** quando muitos são ou o nome indica isso, **Baixa** quando apenas alguns valores são, ou o nome indica isso mas os valores não parecem.
- **Motivo:** quantos dos valores da amostra se parecem com esse tipo e se o nome indica isso.
- **Exemplos:** até dois dos valores, mascarados.

Os campos prováveis (certeza alta e média) vêm escolhidos; marque ou desmarque qualquer um. **Sugerir como regras** abre a seção **Dados pessoais** da coleção com os campos escolhidos listados como sugeridos por este plugin: um administrador da conexão adiciona cada um lá (ou todos de uma vez) e, a partir de então, quem não pode ver dados pessoais vê os valores como `***`. Nada é salvo apenas pela palavra do plugin. **Copiar lista** copia os campos escolhidos, um por linha (`bancodedados.coleção.campo`, o que contém, certeza), para enviar a um administrador.

## Como os valores são identificados

- **Endereços de e-mail** e **endereços IP** (IPv4 e IPv6; um horário como `12:30:45` não é).
- **Números de cartão** na faixa e no comprimento de uma bandeira (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy) que passam na verificação de Luhn; a verificação de Luhn sozinha aceitaria um a cada dez números.
- **IBANs** que passam na verificação mod-97 (um turco, além disso, com 26 caracteres).
- **Números de identidade:** números de identidade turcos cujos dois dígitos verificadores estão corretos e números de seguridade social dos EUA escritos como `123-45-6789`.
- **Números de telefone** de 9 a 15 dígitos escritos de uma só vez: com `+` ou `00`, com separadores, ou com um 0 inicial antes de 9 ou 10 dígitos. Um número solto, ou um valor armazenado como número (uma coordenada, um valor monetário), só é tomado por telefone em um campo com nome de telefone, e somente se for um número inteiro.
- **Senhas e chaves** escritas como quem as gera as escreve: hashes bcrypt, Argon2 e scrypt, JSON Web Tokens, chaves de acesso da AWS, tokens do GitHub e do Stripe, chaves privadas.
- **Pelo nome:** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, o `name` de uma pessoa (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` e semelhantes, em inglês, turco e nos demais idiomas do aplicativo (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). Um nome que fala sobre o dado, e não é o dado, não conta: `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

Um campo dentro de um objeto ou de um array é nomeado como uma regra de dados pessoais o nomeia: `contacts.email` para um e-mail em um array de contatos.

## Exemplo

Em uma coleção `users`:

```
Campo       Contém               Certeza   Motivo                                         Exemplos
email       Endereço de e-mail   Alta      200 de 200 valores; o nome também indica isso   u•••@e•••.com
phone       Número de telefone   Alta      196 de 196 valores; o nome também indica isso   +•• ••• ••• •• 67
apiToken    Senha ou chave       Alta      O nome indica isso                              ••••••••
firstName   Nome de pessoa       Média     O nome indica isso                              A•••
```

Uma senha ou chave encontrada recebe uma nota: uma regra a oculta da visualização no aplicativo, não no banco de dados; uma senha deve ser armazenada como um hash lento e uma chave em um cofre de segredos. Um campo cujo nome diz que é uma senha é mostrado como tal, independentemente da aparência dos valores.

## Em visualizações

Uma visualização é lida como uma coleção, mas seus dados são os de sua origem: as regras são sugeridas na coleção que ela lê, cujas regras alcançam a visualização. **Sugerir como regras** fica desativado em uma visualização.

## Permissões

- **Ler documentos** (`documents:read`): para coletar a amostra dos documentos da coleção e para sugerir campos como dados pessoais.

As leituras passam pelo aplicativo com os direitos e o mascaramento de campos do usuário conectado: um campo que já está oculto para você chega como `***`, nunca é tomado por dados e é indicado como já oculto. Somente um administrador da conexão (quem pode gerenciá-la) pode receber os campos sugeridos; para qualquer outra pessoa, **Sugerir como regras** informa isso, e **Copiar lista** serve para enviá-los a um administrador.

## Configurações

Nenhuma.

## Limites

- Uma amostra: um campo que contém dados pessoais em poucos documentos pode não aparecer nela. São lidos 200 valores por campo, 50 elementos de um array e seis níveis de profundidade.
- Um campo que nenhuma regra consegue nomear (uma chave com ponto, com `$` no início, com caractere oculto ou espaços nas pontas, ou uma regra com mais de 512 bytes) é listado, com o motivo, mas não pode ser escolhido.
- No máximo 50 campos são sugeridos de uma vez: a aba avisa isso antes de você sugerir e permanece aberta enquanto a seção Dados pessoais é exibida, para que você possa voltar para buscar os outros.
- A seção Dados pessoais oferece apenas os campos sugeridos que uma amostra da coleção contém; um que ela não contém é listado como não oferecido.
- Nomes e endereços são identificados apenas pelo nome do campo: o nome de uma pessoa em um campo chamado `title` não é encontrado.
