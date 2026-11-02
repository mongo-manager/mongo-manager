# Olá documentos

Olá documentos lista os documentos de uma coleção em uma tabela simples: o `_id` e os campos que a maioria dos documentos tem. É o modelo inicial para plugins do Mongo Manager, pequeno o bastante para ser lido em poucos minutos e feito para ser substituído pelo seu próprio plugin.

## Onde aparece

- **Guia da coleção:** uma guia **Olá** em cada coleção, depois das guias do próprio aplicativo. Ela lista os primeiros 50 documentos que o filtro de Documentos mantém.
- **Página:** **Olá documentos** na barra lateral. Aberta enquanto a guia de uma coleção está ativa, lista os primeiros 50 documentos dessa coleção; aberta de qualquer outro lugar, pede que você abra uma coleção primeiro.

## Como usar

- Abra uma coleção e escolha a guia **Olá**.
- Clique em **Abrir** em uma linha para mostrar esse documento em Documentos.
- Clique em **Recarregar** para ler os documentos novamente, por exemplo depois de alterar o filtro de Documentos.

Visualizações também funcionam: elas são marcadas como somente leitura, e o plugin nunca grava nada.

## Permissões

- **Ler documentos** (`documents:read`): para listar os documentos da coleção em que é aberto, como você, com os seus direitos e com a máscara de dados do aplicativo.

## Configurações

Nenhuma.

## Limites

- No máximo 50 documentos são listados, e no máximo quatro campos além de `_id`.
- Os valores são mostrados como uma linha de texto, cortada em 80 caracteres; documentos aninhados e arrays mostram apenas o tamanho.

## Criando seu próprio plugin a partir deste

Substitua este README pelo do seu próprio plugin: os administradores o leem na página de detalhes do plugin antes de aprová-lo. Use apenas títulos, parágrafos, listas e código: links, imagens, tabelas e HTML são mostrados como texto simples.

Para criar um plugin seu:

1. Altere `id`, `name`, `version`, `author`, `repository` e as contribuições em `mongo-manager-plugin.json`.
2. Escreva sua página em `main.js` e `style.css`.
3. Escreva cada texto nos dez idiomas do aplicativo (inglês, turco, chinês, japonês, espanhol, português, coreano, alemão, francês e russo): cada texto da página e do manifesto, cada nota do histórico de alterações e este README, com um `README.<lang>.md` ao lado do `README.md` para cada um dos outros nove.
4. Execute `node scripts/pack.mjs` para obter `<id>-<version>.tgz`, ou `node scripts/pack.mjs --folder <data-dir>/plugins` para testá-lo no seu próprio servidor.
5. Publique o arquivo como um recurso de uma versão (release) do GitHub.

O guia de Plugins na documentação do Mongo Manager explica cada campo, método e regra.
