// Regressao para o teto de buffer do AO VIVO (electron/players/live-buffer-limits.cjs).
//
// O irmao do VOD (`vod-buffer-limits.test.cjs`) ja existia; este nao. O modulo que
// poe o teto de 96MiB no live foi empacotado e publicado sem um unico teste, e o
// teto e a unica coisa entre o canal e o atraso de 887 s que a medicao registrou.
// Um teto que muda de valor sem ninguem perceber e o modo de falha que este
// arquivo existe para fechar — e o proprio `live-buffer-limits.cjs` diz isso no
// cabecalho, citando a troca de 512MiB para 96MiB que aconteceu sem medicao.
//
// O que nao pode regredir:
//
//   1. Sem env, o padrao e 96MiB — o valor com que o pico de 887,6 s foi medido.
//      96MiB a ~900 kbps da exatamente as 887 s observadas. Se o padrao mudar, a
//      medicao que justifica o arquivo deixa de valer.
//   2. Env invalido ERRA. Fallback silencioso seria o proprio bug: comportamento
//      mudando sem deixar rastro, que e como o teto de 96MiB entrou no VOD sem
//      ninguem saber de onde veio.
//   3. `descreverLiveBuffer` tem que distinguir padrao de override, porque e o
//      log do boot que responde "de onde saiu esse numero" sem ninguem ler codigo.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MiB,
  LIVE_MAX_BYTES_PADRAO,
  liveMaxBytes,
  descreverLiveBuffer,
  formatBytes,
} = require('./live-buffer-limits.cjs')

test('sem env, o padrao e 4MiB — o valor que o dono testou', () => {
  /*
   * TROCA MEDIDA, NAO TEORICA.
   *
   * Era 96 MiB. Em 05/10, no painel `fibers.lol`, o dono reclamou de gaguejo e de
   * recarga sozinho. Com o portão em 4 MiB, no MESMO painel:
   *
   *   gaguejo:   sumiu          (veredito do dono)
   *   recargas:  5+ → 1
   *
   * Este é o número testado. O de 1 MiB — que a aritmética aponta, porque
   * 4 MiB segurou 138,9 s e 90 s de buffer a esse bitrate dariam ~2,7 MB — NÃO
   * entra aqui: ele é conta, não medição, e o padrão só sobe depois de alguém
   * rodar e dizer que o gaguejo continuou ausente.
   */
  assert.equal(liveMaxBytes({}), LIVE_MAX_BYTES_PADRAO)
  assert.equal(liveMaxBytes({}), 4 * MiB)
})

test('o padrao nao volta sozinho para 96MiB', () => {
  // 96 MiB foi o teto do pico de 887 s. Se alguem "restaurar" esse numero achando
  // que era conservatism, traz de volta o gaguejo que o dono mediu.
  assert.notEqual(LIVE_MAX_BYTES_PADRAO, 96 * MiB, 'o padrao antigo produce o gaguejo')
  assert.notEqual(LIVE_MAX_BYTES_PADRAO, 1 * MiB, '1 MiB ainda nao foi testado')
})

test('o padrao e o mesmo em varias leituras, sem valor novo a cada chamada', () => {
  // Um `getter` que devolvesse objeto novo nao quebraria o numero, mas quebraria
  // o memo do perfil de playback, que compara o valor aplicado a cada loadfile.
  const a = liveMaxBytes({})
  const b = liveMaxBytes({})
  assert.equal(typeof a, 'number')
  assert.equal(typeof b, 'number')
  assert.equal(a, b)
})

test('env sobrepoe, que e o que permite o A/B sem recompilar', () => {
  const env = { STPLAY_LIVE_MAX_BYTES: '8MiB' }
  assert.equal(liveMaxBytes(env), 8 * MiB)
  assert.equal(liveMaxBytes({ STPLAY_LIVE_MAX_BYTES: '8388608' }), 8388608)
  assert.equal(liveMaxBytes({ STPLAY_LIVE_MAX_BYTES: ' 64MiB ' }), 64 * MiB)
})

test('env invalido ERRA, e nao cai num numero silencioso', () => {
  assert.throws(
    () => liveMaxBytes({ STPLAY_LIVE_MAX_BYTES: '96MB' }),
    /STPLAY_LIVE_MAX_BYTES invalido/,
  )
  assert.throws(() => liveMaxBytes({ STPLAY_LIVE_MAX_BYTES: 'abc' }), /invalido/)
  assert.throws(() => liveMaxBytes({ STPLAY_LIVE_MAX_BYTES: '-1' }), /invalido/)
})

test('descreverLiveBuffer diz se veio do padrao ou do portao', () => {
  const padrao = descreverLiveBuffer({})
  assert.equal(padrao.padrao, true)
  assert.equal(padrao.maxBytes, LIVE_MAX_BYTES_PADRAO)
  assert.equal(padrao.fonte, 'padrao do modulo')

  const override = descreverLiveBuffer({ STPLAY_LIVE_MAX_BYTES: '8MiB' })
  assert.equal(override.padrao, false)
  assert.equal(override.maxBytes, 8 * MiB)
  assert.equal(override.fonte, 'portao STPLAY_LIVE_MAX_BYTES')
})

test('formatBytes volta exportado, e e o que o log do boot escreve', () => {
  // Divisao exata em MiB vira `4MiB` (sem decimal). O log do boot mostra
  // `teto de buffer do LIVE { maxBytes: 4194304 }` com o numero cru ao lado, e
  // e esse par que o dono le para conferir o teto sem abrir codigo.
  assert.equal(formatBytes(LIVE_MAX_BYTES_PADRAO), '4MiB')
  assert.equal(formatBytes(1 * MiB), '1MiB')
  assert.equal(formatBytes(96 * MiB), '96MiB')
  // Valor que nao fecha em MiB sai cru, e nao inventando unidade.
  assert.equal(formatBytes(1536), '1536')
})

test('formatBytes recusa valor invalido em vez de escrever "NaN" no log', () => {
  // Sem esta guarda, `formatBytes(undefined)` escreveria literalmente `NaN` no
  // `player.log`, e um log com `NaN` nao responde nada.
  assert.throws(() => formatBytes(0), /valor invalido/)
  assert.throws(() => formatBytes(-1), /valor invalido/)
  assert.throws(() => formatBytes(Number.NaN), /valor invalido/)
})
