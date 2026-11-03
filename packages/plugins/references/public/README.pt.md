# Referências

Referências mostra como os documentos de um banco de dados apontam uns para os outros por meio de ObjectIds. Em Documentos, ele escreve o nome do documento referenciado ao lado de um id como `customerId`, de modo que uma linha é lida como “customer: Ada Lovelace” em vez de uma sequência de dígitos hexadecimais. Sua aba descobre quais campos de uma coleção contêm ids de outros documentos, em quais coleções esses documentos estão e quais ids não apontam para nada.

O plugin apenas lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Valores de célula:** ao lado de um ObjectId em Documentos, uma seta e o nome do documento referenciado (`→ Ada Lovelace`), ou `→ não encontrado` quando nenhum documento tem esse id.
- **Aba da coleção:** uma aba **Referências** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.
- **Ação de documento:** **Referenciado por**, nas ações de um documento, lista os documentos do banco de dados que fazem referência a ele.

## Nomes ao lado dos ids

Uma célula recebe um nome quando seu campo tem nome de uma coleção do mesmo banco de dados, no singular ou no plural, com terminação de id ou sem ela:

- `customerId`, `customer_id` ou `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

O plugin procura os ids mostrados na página por `_id` nessa coleção e lê apenas os campos de nome do que encontra. O nome é o primeiro entre `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` e `slug` que o documento contém; se não houver nenhum, seu `_id` é mostrado. Um campo cujos ids não são encontrados em nenhuma coleção com o nome dele não recebe nenhum texto.

`→ não encontrado`, mostrado como aviso, marca uma referência solta: o campo aponta para uma coleção, mas essa coleção não tem nenhum documento com este id.

## A aba Referências

Abra uma coleção e depois a aba **Referências**. Ela começa a procurar assim que é aberta; **Encontrar referências** procura de novo.

1. Lê uma amostra aleatória de 200 documentos e reúne os campos que contêm ObjectIds (exceto o `_id` dos próprios documentos).
2. Procura esses ids por `_id` nas outras coleções do banco de dados, começando pelas que têm nome parecido com o do campo.
3. Mostra um cartão por relação encontrada: o campo, a coleção para a qual aponta, a proporção de ids da amostra encontrados ali e alguns nomes de exemplo.

Em cada cartão:

- **Abrir com $lookup** coloca uma etapa `$lookup` que une os documentos referenciados na aba Agregações da coleção. Nada é executado até você executar lá.
- **Mostrar órfãos** coloca um filtro em Documentos com os documentos que contêm algum dos ids da amostra que a coleção de destino não tem.

Os campos que contêm ObjectIds não encontrados em nenhuma coleção são listados à parte.

## Referenciado por

**Referenciado por** procura os documentos que fazem referência àquele em que é aberto. Ele lê o modelo do banco de dados — as referências que a aba Banco de dados desenha, encontradas a partir do nome de um campo (`customerId` → `customers`), de valores da amostra que são ids desta coleção, ou de um `$lookup` em uma visualização ou em um pipeline salvo — e pergunta a cada campo que faz referência ao `_id` desta coleção pelo id deste documento, inclusive a um array que o contenha.

Cada campo em que ele é encontrado é um cartão: a coleção e o campo (`orders.customerId`), quantos documentos (até 20 são listados, “20+” quando há mais) e seus nomes. **Mostrar em orders** coloca um filtro que os seleciona na consulta de Documentos dessa coleção, na própria aba dela. Um campo que não pôde ser lido informa isso; os outros continuam listados.

## Exemplo

Uma coleção `orders` com `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }`, ao lado das coleções `customers` e `products`. A aba mostra duas relações, `customerId → customers` e `productIds → products`, cada uma com a proporção encontrada (por exemplo, “196 de 200 ids da amostra encontrados”). **Abrir com $lookup** na primeira coloca esta etapa em Agregações:

```json
[
  {
    "$lookup": {
      "from": "customers",
      "localField": "customerId",
      "foreignField": "_id",
      "as": "customerId_ref"
    }
  }
]
```

## Permissões

- **Ler documentos** (`documents:read`): para ler a amostra da coleção aberta.
- **Ler as outras coleções do mesmo banco de dados** (`database:read`): para listar as coleções do banco de dados e procurar ids nelas; em **Referenciado por**, para ler o modelo do banco de dados e colocar um filtro na consulta de Documentos de outra coleção. Das outras coleções, apenas `_id` e os campos de nome listados acima são lidos, nunca documentos inteiros.

As leituras passam pelo aplicativo com os direitos e o mascaramento de campos do usuário conectado: uma coleção que o usuário não pode ler também não é lida pelo plugin, e uma célula cuja leitura foi recusada é consultada de novo após 30 segundos.

## Configurações

Nenhuma.

## Limites

- Apenas ObjectIds são seguidos. Ids guardados como texto, números ou UUIDs não são verificados.
- A aba obtém uma amostra de 200 documentos aleatórios, mantém os 8 campos com mais ids distintos, até 20 ids por campo e 200 ids no total.
- Ela procura em no máximo 50 coleções do banco de dados e para mais cedo quando todos os campos são encontrados em 80% ou mais. Visualizações e coleções `system.` nunca são verificadas.
- Uma relação é a coleção que contém a maioria dos ids da amostra de um campo. Um campo cujos ids estão espalhados por várias coleções mostra apenas a que contém mais.
- **Referenciado por** encontra as referências que o modelo do banco de dados encontra (ele obtém uma amostra de cada coleção): um campo que a amostra não mostrou não é consultado. Ele consulta no máximo 20 campos e lista até 20 documentos de cada um. Cada campo consultado é uma das leituras por minuto do aplicativo: depois delas, os campos restantes não são consultados, e isso é informado.
- Nas células, um campo é comparado apenas com as duas primeiras coleções de nome parecido; os ids são procurados de 200 em 200 e até 5.000 nomes ficam na memória. A lista de coleções é lida de novo após um minuto.
- Nomes com mais de 60 caracteres são encurtados.
- Os campos são seguidos até seis níveis de profundidade.
