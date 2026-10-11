import type { Channel } from '../types'

function normalizeHaystack(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
}

export function isUhd4kChannel(channel: Channel): boolean {
  const hay = normalizeHaystack(`${channel.group || ''} ${channel.name || ''}`)
  return (
    /\bUHD\b/.test(hay) ||
    /\b4K\b/.test(hay) ||
    hay.includes('ULTRA HD') ||
    hay.includes('ULTRAHD') ||
    hay.includes('HDR10')
  )
}

/** Esportes / PPV costumam ter stream mais pesado ou painel mais lento */
export function isHeavyLiveChannel(channel: Channel): boolean {
  if (isUhd4kChannel(channel)) return true
  const hay = normalizeHaystack(`${channel.group || ''} ${channel.name || ''}`)
  // ESPN / FHD / HD travavam no buffer pequeno (6s) — trata como pesado
  if (/\bESPN\b/.test(hay)) return true
  if (/\bFHD\b/.test(hay) || hay.includes('FULL HD') || hay.includes('FULLHD')) return true
  if (/\bHD\b/.test(hay) || /\bFHD\b/.test(hay)) return true
  return (
    hay.includes('ESPORTE') ||
    hay.includes('SPORT') ||
    hay.includes('PPV') ||
    hay.includes('JOGOS') ||
    hay.includes('AREA DE JOGOS') ||
    hay.includes('CHAMPIONS') ||
    hay.includes('PREMIERE') ||
    hay.includes('FOOTBALL') ||
    hay.includes('FUTEBOL')
  )
}

/** Mesma regra para quando só temos a URL (interno via manager não recebe channel) */
export function isHeavyLiveUrl(url: string): boolean {
  const hay = normalizeHaystack(url)
  if (hay.includes('ESPN')) return true
  if (hay.includes('FHD') || hay.includes('FULLHD') || hay.includes('FULL-HD')) return true
  return false
}
