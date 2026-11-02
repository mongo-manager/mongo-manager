# Verificação de validação

A verificação de validação separa as regras de validação de uma coleção e verifica os documentos dela com cada regra individualmente: quantos documentos violam as regras como um todo e quantos violam cada campo obrigatório, cada propriedade e cada condição. Uma regra que muitos documentos violam é uma regra a corrigir nos dados, ou na própria regra, antes de torná-la estrita.

O plugin apenas lê. Ele não altera nada no banco de dados nem nas regras.

## Onde aparece

- **Aba da coleção:** uma aba **Verificação de regras** ao lado de Documentos, Agregações e das outras abas de cada coleção.

## Como usar

Abra uma coleção e, em seguida, a aba **Verificação de regras**. A verificação é executada em 1.000 documentos aleatórios assim que a aba é aberta. Escolha **10.000 aleatórios** ou **Todos** para verificar mais; **Verificar** executa de novo.

A aba lista as regras, começando pelas mais violadas. Cada uma informa quantos dos documentos verificados a violam, com a proporção. **Mostrar em Documentos** coloca na consulta de Documentos um filtro que seleciona esses documentos, para que possam ser examinados e corrigidos lá. **Mostrar todos os que violam as regras** faz o mesmo para o conjunto das regras.

O nível e a ação de validação são indicados. Um nível `moderate` verifica apenas documentos que já seguem as regras, e uma ação `warn` registra no log uma regra violada em vez de recusar a gravação: a aba informa isso quando qualquer um dos dois está definido.

## Como as regras são separadas

- **`$jsonSchema`:** cada campo de `required` é uma regra; cada propriedade de `properties` é uma regra (suas verificações: tipo, mínimo, padrão e as demais); `additionalProperties` diferente de `true` é uma única regra, "nenhum campo além dos do esquema", junto com `properties` e `patternProperties`; qualquer outra palavra-chave (`minProperties`, `dependencies`, `anyOf`, …) é uma regra por si só. `title` e `description` não dizem nada sobre um documento e ficam de fora, assim como o `bsonType: "object"` do nível superior.
- **Validador de consulta:** a condição de cada campo é uma regra, assim como cada cláusula de um `$and` de nível superior; `$or`, `$nor` e `$expr` são, cada um, uma única regra.

Um documento viola uma regra quando não a atende: o filtro usado é `{ $nor: [regra] }`.

## Exemplo

Em uma coleção `customers` cujo validador exige `email` e diz que `age` é um int igual ou maior que 0:

```
email é obrigatório          12 documentos (1,2%)
age  bsonType: 'int', minimum: 0     3 documentos (0,3%)
name é obrigatório           Nenhum documento a viola
```

**Mostrar em Documentos** na primeira coloca `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` em Documentos.

## Sobre as visualizações

Uma visualização não tem regras de validação próprias: a aba informa isso e aponta para a coleção que ela lê.

## Permissões

- **Ler documentos** (`documents:read`): para contar os documentos que violam cada regra, em uma única agregação somente leitura.
- **Ler a definição desta coleção** (`collection:read`): para ler as regras de validação dela.

As leituras passam pelo aplicativo com os direitos e o mascaramento de campos do usuário conectado. O que uma regra diz sobre um campo cujos valores estão ocultos para o usuário não é entregue ao plugin (o nome do campo é): essa regra não é verificada, e as contagens são as das regras exibidas. O plugin não pode ler outras coleções.

## Configurações

Nenhuma.

## Limites

- Uma amostra aleatória informa com que frequência uma regra é violada, não quantos documentos a violam no total: escolha **Todos** para obter as contagens exatas.
- A verificação é um único pipeline que roda por no máximo 10 segundos, sem usar disco. Em uma coleção grande, **Todos** pode esgotar o tempo; uma amostra não.
- No máximo 40 regras são contadas; a aba informa quando há mais.
- Uma regra é contada como foi escrita. Uma regra que só vale junto com outra (um `anyOf` entre propriedades, por exemplo) é contada como um todo, como o MongoDB a verifica.
