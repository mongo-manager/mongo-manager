# Localizador de duplicados

O localizador de duplicados lista os valores que mais de um documento de uma coleção compartilha, em campos que deveriam ser únicos: um endereço de e-mail, um número de pedido, um nome e um sobrenome juntos. Cada valor mostra quantos documentos o compartilham, os mais compartilhados primeiro, e os próprios documentos estão a um clique.

O plugin só lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Aba da coleção:** uma aba **Duplicados** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.

## Como usar

1. Abra uma coleção e, em seguida, a aba **Duplicados**.
2. Em **Campos que deveriam ser únicos**, digite o nome de um campo e pressione Enter, ou clique em um dos campos sugeridos em **Nesta coleção**. Para um campo aninhado, digite o caminho dele: `address.city`. Vários campos digitados de uma vez, separados por vírgulas, são adicionados juntos.
3. Adicione até cinco campos para verificá-los juntos: nesse caso, os documentos só são duplicados quando todos esses campos coincidem.
4. Defina as opções descritas abaixo e pressione **Encontrar duplicados**.

As opções:

- **Ignorar maiúsculas e minúsculas:** `Ada@Example.com` e `ada@example.com` contam como o mesmo valor. Desativada por padrão.
- **Omitir documentos sem o campo:** documentos em que um campo escolhido está ausente ou é null não são agrupados. Ativada por padrão; desative para ver quantos documentos não têm o campo.
- **Onde procurar:** a **Coleção inteira** (o padrão) ou apenas os documentos do **Filtro de documentos**.

O resultado informa quantos valores duplicados foram encontrados e quantos documentos estão envolvidos. Cada linha mostra um valor e sua contagem:

- **Listar os documentos** abre a linha para mostrar os primeiros 20 dos seus documentos; **Abrir** mostra um deles no app.
- **Mostrar** (ou **Todos em Documentos**) coloca na consulta de Documentos um filtro com os documentos desse valor, onde é possível percorrer todos eles página a página.

## Exemplo

Uma coleção `users` em que `email` deveria ser único. Escolha `email`, ative **Ignorar maiúsculas e minúsculas** e pressione **Encontrar duplicados**. Uma linha como esta:

```
ada@example.com     3 documentos
```

significa que três usuários compartilham esse endereço com alguma grafia diferente. **Mostrar** coloca em Documentos um filtro com esses três documentos, onde você pode decidir qual manter.

Para encontrar pessoas cadastradas duas vezes, escolha `firstName` e `lastName` juntos: só são agrupados os documentos em que os dois campos coincidem.

## Como funciona

O agrupamento é executado no servidor como um único pipeline de agregação somente leitura: um `$match` para o filtro (e para os campos ausentes, quando omitidos), um `$group` nos campos escolhidos e, depois, os grupos com mais de um documento, ordenados por contagem. Somente os grupos voltam para o navegador, nunca a coleção inteira.

Quando as maiúsculas e minúsculas são ignoradas, os valores de texto são comparados em minúsculas (`$toLower`); os outros tipos são comparados como estão.

## Permissões

- **Ler documentos** (`documents:read`): para executar o pipeline de agrupamento, ler alguns documentos para sugerir campos e listar os documentos de um grupo.

As leituras passam pelo app, com os direitos e o mascaramento de campos do usuário conectado. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Até 5 campos por vez.
- São listados até 200 valores duplicados, os mais compartilhados primeiro. Quando há mais, a contagem aparece como “200+” e uma nota informa que apenas os 200 mais compartilhados são listados.
- Um grupo lista seus primeiros 20 documentos; Mostrar coloca todos em Documentos.
- Os campos sugeridos vêm dos primeiros 50 documentos da coleção (no máximo 12 sugestões); qualquer outro campo pode ser digitado.
- Com documentos grandes (logs de API, por exemplo), só é lido o que cabe em uma resposta à página (1 MB): as sugestões vêm de menos documentos, menos valores longos são listados (uma nota avisa) e um grupo abre com os primeiros documentos que cabem.
- Os valores são comparados exatamente como estão armazenados, exceto pelas maiúsculas e minúsculas quando ignoradas. Um número armazenado como texto e o mesmo número armazenado como número são valores diferentes.
- O pipeline é executado por no máximo 10 segundos, sem uso de disco. Em uma coleção muito grande, restrinja-a com o filtro de Documentos.
