# Anonimizador

Uma pessoa desenvolvedora precisa de dados parecidos com os de produção para reproduzir um bug; uma equipe quer compartilhar uma amostra com um fornecedor; um ambiente de testes deve parecer real sem guardar dados pessoais de ninguém. A cópia anônima do próprio app escreve `***` no lugar dos valores ocultos. O Anonimizador, por sua vez, gera dados que continuam parecendo e se comportando como os originais, na linha de ferramentas como o mascaramento de dados do Studio 3T, o Hackolade e os recursos de mascaramento das plataformas de banco de dados: valores fictícios do mesmo tipo, hashes que mantêm as junções funcionando, valores embaralhados entre documentos, datas deslocadas um pouco e números com ruído.

## Como usar

Abra uma coleção e a aba **Anonimizar** dela.

1. O plugin coleta uma amostra aleatória de 100 documentos e lista os campos deles (um campo dentro de um objeto ou de um array de objetos é listado separadamente; o objeto que o contém não é, a menos que alguns documentos tenham ali um valor em vez de um objeto: nesse caso ele também é listado, marcado como _quando não é um objeto_, para esses valores). Cada campo recebe uma técnica:
   - **Manter** — o valor como está.
   - **Valor fictício** — um valor realista do mesmo tipo, pelo nome e tipo do campo ou pelo tipo que você escolher (nome completo, e-mail, telefone, endereço, cidade, CEP, empresa, frase, UUID, data…): um e-mail continua sendo um e-mail, em um domínio de exemplo; um telefone, em uma faixa que nenhuma linha tem.
   - **Hash consistente** — a mesma entrada gera a mesma saída em toda a cópia (um e-mail mantém o mesmo hash em todos os documentos que o têm, então você ainda pode agrupar ou juntar por ele), e o tipo é mantido (um ObjectId continua sendo um ObjectId; um inteiro, um inteiro). A chave é gerada quando a aba é aberta e nunca é salva: duas sessões geram hashes diferentes.
   - **Embaralhar** — os valores do campo são trocados entre os documentos: todos os valores continuam lá, nenhum no próprio documento.
   - **Deslocar datas** — as datas são movidas em até ± os dias que você informar, os mesmos dias para todas as datas de um documento (a ordem dos eventos de uma pessoa é mantida). Datas escritas como texto mantêm o formato.
   - **Ruído numérico** — os números mudam em até ± a porcentagem que você informar; um inteiro continua sendo um inteiro.
   - **Null**, **Remover**, **Mascarar** (`***`).
     Um `_id` só pode ser mantido, ter hash, ser simulado (como ObjectId ou UUID), embaralhado ou removido (a importação então gera novos): nunca algo que faça dois documentos compartilharem o mesmo.
     Campos que identificam uma pessoa, um endereço ou uma conta (nomes, e-mails, telefones, ruas, CEPs, datas de nascimento, senhas, IBANs…) começam como **Valor fictício**; os demais, como **Manter**.
2. **Campos que não estão na amostra**: os que um documento posterior tem e a amostra não tinha ficam de fora por padrão, assim como um valor encontrado onde a amostra só tinha objetos; você pode mantê-los.
3. A pré-visualização mostra cinco documentos antes e depois e acompanha cada mudança. **Novos valores** gera novos valores fictícios, novos embaralhamentos e uma nova chave de hash.
4. **Criar a cópia** lê até 1.000 documentos (você escolhe quantos), página por página em ordem de `_id` (todo tipo de `_id`, números antes de ObjectIds, como o MongoDB ordena), e os anonimiza na página. A cópia tem no máximo o que o app aceita em uma mensagem (cerca de 1 MB): quando não cabe mais, ela é cortada em um documento inteiro e a página avisa.
5. Depois:
   - **Salvar NDJSON** ou **Salvar JSON** salva a cópia como arquivo;
   - **Importar…** abre o assistente de importação do app em uma nova coleção do mesmo banco de dados (por padrão `<coleção>_anonymised`) com a cópia como arquivo: lá você confere, mapeia e inicia a importação.

**Salvar configurações** salva a técnica de cada campo como um arquivo JSON (nunca a chave do hash nem qualquer valor); **Carregar configurações** aplica um arquivo novamente: um campo que o arquivo cita e esta coleção não tem é contado e ignorado.

## Dados pessoais

Um campo que as regras de dados pessoais ocultam de você nunca é mantido: o plugin só teve `***` para ele. Ele pode ser mascarado, simulado, definido como null ou removido, e um campo oculto que a amostra não mostrou é mascarado onde quer que apareça. A coleção em si nunca é alterada: a cópia vai apenas para onde você a salvar ou importar.

## Permissões

- **Ler documentos:** os documentos dos quais a cópia é feita.
- **Ler o banco de dados:** entregar a cópia ao assistente de importação para outra coleção do banco de dados.
