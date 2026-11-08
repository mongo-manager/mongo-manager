# Gráficos

Gráficos desenha os valores de uma coleção: quantos documentos têm cada valor de um campo, como uma contagem ou uma soma se move ao longo do tempo, como um número se distribui ou como dois números se relacionam. Cada gráfico vem com uma tabela de resumo, e cada linha da tabela pode mostrar seus documentos em Documentos.

O plugin apenas lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Aba da coleção:** uma aba **Gráficos** ao lado de Documentos, Agregações e das outras abas de cada coleção e view.

## Como usar

Abra uma coleção e, em seguida, a aba **Gráficos**.

1. Escolha um tipo de gráfico: **Barras**, **Ao longo do tempo**, **Rosca**, **Histograma** ou **Dispersão**.
2. Escolha o campo (para Ao longo do tempo, um campo de data; para Histograma, um campo numérico; para Dispersão, um campo numérico para X e outro para Y).
3. Para Barras, Rosca e Ao longo do tempo, escolha uma **Medida**: Contagem, ou a Soma, a Média, o Mínimo ou o Máximo de outro campo numérico.
4. Para Ao longo do tempo, escolha um **Período**: Hora, Dia, Semana, Mês ou Ano.
5. Escolha os **Documentos do gráfico**: o **Filtro de Documentos** (a consulta da aba Documentos) ou a **Coleção inteira**.

O gráfico é desenhado assim que as escolhas estão completas e de novo a cada alteração. Passe o mouse sobre uma barra, fatia ou ponto para ver seu valor. Sob o gráfico, a tabela **Dados** lista o que foi desenhado; **Mostrar** coloca na consulta de Documentos um filtro para os documentos daquela linha.

## Exemplo

Uma coleção `orders` com um campo `status` e uma data `createdAt`:

- Barras, campo `status`, medida Contagem: uma barra por status, a maior primeiro.
- Ao longo do tempo, campo de data `createdAt`, período Mês, medida Soma de `total`: a receita por mês.
- Histograma de `total`: como os totais dos pedidos se distribuem em 12 faixas iguais.

Ao clicar em **Mostrar** na linha `shipped` do gráfico de barras, este filtro é colocado em Documentos:

```json
{ "status": { "$eq": "shipped" } }
```

## Tipos de gráfico

- **Barras:** os valores de um campo de texto, número, verdadeiro/falso ou ObjectId, agrupados e contados (ou somados, com média…), o maior primeiro. Um valor ausente tem sua própria barra.
- **Ao longo do tempo:** documentos por período de um campo de data, usando o `$dateTrunc` do servidor, em UTC.
- **Rosca:** como Barras, em partes de um todo.
- **Histograma:** um campo numérico em 12 faixas de mesma largura entre seu menor e seu maior valor.
- **Dispersão:** dois campos numéricos dos mesmos documentos, como pontos.

## Permissões

- **Ler documentos** (`documents:read`): os gráficos são pipelines de agregação executados na coleção aberta, e a lista de campos vem de uma amostra de seus documentos.

As leituras passam pelo aplicativo, com os direitos do usuário conectado e o mascaramento de campos. O plugin não pode ler outras coleções, índices nem nada fora da coleção em que é aberto.

## Configurações

Nenhuma.

## Limites

- A lista de campos vem de uma amostra aleatória de 200 documentos. Um campo que nenhum deles tem não é oferecido. De documentos grandes são tomados menos: quantos couberem em uma resposta à página (1 MB).
- Campos aninhados são oferecidos até dois níveis de profundidade (por exemplo `address.city`).
- Barras mostra os 12 maiores grupos; Rosca mostra 7. O restante é reunido em **Outros**, e a tabela diz o que Outros contém.
- Ao longo do tempo mostra os últimos 1.000 períodos. Quando há mais, os períodos mais antigos ficam de fora e o gráfico informa isso; escolha um período mais longo para vê-los.
- Histograma usa 12 faixas.
- Dispersão desenha uma amostra aleatória de no máximo 1.000 documentos que têm os dois números.
- Um valor dentro de um array não é representado como data nem como número: um array não é um instante.
- Cada pipeline é executado por no máximo 10 segundos, sem usar disco, um de cada vez. Um gráfico sobre uma coleção muito grande pode expirar; o filtro de Documentos pode restringi-lo.
- Os gráficos são executados no servidor; só os resultados agrupados chegam ao navegador.
