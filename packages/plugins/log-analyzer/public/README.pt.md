# Analisador de logs

Quando um banco de dados fica lento, o log diz o motivo: as consultas lentas, as varreduras sem índice, os erros e as conexões. Lê-lo manualmente é demorado. O analisador de logs lê um arquivo de log do mongod ou do mongos no seu navegador e o resume, como o `mloginfo --queries` do mtools faz na linha de comando, o analisador de logs do NoSQLBooster faz na própria janela e o Query Insights do Atlas faz nos clusters que ele gerencia.

## Como usar

1. Abra **Analisador de logs** na barra lateral.
2. Solte um arquivo de log na página ou escolha um: os logs JSON estruturados do MongoDB 4.4 e posteriores, os logs de texto antigos, ou qualquer um dos dois compactados com gzip (`mongod.log.gz`, e também várias partes gzip unidas em um só), até 2 GB (no caso de gzip, depois de descompactado). Ele é lido em streaming, com uma barra de progresso e **Parar**. Uma linha com mais de 1 MB (nenhuma linha de log tem isso) é ignorada e contada como não lida; um arquivo gzip cortado é indicado como tal, junto com o que foi lido antes.
3. Veja o que foi encontrado:
   - **Resumo:** linhas, linhas que não foram lidas como linhas de log, o intervalo de tempo, operações lentas, erros, avisos, e a versão e o host do servidor. As severidades e os componentes são mantidos por nome até 16 e 200; as linhas dos demais são contadas e isso é informado (erros e avisos sempre são contados).
   - **Linha do tempo:** linhas de log e operações lentas por minuto (por hora, dia, semana ou quatro semanas em um log mais longo). Uma linha com horário anterior a 2009 ou mais de um dia depois de agora (um relógio incorreto) é contada, mas fica fora do intervalo e da linha do tempo, e a página informa quantas são.
   - **Operações lentas:** agrupadas por namespace, operação e **forma de consulta**: a consulta com os valores substituídos por `?`, de modo que consultas parecidas sejam contadas juntas. Para cada uma: quantidade, total, média, p95 (a partir de uma amostra de até 1.000 de suas durações) e tempo mais lento, os planos (uma varredura sem índice é marcada), e as chaves e os documentos lidos em comparação com os retornados. Ordene por tempo total, quantidade, mais lenta ou p95, do maior para o menor, acima da tabela ou pelo cabeçalho de uma coluna; a coluna usada na ordenação é marcada. **Copiar forma**, ou **Exemplo** para ver uma linha como ela foi escrita.
   - **Erros e avisos** por mensagem, com a frequência e o momento.
   - **Conexões:** quantas foram abertas e encerradas, o máximo simultâneo e cada cliente com seus aplicativos (no máximo 1.000 clientes; as linhas dos demais são contadas e isso é informado).
4. **Salvar as operações lentas como CSV** para uma planilha (o app salva no máximo 1 MB, então o CSV de um log muito movimentado mantém suas formas mais lentas, cortado em uma linha inteira, e a página informa quantas linhas ficaram de fora), ou **Ler outro arquivo**.

## Privacidade

O arquivo nunca sai do seu navegador: a página do plugin não pode acessar nenhum endereço e não lê nada dos seus bancos de dados. As formas não contêm valores. Uma linha como foi escrita, que pode conter valores, só aparece quando você pede o exemplo dela e nunca é enviada a lugar nenhum.

## Permissões

Nenhuma: ele lê apenas o arquivo que você fornece.
