# Dicionário de dados

Uma equipe que compartilha um banco de dados precisa saber o que cada coleção guarda: quais campos, de que tipo, quais são obrigatórios, o que significam, como as coleções se referenciam e quais índices existem. O Dicionário de dados escreve isso para um banco de dados inteiro, a partir do próprio modelo de dados do app, e salva como documento. NoSQLBooster ("Schema documentation"), Hackolade (HTML e PDF), DbSchema (Markdown) e Dataedo fazem o mesmo.

## Como usar

Abra qualquer coleção e a aba **Dicionário de dados** dela: ela documenta todo o banco de dados da coleção.

1. O plugin lê o modelo do banco de dados (o mesmo que a aba Banco de dados desenha) em uma única leitura: coleções, campos com seus tipos e com que frequência estão presentes, campos ocultos e referências.
2. Depois lê os índices e as regras de validação de cada coleção, uma após a outra, informando até onde chegou. Quando as leituras do minuto acabam, ele aguarda e continua; uma coleção cujos índices ou regras não puderam ser lidos informa o motivo, e as outras continuam sendo lidas.
3. **Markdown** e **HTML** salvam o dicionário como arquivo; **Copiar Markdown** o coloca na área de transferência, para uma wiki ou um pull request. Um dicionário com mais de 100.000 caracteres é copiado até a última linha completa antes desse limite, e a página avisa: salve como arquivo para ter tudo. Um arquivo tem no máximo 1 MB: um dicionário maior que isso é salvo com as primeiras coleções que couberem, e tanto a página quanto o arquivo informam quantas são; quando nem uma coleção cabe, nada é salvo e a página explica o motivo.

## O que ele mostra

Para cada coleção:

- **Campos:** o caminho, os tipos, com que frequência está presente, se o `$jsonSchema` o exige e a descrição, os valores permitidos e o tipo que as regras informam. Um campo oculto de você por ser dado pessoal aparece como oculto: apenas o nome e se as regras o exigem.
- **Referências:** as coleções a que ela se refere (por qual campo) e as que se referem a ela.
- **Índices:** as chaves de cada índice e se ele é único, se faz os documentos expirarem (TTL) ou se é parcial. O filtro de um índice parcial nunca é mostrado: ele pode conter valores.
- **Validação:** o nível e a ação, que não há regras, ou por que não foi possível lê-las. Um `$jsonSchema` combinado com outras regras por meio de `$and` também é lido.

Uma visualização informa de qual coleção ela é. Uma coleção que o modelo não conseguiu ler informa isso. A página e o arquivo HTML nunca executam scripts. Nos arquivos, o nome de uma coleção ou de um campo e o texto de uma regra são escritos como texto: nunca viram um link (nem um endereço, um nome `www.` ou um e-mail), uma imagem, uma tag ou uma tabela quebrada, e caracteres que não mostram nada ou que invertem o texto são removidos, na página também. Um valor permitido é mostrado com até 80 caracteres. A entrada de cada coleção no sumário leva até ela, tanto em HTML quanto em Markdown.

## Permissões

- **Ler o banco de dados:** as outras coleções do banco de dados e o modelo delas.
- **Ler os detalhes das coleções:** os índices e as regras de validação de cada coleção.
