const assert = require('node:assert/strict')
const { describe, test } = require('node:test')

const {
  LIVE_MAX_DELAY_PADRAO,
  deveRecarregar,
  descreverLiveEdge,
  liveMaxDelaySecs,
} = require('./live-edge-keeper.cjs')

const base = {
  live: true,
  running: true,
  esperandoPrimeiroQuadro: false,
  pausado: false,
  cacheSecs: 180,
  ultimoReloadMs: 0,
  cooldownMs: 120,
  agoraMs: 10_000_000,
}

describe('deveRecarregar', () => {
  // O limite padrao subiu de 90 para 300 s porque os 90 s nunca tiveram medicao —
  // ver o teste "O LIMITE DE 90 s VOLTOU A SER UM DEFETO" abaixo, que tem o relato
  // do dono. Aqui os numeros acompanham o limite, para o teste continuar medindo
  // a REGRA (acima do limite recarrega) e nao o numero de uma vez so.
  test('recarrega quando o atraso passa do limite', () => {
    assert.equal(deveRecarregar({ ...base, cacheSecs: 301, limite: 300 }), true)
  })

  test('nao recarrega dentro do limite', () => {
    assert.equal(deveRecarregar({ ...base, cacheSecs: 299, limite: 300 }), false)
    assert.equal(deveRecarregar({ ...base, cacheSecs: 0, limite: 300 }), false)
  })

  // Em VOD um cache grande e RUNWAY, nao atraso. Recarregar um filme joga a
  // posicao fora — o pior defeito possivel num player de filme.
  test('nunca em VOD', () => {
    assert.equal(deveRecarregar({ ...base, live: false, cacheSecs: 900 }), false)
  })

  // Sem quadro ainda nao ha canal tocando, e o cache sobe porque ele ainda vai
  // ler tudo. Medir ali recarrega antes do primeiro quadro.
  test('nunca antes do primeiro quadro', () => {
    assert.equal(deveRecarregar({ ...base, esperandoPrimeiroQuadro: true }), false)
  })

  // Com o video pausado o buffer enche de proposito. Recarregar ali perderia a
  // posicao de quem pausou.
  test('nunca com o video pausado', () => {
    assert.equal(deveRecarregar({ ...base, pausado: true }), false)
  })

  test('nao recarrega com o motor parado', () => {
    assert.equal(deveRecarregar({ ...base, running: false }), false)
  })

  /*
   * Origem lenta reenchendo o buffer faria o guardiao disparar em loop, e cada
   * recarga joga o que ja tinha chegado. O cooldown e o que impede.
   */
  test('respeita o cooldown', () => {
    const agora = 10_000_000
    // `cacheSecs: 400` para ficar acima do limite novo (300 s) — com o `base` em
    // 180 o cooldown nunca seria testado, porque o limite ja seguraria.
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, agoraMs: agora, ultimoReloadMs: agora - 119_000 }), false)
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, agoraMs: agora, ultimoReloadMs: agora - 121_000 }), true)
  })

  /*
   * `get_property` devolve `null` quando o pipe estoura. `null > 300` e `false` por
   * acaso, mas `undefined` nao e — e a diferenca entre "sem medida" e "sem atraso"
   * tem que ser explicita, nao sorte.
   */
  test('sem medida numerica, nao recarrega', () => {
    for (const v of [null, undefined, NaN, Infinity, '180']) {
      assert.equal(deveRecarregar({ ...base, cacheSecs: v }), false, `valor ${String(v)}`)
    }
  })

  /*
   * CANAL RECEM-ABERTO NAO E ATRASO.
   *
   * A sessao de zape do dono terminou com 19 recargas que nao deviam ter
   * acontecido: o cooldown era reiniciado a cada carga (isso ja foi corrigido no
   * `stur-player.cjs`) e o guardiao agia em canais que ainda estavam enchendo o
   * proprio cache do handshake. Este piso e o que segura o resto.
   */
  test('nao age em canal que recem abriu', () => {
    const agora = 10_000_000
    // `cacheSecs: 400` aqui nao e decoracao: o `base` tem 180, que com o limite
    // novo (300 s) ficaria ABAIXO do gatilho, e o teste passaria a medir o
    // limite em vez do piso — que e o que ele existe para medir.
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, agoraMs: agora, tocandoDesdeMs: agora - 44_000 }), false)
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, agoraMs: agora, tocandoDesdeMs: agora - 46_000 }), true)
  })

  test('o piso de toque vale mesmo sem recarga anterior', () => {
    // Ultimo reload = 0 e o estado de quem NUNCA recarregou. Sem o piso, o canal
    // recem-aberto passaria.
    const agora = 10_000_000
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, agoraMs: agora, ultimoReloadMs: 0, tocandoDesdeMs: agora - 5_000 }), false)
  })

  test('o limite vem do parametro, e 300 por padrao', () => {
    assert.equal(LIVE_MAX_DELAY_PADRAO, 300)
    assert.equal(deveRecarregar({ ...base, cacheSecs: 100, limite: 120 }), false)
    assert.equal(deveRecarregar({ ...base, cacheSecs: 100, limite: 60 }), true)
  })

  test('O LIMITE DE 90 s VOLTOU A SER UM DEFITO — E ESTE TESTE IMPEDE', () => {
    /*
     * O dono pediu "não trave e não recarregue", e a resposta foi: os 90 s nunca
     * tiveram medição. Eram um número escolhido por precaução que custou um
     * congelamento de tela a cada minuto e meio durante semanas.
     *
     * O painel entrega ~2× o tempo real, então 90 s de atraso é material íntegro
     * já baixado. Numa TV isso não tem diferença visual. O que os 90 s faziam era
     * destruir material bom periodicamente — que é o congelamento.
     */
    assert.equal(
      LIVE_MAX_DELAY_PADRAO,
      300,
      'voltar a 90 s traz de volta o congelamento que o dono pediu para tirar',
    )
    // E o caso real que o dono viu: 160 s de buffer não deve recarregar.
    assert.equal(deveRecarregar({ ...base, cacheSecs: 160, limite: 300 }), false)
    // Acima de 5 min, algo está errado de verdade e o lastro ainda age.
    assert.equal(deveRecarregar({ ...base, cacheSecs: 400, limite: 300 }), true)
  })
})

describe('liveMaxDelaySecs', () => {
  test('padrao sem env', () => {
    assert.equal(liveMaxDelaySecs({}), 300)
  })

  test('portao aceita segundos', () => {
    assert.equal(liveMaxDelaySecs({ STPLAY_LIVE_MAX_DELAY_SECS: '45' }), 45)
  })

  // Sem fallback silencioso: valor invalido vira erro, nao um numero que ninguem
  // sabe de onde saiu.
  test('valor invalido lanca', () => {
    assert.throws(() => liveMaxDelaySecs({ STPLAY_LIVE_MAX_DELAY_SECS: 'lixo' }))
    assert.throws(() => liveMaxDelaySecs({ STPLAY_LIVE_MAX_DELAY_SECS: '-5' }))
    assert.throws(() => liveMaxDelaySecs({ STPLAY_LIVE_MAX_DELAY_SECS: '0' }))
  })

  test('descreve a fonte da configuracao', () => {
    assert.equal(descreverLiveEdge({}).fonte, 'padrao do modulo')
    assert.equal(descreverLiveEdge({ STPLAY_LIVE_MAX_DELAY_SECS: '45' }).fonte, 'portao STPLAY_LIVE_MAX_DELAY_SECS')
    assert.equal(descreverLiveEdge({ STPLAY_LIVE_MAX_DELAY_SECS: '45' }).maxDelaySecs, 45)
  })
})