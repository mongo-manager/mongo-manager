# Dados de teste

Testar um índice, uma consulta, um gráfico ou uma tela exige documentos: mais do que você digitaria à mão, e nenhum deles real. Dados de teste cria documentos realistas no formato dos da sua coleção e os entrega ao assistente de importação do app, onde você os confere e inicia a importação. O NoSQLBooster oferece o mesmo recurso com o nome "Test Data Generator".

## Como usar

1. Abra uma coleção e a aba **Dados de teste** dela. O plugin lê uma amostra de 100 documentos e lista os campos deles (`_id` fica por conta do servidor).
2. Cada campo recebe **valores de teste** escolhidos pelo nome e pelo tipo: `email` recebe endereços de e-mail, `createdAt` datas do último ano, `price` preços, `status` um dos valores que a coleção já tem e um `location` GeoJSON recebe um ponto. O nome nunca muda o tipo de um campo: uma data guardada como texto recebe datas como texto, e uma imagem guardada como bytes recebe pequenas imagens PNG. Você pode trocar qualquer um deles entre mais de 100 modelos agrupados: pessoa, internet, localização, empresa, comércio, finanças, data e hora, número, texto, identificador, verdadeiro ou falso, outros ("este texto", null, vazio).
3. Desmarque um campo para omiti-lo ou adicione um (`profile.phone` para um dentro de outro; uma lista de objetos como `items[].qty` recebe de um a três elementos).
4. Escolha quantos documentos criar (até 5.000), que parcela dos campos omitir (para documentos que não têm todos os campos), o idioma das palavras (qualquer um dos dez idiomas do app) e uma **semente**: a mesma semente cria os mesmos documentos de novo enquanto a aba continuar aberta (as datas contam para trás a partir do momento em que ela foi aberta). Nenhum documento fica sem campos.
5. Confira a **pré-visualização** e clique em **Importar…**: o assistente de importação abre na coleção, com os documentos como arquivo. Nada é gravado até você iniciar a importação lá, com as suas próprias permissões. **Baixar JSON** salva os documentos em vez disso.

## O que nunca é criado

- E-mails e endereços web usam apenas domínios de exemplo reservados (`example.com`, `example.org`, `example.net`, `.test`); endereços IP, as faixas de documentação; telefones, a faixa reservada para a ficção (`+1 2xx-555-01xx`) ou uma em que nenhuma linha existe (`+90 000 …`). Os nomes de empresa são inventados.
- Nenhum valor que distinga uma pessoa ou uma coisa é copiado da coleção: "um dos valores existentes" só é oferecido para um campo com nome de categoria (um status, um país) ou que não pareça um identificador (um id, um número, um código, um passaporte…) nem uma pessoa (um proprietário, um cliente, um autor, um usuário…), e só quando cada um dos seus poucos valores curtos, que você pode ver, aparece pelo menos duas vezes na amostra. O nome, o e-mail, o telefone ou o endereço de uma pessoa nunca são oferecidos, nem mesmo `email2` e `phone1`.
- Um campo ocultado de você por ser um dado pessoal aparece como oculto, com o tipo desconhecido: os valores de teste dele são texto até você escolher outros (o motivo é lido junto com os controles dele), e o assistente de importação o deixa de fora, a menos que você o inclua lá. Quando o app não consegue saber a tempo o que está oculto para você, todos os campos são tratados como ocultos até você escolher **Tentar novamente**.
- Um campo novo nunca é colocado dentro de uma lista de documentos (`items.note` ao lado de `items[].qty`) e não contém `$` nem colchetes.
- Os documentos são medidos como o app os recebe: uma entrega ou um download aceita no máximo 1.000.000 de caracteres e 1,04 MB como enviado. Responder não à pergunta do app deixa uma nota curta, nunca um erro.
- Nenhum IBAN, número de conta ou de cartão é real: esses modelos são marcados como falsos (`XX00 TEST …`).

## Permissões

- **Ler documentos:** uma amostra da coleção, para conhecer os campos. A importação em si é do app, por meio do assistente dele.
