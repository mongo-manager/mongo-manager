# Mapa

O Mapa desenha onde estão os documentos de uma coleção, em um mapa próprio: suas formas GeoJSON (pontos, linhas, polígonos e coleções deles) e os pares de coordenadas `[lng, lat]` do formato antigo. Pontos próximos entre si são agrupados com uma contagem; ao clicar em uma forma, abre-se um cartão sobre o documento dela.

O plugin só lê. Ele não altera nada no banco de dados.

## Onde aparece

- **Aba da coleção:** uma aba **Mapa** ao lado de Documentos, Agregações e das outras abas de cada coleção e visualização.
- **Ação de documento:** **Mostrar no mapa**, no menu de ações de uma linha de documento em Documentos, desenha apenas esse documento.
- **Valores de célula:** ao lado de um ponto GeoJSON em Documentos, a posição dele como `lat, lng` (cinco casas decimais), por exemplo `41.00820, 28.97840`.

## Como usar

Abra uma coleção e depois a aba **Mapa**. Os documentos da consulta atual de Documentos são lidos e suas formas são desenhadas; o mapa se ajusta a elas.

- Arraste para mover, role ou use **Aumentar zoom** e **Diminuir zoom** para dar zoom, e **Ajustar às formas** para ver tudo de novo.
- Um círculo com um número reúne vários lugares próximos: clique para aumentar o zoom.
- Clique em um ponto ou forma para abrir o cartão dele: o nome do documento, alguns de seus campos e **Abrir** para mostrar o documento no aplicativo.
- **Campo GeoJSON** limita o mapa a um campo quando os documentos têm formas em vários (por exemplo `pickup` e `dropoff`); **Todos os campos** mostra todos.
- **Formas** lista o que foi desenhado (documento, campo, tipo). É o caminho pelo teclado no mapa: **Mostrar no mapa** centraliza uma forma e **Abrir** abre o documento dela.

## Filtrar por uma área

Os três botões ao lado do seletor de campo filtram os documentos por uma área:

- **Desenhar uma área para filtrar:** clique no mapa para adicionar vértices; clique no primeiro vértice, clique duas vezes ou pressione Enter para concluir. Backspace desfaz o último vértice; Esc cancela, onde quer que esteja o foco.
- **Desenhar um círculo para filtrar:** clique no centro e depois na borda; o raio aparece conforme você move, e o contorno é o que ele tem no globo (mais largo em direção a um polo no mapa).
- **Filtrar pela área visível:** a parte do mundo que o mapa mostra.

Pelo teclado: com o foco no mapa, as setas o movem e a barra de espaço coloca um vértice (ou o centro do círculo e depois a borda) no centro do mapa, onde aparece uma cruz. Um segundo clique em uma ferramenta em uso a solta; escolher outro campo interrompe um desenho.

Os documentos com uma forma na área são colocados na consulta de Documentos com o `$geoWithin` do MongoDB. Cada borda segue a linha desenhada no mapa (vértices são adicionados ao longo dela, pois o MongoDB une dois vértices pelo caminho mais curto no globo, que se curva em direção a um polo), e uma área pode cruzar o antimeridiano. Funciona igualmente com formas GeoJSON e com pares `[lng, lat]`, e não precisa de índice. Uma forma dentro de um Feature é filtrada pela geometria dele, uma dentro de um FeatureCollection pelos features da coleção (um documento está dentro quando qualquer uma de suas formas está) e uma dentro de um array pelos elementos do array. Quando um campo guarda suas formas de mais de uma dessas maneiras, o filtro considera cada uma. Formas sob uma chave que nenhum filtro consegue nomear (com ponto ou `$`, ou vazia) ficam de fora, e a página avisa isso ao lado das ferramentas, antes de filtrar.

