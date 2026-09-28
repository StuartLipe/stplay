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

export function groupEpisodesBySeason(items: EpisodeListItem[]): Array<[string, EpisodeListItem[]]> {
  const seasons = new Map<string, EpisodeListItem[]>()
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
