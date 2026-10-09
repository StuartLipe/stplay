// Regressao para o governador de underrun (electron/players/live-underrun-governor.cjs).
//
// O sintoma que este arquivo existe para fechar: "depois de 1 min assistindo da
// umas travadas, tipo gargalando, e o canal continua rodando". O playback nunca
// para de verdade — o mpv segura o stream por falta de byte e reanima. Entao os
// detectores de stall nao veem nada, porque stall de verdade nao existe.
//
// O que nao pode regredir:
//
//   1. Uma pausa isolada NAO sobe o degrau. Uma pausa e jitter de rede, que todo
//      mundo tem; subir o readahead por causa dela custaria entrada lenta de canal
//      sem motivo nenhum.
//   2. Tres pausas na janela sobem UM degrau, e a janela zera depois — senao o
//      proximo tique veria as mesmas tres e escalaria ate o maximo sem parar.
//   3. NUNCA desce. Descer e oscilar: subir, resolver, descer, voltar.
//   4. Chega no degrau maximo e para de pedir. Nao ha envio indevido para o mpv
//      recebendo o mesmo valor.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEGRAUS,
  CACHE_SECS_FIXO,
  PAUSAS_PARA_SUBIR,
  JANELA_MS,
  ENTRE_MUDANCAS_MS,
  decidir,
  criarGovernador,
  registrarUnderrun,
  proximaAcao,
} = require('./live-underrun-governor.cjs')

test('o primeiro degrau e o perfil que ja estava em uso', () => {
  assert.equal(DEGRAUS[0], 8, 'o comeco tem de ser o valor medido, nao um novo')
  assert.equal(decidir({}).readaheadSecs, 8)
  assert.equal(decidir({}).cacheSecs, 8)
})

test('uma pausa isolada nao move nada', () => {
  const d = decidir({ pausas: [1000], agoraMs: 2000 })
  assert.equal(d.subiu, false)
  assert.equal(d.degrau, 0)
  assert.equal(d.naJanela, 1)
  assert.match(d.motivo, /1\/3/, 'o motivo diz o que falta')
})

test('duas pausas ainda nao sobem', () => {
  const agora = 1000 + ENTRE_MUDANCAS_MS
  const d = decidir({ pausas: [1000, agora - 1000], agoraMs: agora })
  assert.equal(d.subiu, false)
  assert.equal(d.degrau, 0)
})

test('tres pausas na janela sobem um degrau', () => {
  const agora = 1000 + ENTRE_MUDANCAS_MS
  const d = decidir({
    pausas: [agora - 3000, agora - 2000, agora - 1000],
    agoraMs: agora,
  })
  assert.equal(d.subiu, true)
  assert.equal(d.degrau, 1)
  assert.equal(d.readaheadSecs, DEGRAUS[1], 'o TETO sobe')
  assert.equal(d.cacheSecs, CACHE_SECS_FIXO, 'o gatilho da pausa fica')
})

test('pausa fora da janela nao conta', () => {
  const agora = 100_000 + ENTRE_MUDANCAS_MS
  const velha = agora - JANELA_MS - 1
  const d = decidir({
    pausas: [velha, agora - 2000, agora - 1000],
    agoraMs: agora,
  })
  assert.equal(d.subiu, false, 'a pausa velha saiu da janela deslizante')
  assert.equal(d.naJanela, 2)
})

test('sobe ate o degrau maximo e para de pedir', () => {
  const gov = criarGovernador()
  let t = 1000
  let subidas = 0
  for (let i = 0; i < 40; i += 1) {
    t += ENTRE_MUDANCAS_MS
    for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
    const acao = proximaAcao(gov, t)
    if (acao) subidas += 1
  }
  assert.equal(gov.degrau, DEGRAUS.length - 1, 'tem de chegar no topo')
  assert.equal(subidas, DEGRAUS.length - 1, 'e subir uma vez por degrau, nao mais')
})

