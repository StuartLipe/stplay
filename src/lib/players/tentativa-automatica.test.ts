import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ESPERO_ENTRE_TENTATIVAS_MS,
  TENTATIVAS_AUTOMATICAS_MAX,
  deveRepetirSozinho,
  estadoTentativaAutomatica,
  gastarTentativa,
} from './tentativa-automatica.ts'

/**
 * O CASO MEDIDO, que e o que a pessoa reportou: "o canal nao caiu, e muito
 * dificil os canais abertos cair".
 *
 *   01:26:35.389  start
 *   01:26:44.754  loadfile ok        <- o aquecimento bateu no teto
 *   01:26:44.766  end-file error     <- 12ms, publicados:0 janela:0
 *                 motivo:null  tentativas:0     <- nem chegou a falhar
 *   01:26:48.295  start              <- retry
 *   01:26:53.948  file-loaded
 *   01:26:53.958  first frame        <- FUNCIONOU
 *
 * A origem no mesmo instante: peak -17,3 dBFS. So a primeira tentativa falhou.
 */
test('a primeira falha de live repete em vez de mostrar erro', () => {
  assert.equal(deveRepetirSozinho(estadoTentativaAutomatica(), { kind: 'live' }), true)
})

test('so repete duas vezes, e nao mais', () => {
  let s = estadoTentativaAutomatica()
  const respostas: boolean[] = []
  for (let i = 0; i < 6; i++) {
    const repete = deveRepetirSozinho(s, { kind: 'live' })
    respostas.push(repete)
    if (!repete) break
    s = gastarTentativa(s)
  }
  assert.deepEqual(respostas, [true, true, false], 'duas repeticoes e entao o erro')
  assert.equal(s.gastas, TENTATIVAS_AUTOMATICAS_MAX)
})

test('filme e serie NAO repetem sozinhos: repetir esconderia um erro real', () => {
  assert.equal(deveRepetirSozinho(estadoTentativaAutomatica(), { kind: 'movie' }), false)
  assert.equal(deveRepetirSozinho(estadoTentativaAutomatica(), { kind: 'series' }), false)
})

test('o espaco entre tentativas cobre o tempo que o painel leva', () => {
  // Medido: a tentativa que volta rapido pegava o mesmo cache do painel. O que
  // funcionou no log foi a segunda, 13s depois. 2,5s e o minimo que ainda deixa
  // a conexao velha morrer sem custar tempo de quem so queria assistir.
  assert.ok(ESPERO_ENTRE_TENTATIVAS_MS >= 2000, 'abaixo de 2s repete a mesma requisicao')
  assert.ok(ESPERO_ENTRE_TENTATIVAS_MS <= 4000, 'acima de 4s a pessoa espera de menos')
})

test('gastarTentativa nao muta o estado anterior', () => {
  const antes = estadoTentativaAutomatica()
  const depois = gastarTentativa(antes)
  assert.equal(depois.gastas, 1)
  assert.equal(antes.gastas, 0, 'o estado anterior nao foi mexido')
  assert.deepEqual(estadoTentativaAutomatica(), { gastas: 0 }, 'estado inicial e zero')
})