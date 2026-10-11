import type { Channel } from '../types'

const SCHEDULED_EVENT_RE = /^\[\d{1,2}:\d{2}H?\]/i
const GAMES_HUB_RE = /JOGOS?\s+DE\s+HOJE/i

function normGroup(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Categoria "ÁREA DE JOGOS" do painel Xtream (não Premiere/Sportv genéricos). */
export function isGamesAreaGroup(groupName: string): boolean {
  const g = normGroup(groupName)
  return /AREA DE JOGOS/.test(g) || g === 'JOGOS'
}

export function isScheduledLiveEventName(name: string): boolean {
  return SCHEDULED_EVENT_RE.test((name || '').trim())
}

export function isGamesHubChannel(channel: Channel): boolean {
  return GAMES_HUB_RE.test(channel.name || '')
}

/**
 * Player One mostra só o tile "JOGOS DE HOJE" na categoria — não lista os 12 streams
 * agendados ([16:00H] Time x Time) direto na grade.
 */
export function filterGamesAreaLiveChannels(channels: Channel[], groupName: string): Channel[] {
  if (!isGamesAreaGroup(groupName)) return channels

  const hubs = channels.filter(isGamesHubChannel)
  if (hubs.length > 0) return hubs

  const withoutSchedule = channels.filter((c) => !isScheduledLiveEventName(c.name))
  return withoutSchedule
}