test('nunca desce, nem com o canal limpo', () => {
  const gov = criarGovernador()
  let t = 1000
  t += ENTRE_MUDANCAS_MS
  for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
  proximaAcao(gov, t)
  assert.equal(gov.degrau, 1)

  // Passa muito tempo com o canal perfeito: sem underrun nenhum.
  t += 10 * ENTRE_MUDANCAS_MS
  const acao = proximaAcao(gov, t)
  assert.equal(acao, null)
  assert.equal(gov.degrau, 1, 'o colchao que deu conta fica')
})

test('o intervalo entre mudancas e respeitado', () => {
  const gov = criarGovernador()
  let t = 1000
  t += ENTRE_MUDANCAS_MS
  for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
  assert.ok(proximaAcao(gov, t), 'a primeira vez passa')

  // Mesma janela, mesmo com pausinhas novas: nao pode escalar de novo na hora.
  t += 1000
  for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
  assert.equal(proximaAcao(gov, t), null, 'o demuxer precisa de tempo para encher')
})

test('a janela zera depois de subir, senao escalona sem parar', () => {
  const gov = criarGovernador()
  let t = 1000
  t += ENTRE_MUDANCAS_MS
  for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
  const acao = proximaAcao(gov, t)
  assert.equal(acao.subiu, true)
  assert.equal(gov.pausas.length, 0, 'as 3 pausinhas que motivaram nao contam de novo')
})

test('o historico fica preso na janela, nao cresce a sessao toda', () => {
  const gov = criarGovernador()
  let t = 1000
  for (let i = 0; i < 500; i += 1) {
    t += 1000
    registrarUnderrun(gov, t)
  }
  // Um underrun por segundo durante 500 s. O que segura o array e a janela
  // deslizante de 30 s, entao o teto e a janela em segundos, mais o que acabou
  // de entrar. Crescer alem disso seria vazar memoria numa sessao longa de TV.
  const teto = JANELA_MS / 1000 + 1
  assert.ok(
    gov.pausas.length <= teto,
    `sobrou ${gov.pausas.length}, teto ${teto} — a janela deslizante nao esta descartando`,
  )
  assert.ok(gov.pausas.length > 0, 'a janela nunca pode esvaziar sozinha')
})

test('o gatilho da pausa NAO sobe — so o teto', () => {
  /*
   * REGRESSAO MEDIDA, NAO TEORICA.
   *
   * Subir `cache-secs` junto com o teto fez o canal garralhar MAIS: "agora trava a
   * cada poucos segundos". Couplados, os dois numeros nao tem direcao — subir o
   * colchao tambem sobe a linha de alarme, e o `cache-pause` passa a disparar
   * duas vezes mais vezes.
   *
   * Este teste e o que impede a reconciliacao de voltar.
   */
  const gov = criarGovernador()
  let t = 1000
  let subidas = 0
  for (let i = 0; i < DEGRAUS.length + 2; i += 1) {
    const antes = gov.degrau
    t += ENTRE_MUDANCAS_MS
    for (let k = 0; k < PAUSAS_PARA_SUBIR; k += 1) registrarUnderrun(gov, t)
    const acao = proximaAcao(gov, t)
    if (!acao) {
      assert.equal(gov.degrau, DEGRAUS.length - 1, 'no topo nao ha degrau acima')
      continue
    }
    subidas += 1
    assert.ok(acao.readaheadSecs > 8, 'o teto tem de crescer')
    assert.equal(acao.cacheSecs, CACHE_SECS_FIXO, 'o gatilho da pausa nao sobe')
    assert.equal(acao.cacheSecs, 8, 'o gatilho fica no valor medido')
    assert.equal(gov.degrau, antes + 1, 'o degrau sobe')
  }
  assert.equal(subidas, DEGRAUS.length - 1, 'um degrau por ralo, e para no topo')
  assert.equal(gov.degrau, DEGRAUS.length - 1)
})

test('decidir recusa entrada absurda em vez de inventar degrau', () => {
  assert.equal(decidir({ degrau: -5 }).degrau, 0)
  assert.equal(decidir({ degrau: 999 }).degrau, DEGRAUS.length - 1)
  assert.equal(decidir({ degrau: 999 }).subiu, false)
})
