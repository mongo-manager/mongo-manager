# Script de índices

O Script de índices escreve os índices de uma coleção — ou de um banco de dados inteiro — como os comandos que os criam novamente: para o mongosh, para o driver do Node.js ou do Python, ou como JSON. Use-o para criar os mesmos índices em outro ambiente, guardá-los junto com o seu código ou planejar uma migração.

O plugin só lê. Nada é executado: o script é um texto para copiar ou salvar.

## Onde aparece

- **Aba da coleção:** uma aba **Script de índices** ao lado de Documentos, Agregações e das outras abas de cada coleção.

## Como usar

Abra uma coleção e depois a aba **Script de índices**. Ela lê os índices da coleção assim que é aberta.

- **Índices de:** **Esta coleção** ou **O banco de dados inteiro**: todas as coleções dele (as visualizações não têm índices próprios).
- **Escrito para:** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (o `create_index` do PyMongo) ou **JSON**: cada índice como `{ collection, key, options }` em Extended JSON canônico, exato até o tipo.

**Copiar** coloca o script na área de transferência; **Baixar** o salva (`.txt` para os scripts, `.json` para o JSON).

Cada opção de um índice é escrita: o nome, `unique`, `sparse`, um filtro parcial, um TTL (`expireAfterSeconds`), uma collation, `hidden`, os pesos e o idioma de um índice de texto, e o resto. O `createIndex` do driver (o do mongosh também) deixa de fora as opções que não conhece, como `prepareUnique`: um índice que tenha uma é escrito como o comando `createIndexes` (`db.runCommand(…)` no mongosh, `await db.command(…)` no Node.js), que mantém todas elas. Um índice de texto é escrito com os campos em que foi criado (`{ title: "text" }`), como os pesos dele indicam. Valores de tipo próprio (datas, ids, números, dados binários, timestamps) são escritos como a linguagem os cria. O índice `_id` padrão, ou um clusterizado, é criado com a coleção e fica de fora.

## Exemplo

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Para Python:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## Permissões

- **Ler a definição desta coleção** (`collection:read`): para listar os índices dela.
- **Ler as outras coleções do mesmo banco de dados** (`database:read`): para **O banco de dados inteiro**, a fim de listar as coleções e os índices delas.

As leituras passam pelo app com os direitos do usuário conectado e o mascaramento de campos. O valor de um filtro parcial em um campo oculto para o usuário chega como `"***"`: um índice que contenha um é marcado no script e na aba, já que o script não o criaria como ele é.

## Configurações

Nenhuma.

## Limites

- **O banco de dados inteiro** lê no máximo 100 coleções; a aba avisa quando há mais. Uma coleção cujos índices não puderam ser lidos é citada, com o motivo, na aba e no início do script; o JSON, que não tem onde dizer isso, não é copiado nem salvo nesse caso. Se o limite de leituras por minuto do app for ultrapassado, a aba para e avisa: tente novamente em um minuto.
- Índices de busca (Atlas Search, Vector Search) não são escritos: são criados de outra forma.
- Os scripts de Node.js e Python começam com as linhas que importam o que usam; conecte antes o `db` ao seu banco de dados. O script de Node.js usa await no nível superior: execute-o como um módulo ES (um arquivo `.mjs`).
- Os campos de uma chave chegam como um objeto, que lista primeiro os nomes que são números (`"2"`): a ordem em que uma chave composta assim foi criada se perde, e a aba e o script avisam isso (o JSON marca o índice como `keyOrderUncertain`; o que contém uma data que o JavaScript não consegue representar, como `farDate`).
