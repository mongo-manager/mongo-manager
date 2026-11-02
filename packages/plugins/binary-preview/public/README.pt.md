# Pré-visualização de binários

As coleções costumam guardar arquivos dentro dos documentos como valores binários: avatares, recibos digitalizados, miniaturas, PDFs pequenos. Documentos mostra um valor assim como `Binary(…)`, o que não diz nada sobre o que ele é. A pré-visualização de binários informa o que ele contém quando você aponta para ele e mostra as imagens, desenhadas a partir dos próprios bytes. O NoSQLBooster oferece o mesmo recurso como seu "Binary Image Preview Tooltip".

## Onde aparece

- **Valores de célula:** ao apontar para um valor binário em Documentos, informa o que ele contém (`Imagem PNG · 320 × 200 · 24 KB`, `Documento PDF · 1,2 MB`, `Arquivo ZIP`, `Áudio MP3`, `Imagem HEIC`, `Vídeo QuickTime`) ou, para qualquer outra coisa, seu subtipo e comprimento. O aplicativo envia ao plugin apenas os primeiros 2 KB do valor, nunca o valor inteiro.
- **Aba Imagens:** as imagens armazenadas nos documentos da coleção (PNG, JPEG, GIF, WebP, AVIF, BMP e SVG), dentro do filtro de Documentos, 12 por vez. Um clique mostra uma em tamanho grande; **Abrir documento** abre o documento dela no aplicativo.
- **Mostrar imagens** (uma ação de documento): as imagens desse documento.

## Como lê

A aba primeiro lê 50 documentos para descobrir quais campos contêm imagens (10 se esses 50 juntos passarem do limite de mensagem de 1 MB do aplicativo e, depois, um de cada vez); em seguida lê somente esses campos e `_id`, página por página na ordem de `_id`, passando por `_id` de todo tipo. Uma página acima do limite é lida documento por documento; um documento grande demais mesmo sozinho é contado, e a aba informa quantos precisam ser abertos em Documentos. Uma imagem grande mantém o teclado nela até ser fechada (Escape ou **Fechar**), e o foco volta para a miniatura dela.

As imagens são desenhadas a partir dos próprios bytes do valor como endereços `data:`; a página do plugin não pode carregar mais nada, e um SVG exibido como imagem não executa nenhum script. UUIDs nunca são tomados por arquivos.

## Permissões

- **Ler documentos:** para encontrar e mostrar as imagens, com os seus direitos e com os seus campos ocultos permanecendo ocultos.
