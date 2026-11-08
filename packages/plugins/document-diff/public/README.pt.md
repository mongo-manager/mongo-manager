# Comparação de documentos

A Comparação de documentos compara um documento com outro da mesma coleção, campo a campo, e lista o que foi adicionado, removido ou alterado. Objetos aninhados são comparados campo a campo e arrays elemento a elemento, de modo que uma mudança no fundo de um documento aparece no seu próprio caminho.

O plugin apenas lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Ação de documento:** **Comparar com…** no menu de ações de uma linha de documento em Documentos. Abre em uma caixa de diálogo sobre a coleção.

## Como usar

1. Em Documentos, abra o menu do documento que você quer comparar e escolha **Comparar com…**. Esse documento é o lado **Esquerda**.
2. Informe o lado **Direita**: digite o `_id` dele na caixa ou escolha um em **Ou um desta coleção**.
3. Clique em **Comparar**.

O resultado começa com um resumo (quantos campos foram alterados, estão somente à esquerda, somente à direita ou são iguais) e lista os campos alterados. **Quais campos** alterna entre **Somente diferenças** e **Todos os campos**. **Trocar os lados** troca Esquerda e Direita. **Copiar as diferenças como JSON** copia a lista de mudanças para a área de transferência.

## Digitando um _id

A caixa interpreta o que você digita do jeito que você quis dizer:

- 24 dígitos hexadecimais são um ObjectId: `652f1c0e9b1e8a3d4c5b6a79`
- um número inteiro é um número (um int, ou um long quando for maior): `1042`
- um número decimal é um double: `3.5`
- texto que começa com `{`, `[` ou aspas duplas é lido como Extended JSON: `{ "$uuid": "…" }` ou `"A-100"`
- qualquer outra coisa é uma string: `A-100`

## Exemplo

Esquerda:

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Direita:

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

A comparação lista `tags.1` alterado de `"b"` para `"c"`, `address.city` alterado e `address.zip` somente à direita; `name` é igual. Os campos `_id` ficam de fora: dois documentos sempre diferem nele.

## Como os valores são comparados

- Objetos são comparados por campo e arrays por índice (posição 0, 1, 2…).
- Qualquer outro valor é comparado por inteiro, pelo seu Extended JSON. Um número armazenado como int de um lado e como double do outro é uma mudança, assim como uma string `"5"` contra um número `5`.
- Cada linha informa seu tipo com palavras (Alterado, Somente à esquerda, Somente à direita, Igual), não só por cor.

## Permissões

- **Ler documentos** (`documents:read`): para ler os dois documentos e para listar documentos da coleção entre os quais escolher.

As leituras passam pelo aplicativo, com os direitos e o mascaramento de campos do usuário conectado. O plugin não consegue ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Os dois documentos devem estar na mesma coleção.
- A lista de escolha contém até 50 documentos da consulta atual de Documentos (sem o próprio documento), nomeados pelo primeiro campo que tiverem entre `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` e `slug`. Qualquer outro documento pode ser comparado digitando o `_id` dele.
- O aninhamento é seguido até 100 níveis; abaixo disso, um valor é comparado por inteiro.
- Valores longos são abreviados na tabela; passe o cursor sobre um para ver mais (até 2.000 caracteres).
- Se o documento da esquerda foi excluído desde que o menu foi aberto, a caixa de diálogo informa isso e não compara nada.
