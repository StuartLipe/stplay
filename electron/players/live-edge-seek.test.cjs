// Regressao para o guardiao da borda (electron/players/live-edge-keeper.cjs).
//
// O que estes testes seguram vem de uma sessao real: numa origem que entrega ~2x o
// tempo real, o canal estava inteiro tocando e mesmo assim o dono viu "carrega o
// canal do nada". O log dizia o motivo:
//
//   cache 50 -> 60 -> 70 -> 80 -> 90 -> 96 s
//   atraso no live passou do limite; recarregando { cacheSecs: 96.6 }
//
// O guardiao recarregava a cada 90 s. Nao era falha de abertura: eram 96 s de
// material ja baixado que o playback nao alcançava, e o app jogava fora a cada
// ciclo, limpando o demuxer e recomeçando a rede do zero.
//
// Duas coisas nao podem regredir:
//
//   1. O avanco do seek e o CACHE MENOS A FOLGA. Um a mais apontaria alem da ultima
//      coisa que o demuxer indexou, e seek para depois do fim e ignorado.
//   2. Cache curto NAO gera seek. Mandar +1 s quando o demuxer ainda esta enchendo
//      e jitter puro: o video pisca e volta, que e pior do que nao fazer nada.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SEEK_FOLGA_SECS,
  SEEK_PISO_SECS,
  SEEK_ATIVO_PADRAO,
  BORDA_ALVO_SECS,
  BORDA_MARGEM_SECS,
  RECARGA_DE_ULTIMO_RECURSO_SECS,
  avancoParaVoltarAoVivo,
  seekDeBordaAtivo,
  avancoParaManterBorda,
  bordaContinuaAtiva,
  portoesEmConflito,
  recarregaPorAtraso,
  deveRecarregar,
} = require('./live-edge-keeper.cjs')

test('RECARGA POR ATRASO NUNCA — nem com 10 h de buffer', () => {
  /*
   * ESTE TESTE É A RESPOSTA DIRETA AO DONO, E A SEGUNDA VEZ QUE ELE PEDE.
   *
   *   1ª vez: "o que eu preciso é que ele não trave e nem recarregue"
   *   2ª vez, depois de instalar o build de 300 s e ver recarregar aos 5 min:
   *          "o que eu preciso é não ter limite — se ficar 10 hrs o app não pode
   *           recarregar essas 10 hrs"
   *
   * O log da 2ª vez:
   *
   *   atraso no live passou do limite; recarregando  cacheSecs: 305.9, limite: 300
   *
   * Cinco minutos de canal contínuo, uma tela congelada. Não era o painel falhando,
   * não era o canal quebrando — era o app descartando material bom porque o número
    * passou de uma linha que não tem medição nenhuma por trás. E essa linha
    * foi criada por mim dois minutos antes, subindo de 90 para 300 — ou seja, o
    * dobro do defeito por ajuste de valor.
   *
   * POR QUE ISSO PRECISA DE UM TESTE E NÃO SÓ DE UM COMENTÁRIO.
   *
   * O padrão de código deste app é tratar atraso como defeito. Isso apareceu três
   * vezes nesta sessão: primeiro o limite de 90 s, depois o de 300 s, depois o lastro
   * de 300 s da borda contínua. Cada um deles era "só um número" e cada um virou um
   * congelamento de tela. Sem uma função que responda `false` para qualquer valor, o
   * próximo que mexer no guardião reintroduz o reload sem perceber — porque a
   * função `deveRecarregar` continua respondendo `true` para atraso grande (ela é a
   * régua do log agora), e é dela que o olho vai.
   *
   * Por isso `recarregaPorAtraso` não recebe argumento nenhum no corpo: ela não
   * decide, ela afirma. `deveRecarregar` é a régua; esta é a decisão.
   */
  assert.equal(recarregaPorAtraso(), false)
  assert.equal(recarregaPorAtraso(305.9), false)
  assert.equal(recarregaPorAtraso(90), false)
  assert.equal(recarregaPorAtraso(RECARGA_DE_ULTIMO_RECURSO_SECS), false)
  assert.equal(recarregaPorAtraso(36_000), false, '10 h de atraso nao recarrega')
  assert.equal(recarregaPorAtraso(Number.POSITIVE_INFINITY), false, 'nem infinito')

  // E o par que fecha a porta: a regua avisa, a decisao nao age. Se alguem mudar a
  // decisao sem mudar a regua, este par falha — que e o ponto.
  const regua = deveRecarregar({
    live: true,
    running: true,
    esperandoPrimeiroQuadro: false,
    pausado: false,
    cacheSecs: 305.9,
    limite: 300,
    ultimoReloadMs: 0,
    cooldownMs: 120,
    agoraMs: 10_000_000,
    tocandoDesdeMs: 10_000_000 - 600_000,
  })
  assert.equal(regua, true, 'a regua continua avisando que o atraso passou')
  assert.equal(recarregaPorAtraso(305.9), false, 'e a decisao continua nao recarregando')
})

