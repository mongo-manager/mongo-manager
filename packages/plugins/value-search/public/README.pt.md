# Busca de valores

A busca de valores procura um valor em todos os campos de uma coleção de uma só vez: um nome, um endereço de e-mail, um número de pedido, um ObjectId, uma data. Use quando você conhece um valor, mas não sabe em qual campo ele está. Cada documento encontrado mostra os campos que corresponderam e abre no app.

O plugin só lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Aba da coleção:** uma aba **Buscar** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.

## Como usar

1. Abra uma coleção e depois a aba **Buscar**. Ela primeiro lê uma amostra da coleção para conhecer seus campos; a página vazia diz quantos campos serão pesquisados.
2. Digite o que procura em **Buscar por**: um texto, um número, uma data como `2026-01-05` ou um ObjectId.
3. Escolha **Como corresponder**: **Contém**, **Valor inteiro** ou **Regex**.
4. Se quiser, ative **Ignorar maiúsculas e minúsculas**, ou **Corresponder também a nomes de campo** para listar também os nomes de campo que contêm o texto.
5. Escolha **Onde buscar**: **Coleção inteira** (o padrão) ou o **Filtro de documentos** (a consulta da aba Documentos). Um filtro que nomeia um único documento pelo `_id`, como o que **Abrir** deixa lá, não é oferecido.
6. Clique em **Buscar** (ou pressione Enter).

O resultado lista os documentos encontrados, cada um com os campos que corresponderam e seus valores, com a correspondência destacada. **Todos os campos** reduz a lista aos documentos que correspondem em um único campo. **Abrir** mostra um documento no app; a busca e seus resultados continuam lá quando você volta à aba. **Mostrar em Documentos** coloca a busca, como filtro, na consulta de Documentos, para que todos os documentos correspondentes possam ser percorridos página por página ali.

## O que cada tipo de termo encontra

- **Texto:** campos de texto que o contêm (Contém), são iguais a ele (Valor inteiro) ou correspondem a ele (Regex).
- **Número** (como `1042` ou `19.90`): além da correspondência de texto, os campos que guardam esse número, qualquer que seja o tipo armazenado: int, long, double ou decimal. `1042` encontra `1042`, `NumberLong(1042)` e `1042.0` igualmente, e `524.66` encontra um decimal `524.66`. Com **Contém**, também são encontrados números cujos dígitos contêm o termo: `524` encontra `524.66` e `1524`.
- **ObjectId** (24 dígitos hexadecimais): além da correspondência de texto, os campos que guardam esse ObjectId, como referências ao documento.
- **Data** (`2026-01-05`, `2026-01-05 14:30` ou `2026-01-05T14:30:15`): além da correspondência de texto, os campos de data dentro daquele dia, minuto ou segundo, em UTC.

Com **Regex**, o termo é uma expressão regular executada pelo servidor exatamente como foi escrita; números, ObjectIds e datas não são adicionados.

## Exemplo

Em uma coleção `customers`, busque `ada@example.com` com **Contém** e **Ignorar maiúsculas e minúsculas**. O resultado pode ser:

```
2 documentos · 38 campos · coleção inteira
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**Mostrar em Documentos** então coloca em Documentos um filtro como este (uma condição por campo pesquisado):

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## Permissões

- **Ler documentos** (`documents:read`): para ler uma amostra da coleção e conhecer seus campos, e para executar a busca.

As leituras passam pelo app com os direitos do usuário conectado e o mascaramento de campos. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Os campos pesquisados vêm de uma amostra aleatória de 200 documentos, até 100 caminhos de campo, com seis níveis de profundidade. Um campo que nenhum dos documentos da amostra contém não é pesquisado; busque de novo mais tarde para obter outra amostra, ou use Documentos com um filtro explícito. De documentos grandes são tomados menos: quantos couberem em uma resposta à página (1 MB).
- Até 100 documentos são listados. Quando mais correspondem, a contagem aparece como “100+”; Mostrar em Documentos mostra todos.
- Até 20 campos correspondentes são mostrados por documento.
- Uma expressão regular tem no máximo 200 caracteres. O servidor a executa e limita a própria execução. A página marca os campos correspondentes por conta própria e não faz isso para um padrão que poderia retroceder sem fim (como `(a+)+`) nem além dos primeiros 1.000 caracteres de um valor; o documento ainda assim é listado.
- A busca é uma única consulta com uma condição por campo; em uma coleção grande sem índices adequados, ela lê todos os documentos. Ela roda por no máximo 10 segundos, sem usar disco; restrinja-a com o filtro de documentos se o tempo esgotar.
- Contém e Regex só encontram texto dentro de strings; um número, uma data ou um ObjectId é encontrado pelo valor inteiro.
