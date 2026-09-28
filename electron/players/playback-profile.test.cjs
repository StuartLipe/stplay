// Regressao para o memo do perfil de playback (electron/players/playback-profile.cjs).
//
// O bug que estes testes seguram down e SILENCIOSO: se `diffProfile` decidir que
// uma property ja esta no valor certo quando nao esta, o canal abre com o perfil
// errado. Sem erro, sem log de falha — so imagem com buffer estranho, e so em
// alguns canais, porque depende de qual canal foi clicado antes.
const assert = require('node:assert/strict')
const { describe, test } = require('node:test')
const { profileFor, diffProfile, commitApplied } = require('./playback-profile.cjs')
const { liveStreamLavfO } = require('./live-load-policy.cjs')

function applyOk(applied, profile) {
  commitApplied(applied, profile, profile.map(() => ({ ok: true })))
  return applied
}

describe('perfil de playback: diff contra o memo', () => {
  test('memo vazio manda o perfil inteiro', () => {
    const { fresh, stale } = diffProfile(profileFor(true, false), new Map())
    assert.equal(fresh.length, 9)
    assert.equal(stale.length, 0)
  })

  test('zape de live reenvia so o que a liberacao do slot mudou', () => {
    // Sequencia REAL do zape, na ordem em que acontece no main:
    //   1. perfil completo da live que estava tocando        (9 properties)
    //   2. liberacao do slot: stream-lavf-o <- reconnect=0  (fora do perfil)
    //   3. perfil do soft-zap                               (5 properties)
    //
    // O passo 2 e o que quebra o memo: ele escreve stream-lavf-o por fora do
    // perfil, entao a liberacao tem que atualizar o memo junto — e atualiza
    // (ver loadStream). Sem esse update o memo continuaria dizendo reconnect=1,
    // o diff do passo 3 pularia o comando por "ja esta aplicado", e o canal
    // abriria com reconnect=0 — o modo que segura o socket velho e ocupa a
    // unica tela da conta. Sintoma: canal que nao abre depois de um zape,
    // sem erro nenhum no log.
    const applied = applyOk(new Map(), profileFor(true, false))

    // passo 2: a liberacao escreve e registra no memo
    applied.set('stream-lavf-o', liveStreamLavfO(false))

    const { fresh, stale } = diffProfile(profileFor(true, true), applied)

    assert.deepEqual(fresh.map((p) => p[0]), ['pause', 'stream-lavf-o'])
    assert.equal(
      fresh.find((p) => p[0] === 'stream-lavf-o')[1],
      liveStreamLavfO(true),
      'tem que voltar para reconnect=1, senao o socket velho continua preso',
    )
    assert.deepEqual(stale, ['cache-pause', 'cache-pause-initial', 'demuxer-lavf-o'])
  })

  test('CONTRA-TESTE: sem o update do memo na liberacao, reconnect=0 sobrevive', () => {
    // Prova que o update do passo 2 e load-bearing. Se alguem remover a linha
    // appliedProfile.set da liberacao, este teste e o de cima mudam de resultado
    // e a suite falha — que e o ponto.
    const applied = applyOk(new Map(), profileFor(true, false))
    // passo 2 SEM registrar no memo — o bug
    const { fresh } = diffProfile(profileFor(true, true), applied)
    assert.equal(
      fresh.some((p) => p[0] === 'stream-lavf-o'),
      false,
      'reproduz o bug: reconnect=0 sobrevive no canal novo',
    )
  })

  test('property so e pulada com valor IGUAL, nao so com a chave presente', () => {
    const applied = new Map([['cache-secs', 99]])
    const { fresh, stale } = diffProfile(profileFor(true, false), applied)
    // cache-secs esta no memo mas com outro valor: tem que reenviar.
    assert.ok(fresh.map((p) => p[0]).includes('cache-secs'))
    assert.equal(stale.includes('cache-secs'), false)
  })

  test('zero e false nao sao confundidos com ausente', () => {
    // has() em vez de get() !== undefined trataria 0 como ausente; e
    // get() || default trataria false como ausente.
    const applied = new Map([['cache-pause-wait', 0]])
    const { fresh, stale } = diffProfile(profileFor(true, false), applied)
    assert.equal(stale.includes('cache-pause-wait'), false)
    assert.ok(fresh.map((p) => p[0]).includes('cache-pause-wait'))
  })

  test('property que o mpv recusou NAO entra no memo', () => {
    const applied = new Map()
    const profile = profileFor(true, false)
    const results = profile.map((_, i) => (i === 0 ? { ok: false, error: 'property unavailable' } : { ok: true }))

    commitApplied(applied, profile, results)

    const { fresh } = diffProfile(profile, applied)
    assert.equal(fresh.length, 1, 'so a que falhou volta a ser enviada')
    assert.equal(fresh[0][0], profile[0][0])
  })

  test('resultado ausente (nem ok nem erro) nao entra no memo', () => {
    const applied = new Map()
    const profile = [['x', 1], ['y', 2]]
    commitApplied(applied, profile, [{ ok: true }, undefined])
    assert.equal(applied.size, 1)
    assert.equal(applied.get('x'), 1)
  })
})

describe('perfil de playback: tabela por modo', () => {
  test('live completo e live soft-zap tem properties diferentes', () => {
    const full = profileFor(true, false).map((p) => p[0])
    const soft = profileFor(true, true).map((p) => p[0])
    // pause so existe no soft-zap: e o comando que tira o pause que o
    // watchdog pode ter deixado ao forcar o primeiro quadro.
    assert.ok(soft.includes('pause'))
    assert.equal(full.includes('pause'), false)
    // cache-secs so no completo.
    assert.ok(full.includes('cache-secs'))
    assert.equal(soft.includes('cache-secs'), false)
  })

  test('VOD usa cache-secs 12 e live usa 8', () => {
    const pick = (p) => p.find(([k]) => k === 'cache-secs')[1]
    assert.equal(pick(profileFor(false, false)), 12)
    assert.equal(pick(profileFor(true, false)), 8)
  })

  test('VOD nao leva live_start_index (seek para tras so faz sentido em live)', () => {
    assert.equal(profileFor(false, false).map((p) => p[0]).includes('demuxer-lavf-o'), false)
  })

  test('nenhum modo repete a mesma property', () => {
    for (const [live, soft] of [[true, true], [true, false], [false, false]]) {
      const keys = profileFor(live, soft).map((p) => p[0])
      assert.equal(new Set(keys).size, keys.length, `duplicada em live=${live} softZap=${soft}`)
    }
  })
})
