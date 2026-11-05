# UUIDs legados

Antes de o MongoDB ter um tipo UUID padrão (subtipo binário 4), os drivers armazenavam UUIDs como binários de subtipo 3, cada um com sua própria ordem de bytes: o driver Java invertia cada metade dos bytes, o driver C# (o `Guid` do .NET) invertia os três primeiros grupos e o driver Python mantinha a ordem. Por isso os mesmos 16 bytes são lidos como três UUIDs diferentes, e um UUID procurado deve ser escrito na ordem do driver que o armazenou. Este plugin os lê em todas as ordens, informa em qual ordem um campo foi gravado e encontra um UUID independentemente de como foi armazenado.

O plugin apenas lê. Não altera nada no banco de dados.

## Onde aparece

- **Em Documentos:** apontar para um UUID legado (um binário de 16 bytes de subtipo 3) o mostra lido nas ordens de Java, C# e Python.
- **Aba da coleção:** uma aba **UUIDs** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.

## Como usar

Abra uma coleção e depois a aba **UUIDs**. Uma amostra aleatória de 1.000 documentos é lida assim que a aba abre; **Verificar novamente** lê outra.

**Campos UUID** lista cada campo da amostra que contém UUIDs (inclusive campos aninhados e arrays), com quantos são legados e quantos são padrão. Para um campo de UUIDs legados, informa o driver cuja ordem de bytes lê todos os valores como UUIDs bem formados: o dígito de versão e os bits de variante de um UUID ficam em posições fixas e, lidos na ordem errada, quase nunca caem ali. Mostra o primeiro valor do campo lido em cada ordem. **Localizar neste campo** preenche o localizador com o campo e esse driver.

**Localizar um UUID** aceita um UUID como as pessoas o escrevem (32 dígitos hexadecimais, com ou sem hifens ou chaves, ou `UUID("…")`), o campo onde procurar e como foi armazenado: **Qualquer um destes**, o subtipo padrão, ou a ordem legada de Java, C# ou Python. Mostra o valor como cada driver o armazenou, como o shell o escreve (`BinData(3, "…")`, `UUID("…")`), com um botão para copiar cada um. **Mostrar em Documentos** coloca na consulta de Documentos um filtro que seleciona os documentos com esse UUID; com **Qualquer um destes**, encontra o valor de qualquer driver.

## Exemplo

O UUID `00112233-4455-6677-8899-aabbccddeeff`, como cada driver o armazenou:

```
Padrão    UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## Permissões

- **Ler documentos** (`documents:read`): para ler a amostra e para colocar um filtro na consulta de Documentos.

As leituras passam pelo app com os direitos do usuário conectado e o mascaramento de campos: um valor oculto não é um UUID que o plugin consiga ler. O plugin não pode ler outras coleções. A um renderizador de células são enviados apenas os primeiros bytes de um valor binário, seu subtipo e seu tamanho.

## Configurações

Nenhuma.

## Limites

- Os campos são encontrados em uma amostra aleatória de 1.000 documentos; um campo raro pode não estar nela.
- Um campo cujos valores vieram de mais de um driver não se encaixa em uma única ordem: a aba informa isso. Com poucos valores, mais de uma ordem pode se encaixar: todas são nomeadas.
- Somente binários de 16 bytes de subtipo 3 ou 4 são lidos como UUIDs.
