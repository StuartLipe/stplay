import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ehCanalAdulto, ehCategoriaAdulta } from './adulto.ts'

/*
  Este arquivo existe porque o defeito nao foi um padrao errado: foram DOIS
  padroes para a mesma pergunta, discordando. O `App.tsx` usava um e o
  `xtream.ts` usava outro, e cada teste abaixo ja falhou em producao num painel
  especifico.
*/

/*
  O BUG DE ORIGEM. Este painel nomeia a categoria "CANAIS | ADULTOS" e o padrao
  antigo da tela era `\bADULTO\b`: o S final mata o limite de palavra, a
  categoria nao casava, e com a protecao ligada ela ficava VISIVEL e
  desprotegida — o inverso do que o nome promete.
*/
test('o plural de ADULTO casa: e a categoria deste painel', () => {
  assert.equal(ehCategoriaAdulta('CANAIS | ADULTOS'), true)
})

test('todos os formatos de ADULT casam', () => {
  for (const nome of ['ADULT', 'ADULTO', 'ADULTA', 'ADULTOS', 'ADULTAS', 'adultos']) {
    assert.equal(ehCategoriaAdulta(nome), true, nome)
  }
})

/*
  "ADULT SWIN", "ADULT SWIN 4K" e "ADULT SWIN UHD" foram o primeiro caso real:
  o `\bADULT\b` foi acrescentado para pegar o painel que nomeia em ingles. O
  plural novo nao pode ter custado esse acerto.
*/
test('o padrao em ingles continua casando', () => {
  for (const nome of ['ADULT SWIN', 'ADULT SWIN 4K', 'ADULT SWIN UHD']) {
    assert.equal(ehCategoriaAdulta(nome), true, nome)
  }
})

/*
  O limite de palavra e o que segura "ADULTADO". `\bADULT\w*\b` seria o jeito
  curto e estaria errado: casaria esta e qualquer nome que comece com "adult".
*/
test('palavra que comeca com ADULT mas nao e conteudo adulto nao casa', () => {
  for (const nome of ['ADULTADO', 'ADULTADOS', 'ADULTAÇÃO', 'ADULTE']) {
    assert.equal(ehCategoriaAdulta(nome), false, nome)
  }
})

test('os termos do padrao antigo continuam valendo', () => {
  const casos = [
    '+18',
    'CANAIS 18+',
    'XXX',
    'ADULTOS XXX',
    'ONLYFANS',
    'ONLY FANS',
    'PRIVACY',
    'PORNO',
    'PORNÔ',
    'HENTAI',
    'SEXTREME',
    'EROTIC',
    'PRIVE',
    'PRIVÊ',
    'CINE PRIV',
    'BRAZZER',
    'BANG BROS',
    'BANGBROS',
    'VIXEN',
    'BLACKED',
    'TUSHY',
    'SWEET SINNER',
    'EVIL ANGEL',
    'PLAYBOY',
    'VENUS',
    'FETISH',
    'FETICHE',
    'REDLIGHT',
    'HARDCORE',
    'SOFTCORE',
  ]
  for (const nome of casos) {
    assert.equal(ehCategoriaAdulta(nome), true, nome)
  }
})

/*
  Estas aparecem na coluna do mesmo painel do bug. Se qualquer uma casasse, uma
  categoria comum desapareceria da tela com a protecao ligada — o mesmo defeito
  pelo outro lado.
*/
test('categorias comuns deste painel nao casam', () => {
  const casos = [
    'INFANTIL',
    'CANAIS | PEGADINHAS 24H',
    'CANAIS | SÉRIES 24H',
    'CANAIS | STADUP 24H',
    'CANAIS H265',
    'CINE PLAY',
    'DIVERSOS',
    'DOCUMENTÁRIOS',
    'FILMES & SÉRIES',
    'GLOBOS CAPITAIS',
    'GLOBOS REGIONAIS',
    'HBO',
    'NOTÍCIAS',
    'RECORD TV',
    'RELIGIOSOS',
    'SBT',
    'TELECINE',
    'VARIEDADES',
    'Todos',
    'Continuar Assistindo',
  ]
  for (const nome of casos) {
    assert.equal(ehCategoriaAdulta(nome), false, nome)
  }
})

test('vazio e indefinido nao casam', () => {
  assert.equal(ehCategoriaAdulta(''), false)
  assert.equal(ehCategoriaAdulta(undefined), false)
})

/*
  Um canal dentro de "CANAIS | ADULTOS" e adulto pelo GRUPO. Antes nao era: o
  `isAdultChannel` usava o padrao restrito e o grupo nao casava, entao os canais
  apareciam soltos dentro de outra categoria.
*/
test('o canal herda o adulto pelo grupo', () => {
  assert.equal(ehCanalAdulto({ group: 'CANAIS | ADULTOS', name: 'Canal 1' }), true)
})

test('o canal herda o adulto pelo proprio nome', () => {
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'ADULT SWIN 4K' }), true)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'PLAYBOY TV' }), true)
})

/*
  O prefixo [XXX] e do NOME do canal, e ai o "XXX" solto nao basta: o texto
  inteiro e o nome, e "XXX" aparece no meio de meio mundo sem que aquilo seja
  conteudo adulto. Na categoria o termo sozinho ja e o nome.
*/
test('prefixo [XXX] no nome conta', () => {
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: '[XXX] Canal' }), true)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: '(XXX) Canal' }), true)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'XXX - Canal' }), true)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'Canal XXX' }), true)
})

/*
  "XXX" solto no NOME conta, e nao e falha: e assim que painel nomeia canal
  adulto — "XXX - BELA DA SEMANA" apareceu na lista de ocultados deste painel.
  O prefixo com contexto acima e um caminho a mais, para o nome que nao tem
  "XXX" nenhum.
*/
test('XXX no meio do nome do canal conta', () => {
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'XXX - BELA DA SEMANA' }), true)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'Canal XXXTESTE' }), true)
})

test('nome de canal sem nenhum destes termos nao e adulto', () => {
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'MAXWELL HD' }), false)
  assert.equal(ehCanalAdulto({ group: 'Ao vivo', name: 'Discovery Kids HD' }), false)
})

test('canal comum nao e adulto', () => {
  assert.equal(ehCanalAdulto({ group: 'INFANTIL', name: 'BABY FIRST SD' }), false)
  assert.equal(ehCanalAdulto({ group: 'CANAIS H265', name: 'GLOOB HD' }), false)
})

test('canal vazio e indefinido nao casam', () => {
  assert.equal(ehCanalAdulto(undefined), false)
  assert.equal(ehCanalAdulto({}), false)
})