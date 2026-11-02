# Relatório de armazenamento

Quando os documentos de uma coleção são excluídos ou diminuem, o WiredTiger mantém o espaço liberado dentro do arquivo da coleção e o reutiliza em novas gravações; o arquivo não fica menor no disco. Um banco de dados que removeu boa parte dos dados pode reter gigabytes que ninguém usa. O relatório de armazenamento mostra, para cada coleção de um banco de dados, o que ela ocupa e quanto disso é espaço livre, e permite devolvê-lo com `compact`, como descrevem as visões de armazenamento do Atlas e do Compass, o `db.collection.stats()` e as próprias orientações do MongoDB.

## Como usar

Abra qualquer coleção e a aba **Armazenamento** dela: o relatório cobre todo o banco de dados da coleção.

1. O plugin lê as estatísticas de armazenamento de cada coleção por meio do app (`$collStats`), no máximo as primeiras 500 coleções por nome, somadas entre os shards. As views não têm armazenamento próprio e não são listadas.
2. As coleções aparecem com as mais recuperáveis primeiro. Cada linha informa os documentos, o tamanho dos dados, o tamanho de armazenamento (em disco), o tamanho dos índices, os bytes livres dentro do arquivo dela e dos arquivos dos índices, e que proporção desses arquivos isso representa. Os totais somam as coleções cujos tamanhos são conhecidos.
3. Uma coleção é marcada como **Vale compactar** quando pelo menos 20% dos arquivos dela e pelo menos 10 MB estão livres. Abaixo disso, o WiredTiger reutiliza o espaço por conta própria e a compactação custa mais do que devolve.
4. Escolha uma coleção para ver os tamanhos e o espaço livre dos índices dela e, em seguida:
   - **Estimar** pergunta ao MongoDB o que a compactação devolveria (`compact` com `dryRun`, MongoDB 8.0 e posterior; um servidor mais antigo, ou um atrás do mongos, informa isso).
   - **Compactar…** pede ao app que a compacte. O app mostra a própria caixa de diálogo — o que a compactação faz e que ela pode deixar o servidor mais lento — e só a executa depois que você digita o nome da coleção. Depois, o relatório é lido novamente.

**Atualizar** lê o relatório novamente. O relatório é lido no máximo duas vezes por minuto: em meio minuto, o mesmo é exibido, e uma compactação faz com que ele seja lido de novo.

Uma coleção de série temporal é listada, mas não é compactada aqui: as medições dela ficam em buckets próprios. A compactação também não é oferecida onde o app a recusaria: uma conexão somente leitura ou onde as regras de dados pessoais ocultam valores de você.

## O que saber sobre a compactação

- Ela reescreve os arquivos da coleção e dos índices dela. Pode demorar em uma coleção grande e deixa o servidor mais lento enquanto é executada: a página informa que está compactando até terminar, e apenas uma compactação de uma coleção é executada por vez. Em um conjunto de réplicas, apenas o membro em que ela é executada é compactado: execute-a em cada membro (secundários primeiro). A pergunta do app informa isso, e também a estimativa quando o MongoDB a fornece.
- Ela exige o direito da conexão de administrar bancos de dados e nunca é executada em uma conexão somente leitura. Cada execução é gravada no log de auditoria do app.
- O plugin em si nunca executa nada no servidor: ele pergunta ao app, e o app pergunta a você.

## Dados pessoais

Onde as regras de dados pessoais ocultam valores de você, os tamanhos da coleção também ficam ocultos (eles revelariam quantos dados ocultos existem): a linha dela diz **Oculto**, ela não entra nos totais e não é oferecida nem estimativa nem compactação para ela. A contagem de documentos continua sendo exibida.

## Permissões

- **Ler o banco de dados:** o armazenamento das coleções do banco de dados e a estimativa ou compactação de uma coleção diferente da própria aba.
- **Ler os detalhes da coleção:** a estimativa e a compactação da coleção da aba.
