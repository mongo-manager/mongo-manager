# Analisador de chaves de shard

A chave de shard decide como os documentos de uma coleção fragmentada (sharded) são distribuídos entre os shards, e uma escolha ruim é difícil de desfazer: com poucos valores distintos, os chunks não podem ser divididos; se um valor está em muitos documentos, um shard assume toda essa carga; e, se um valor cresce a cada inserção (uma data, um contador, um ObjectId), todas as inserções caem no mesmo shard. O MongoDB 7.0 adicionou o `analyzeShardKey` para medir uma candidata antes de fragmentar; o Atlas e a documentação do MongoDB avaliam a resposta dele da mesma forma. O analisador de chaves de shard faz essa consulta por você e coloca as candidatas lado a lado.

## Como usar

Abra uma coleção e a aba **Chave de shard** dela.

1. O plugin amostra os documentos da coleção (200) e oferece os campos deles. Campos ocultos de você como dados pessoais nunca são oferecidos, nem campos dentro de um array, campos que contêm arrays (o MongoDB os recusa em uma chave de shard), objetos inteiros ou campos com nome de número inteiro (`"0"`: a página não conseguiria manter a posição deles na chave).
2. Crie uma candidata: escolha um campo, **Crescente** ou **Hash**, e clique em **Adicionar campo**; uma candidata aceita até cinco campos, com no máximo um hasheado. Um chip remove um campo.
3. **Analisar** pede ao MongoDB, por meio do app e como você, que analise a candidata: `analyzeShardKey` com as características da chave, amostrando até 10.000 documentos.
4. Até seis candidatas ficam lado a lado. Para cada uma:
   - **Valores distintos**: boa a partir de 1.000, razoável a partir de 100, ruim abaixo disso (uma chave única é sempre boa);
   - **Valor mais frequente**: a proporção dos documentos amostrados que o contêm; boa abaixo de 5%, razoável abaixo de 20%, ruim a partir de 20%;
   - **Monotonicidade**: uma chave que cresce a cada inserção é ruim; uma chave hasheada a distribui e é boa;
   - se a chave é única, quantos documentos foram amostrados, o tamanho médio deles e os cinco valores mais frequentes com suas contagens;
   - um **Veredito**, o pior dos três.

O × de uma candidata a remove.

## O que o MongoDB pode não informar

- Um servidor standalone não pode analisar: o `analyzeShardKey` precisa de um conjunto de réplicas ou de um cluster fragmentado.
- O MongoDB anterior à versão 7.0 não tem esse comando.
- O MongoDB precisa de um índice que comece pela chave: se não houver, o plugin indica o índice a criar, e **Copiar** coloca o comando do shell na área de transferência. Nada é criado por você.

## Dados pessoais

Os valores mais frequentes são os próprios valores da coleção. Quando as regras de dados pessoais alcançam a coleção para você, o app recusa a análise (ela revelaria valores ocultos) e a página explica o motivo.

## Permissões

- **Ler documentos:** os documentos amostrados de onde vêm os campos e a análise, cujos valores frequentes são dados.
