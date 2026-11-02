# Expiração (TTL)

Um índice TTL remove cada documento de uma coleção depois de um tempo definido a partir da data de um de seus campos: sessões após um dia, logs após um mês. Expiração mostra, para cada índice TTL de uma coleção, quando seus documentos saem: quantos já expiraram mas ainda não foram removidos, quantos saem na hora, no dia, na semana, mais tarde, e quantos ele nunca remove.

O plugin apenas lê. Ele não altera nada no banco de dados e não remove nada.

## Onde aparece

- **Guia da coleção:** uma guia **Expiração** ao lado de Documentos, Agregações e das outras guias de cada coleção e visualização.

## Como usar

Abra uma coleção e depois a guia **Expiração**. Ela lê os índices da coleção e conta assim que é aberta; **Contar novamente** conta de novo, a partir do momento do clique.

Cada índice TTL é um cartão: seu campo, quanto tempo depois da data do campo um documento é removido (`expireAfterSeconds`; 0 significa na própria data) e seu filtro parcial, se houver. Seus documentos são contados em seis grupos:

- **Expirado, ainda não removido:** o tempo já passou. O monitor de TTL do servidor é executado cerca de uma vez por minuto e os remove; em um servidor ocupado, pode atrasar.
- **Na próxima hora**, **Em 1–24 horas**, **Em 1–7 dias**, **Após 7 dias:** cada grupo começa onde o anterior termina.
- **Nunca:** o campo não contém uma data (ausente, ou texto ou número) ou, em um índice parcial, o documento está fora do filtro.

**Mostrar** coloca na consulta de Documentos um filtro que seleciona os documentos de um grupo.

## Exemplo

Em uma coleção `sessions` com `createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })`:

```
lastSeen   Remove um documento 1 dia depois da data de lastSeen
Expirado, ainda não removido   0 documentos
Na próxima hora               12 documentos
Em 1–24 horas                340 documentos
Em 1–7 dias                    0 documentos
Após 7 dias                    0 documentos
Nunca                          3 documentos
```

Os três que nunca saem não têm data em `lastSeen`: **Mostrar** em **Nunca** os encontra.

## Permissões

- **Ler a definição desta coleção** (`collection:read`): para listar seus índices.
- **Ler documentos** (`documents:read`): para contar cada grupo com um pipeline somente leitura e para colocar um filtro na consulta de Documentos.

As leituras passam pelo aplicativo com os direitos do usuário conectado e o mascaramento de campos: um campo TTL oculto para o usuário não pode ser contado, e seus grupos informam isso. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Cada grupo é um pipeline, um intervalo sobre o campo TTL, que seu índice pode atender (**Nunca** e o filtro de um índice parcial podem ler a coleção inteira); cada um é executado por no máximo 10 segundos. Um grupo que não pôde ser contado informa isso, e o motivo.
- Um documento cujo campo contém várias datas é removido pela mais antiga e contado no grupo dela.
- Somente os índices TTL são lidos. O `expireAfterSeconds` próprio de uma coleção de séries temporais ou clusterizada não é exibido.
