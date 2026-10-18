const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  DEGRAUS,
  criarGovernador,
  decidir,
  proximaAcao,
  registrarUnderrun,
} = require('./live-underrun-governor.cjs')

/*
 * O furo que este teste trava.
 *
 * Medido no painel do dono (16/out, stream 524850.m3u8): 5 pausas de cache em 60 s
 * com o runway em 39 s, 48 s, 72 s, 75 s e 80 s. O cache NUNCA esteve seco — o
 * demuxer parou de CONSUMIR. O governador respondeu "readahead 8s -> 16s", que e
 * aumentar o colchao para um colchao que ja estava cheio: nao compra runway e
 * produz o acúmulo que o proprio motor registra (pico de 887 s de atraso).
 *
 * Sem o `folgaSecs` armazenado em cada pausa, o governador contava 3 pausas e
 * subia degrau, meia hora apos o problema comecar, sem nunca perguntar o tamanho
 * do buffer.
 */

test('com o cache ja cobrindo o degrau na pausa mais recente, nao sobe', () => {
  const agora = 1_000_000
  // 3 pausas na janela: normalmente subiria. Mas a mais recente tem cacheSecs
  // acima do degrau atual (8s), entao o problema nao e falta de colchao.
  const pausas = [
    { t: agora - 3000, folgaSecs: 5 },
    { t: agora - 2000, folgaSecs: 6 },
    { t: agora - 1000, folgaSecs: DEGRAUS[0] + 2 }, // 10s com o degrau em 8s
  ]

  const d = decidir({ pausas, degrau: 0, agoraMs: agora })

  assert.equal(d.subiu, false, 'nao pode subir quando o cache ja cobre o degrau')
  assert.equal(d.readaheadSecs, DEGRAUS[0], 'o readahead fica onde estava')
  assert.match(d.motivo, /cobre o degrau/)
})

test('com o cache pequeno na pausa mais recente, sobe como sempre', () => {
  const agora = 1_000_000
  const pausas = [
    { t: agora - 3000, folgaSecs: 5 },
    { t: agora - 2000, folgaSecs: 6 },
    { t: agora - 1000, folgaSecs: 2 }, // abaixo do degrau
  ]

  const d = decidir({ pausas, degrau: 0, agoraMs: agora })

  assert.equal(d.subiu, true, 'com cache pequeno, subir e a resposta certa')
  assert.equal(d.readaheadSecs, DEGRAUS[1])
})

test('sem dado de cache (desconhecido) NAO e lido como "o buffer secou"', () => {
  const agora = 1_000_000
  const pausas = [
    { t: agora - 3000, folgaSecs: -1 },
    { t: agora - 2000, folgaSecs: -1 },
    { t: agora - 1000, folgaSecs: -1 },
  ]

  const d = decidir({ pausas, degrau: 0, agoraMs: agora })

  assert.equal(d.subiu, true, 'desconhecido nao bloqueia a subida com 3 pausas')
  assert.equal(d.readaheadSecs, DEGRAUS[1])

  // E o mesmo pela via de `proximaAcao`, que nao recebe mais cacheSecs.
  const gov = criarGovernador()
  for (let i = 0; i < 3; i++) registrarUnderrun(gov, agora - 1000 * (i + 1), -1)
  const semArg = proximaAcao(gov, agora)
  assert.ok(semArg, 'com 3 pausas e sem dado de cache, o governador manda subir')
})

/*
 * O QUE O LOG MEDIU (16/out, tres sessoes identicas):
 *
 *   load   folga=40,3 s   o demuxer le a janela HLS inteira antes do playhead
 *   +12 s  folga=0,176 s  pausa
 *
 * O buffer drena de 40 s para 150 ms em 12 segundos. Com `PAUSAS_PARA_SUBIR = 3`
 * e a janela de 30 s, e o painel dando 2 pausas por sessao, o_degrau nunca subia:
 * o usuario levava o gaguejo inteiro sem reparo nenhum.
 */

test('folga que SECOU escala na primeira pausa, sem esperar as tres', () => {
  const agora = 1_000_000
  const pausas = [{ t: agora - 1000, folgaSecs: 0.124 }] // a medida real do painel

  const d = decidir({ pausas, degrau: 0, agoraMs: agora })

  assert.equal(d.subiu, true, 'runway seco nao espera confirmacao')
  assert.equal(d.readaheadSecs, DEGRAUS[1], '8s -> 16s passa o segmento de 10s')
})

test('folga marginal continua esperando as tres pausas', () => {
  const agora = 1_000_000
  const pausas = [{ t: agora - 1000, folgaSecs: 4 }]

  const d = decidir({ pausas, degrau: 0, agoraMs: agora })

  assert.equal(d.subiu, false, '4s e margem: ainda nao e prova de que o buffer e curto')
  assert.match(d.motivo, /1\/3/)
})

test('proximaAcao repassa o folgaSecs de cada pausa ate decidir', () => {
  const agora = 1_000_000
  let gov = criarGovernador()
  for (let i = 0; i < 3; i++) registrarUnderrun(gov, agora - 1000 * (i + 1), 40)

  const comBuffer = proximaAcao(gov, agora)
  assert.equal(comBuffer, null, 'folga de 40s cobre o degrau: nenhuma acao de IPC')

  // Mesma janela de pausas, agora com o buffer curto na pausa mais recente: sobe.
  gov = criarGovernador()
  gov.ultimaMudancaMs = 0
  for (let i = 0; i < 2; i++) registrarUnderrun(gov, agora - 1000 * (i + 1), 40)
  registrarUnderrun(gov, agora, 0.124) // a pausa mais recente tem buffer seco

  const semBuffer = proximaAcao(gov, agora)
  assert.ok(semBuffer, 'folga seca na pausa mais recente: o governador manda subir')
  assert.equal(semBuffer.readaheadSecs, DEGRAUS[1])
})