test('O SEEK ESTA DESLIGADO POR PADRAO — a medicao provou que e pior', () => {
  /*
   * REGRESSAO MEDIDA, E A MAIS IMPORTANTE DESTE ARQUIVO.
   *
   * Medido no canal do dono, com o seek LIGADO:
   *
   *   atraso no live; voltando a borda viva   avancoSegs: 96
   *   socket do demuxer morto                 cacheTime: 97.4, cacheParadoMs: 21212
   *                                          timePos: 97.46, timePosParadoMs: 21174
   *
   * O seek pegou: time-pos foi de 1 para 97.46. E travou 21 s, porque os 97 s de
   * buffer estavam todos ATRAS da posicao nova — cache a frente era zero e o
   * demuxer parou de entregar.
   *
   * A origem nao tem borda viva: ela entrega uma rajada, enche ~97 s e para. O
   * "2x o tempo real" medido antes era a FASE DE ENCHIMENTO.
   *
   * O reload e feio na tela e e o unico caminho que comprovadamente devolve o
   * canal. Trocar recarga limpa por 21 s de congelamento foi a pior versao
   * possivel. Este teste existe para o seek nao voltar sozinho.
   */
  assert.equal(SEEK_ATIVO_PADRAO, false)
  assert.equal(seekDeBordaAtivo({}), false)
  assert.equal(seekDeBordaAtivo({ STPLAY_LIVE_EDGE_SEEK: '0' }), false)
  assert.equal(seekDeBordaAtivo({ STPLAY_LIVE_EDGE_SEEK: '' }), false)
  assert.equal(seekDeBordaAtivo({ STPLAY_LIVE_EDGE_SEEK: 'true' }), false)
  // So o "1" exato liga: e o que a documentacao do portao promete.
  assert.equal(seekDeBordaAtivo({ STPLAY_LIVE_EDGE_SEEK: '1' }), true)
})

// =============================================================================
// BORDA CONTÍNUA — o conserto que responde "como não ter limite"
// =============================================================================

test('BORDA CONTÍNUA ESTA DESLIGADA POR PADRAO — 3 numeros errados hoje', () => {
  /*
   * REGRESSÃO DE DISCIPLINA, E A MAIS IMPORTANTE DO ARQUIVO.
   *
   * Numa sessão só, três medições refutaram três afirmações minhas:
   *
   *   1. cache-secs + teto subiram juntos  → travada a cada poucos segundos
   *   2. 4 MiB "≈ 37 s"                    → realidade foi 138,9 s
   *   3. 1 MiB "≈ 35 s"                    → realidade foi 93,1 s, e RECARREGOU
   *
   * O item 3 é o que motivou isto. A conta linear estava errada: 4× menos bytes deu
   * só 1,5× menos segundos, porque o teto em BYTES não controla a duração do
   * buffer — existe um chão perto de 90 s que ele não alcança.
   *
   * A borda contínua é uma hipótese, não um número. Ela entra desligada, e só o dono
   * liga. Apagar a variável devolve o comportamento de hoje sem tocar em código.
   */
  assert.equal(bordaContinuaAtiva({}), false)
  assert.equal(bordaContinuaAtiva({ STPLAY_LIVE_EDGE_KEEP: '0' }), false)
  assert.equal(bordaContinuaAtiva({ STPLAY_LIVE_EDGE_KEEP: '' }), false)
  assert.equal(bordaContinuaAtiva({ STPLAY_LIVE_EDGE_KEEP: 'true' }), false)
  assert.equal(bordaContinuaAtiva({ STPLAY_LIVE_EDGE_KEEP: '1' }), true)
})

