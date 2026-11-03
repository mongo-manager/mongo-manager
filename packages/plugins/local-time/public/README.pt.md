# Hora local

O MongoDB guarda as datas em UTC e Documentos as mostra assim: `2026-10-26T11:03:12.000Z`. Hora local mostra cada data como você lê o relógio — no fuso horário do seu navegador, ou em um que você definir — com a diferença em relação ao UTC, para que você não precise somar três horas de cabeça. É uma das mudanças mais pedidas no fórum de feedback do MongoDB Compass ("ver datas no horário local em vez de UTC").

O plugin não tem página própria e não lê nada do banco de dados. Ele só olha as datas que o app já está mostrando.

## Onde aparece

- **Valores de célula:** ao apontar para uma data em Documentos, a data no horário local: `26 de out. de 2026, 14:03:12 (UTC+3)`.

Aparece em qualquer lugar onde Documentos mostre uma data (tabela, árvore, cartões, inspetor de documentos), na dica da célula — ou ao lado do valor, se você escolher isso nas configurações. Nada é adicionado ao documento em si, e o valor continua sendo o armazenado.

## Configurações

Um administrador define estas na página Plugins, para todos:

- **Mostrar ao lado da data:** desativado, o horário local fica na dica; ativado, é escrito ao lado do valor.
- **Fuso horário:** um nome IANA como `Europe/Istanbul` ou `America/New_York`. Vazio, cada pessoa vê o fuso do próprio navegador. Um nome que o navegador não conhece é tratado como vazio, e cada data informa isso: `· fuso horário desconhecido "Europe/Istambul"`. Um fuso que é o próprio UTC é nomeado uma única vez: `(UTC)`.
- **Adicionar há quanto tempo foi:** acrescenta "há 3 dias" ou "em 2 horas" após a data — na unidade maior quando o arredondamento a alcança: "ontem", e não "há 24 horas".

## Exemplo

Um documento como este:

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

mostra, para alguém em Istambul: `26 de out. de 2026, 14:03:12 (UTC+3)` — ou, com um fuso definido, `26 de out. de 2026, 14:03:12 (Europe/Istanbul, UTC+3)`.

Datas anteriores a 1900 ou posteriores a 2200 ficam como o app as mostra.

## Permissões

- **Ler documentos:** um renderizador de células recebe os valores das células sobre as quais responde; este plugin lê apenas datas, e somente as que estão na tela.