A área é colocada junto ao filtro de Documentos em uso: as outras condições dele são mantidas, e uma área no mesmo campo que já esteja ali (de um desenho anterior ou escrita por você) é substituída. A ordenação e a projeção de Documentos voltam a nenhuma, como em qualquer consulta que um plugin coloca ali. Um polígono cujas bordas se cruzam, se tocam ou voltam sobre si mesmas, ou cujos vértices estão em uma linha, não forma uma área: a página explica o motivo. Quando os documentos têm formas em vários campos, escolha primeiro o campo pelo qual filtrar; a página avisa isso ao lado dos botões. **Mostrar no mapa** (um documento) não tem ferramentas de desenho.

## O que é lido como lugar

- Uma geometria GeoJSON em qualquer campo: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` ou `GeometryCollection`.
- Um `Feature` ou `FeatureCollection` do GeoJSON.
- Um par antigo `[lng, lat]`, com a longitude primeiro como o MongoDB guarda, mas só em um campo com nome de lugar: `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` e seus plurais ou variantes próximas. Dois números em outros lugares (uma versão, um tamanho) não são tomados como lugar. Um campo chamado `latlng` não é lido, pois geralmente tem a latitude primeiro.

Os campos são procurados até seis níveis de profundidade, e dentro de arrays. Uma forma que não seja GeoJSON válido é deixada de fora por inteiro.

## Exemplo

Uma coleção `stores`:

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

Os dois aparecem na aba Mapa. Em Documentos, a célula `location` do primeiro mostra `40.99030, 29.02750` ao lado do valor.

## Blocos de mapa

Por padrão, nenhum bloco de mapa é carregado e nenhum servidor de blocos é contatado: o mapa desenha uma grade de meridianos e paralelos, e uma nota informa que um administrador pode configurar um servidor de blocos. Com um servidor de blocos configurado, as formas são desenhadas sobre blocos de mapa reais.

## Permissões

- **Ler documentos** (`documents:read`): para ler os documentos da consulta atual e o único documento de Mostrar no mapa.

As leituras passam pelo aplicativo, com os direitos do usuário conectado e a máscara de campos. O plugin não consegue ler outras coleções.

## Configurações

Os administradores as definem na página de Plugins. Todos que usam o plugin podem vê-las, então nunca coloque aqui um segredo (como uma chave de API privada).

- **Servidor de blocos** (`tileUrl`): um modelo de endereço http ou https para blocos raster. `{z}`, `{x}` e `{y}` são preenchidos para cada bloco, `{-y}` conta as linhas a partir do sul (TMS), `{s}` escolhe um subdomínio (`a`, `b` ou `c`) e `{r}` fica vazio. Exemplo: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (verifique antes a política de uso do provedor de blocos).
- **Créditos dos blocos** (`tileAttribution`): a linha de créditos mostrada no mapa, como texto simples, por exemplo `© OpenStreetMap contributors`. Quando vazia, mostra-se o nome do host do servidor de blocos.

O host do servidor de blocos, e somente esse host, é adicionado às imagens que o quadro do plugin pode carregar. Um endereço com credenciais ou um host incomum é recusado.

## Limites

- No máximo os primeiros 1.000 documentos da consulta atual são lidos, em ordem de `_id`, em páginas que cabem no limite de mensagem de 1 MB do aplicativo. Quando há mais, o resumo diz «dos primeiros 1.000 documentos»; restrinja o filtro de Documentos para ver outros.
- Até 50 formas são tomadas de um documento.
- Uma forma com mais de 10.000 vértices é desenhada simplificada (um a cada n pontos é mantido, e as extremidades também), e de uma forma múltipla são desenhadas no máximo 1.000 partes.
- A lista de formas mostra suas primeiras 200 linhas.
- O zoom vai até o nível 19; o ajuste para no nível 15 para que um único ponto não seja desenhado no nível da rua.
- O mapa usa a projeção Web Mercator: latitudes além de cerca de 85 graus ao norte ou ao sul são desenhadas na borda.
