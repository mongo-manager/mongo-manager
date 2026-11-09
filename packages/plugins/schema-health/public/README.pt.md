# Integridade do esquema

A Integridade do esquema verifica se uma coleção tem os antipadrões de esquema descritos na documentação do MongoDB: documentos e arrays que crescem demais, aninhamento profundo, documentos com muitíssimos campos, campos que contêm mais de um tipo e índices em excesso, sem uso ou redundantes. Cada achado diz o que foi encontrado, por que importa e o que fazer a respeito.

O plugin apenas lê. Ele não altera nada no banco de dados: sugere, e você decide.

## Onde aparece

- **Aba da coleção:** uma aba **Integridade** ao lado de Documentos, Agregações e das demais abas de cada coleção e visualização.

## Como usar

Abra uma coleção e depois a aba **Integridade**. A verificação é executada assim que a aba é aberta; **Verificar** a executa de novo, por exemplo depois de alterar os dados ou os índices.

A leitura acontece em três etapas, cada uma exibida enquanto é executada:

1. uma amostra aleatória de até 1.000 documentos, para arrays, aninhamento, número de campos e tipos;
2. o tamanho de até 10.000 documentos aleatórios, medido pelo servidor;
3. os índices da coleção e seus contadores de uso.

Os achados são listados por gravidade: primeiro **Risco alto**, depois **Aviso** e então **Informação**. Cada um indica o campo ou o índice a que se refere, o que foi encontrado, por que importa e o que fazer. Quando um filtro consegue selecionar exatamente os documentos a que um achado se refere, **Mostrar em Documentos** coloca esse filtro na consulta de Documentos.

**O que é verificado**, uma seção da aba que se abre com um clique, lista os limites em uso, com os limites do próprio MongoDB ao lado.

## As verificações

- **Documentos grandes:** acima de 1 MB é um aviso; acima de 8 MB, risco alto. O MongoDB recusa documentos com mais de 16 MB.
- **Array grande:** um array com mais de 1.000 elementos em um documento da amostra é um aviso; com mais de 10.000, risco alto. São listados até 10 desses arrays.
- **Aninhamento profundo:** documentos aninhados em mais de 20 níveis (o limite do MongoDB é 100).
- **Muitíssimos campos:** um documento da amostra com mais de 200 campos.
- **Tipos mistos:** um campo que contém mais de um tipo na amostra, exceto null (por exemplo, um número na maioria dos documentos e uma string em alguns). São listados até 20 desses campos.
- **Muitos índices:** mais de 20 índices na coleção (o MongoDB permite 64).
- **Índice sem uso:** um índice cujo uso o servidor não contabilizou desde que começou a contar (desde a última reinicialização). O índice `_id`, os índices únicos e os índices TTL nunca são informados como sem uso: eles funcionam sem consultas.
- **Índice redundante:** um índice cujas chaves são o início das chaves de outro índice, na mesma direção ou na oposta, de modo que o outro pode atender às suas consultas. Só conta como o que o cobre um índice visível com a mesma ordenação (collation), que não seja esparso (sparse) nem parcial.

## Exemplo

Em uma coleção `orders`, a verificação pode informar:

```
Risco alto   Array grande         items: até 12.400 elementos em um documento da amostra.
Informação   Tipos mistos        total: number em 981 documentos amostrados, string em 19.
Informação   Índice redundante    customerId_1: suas chaves são o início das chaves de customerId_1_createdAt_-1.
```

**Mostrar em Documentos** no achado de tipos mistos coloca `{ "total": { "$type": "string" } }` em Documentos, para que os 19 documentos fora do padrão possam ser corrigidos.

## Em visualizações

Uma visualização não tem índices próprios. Em uma visualização, o plugin não lê índices nem diz nada sobre eles; a amostra e o tamanho dos documentos são verificados como em uma coleção.

## Permissões

- **Ler documentos** (`documents:read`): para ler a amostra e medir o tamanho dos documentos, ambos por meio de pipelines de agregação somente leitura.
- **Ler os índices desta coleção** (`collection:read`): para listar os índices, suas opções e seus contadores de uso.

As leituras passam pelo aplicativo, com os direitos e o mascaramento de campos do usuário conectado. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Arrays, aninhamento, número de campos e tipos são avaliados a partir de uma amostra aleatória de 1.000 documentos; um problema raro pode não estar na amostra. Execute a verificação de novo para obter outra amostra.
- Os tamanhos são medidos em uma amostra aleatória de 10.000 documentos. A medição exige o MongoDB 4.4 ou posterior (`$bsonSize`); em um servidor mais antigo, as demais verificações ainda são executadas e a aba informa que não foi possível medir os tamanhos.
- Documentos grandes reduzem as duas amostras: a amostra pega os documentos que cabem em uma resposta do app à página (cerca de 1 MB) e, quando o MongoDB precisa de mais memória para os tamanhos do que permite sem disco, é medida uma amostra de 1.000 e depois de 100. A linha de status diz quantos foram de fato amostrados e medidos. Se nem um documento couber em uma resposta, os tamanhos medidos continuam aparecendo e a aba informa que não foi possível amostrar os documentos.
- Os contadores de uso recomeçam quando o servidor é reiniciado, e cada membro de um conjunto de réplicas conta por conta própria. Um índice usado apenas em outro membro, ou apenas antes de uma reinicialização, pode ser informado como sem uso. Oculte um índice antes de descartá-lo e fique atento a consultas lentas.
- Cada pipeline é executado por no máximo 10 segundos, sem uso de disco.
- Os limites são padrões do próprio plugin, não configurações; o MongoDB não publica os que o Atlas usa.
