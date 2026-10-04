// Regressao para o casamento de "continuar assistindo" (src/lib/continue-matching.ts).
//
// O bug que estes testes seguram down e um BOIAO MORTO: o "Sim, remover"
// confirmava a remocao, o modal fechava, e o item continuava na lista. Sem erro,
// sem log — so a sensacao de que o botao nao faz nada.
//
// A causa era o choque de namespace: o card da serie no browse tem id 'series-123',
// mas o item guardado para aquela serie tem channel.id 'ep-456' (o EPISODIO
// assistido) e seriesId '123' (numero cru). O menu da pre-visualizacao ainda
// descartava o channelId que o chamador mandava e re-montava o alvo pelo canal
// do browse, entao a comparacao era 'series-123' contra 'ep-456'.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { continueItemMatches, withoutContinueItem } from './continue-matching.ts'
import type { Channel, ContinueWatching } from '../types.ts'

const PLAYLIST = 'pl-1'

function channel(partial: Partial<Channel>): Channel {
  return {
    id: 'x',
    name: 'x',
    kind: 'series',
    logo: '',
    group: '',
    url: '',
    ...partial,
  } as Channel
}

function entry(partial: Partial<ContinueWatching>): ContinueWatching {
  return {
    playlistId: PLAYLIST,
    channel: channel({}),
    currentTime: 60,
    duration: 1800,
    updatedAt: 1,
    ...partial,
  } as ContinueWatching
}

describe('remover de continuar assistindo: card de serie', () => {
  // O cenario real do bug: a serie foi assistida por um episodio.
  const stored = entry({
    channel: channel({ id: 'ep-456', kind: 'series', seriesId: '123', name: 'Ep 1' }),
    seriesId: '123',
    seriesName: 'Minha Serie',
  })

  test('o id do card do browse (series-N) acha o item guardado pelo episodio', () => {
    assert.equal(continueItemMatches(stored, PLAYLIST, 'series-123', undefined), true)
  })

  test('o id do browse acha o item mesmo sem seriesId explicito', () => {
    // Foi assim que o bug se manifestava: o menu passava sId undefined.
    assert.equal(withoutContinueItem([stored], PLAYLIST, 'series-123', undefined).length, 0)
  })

  test('o episodeNumber do browse tb casa (o mesmo numero, so com prefixo)', () => {
    assert.equal(continueItemMatches(stored, PLAYLIST, 'ep-456', undefined), true)
  })

  test('seriesId numerico cru casa', () => {
    assert.equal(continueItemMatches(stored, PLAYLIST, undefined, '123'), true)
  })
})

describe('remover de continuar assistindo: nao remove o item errado', () => {
  const serie = entry({
    channel: channel({ id: 'ep-456', kind: 'series', seriesId: '123' }),
    seriesId: '123',
  })
  const filme = entry({
    channel: channel({ id: 'vod-123', kind: 'movie', name: 'Um Filme' }),
  })
  const lista = [serie, filme]

  test('remover a serie 123 NAO remove o filme vod-123', () => {
    // Comparacao por "tamanho" (tirar o prefixo e comparar) casaria 'vod-123' com
    // 'series-123' e apagaria o filme. O usuario perderia um download sem nunca
    // ter pedido.
    const rest = withoutContinueItem(lista, PLAYLIST, 'series-123', undefined)
    assert.equal(rest.length, 1)
    assert.equal(rest[0].channel.id, 'vod-123')
  })

  test('remover um filme so remove o filme', () => {
    const rest = withoutContinueItem(lista, PLAYLIST, 'vod-123', undefined)
    assert.equal(rest.length, 1)
    assert.equal(rest[0].channel.id, 'ep-456')
  })

  test('nao atravessa de playlist', () => {
    const deOutra = entry({ playlistId: 'pl-2', channel: channel({ id: 'vod-9' }) })
    const rest = withoutContinueItem([deOutra], PLAYLIST, 'vod-9', undefined)
    assert.equal(rest.length, 1, 'item de outra playlist tem de sobreviver')
  })

  test('serie de outra playlist nao e removida pelo id da serie ativa', () => {
    const deOutra = entry({
      playlistId: 'pl-2',
      channel: channel({ id: 'ep-1', seriesId: '123' }),
      seriesId: '123',
    })
    const rest = withoutContinueItem([deOutra], PLAYLIST, 'series-123', undefined)
    assert.equal(rest.length, 1)
  })

  test('alvo desconhecido nao remove nada', () => {
    const rest = withoutContinueItem(lista, PLAYLIST, 'series-999', undefined)
    assert.equal(rest.length, 2)
  })

  test('so o episodio alvo sai quando o alvo e um episodio', () => {
    const ep1 = entry({ channel: channel({ id: 'ep-1', seriesId: '123' }), seriesId: '123' })
    const ep2 = entry({ channel: channel({ id: 'ep-2', seriesId: '123' }), seriesId: '123' })
    const rest = withoutContinueItem([ep1, ep2], PLAYLIST, 'ep-1', '123')
    // seriesId informado => a serie inteira sai, que e o comportamento esperado
    // do botao do card da serie.
    assert.equal(rest.length, 0)
    // Sem seriesId, so o episodio alvo sai.
    const rest2 = withoutContinueItem([ep1, ep2], PLAYLIST, 'ep-1', undefined)
    assert.equal(rest2.length, 1)
    assert.equal(rest2[0].channel.id, 'ep-2')
  })

  test('id vazio ou undefined nao remove nada', () => {
    assert.equal(withoutContinueItem(lista, PLAYLIST, undefined, undefined).length, 2)
    assert.equal(withoutContinueItem(lista, PLAYLIST, '', undefined).length, 2)
  })
})
