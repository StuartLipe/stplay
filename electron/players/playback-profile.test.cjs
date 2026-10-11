// Regressao para o memo do perfil de playback (electron/players/playback-profile.cjs).
//
// O bug que estes testes seguram down e SILENCIOSO: se `diffProfile` decidir que
// uma property ja esta no valor certo quando nao esta, o canal abre com o perfil
// errado. Sem erro, sem log de falha — so imagem com buffer estranho, e so em
// alguns canais, porque depende de qual canal foi clicado antes.
const assert = require('node:assert/strict')
const { describe, test } = require('node:test')
const { profileFor, diffProfile, commitApplied, LIVE_CACHE_SECS, LIVE_CACHE_PAUSE_WAIT, LIVE_READAHEAD_SECS } = require('./playback-profile.cjs')

function applyOk(applied, profile) {
  commitApplied(applied, profile, profile.map(() => ({ ok: true })))
  return applied
}

describe('perfil de playback: diff contra o memo', () => {
  test('memo vazio manda o perfil inteiro', () => {
    const { fresh, stale } = diffProfile(profileFor(true, false), new Map())
    assert.equal(fresh.length, profileFor(true, false).length)
    assert.equal(stale.length, 0)
  })

  test('zape de live nao renova o buffer (rebuffer custaria 1-3s por zape)', () => {
    const applied = applyOk(new Map(), profileFor(true, false))
    const { fresh } = diffProfile(profileFor(true, true), applied)

    // O soft-zap so pode reenviar o que a liberacao do slot mudou de valor.
    // Buffer NOVO aqui (cache-secs/cache-pause-wait) seria um zape que espera
    // o buffer encher antes de mostrar video — o oposto de zape.
    for (const key of ['cache-secs', 'cache-pause-wait', 'cache-pause-initial']) {
      assert.equal(
        fresh.some((p) => p[0] === key),
        false,
        `${key} nao pode ser reenviado no soft-zap`,
      )
    }
    assert.ok(fresh.some((p) => p[0] === 'pause'))
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

  test('live segura o par de buffering; cache-secs fica no valor medido', () => {
    const pick = (p, k) => p.find(([key]) => key === k)[1]
    // O sweep mostrou que cache-secs NAO e o gargalo nesta origem (buffer_min
    // ~52s em todos os perfis) e que cache-pause-wait grande PRODUZ pausa
    // visivel: wait=10 deu 13 pausas, wait=2 deu 1. Entao o perfil segura o
    // par de buffering e nao infla o cache.
    assert.equal(pick(profileFor(true, false), 'cache-pause-initial'), true)
    assert.equal(pick(profileFor(true, false), 'cache-pause'), true)
    assert.equal(pick(profileFor(true, false), 'cache-pause-wait'), LIVE_CACHE_PAUSE_WAIT)
    assert.equal(pick(profileFor(true, false), 'cache-secs'), LIVE_CACHE_SECS)
    assert.ok(LIVE_CACHE_PAUSE_WAIT <= 3, 'wait alto vira pausa visivel nesta origem')
    // VOD nao muda: comeca assim que houver quadro.
    assert.equal(pick(profileFor(false, false), 'cache-secs'), 12)
    assert.equal(pick(profileFor(false, false), 'cache-pause-initial'), false)
  })

  test('readahead acompanha cache-secs (cache-secs manda, o manual avisa)', () => {
    const pick = (p, k) => p.find(([key]) => key === k)[1]
    assert.equal(
      pick(profileFor(true, false), 'demuxer-readahead-secs'),
      pick(profileFor(true, false), 'cache-secs'),
    )
  })

  test('nenhuma property de lavf vai no perfil de runtime', () => {
    // `reconnect` e `live_start_index` sao do demuxer e nao de stream; o
    // runtime escrevia `stream-lavf-o`, que o manual descreve como descarte
    // silencioso de option desconhecida. Ficaram so na linha de comando.
    for (const live of [true, false]) {
      for (const soft of [true, false]) {
        const keys = profileFor(live, soft).map((p) => p[0])
        assert.equal(keys.includes('stream-lavf-o'), false)
        assert.equal(keys.includes('demuxer-lavf-o'), false)
      }
    }
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
