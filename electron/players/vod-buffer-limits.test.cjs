// Regressao para os tetos de buffer do VOD (electron/players/vod-buffer-limits.cjs).
//
// O que estes testes seguram e uma classe de bug silenciosa: um valor de
// configuracao que NINGUEM sabe de onde saiu. A mudanca de 512MiB para 96MiB
// aconteceu no codigo, com um comentario que explicava um problema ja resolvido
// — o proprio registro da sessao diz que o gagueira tinha parado antes. O unico
// sintoma foi gagueira de novo, que ninguem conseguia atribuir.
//
// Duas coisas nao podem regredir:
//
//   1. Sem env, o padrao e o valor ORIGINAL (512MiB / 120s), nao o de 96MiB.
//      Voltar ao numero conhecido e o estado neutro; a mudanca volta a ser uma
//      escolha consciente, feita com o A/B na mao.
//   2. Env invalido ERRA. Um fallback silencioso seria exatamente o bug que o
//      arquivo existe para impedir: comportamento mudando sem deixar rastro.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MiB,
  VOD_MAX_BYTES_PADRAO,
  VOD_READAHEAD_PADRAO,
  parseBytes,
  parseSegundos,
  vodMaxBytes,
  vodReadaheadSecs,
  descreverVodBuffer,
} = require('./vod-buffer-limits.cjs')

test('parseBytes aceita as notacoes que aparecem no app', () => {
  assert.equal(parseBytes('96MiB'), 96 * MiB)
  assert.equal(parseBytes('512MiB'), 512 * MiB)
  assert.equal(parseBytes('1GiB'), 1024 * MiB)
  assert.equal(parseBytes('268435456'), 268435456)
  assert.equal(parseBytes(' 64MiB '), 64 * MiB, 'espaco em volta nao invalida')
})

test('parseBytes recusa o que nao e numero', () => {
  for (const ruim of ['', 'MiB', 'abc', '0', '-5', '96MB', '96 mib x', 'NaN']) {
    assert.equal(parseBytes(ruim), null, `deveria recusar ${JSON.stringify(ruim)}`)
  }
  assert.equal(parseBytes(96), null, 'numero puro sem unidade nao e entrada valida')
})

test('parseSegundos aceita segundos e recusa o resto', () => {
  assert.equal(parseSegundos('120'), 120)
  assert.equal(parseSegundos(' 8 '), 8)
  assert.equal(parseSegundos('8.5'), 8.5)
  for (const ruim of ['', '0', '-1', 'abc']) {
    assert.equal(parseSegundos(ruim), null, `deveria recusar ${JSON.stringify(ruim)}`)
  }
})

test('sem env, volta o valor original de antes da mudancia sem medicao', () => {
  // O padrao NAO e 96MiB: e 512MiB. Voltar ao numero conhecido e o estado
  // neutro — mudar sem medir foi o que criou a duvida.
  assert.equal(vodMaxBytes({}), VOD_MAX_BYTES_PADRAO)
  assert.equal(vodMaxBytes({}), 512 * MiB)
  assert.equal(vodReadaheadSecs({}), VOD_READAHEAD_PADRAO)
  assert.equal(vodReadaheadSecs({}), 120)
})

test('env sobrepoe, que e o que permite o A/B sem recompilar', () => {
  const env = { STPLAY_VOD_MAX_BYTES: '96MiB', STPLAY_VOD_READAHEAD_SECS: '30' }
  assert.equal(vodMaxBytes(env), 96 * MiB)
  assert.equal(vodReadaheadSecs(env), 30)
})

test('env invalido ERRA, e nao cai num numero silencioso', () => {
  assert.throws(
    () => vodMaxBytes({ STPLAY_VOD_MAX_BYTES: '96MB' }),
    /STPLAY_VOD_MAX_BYTES invalido/,
  )
  assert.throws(
    () => vodReadaheadSecs({ STPLAY_VOD_READAHEAD_SECS: 'muito' }),
    /STPLAY_VOD_READAHEAD_SECS invalido/,
  )
  assert.throws(() => vodMaxBytes({ STPLAY_VOD_MAX_BYTES: '-1' }), /invalido/)
})

test('descreverVodBuffer diz se veio do padrao ou de override', () => {
  assert.equal(descreverVodBuffer({}).doPadrao, true)
  const d = descreverVodBuffer({ STPLAY_VOD_MAX_BYTES: '96MiB' })
  assert.equal(d.doPadrao, false)
  assert.equal(d.maxBytes, 96 * MiB)
  assert.equal(d.readaheadSecs, VOD_READAHEAD_PADRAO, 'override parcial mantem o resto no padrao')
})
