/**
 * Casamento de canal de live entre duas listagens do painel.
 *
 * Isolar isso num modulo próprio, e não deixar dentro de `xtream.ts`, pelo mesmo
 * motivo de `live-load-policy.cjs`: a parte que decide é PURA e a parte que
 * faz rede é fina. Se o casamento morar junto do `fetchJson`, testá-lo exige
 * rede, e a trava contra o laço — que é a propriedade que mais importa aqui —
 * fica sem cobertura.
 *
 * O problema que isto resolve, medido: o painel rotaciona o `stream_id` do
 * canal. `709056` virou 404 e o mesmo canal passou a responder em `709057`. O
 * catálogo do app guarda a URL montada no load, então abrir um canal que morreu
 * ha dez minutos insistia no ID morto.
 */

export type LiveStreamLike = {
  stream_id: number
  name?: string
  epg_channel_id?: string
}

export type LiveChannelLike = {
  name?: string
  streamId?: string
  tvgId?: string
}

/**
 * Normaliza nome de canal para casar duas listagens do mesmo canal.
 *
 * O nome é o que o usuário reconhece, mas ele muda entre uma listagem e outra:
 * acento, `HD`/`FHD`/`4K` acrescentado, espaço extra, pontuação. Comparar o nome
 * cru erra em todos esses casos e o efeito é silencioso — o app simplesmente
 * "não acha" o canal e trata como morto.
 */
export function normalizeChannelName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(hd|sd|fhd|uhd|4k|fullhd|hevc|h265)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Procura o mesmo canal numa listagem nova.
 *
 * Ordem: `tvg-id` primeiro (é o identificador estável do painel), nome
 * normalizado como reserva.
 *
 * NUNCA devolve a entrada que já estamos usando. Essa é a trava que importa: o
 * chamador reabre o que o resolvedor devolveu, então devolver o mesmo
 * `stream_id` significaria reabrir a mesma URL morta — e a checagem de "o
 * canal morreu" viraria um laço que nunca converge.
 *
 * @returns a entrada nova, ou `null` se o canal sumiu ou não mudou de id
 */
export function matchLiveStream<T extends LiveStreamLike>(
  streams: readonly T[],
  channel: LiveChannelLike,
): T | null {
  const oldId = String(channel.streamId ?? '').trim()
  const wantedTvg = String(channel.tvgId ?? '').trim()
  const wantedName = normalizeChannelName(String(channel.name ?? ''))
  if (!oldId && !wantedTvg && !wantedName) return null

  if (wantedTvg) {
    const byTvg = streams.find((s) => String(s.epg_channel_id ?? '').trim() === wantedTvg)
    if (byTvg && String(byTvg.stream_id) !== oldId) return byTvg
  }

  if (wantedName) {
    for (const s of streams) {
      if (String(s.stream_id) === oldId) continue
      if (normalizeChannelName(String(s.name ?? '')) === wantedName) return s
    }
  }

  return null
}
