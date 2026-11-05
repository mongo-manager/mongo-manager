# Filtros de data

Filtros de data coloca na consulta de Documentos, com um clique, os intervalos de datas pelos quais as pessoas costumam filtrar (hoje, os últimos 7 dias, este mês), de modo que não seja preciso escrever à mão `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }`.

O plugin apenas lê. Ele não altera nada no banco de dados: escreve um filtro na consulta de Documentos, que é executada como qualquer consulta que você digite.

## Onde aparece

- **Aba da coleção:** uma aba **Datas** ao lado de Documentos, Agregações e das demais abas de cada coleção e visualização.

## Como usar

Abra uma coleção e depois a aba **Datas**. O plugin lê 200 documentos aleatórios para encontrar os campos que contêm datas e escolhe o mais comum; **Campo** oferece os outros, e qualquer campo pode ser digitado.

Escolha um intervalo:

- **Intervalos rápidos:** Hoje, Ontem, Últimas 24 horas, Últimos 7 dias, Últimos 30 dias, Esta semana, Semana passada, Este mês, Mês passado, Este ano. Cada um mostra os dias que abrange.
- **Últimos:** as últimas n horas (até agora), os últimos n dias ou semanas (de 7 dias cada) até o fim de hoje, ou os últimos n meses: meses de calendário inteiros, incluindo o atual.
- **Entre dois dias:** do início de um dia ao fim de outro.

Um clique coloca na consulta de Documentos um filtro que seleciona o intervalo no campo, e a consulta é executada.

**Dias em** indica se os dias começam à meia-noite no horário do navegador ou em UTC. As semanas começam na segunda-feira (ISO 8601).

## Em _id

Quando `_id` contém ObjectIds, ele também é oferecido: um ObjectId começa com o segundo em que foi criado, então um intervalo em `_id` seleciona os documentos criados nele, mesmo em uma coleção sem nenhum campo de data. Ele também usa o índice de `_id`.

## Exemplo

Na quarta-feira, 28 de outubro de 2026, **Esta semana** em `createdAt` coloca em Documentos:

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(em UTC; no horário do navegador, os mesmos dias a partir das suas meias-noites).

## Permissões

- **Ler documentos** (`documents:read`): para ler a amostra que encontra os campos de data e para colocar um filtro na consulta de Documentos.

As leituras passam pelo aplicativo com os direitos e o mascaramento de campos do usuário conectado: um valor oculto não é uma data que o plugin possa ver. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Os campos de data são encontrados em uma amostra aleatória de 200 documentos; um campo raro pode não ser oferecido, mas pode ser digitado.
- Um intervalo é o mesmo para todos os documentos: uma data guardada como texto, ou como número de segundos, não é uma data para o plugin.
- Os intervalos são os do momento em que o botão é clicado.
