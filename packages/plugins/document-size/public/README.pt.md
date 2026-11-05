# Tamanho do documento

Tamanho do documento mostra qual o tamanho dos documentos de uma coleção e para onde vão seus bytes: quantos caem em cada faixa de tamanho, quais são os maiores, a proximidade do maior em relação ao limite de 16 MB do MongoDB e a participação de cada campo nos bytes, campo a campo e também dentro de um campo de objeto. Use-o para encontrar o campo que deixa os documentos grandes, um array que não para de crescer ou nomes de campo que custam mais do que seus valores.

O plugin apenas lê. Ele mede no servidor, em um único pipeline somente leitura (um segundo quando a memória do MongoDB interrompe o primeiro, veja Limites): apenas os tamanhos, os nomes dos campos, seus tipos e os comprimentos dos arrays, e o `_id` dos maiores documentos chegam à página, nunca um documento.

## Onde aparece

- **Aba da coleção:** uma aba **Tamanho do documento** ao lado de Documentos, Agregações e das outras abas de cada coleção.

## Como usar

Abra uma coleção e depois a aba **Tamanho do documento**. Ela mede 1.000 documentos aleatórios assim que abre. Escolha **Todos** para medir todos os documentos (uma coleção grande pode levar mais tempo do que uma leitura permite: a aba então sugere medir uma amostra); **Medir novamente** extrai uma nova amostra. O que foi medido é mantido enquanto a aba estiver aberta — entrar em um campo e voltar, ou ir para **Todos** e voltar, mostra os mesmos números — até você usar **Medir novamente**.

- **Tamanhos:** quantos documentos têm menos de 1 KB, de 1 a 4 KB, e assim por diante até 16 MB.
- **Para onde vão os bytes:** cada campo, começando pelo que mais ocupa — seu tipo (com a média de elementos de um array ao lado), sua participação nos bytes dos documentos, seu tamanho médio e o maior, em quantos documentos aparece e o que seu nome (com o byte do seu tipo) ocupa em cada documento. Os bytes de um campo são o que ele ocupa no seu documento: seu tipo, seu nome e seu valor.
- **Maiores documentos:** os dez maiores, cada um com sua participação no limite de 16 MB e **Abrir** para vê-lo em Documentos (não aparece para o documento de uma view sem `_id`).

O nome de um campo de objeto é um botão: ele mede os campos do próprio objeto, nos documentos em que ele é um objeto (e não um array de objetos); o caminho acima do resumo volta, com no máximo oito níveis de profundidade. Ali a participação nos 16 MB não é exibida, pois o tamanho de um objeto não diz nada sobre ela. Quando o maior documento passa da metade do limite de 16 MB, a aba avisa, já que um documento não pode crescer além dele; quando os nomes dos campos ocupam um quinto dos bytes ou mais (todos são contados, inclusive os que não aparecem na lista), ela informa, pois nomes mais curtos deixam cada documento menor.

## Exemplo

Em uma coleção `orders`, 1.000 documentos aleatórios:

```
1.000 documentos · 15 KB em média · 9 MB o maior · 14,6 MB no total

O maior documento tem 9 MB: 56,3% do limite de 16 MB do MongoDB

Campo                         Tipo                    Participação  Média     Maior     Presente em  Nome
items                         array ≈ 12,5 elementos  78,1%         11,7 KB   8,6 MB    100%         7 B cada
address                       object                  3,9%          606 B     900 B     99%          9 B cada
customerReferenceIdentifier   string                  2,6%          400 B     400 B     100%         29 B cada
```

## Dados pessoais

Quando dados pessoais ficam ocultos para você em uma coleção, o tamanho dos documentos revelaria o comprimento dos valores ocultos: o servidor não mede nada ali, então a aba não pede nada e informa isso.

## Permissões

- **Ler documentos** (`documents:read`): para executar o pipeline de medição na coleção e para abrir um documento.

As leituras passam pelo aplicativo com os direitos do usuário conectado.

## Configurações

Nenhuma.

## Limites

- Uma amostra: o maior documento de todos pode não estar nela; **Todos** lê todos os documentos. Em uma coleção de documentos grandes, a amostra é extraída depois que os tamanhos são medidos, de modo que o MongoDB ordena apenas esses.
- Os 50 campos que mais ocupam são listados; um campo dentro de um array de objetos é medido junto com seu array.
- Uma chave com ponto ou começando com `$` é listada, mas não é explorada.
- Cada medição é um único pipeline de no máximo 10 segundos, sem uso de disco: documentos com muitíssimos nomes de campo distintos (chaves usadas como valores) podem ultrapassar a memória do MongoDB com **Todos**; uma amostra os mede.
