import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ROTACOES_LIVE_MAX,
  deveZerarReresolve,
  estadoInicialReresolve,
  podeRotacionarLive,
  registrarRotacao,
} from './live-reresolve.ts'

const LIVE = { kind: 'live', temPlaylist: true }
const SEM_PLAYLIST = { kind: 'live', temPlaylist: false }
const VOD = { kind: 'movie', temPlaylist: true }

/**
 * O LACO MEDIDO. Este e o teste que reproduz, passo a passo, a linha do log
 *
 *   22:31:01.633  de 709067 para 709686
 *   22:31:05.320  de 709686 para 709067
 *   22:31:08.889  de 709067 para 709686
 *   22:31:12.376  de 709686 para 709067
 *
 * e prova que, com o contador de trocas, a THIRD volta cai no ramo do erro em
 * vez de voltar a girar.
 */
test('o vaivem 709067 <-> 709686 para depois de duas trocas, em vez de girar para sempre', () => {
  let s = estadoInicialReresolve('live-709067')

  // volta 1: 709067 falha, rotaciona para 709686
  assert.equal(podeRotacionarLive(s, LIVE), true, 'a primeira falha pode rotacionar')
  s = registrarRotacao(s, 'live-709686')
  assert.equal(s.trocas, 1)

  // o efeito que roda na troca de id NAO pode apagar o contador
  assert.equal(
    deveZerarReresolve(s, 'live-709686'),
    null,
    'o id que acabamos de rotacionar para nao pode zerar o contador',
  )

  // volta 2: 709686 falha, rotaciona de volta para 709067
  assert.equal(podeRotacionarLive(s, LIVE), true, 'a segunda falha ainda pode rotacionar')
  s = registrarRotacao(s, 'live-709067')
  assert.equal(s.trocas, 2)
  assert.equal(deveZerarReresolve(s, 'live-709067'), null, 'o vaivem nao zera o contador')

  // volta 3: aqui estava o laco infinito. Agora o contador esgou.
  assert.equal(
    podeRotacionarLive(s, LIVE),
    false,
    'com o contador em ROTACOES_LIVE_MAX a falha tem que cair no ramo do erro',
  )
})

test('o erro aparece depois de exatamente ROTACOES_LIVE_MAX trocas, nem antes nem depois', () => {
  let s = estadoInicialReresolve('live-1')
  const vistos: number[] = []
  for (let i = 0; i < 6; i++) {
    const rotaciona = podeRotacionarLive(s, LIVE)
    vistos.push(rotaciona ? 1 : 0)
    if (!rotaciona) break
    s = registrarRotacao(s, `live-rotacao-${i}`)
  }
  assert.deepEqual(vistos, [1, 1, 0], 'duas trocas e entao o erro')
  assert.equal(s.trocas, ROTACOES_LIVE_MAX)
})

test('escolher outro canal zera o contador', () => {
  let s = estadoInicialReresolve('live-709067')
  s = registrarRotacao(s, 'live-709686')
  assert.equal(s.trocas, 1)

  // a pessoa escolheu Cartoon Network SD, nao o 709686
  const novo = deveZerarReresolve(s, 'live-709059')
  assert.ok(novo, 'trocar de canal tem que devolver estado novo')
  assert.equal(novo.trocas, 0, 'o contador recomeca para o canal novo')
  assert.equal(novo.busy, false)
  assert.equal(podeRotacionarLive(novo, LIVE), true, 'o canal novo pode rotacionar de novo')
})

test('voltar para o MESMO id nao reinicia a tentativa', () => {
  let s = estadoInicialReresolve('live-709067')
  s = registrarRotacao(s, 'live-709686')
  // a pessoa escolheu 709067 de novo a mao, e nao foi a rotacao que trouxe ele
  assert.ok(deveZerarReresolve(s, 'live-709067'), 'escolha manual do mesmo id e outra tentativa')
})

test('so rotaciona live com playlist', () => {
  const s = estadoInicialReresolve('live-1')
  assert.equal(podeRotacionarLive(s, VOD), false, 'filme e serie nao tem stream_id para rotacionar')
  assert.equal(podeRotacionarLive(s, SEM_PLAYLIST), false, 'sem playlist nao ha de onde buscar id novo')
})

test('failed repetido com a busca em andamento nao abre outra busca', () => {
  const s = { ...estadoInicialReresolve('live-1'), busy: true }
  assert.equal(podeRotacionarLive(s, LIVE), false, 'busca em andamento bloqueia a proxima')
})

test('a busca termina e a proxima falha ainda pode rotacionar', () => {
  const s = { ...estadoInicialReresolve('live-1'), busy: false }
  assert.equal(podeRotacionarLive(s, LIVE), true)
})

test('registrarRotacao preserva busy e nao muta o estado antigo', () => {
  const antes = { busy: true, trocas: 1, esperado: 'live-a' }
  const depois = registrarRotacao(antes, 'live-b')
  assert.equal(depois.busy, true, 'busy sobrevive a rotacao')
  assert.equal(depois.trocas, 2)
  assert.equal(depois.esperado, 'live-b')
  assert.equal(antes.trocas, 1, 'o estado anterior nao foi mexido')
  assert.equal(antes.esperado, 'live-a', 'o estado anterior nao foi mexido')
})

test('o estado inicial ja conta o id escolhido como esperado', () => {
  const s = estadoInicialReresolve('live-709067')
  assert.equal(s.esperado, 'live-709067')
  assert.equal(deveZerarReresolve(s, 'live-709067'), null, 'o primeiro efeito nao reinicia nada')
})
