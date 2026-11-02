# Remodelar

A forma de uma coleção muda conforme uma aplicação cresce: `fullName` vira `name.full`, um objeto `address` vira colunas planas para um relatório, um preço guardado como texto precisa ser um número. O Remodelar cria essas mudanças como etapas, mostra o resultado nos seus próprios documentos e as envia para Agregações como um pipeline — sem script de migração e sem tocar na coleção. Studio 3T ("Reschema") e NoSQLBooster ("Collection re-schema tool") oferecem o mesmo.

## Como usar

1. Abra uma coleção e a guia **Remodelar** dela. Ela lê uma amostra de 50 documentos para conhecer os campos.
2. Adicione **etapas**, em ordem:
   - **Renomear ou mover:** um novo nome; `a.b` move o campo para dentro de um objeto.
   - **Nivelar um objeto:** `address.city` vira `address_city` (o separador é você quem escolhe, sem `.` nem `$`). Somente as chaves movidas saem do objeto: uma chave que a amostra não encontrou permanece nele, um valor que não é um objeto permanece como está, e um objeto que ficou vazio após a mudança é removido (um que já era vazio permanece).
   - **Aninhar em um objeto:** os campos marcados na lista são reunidos sob um novo (`lat`, `lng` → `location`), que substitui o que houver ali; dois campos que terminam com o mesmo nome são recusados, pois um seria perdido, e também um campo e outro dentro dele.
   - **Converter o tipo:** para int, long, double, decimal, string, date, bool ou ObjectId; um valor que não pode ser convertido vira null ou é mantido. Um campo ausente continua ausente, um null continua null.
   - **Padrão se ausente** (ou **se ausente ou null**): um valor para um campo ausente, ou para um campo ausente ou null — a escolha é sua, e a etapa recebe o nome de acordo com ela.
   - **Remover**, **Dividir texto em uma lista**, **Unir uma lista em texto** (um elemento que não pode ser texto, como um objeto, é unido como nada).
3. A **prévia** mostra os mesmos cinco documentos de amostra antes e depois, executados pelo próprio MongoDB, quando você para de editar. Uma etapa que sobrescreve um campo existente avisa isso, e uma que escreve dentro de uma lista de documentos informa que o valor é definido em cada um deles; uma etapa com problema diz qual é e fica de fora dos estágios; uma etapa que ainda não recebeu seus nomes é contada como não concluída e fica de fora até que seja.
4. No máximo 48 estágios são visualizados e enviados; acima disso, a prévia explica por que não mostra o Depois.
5. **Usar em Agregações** envia os estágios (o aplicativo pergunta antes). Para gravar o resultado, adicione lá um estágio `$out` que nomeie uma nova coleção: Agregações mostra o que a gravação faria e pergunta antes de executá-la. **Copiar estágios** os coloca na área de transferência.

## O que nunca faz

- Nunca altera a coleção: cria estágios `$set` e `$unset`, somente leitura, e nunca cria por conta própria um `$out` ou `$merge`.
- `_id` nunca é renomeado, movido nem removido. Campos ocultos de você como dados pessoais não são oferecidos, nem os objetos que os contêm, e uma etapa que fosse ler, mover, gravar ou remover um deles — inclusive por um nome que você digite — é recusada. Um campo que a amostra encontrou apenas como valor é retido quando uma regra nomeia um campo abaixo dele pelo próprio nome (`profile.ssn`), mas não quando uma regra chega a ele por `*` (`*.ssn`), o que não deixaria nenhum campo. Quando o aplicativo não consegue saber a tempo quais campos estão ocultos, nenhum campo é oferecido até que **Tentar novamente** o informe.
- Um nome que um campo não pode ter (vazio, com `$`, `a..b`) é recusado, assim como um campo movido para dentro de si mesmo.
- Um valor padrão ou um separador é sempre um valor, nunca lido como um campo ou um operador.

## Permissões

- **Ler documentos:** uma amostra para conhecer os campos e os documentos da prévia, com os seus direitos e com os seus campos ocultos mantidos ocultos.