test('so avanca quando o cache passa de alvo + margem', () => {
  assert.equal(avancoParaManterBorda(20), null, 'abaixo do alvo: nada a fazer')
  assert.equal(avancoParaManterBorda(30), null)
  assert.equal(
    avancoParaManterBorda(BORDA_ALVO_SECS + BORDA_MARGEM_SECS),
    null,
    'exatamente em alvo+margem ainda não mexe',
  )
})

test('avanca e deixa o atraso no alvo, com margem sobrando', () => {
  /*
   * ESTE É O PONTO QUE O SEEK ANTERIOR ERROU.
   *
   * Sem margem: seek de +96 num cache de 96 → tempoPos na última gota, cache à
   * frente ZERO, 21 s de congelamento. Medido.
   *
   * Com margem de 12: o playback fica `alvo` atrás e ainda há 12 s à frente. É a
   * diferença entre chegar NA borda e chegar PERTO dela.
   */
  const r = avancoParaManterBorda(93.1)
  assert.equal(r.avanco, 68, '93,1 - 25 = 68,1 → 68')
  // `atrasoRestante` é `cacheSecs - avanco`, e o avanco foi arredondado para
  // inteiro. Por isso 25,0999 e não 25 exato: o resto é o resto que sobrou.
  assert.ok(
    Math.abs(r.atrasoRestante - BORDA_ALVO_SECS) < 1,
    `atraso final ${r.atrasoRestante} deve estar no alvo ${BORDA_ALVO_SECS} +-1`,
  )
})

test('o ciclo converge: aplicar o avanco devolve o cache ao alvo', () => {
  // Simula o tique do guardião: ele mede, avança, e no tique seguinte o cache
  // volta perto do alvo e o guardião para de mexer. É o que transforma "recarregar
  // quando estoura" em "at sempre em cima".
  let cache = 93.1
  let passos = 0
  for (let i = 0; i < 6; i += 1) {
    const r = avancoParaManterBorda(cache)
    if (!r) break
    passos += 1
    cache = r.atrasoRestante + 5 // o demuxer enche um pouquinho entre tiques
  }
  assert.ok(passos >= 1, 'tem que corrigir pelo menos uma vez')
  assert.equal(avancoParaManterBorda(cache), null, 'e para quando chega no alvo')
  assert.ok(cache <= BORDA_ALVO_SECS + BORDA_MARGEM_SECS, `parou em ${cache}`)
})

test('leitura ausente nunca vira NaN no comando', () => {
  assert.equal(avancoParaManterBorda(null), null)
  assert.equal(avancoParaManterBorda(undefined), null)
  assert.equal(avancoParaManterBorda(Number.NaN), null)
  assert.equal(avancoParaManterBorda(Number.POSITIVE_INFINITY), null)
  assert.equal(avancoParaManterBorda('93'), null)
})

test('o alvo e a margem estao em faixa que aguenta rajada sem ser atraso visivel', () => {
  assert.ok(BORDA_ALVO_SECS > 0)
  assert.ok(BORDA_MARGEM_SECS > 0)
  assert.ok(
    BORDA_ALVO_SECS >= 10,
    'abaixo de 10 s o alvo fica frágil demais para uma rajada ruim',
  )
  assert.ok(
    BORDA_ALVO_SECS <= 40,
    'acima de 40 s já é atraso que a pessoa nota na TV',
  )
})

test('a rede de seguranca existe e e alta', () => {
  // Com a borda contínua ativa o reload não é o caminho normal, mas precisa
  // continuar existindo: se o cache passar disto com o teto ativo, alguma coisa
  // está errada e recarregar ainda é a resposta certa.
  assert.ok(RECARGA_DE_ULTIMO_RECURSO_SECS > BORDA_ALVO_SECS + BORDA_MARGEM_SECS)
})

