export type EpisodeListItem = { id: string; name: string; group?: string }

function seasonNumber(label: string): number {
  const match = label.match(/(\d+)/)
  return match ? Number(match[1]) : 0
}

export function resolveEpisodeSeason(item: EpisodeListItem): string {
  const group = item.group?.trim()
  if (group && group !== 'Outros') return group
  const fromName = item.name.match(/S(\d+)E/i)
  if (fromName) return `Temporada ${Number(fromName[1])}`
  return 'Outros'
}

/**
 * Agrupa por temporada PRESERVANDO o tipo de quem entra.
 *
 * Antes devolvia `Array<[string, EpisodeListItem[]]>` e, num caller que passava
 * itens mais ricos (`OverlayItem`, que tem `logo`), o `logo` sumia no tipo: o
 * agrupamento so precisa de `id`, `name` e `group`, mas a assinatura nao dizia
 * isso e cobrava de quem chamasse. O resultado era um erro de compilacao em
 * quem so queria mostrar a capa do proximo episodio.
 */
export function groupEpisodesBySeason<T extends EpisodeListItem>(items: T[]): Array<[string, T[]]> {
  const seasons = new Map<string, T[]>()
  for (const item of items) {
    const key = resolveEpisodeSeason(item)
    const bucket = seasons.get(key)
    if (bucket) bucket.push(item)
    else seasons.set(key, [item])
  }
  return [...seasons.entries()].sort((a, b) => seasonNumber(a[0]) - seasonNumber(b[0]))
}

export function formatSeasonOptionLabel(season: string, count: number): string {
  return `${season} (${count} episódio${count === 1 ? '' : 's'})`
}

export function findSeasonForEpisode(items: EpisodeListItem[], episodeId: string): string | null {
  const hit = items.find((item) => item.id === episodeId)
  return hit ? resolveEpisodeSeason(hit) : null
}
