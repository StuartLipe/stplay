import type { Channel, ContinueWatching } from '../types'

/**
 * Casamento entre um item de "continuar assistindo" e o alvo de uma remocao.
 *
 * Este logitsmo estava diluido em tres lugares do App.tsx, cada um com um
 * recorte diferente, e eles discordavam entre si. O que quebrava na pratica:
 *
 * O card da serie no browse tem `id: 'series-123'`. O item guardado em
 * "continuar assistindo" para essa mesma serie tem `channel.id: 'ep-456'` (o
 * EPISODIO que foi assistido) e `seriesId: '123'` (o numero cru). O menu da
 * pre-visualizacao descartava o channelId que o chamador mandava e re-montava o
 * alvo pelo `menuChannel` do browse, entao a remocao acabava comparando
 * 'series-123' contra 'ep-456' — nao casava com nada e o botao "Sim, remover"
 * nao removia nada. Sem erro, sem log: so a sensacao de que o botao e morto.
 *
 * A regra e explicita por namespace em vez de comparacao por "tamanho":
 * comparar 'vod-123' e 'series-123' depois de tirar o prefixo seria empate, e
 * remover um filme porque o usuario pediu para remover uma serie seria pior do
 * que o botao nao fazer nada.
 */

/** Reconhece o namespace do id de catalogo. */
const SERIES_ID_RE = /^series-(.+)$/
const EPISODE_ID_RE = /^ep-(.+)$/

/** Numero cru de um id namespaced, ou o proprio id se nao for namespaced. */
function seriesNumber(id: string | undefined | null): string | null {
  if (!id) return null
  const m = SERIES_ID_RE.exec(String(id))
  return m ? m[1] : null
}

function episodeNumber(id: string | undefined | null): string | null {
  if (!id) return null
  const m = EPISODE_ID_RE.exec(String(id))
  return m ? m[1] : null
}

/** `true` se `channel` representa a serie `seriesId` (ou o card de serie dela). */
export function channelIsSeries(channel: Pick<Channel, 'id' | 'kind' | 'seriesId'> | null | undefined, seriesId: string | undefined | null): boolean {
  if (!channel || !seriesId) return false
  const asSeries = seriesNumber(channel.id)
  if (asSeries !== null) return asSeries === seriesId
  return channel.seriesId === seriesId
}

/**
 * `true` se o item de continuar assistindo corresponde ao alvo.
 *
 * @param item          item guardado na lista
 * @param playlistId    perfil/playlist ativo; `undefined` desescopa a busca
 * @param channelId     id do alvo. Pode ser `series-123` (card de serie) ou o
 *                      id do episodio (aberto pela ficha da serie)
 * @param seriesId      id de serie quando conhecido
 */
export function continueItemMatches(
  item: ContinueWatching,
  playlistId: string | undefined,
  channelId: string | undefined,
  seriesId?: string,
): boolean {
  if (playlistId !== undefined && item.playlistId !== playlistId) return false

  const channel = item.channel
  const wantedSeries = seriesId ?? seriesNumber(channelId) ?? undefined
  const targetEpisode = episodeNumber(channelId)
  const targetRaw = targetEpisode === null ? channelId : undefined

  // Alvo e a SERIE (card do browse, ou seriesId explicito): casa com qualquer
  // episodio guardado daquela serie. E o que o botao do card de serie precisa.
  if (wantedSeries) {
    if (item.seriesId === wantedSeries) return true
    if (channel.seriesId === wantedSeries) return true
    if (seriesNumber(channel.id) === wantedSeries) return true
  }

  // Alvo e um EPISODIO especifico: so esse episodio deve sair.
  if (targetRaw) {
    if (channel.id === targetRaw) return true
    if (channel.streamId && channel.streamId === targetRaw) return true
  }
  if (targetEpisode !== null) {
    if (episodeNumber(channel.id) === targetEpisode) return true
    // `streamId` do catalogo Xtream e o numero cru do stream, sem prefixo.
    if (channel.streamId && String(channel.streamId) === targetEpisode) return true
  }

  return false
}

/** Filtra a lista mantendo tudo que NAO corresponde ao alvo. */
export function withoutContinueItem(
  items: ContinueWatching[],
  playlistId: string | undefined,
  channelId: string | undefined,
  seriesId?: string,
): ContinueWatching[] {
  return items.filter((item) => !continueItemMatches(item, playlistId, channelId, seriesId))
}