test('conflito de portoes e DETECTADO, nao silencioso', () => {
  // O primeiro seek (sem margem) congelou o canal por 21 s — medido. A borda
  // contínua é o conserto dele. Ligar os dois daria dois seeks na mesma janela com
  // alvos incompatíveis: um vai para a última gota (congela), o outro para 25 s
  // atrás (funciona). O resultado seria o pior dos dois, alternando.
  assert.equal(portoesEmConflito({}), false)
  assert.equal(portoesEmConflito({ STPLAY_LIVE_EDGE_KEEP: '1' }), false)
  assert.equal(portoesEmConflito({ STPLAY_LIVE_EDGE_SEEK: '1' }), false)
  assert.equal(
    portoesEmConflito({ STPLAY_LIVE_EDGE_KEEP: '1', STPLAY_LIVE_EDGE_SEEK: '1' }),
    true,
    'os dois juntos tem de aparecer no log, nao virar sintoma',
  )
})

// Daqui para baixo: a aritmetica do avanco antigo. Ela continua correta e testada — o que
// falhou foi a IDEIA do seek, não o cálculo. Se um dia o painel entregar de
// verdade, `STPLAY_LIVE_EDGE_SEEK=1` liga o caminho com a conta já pronta.

test('o avanco e o cache menos a folga', () => {
  // O numero que o dono viu: 96,6 s de buffer.
  assert.equal(avancoParaVoltarAoVivo(96.6), Math.round(96.6 - SEEK_FOLGA_SECS))
  assert.equal(avancoParaVoltarAoVivo(90), 90 - SEEK_FOLGA_SECS)
  assert.equal(avancoParaVoltarAoVivo(180), 180 - SEEK_FOLGA_SECS)
})

test('a folga e de 1 s — seek alem do fim e ignorado pelo mpv', () => {
  assert.equal(SEEK_FOLGA_SECS, 1)
  assert.equal(avancoParaVoltarAoVivo(50), 49, 'sem a folga seria 50, no limite do indice')
})

test('cache curto nao gera seek: o demuxer ainda esta enchendo', () => {
  assert.equal(avancoParaVoltarAoVivo(0), null)
  assert.equal(avancoParaVoltarAoVivo(1), null)
  assert.equal(avancoParaVoltarAoVivo(2), null)
  assert.equal(avancoParaVoltarAoVivo(SEEK_PISO_SECS - 0.1), null, 'abaixo do piso')
  assert.ok(avancoParaVoltarAoVivo(SEEK_PISO_SECS) !== null, 'no piso ja corrige')
})

test('leitura ausente do mpv nao vira NaN no comando', () => {
  // `demuxer-cache-time` devolve null quando o mpv nao responde, e ja aconteceu:
  // o log tem `cacheSecs: null` em 46 tiques seguidos durante o boot.
  assert.equal(avancoParaVoltarAoVivo(null), null)
  assert.equal(avancoParaVoltarAoVivo(undefined), null)
  assert.equal(avancoParaVoltarAoVivo(Number.NaN), null)
  assert.equal(avancoParaVoltarAoVivo(Number.POSITIVE_INFINITY), null)
  assert.equal(avancoParaVoltarAoVivo('96'), null, 'string nao e numero')
})

test('o avanco e sempre inteiro e sempre positivo', () => {
  for (const cache of [3, 3.4, 7, 12.5, 90, 96.6, 300]) {
    const avanco = avancoParaVoltarAoVivo(cache)
    assert.equal(Number.isInteger(avanco), true, `${cache} -> ${avanco} nao e inteiro`)
    assert.ok(avanco >= 1, `${cache} -> ${avanco} nao e positivo`)
    assert.ok(avanco < cache, `${cache} -> ${avanco} nao avanca`)
  }
})

test('folga e piso customizados existem para o A/B sem recompilar', () => {
  // `folga: 0` remove a folga: o alvo passa a ser o indice exato do mpv, que e
  // o caso-limite a usar quando se quer o avanco maximo possivel.
  assert.equal(avancoParaVoltarAoVivo(10, { folga: 0 }), 10)
  // `piso: 0` so abaixa o piso — a FOLGA continua 1, porque sao gateways separados.
  // Por isso o resultado e 9 e nao 10.
  assert.equal(avancoParaVoltarAoVivo(10, { piso: 0 }), 9)
  assert.equal(avancoParaVoltarAoVivo(5, { piso: 6 }), null)
  assert.equal(avancoParaVoltarAoVivo(3, { folga: 0 }), 3)
})
