# SQL para MongoDB

O SQL para MongoDB converte uma instrução SELECT do SQL na consulta do MongoDB que faz a mesma coisa, um `find` quando cabe e um pipeline de agregação nos demais casos, e a mostra como código do mongosh e como um programa para cada driver oficial. Na aba SQL de uma coleção, ele também executa a consulta, somente leitura, e mostra as linhas.

Executar uma consulta nunca altera dados: este plugin nunca grava.

## Onde aparece

- **Aba de coleção:** uma aba **SQL** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.

## Como usar

1. Abra uma coleção e depois a aba **SQL**. **Exemplos** preenche o editor com consultas escritas com os campos dessa coleção.
2. Escreva um SELECT no editor. Sugestões aparecem enquanto você digita: palavras-chave, os campos da coleção (inclusive caminhos aninhados), valores que um campo contém depois de `=` ou dentro de `IN (…)`, funções e o nome da coleção depois de FROM ou JOIN. Enter aceita a sugestão destacada; Tab também, depois que você digitou parte dela ou se moveu até ela.
3. O código do MongoDB é atualizado enquanto você digita. **Código para** escolhe a linguagem: mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby ou Rust. **Copiar código** o copia.
4. **Executar** (Ctrl+Enter, ou Cmd+Enter no Mac) executa a consulta aqui, somente leitura, e mostra até 50 linhas em **Resultados**. **Abrir** em uma linha mostra aquele documento no app. **Limpar** esvazia os resultados.
5. **Formatar** (Shift+Alt+F) organiza o SQL: uma cláusula por linha, com palavras-chave em maiúsculas. Isso nunca muda o significado da consulta.
6. **Usar em Documentos** coloca o filtro, a projeção e a ordenação na aba Documentos da coleção; **Abrir em Agregações** coloca o pipeline na aba Agregações. Nada é executado lá até que você peça.

Um erro é marcado na própria linha, e a mensagem informa a linha e a coluna; **Mostrar no editor** move o cursor até lá.

## Exemplo

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

torna-se

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

Uma consulta agrupada vira um pipeline:

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOINs

Um INNER ou LEFT JOIN com outra coleção do mesmo banco de dados é traduzido para `$lookup`, e Executar o executa aqui:

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

As colunas do resultado têm o cabeçalho como o SELECT as escreve (`o.orderNo`, `c.name` ou um nome AS). Uma pequena marca ao lado do cabeçalho de uma coluna unida informa o campo da coleção de onde ela vem, por exemplo `customers.name`. A coleção unida é lida com os direitos do usuário e o mascaramento de campos, como qualquer outra leitura.

## Qual SQL é compreendido

- SELECT com colunas, `*`, aliases (AS) e DISTINCT
- WHERE com `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT
- GROUP BY com COUNT, SUM, AVG, MIN, MAX, e HAVING
- ORDER BY (ASC, DESC), LIMIT e OFFSET
- um INNER ou LEFT JOIN … ON um campo = outro
- comentários, nomes entre aspas e valores entre aspas duplas (lidos como texto, como o MySQL faz)

Todo o resto é recusado com uma mensagem que diz o que e onde: CASE, subconsultas, `COUNT(DISTINCT …)`, LIKE … ESCAPE, mais de um JOIN, instruções que não sejam SELECT e comparações com NULL (escreva IS NULL no lugar).

Algumas regras do SQL são mantidas de propósito: `<>` e NOT IN deixam de fora os documentos em que o campo é nulo ou não existe, como o SQL faz, e um número inteiro acima de 9007199254740991 é recusado em vez de arredondado.

## Importar e exportar arquivos SQL

Importar um dump SQL e exportar coleções como SQL é função do próprio app: **SQL ↔ MongoDB** na barra lateral, uma página que informa em qual conexão e banco de dados ela trabalha. Este plugin não importa nem exporta.

## Permissões

- **Ler documentos** (`documents:read`): para executar a consulta na coleção aberta e ler uma amostra dela para sugestões e exemplos.
- **Ler as outras coleções do mesmo banco de dados** (`database:read`): para executar um JOIN, que lê a coleção que ele nomeia. Sem um JOIN, nenhuma outra coleção é lida.

As leituras passam pelo app, com os direitos do usuário conectado e o mascaramento de campos.

## Configurações

Nenhuma.

## Limites

- Executar mostra no máximo 50 linhas. Um LIMIT maior, ou nenhum, mostra as primeiras 50 e informa que há mais correspondências.
- Executar lê apenas a coleção aberta aqui (e a que um JOIN nomeia). Uma consulta cujo FROM nomeia outra coleção é traduzida, mas não executada; abra essa coleção para executá-la.
- Usar em Documentos mantém LIMIT e OFFSET somente no código: Documentos pagina seus resultados por conta própria.
- As sugestões de campos e valores vêm dos primeiros 100 documentos da coleção, com até 20 valores por campo.
- Com documentos grandes (logs de API, por exemplo), só é lido o que cabe em uma resposta à página (1 MB): Executar mostra menos linhas e informa que há mais correspondências, e as sugestões vêm de menos documentos.
- Um JOIN por consulta, como um `$lookup` simples (localField e foreignField). Um JOIN nunca lê uma coleção do sistema.
- Uma consulta executada como pipeline (agrupada ou com JOIN) dura no máximo 10 segundos e não usa disco. As execuções nunca são adicionadas às consultas recentes do usuário.
