# Dicas de tempo

Dicas de tempo mostra uma data legível sobre valores que escondem uma. Um ObjectId carrega o segundo em que foi criado nos seus quatro primeiros bytes, e muitas coleções guardam horários como timestamps Unix (segundos ou milissegundos desde 1970). Dicas de tempo mostra esses momentos em Documentos, no idioma do app e no seu horário local, para que você não precise decodificá-los.

O plugin não tem página própria e não lê nada do banco de dados. Ele só olha os valores que o app já está mostrando.

## Onde aparece

- **Valores de célula:** ao apontar para um ObjectId em Documentos, o momento em que foi criado.
- **Valores de célula:** ao apontar para um número que se lê como hora Unix, a data dele, marcada com `≈`.

Ambos aparecem em qualquer lugar onde Documentos mostra o valor (tabela, árvore, cartões, o inspetor de documentos), em uma dica que a célula ou a linha mostra quando você aponta para ela ou o foco do teclado chega lá: o valor completo na primeira linha e, abaixo, a hora, depois do nome do plugin. Nada é escrito ao lado do valor e nada é adicionado ao próprio documento. Um leitor de tela lê a hora junto com o valor.

## Como usar

Não há nada para abrir ou configurar: depois que um administrador aprova e ativa o plugin, as dicas aparecem em Documentos para todos.

## Exemplo

Um documento como este:

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

mostra, para um usuário em Istambul com o app em português, estas dicas:

```
_id           ao apontar:  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                           Dicas de tempo: 11 de out. de 2023, 07:52
createdAt     ao apontar:  1696999920
                           Dicas de tempo: ≈ 11 de out. de 2023, 07:52
updatedAtMs   ao apontar:  1697003520000
                           Dicas de tempo: ≈ 11 de out. de 2023, 08:52
quantity      sem dica
```

`quantity` não recebe dica: 3 não está no intervalo das horas Unix.

## O que é lido como hora

- **ObjectId:** sempre. Os primeiros oito dígitos hexadecimais são a hora de criação em segundos. A hora é o momento em que o id foi gerado, geralmente pelo driver do programa que inseriu o documento, o que nem sempre é o momento da inserção.
- **Número:** um int, long ou double de 1.000.000.000 até 4.102.444.800 (sem incluí-lo) é lido como segundos; o mesmo intervalo multiplicado por 1.000, como milissegundos. Isso cobre de 9 de setembro de 2001 até o fim de 2099.

Um número é apenas um palpite: um preço, uma contagem ou um telefone dentro desse intervalo também recebe uma data. Por isso as dicas de números começam com `≈`. Datas guardadas como datas BSON de verdade são mostradas pelo próprio app e não precisam de dica.

## Formato

- A data e a hora usam o idioma do app: data média, hora curta (por exemplo, `Oct 11, 2023, 7:52 AM` em inglês, `11 Eki 2023 07:52` em turco).
- O fuso horário é o fuso local do navegador.
- Quando o idioma do app muda, as dicas são mostradas de novo no novo idioma.

## Permissões

- **Ler documentos** (`documents:read`): o app só pergunta pelos valores de uma célula a plugins com permissão para ler documentos. Dicas de tempo recebe os valores da página e nunca consulta o banco de dados por conta própria.

## Configurações

Nenhuma.

## Limites

- Só ObjectIds e números simples são lidos. Uma hora guardada como texto (`"2023-10-11T07:52:00Z"`) ou como decimal (`$numberDecimal`) não recebe dica.
- Segundos são a menor unidade mostrada; milissegundos não são mostrados.
- Números abaixo de 1.000.000.000 de segundos (antes de setembro de 2001) ou a partir do ano 2100 não são lidos como horas.
- As dicas acompanham os valores que o app mostra; um valor dentro de um objeto aninhado recebe uma onde o app mostra esse valor aninhado como célula.
