# Playground de busca

O Atlas Search e o Vector Search respondem a consultas que um índice comum não consegue: palavras com erros de digitação, pontuações de relevância, correspondências destacadas, documentos cujos embeddings estão próximos aos de uma consulta. Escrever à mão um estágio `$search` ou `$vectorSearch` para ver o que um índice retorna leva tempo; o Search Tester do Atlas e a visualização de índices de busca do Compass permitem testar um em poucos cliques. O Playground de busca faz o mesmo com os índices de busca de uma coleção.

## Como usar

Abra uma coleção e a aba **Busca**. Ela lista os índices de busca da coleção, cada um com seu tipo (texto completo ou vetorial) e seu estado; um que ainda não pode ser consultado (em construção, com falha) fica marcado e não pode ser executado.

### Texto completo

- **Buscar por**: as palavras.
- **Em**: um dos campos de texto que o índice mapeia, ou **Todos os campos** (todos os campos de um índice dinâmico; caso contrário, todos os campos de texto que ele mapeia).
- **Erros de digitação permitidos**: nenhum, uma letra ou duas (`fuzzy`).
- **Destaques**: os trechos correspondentes, com as palavras encontradas marcadas.
- **Resultados**: de 1 a 100.

### Vetorial

- **Campo vetorial**: um dos campos vetoriais do índice, com suas dimensões.
- **Vetor**: um vetor de consulta colado (`[0.1, 0.2, …]` ou números separados por vírgulas ou espaços), ou **Como um documento**: um dos 20 primeiros documentos da coleção, cujo próprio vetor encontra outros parecidos; pode ser uma lista de números ou um vetor BSON (subtipo binário 9) de valores float32 ou int8. O vetor deve ter as dimensões do índice.
- **Candidatos**: quantos vizinhos mais próximos o MongoDB considera (no mínimo o número de resultados e no máximo 10.000).
- **Filtro**: um objeto JSON sobre os campos de filtro do índice, como `{ "year": { "$gte": 2000 } }`.

**Buscar** executa o pipeline; cada resultado mostra sua pontuação, seus destaques e seus campos. **Usar em Agregações** envia o pipeline ao editor de Agregações, onde você pode adicionar estágios e salvá-lo.

## O que é necessário

Índices de busca existem no Atlas e no MongoDB Community 8.2 e posteriores com `mongot` (em prévia). Quando a busca não está habilitada ou a coleção não tem índice de busca, a aba avisa; crie um na página de Índices da coleção.

## Segurança

O app executa o pipeline como você, somente leitura, com o estágio de busca primeiro e sem nada que grave, una outra coleção ou execute código. Os destaques são exibidos como texto, nunca como marcação. Campos ocultos de você como dados pessoais não são oferecidos, e um usuário de quem dados pessoais são ocultados tem a busca recusada onde as regras alcançam (ela poderia revelar os valores ocultos pelo que encontrasse): a aba avisa isso antes de você buscar.

## Permissões

- **Ler documentos:** os resultados da busca e os documentos dos quais um vetor é obtido.
- **Ler detalhes da coleção:** os índices de busca da coleção — seus nomes, estados e os campos que mapeiam, nunca um oculto.
