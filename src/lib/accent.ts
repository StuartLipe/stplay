import {
  deriveCustomTokens,
  surfaceRampFor,
  textDefaultFor,
  textRampFor,
  toneLiftFor,
} from './theme-tokens'

export type AccentPresetId = 'teal' | 'rose' | 'blue' | 'amber' | 'purple' | 'emerald' | 'orange' | 'cyan'
export type AccentId = AccentPresetId | 'custom'

export type AccentSwatch = {
  id: AccentPresetId
  label: string
  color: string
}

export const ACCENT_PRESETS: AccentSwatch[] = [
  { id: 'teal', label: 'Teal', color: '#2dd4bf' },
  { id: 'rose', label: 'Rosa', color: '#fb7185' },
  { id: 'blue', label: 'Azul', color: '#60a5fa' },
  { id: 'amber', label: 'Âmbar', color: '#fbbf24' },
  { id: 'purple', label: 'Roxo', color: '#a78bfa' },
  { id: 'emerald', label: 'Verde', color: '#34d399' },
  { id: 'orange', label: 'Laranja', color: '#fb923c' },
  { id: 'cyan', label: 'Ciano', color: '#22d3ee' },
]

export const DEFAULT_ACCENT_FAVORITES: AccentPresetId[] = ['teal', 'rose', 'blue', 'amber', 'purple']

/*
 * A cor do destaque "Custom" por padrao.
 *
 * Era `#34d399`, o mesmo verde do preset `teal` — o que fazia o "Custom" com
 * nomeclatura propia chegar pintado de verde, igual ao preset. Agora e branco,
 * que e a cor que o dono escolheu e deixou salva.
 *
 * Este e o unico lugar donde o valor mora. `normalizeHexColor` usa
 * `DEFAULT_CUSTOM_ACCENT.color` como `fallback`, e `resolveAccent` usa para
 * abrir o Custom sem cor salva. Se o padrao fosse escrito tambem no
 * `DEFAULT_SETTINGS` do `storage.ts`, os dois divergiriam na primeira edicao e
 * o app comecaria a pintar o destaque de uma cor e a rotular de outra.
 */
export const DEFAULT_CUSTOM_ACCENT = { name: 'Custom', color: '#ffffff' }

const PRESET_MAP = new Map(ACCENT_PRESETS.map((item) => [item.id, item]))

export function isAccentPresetId(value: string): value is AccentPresetId {
  return PRESET_MAP.has(value as AccentPresetId)
}

export function isAccentId(value: string): value is AccentId {
  return value === 'custom' || isAccentPresetId(value)
}

export function getAccentPreset(id: AccentPresetId) {
  return PRESET_MAP.get(id)!
}

export function normalizeHexColor(value: string, fallback = DEFAULT_CUSTOM_ACCENT.color) {
  const raw = String(value || '').trim()
  const short = raw.match(/^#([0-9a-fA-F]{3})$/)
  if (short) {
    const [a, b, c] = short[1]
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase()
  }
  const full = raw.match(/^#([0-9a-fA-F]{6})$/)
  if (full) return `#${full[1]}`.toLowerCase()
  return fallback.toLowerCase()
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex)
  const value = Number.parseInt(normalized.slice(1), 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

export function accentInkFor(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#061018' : '#f8fafc'
}

export function accentGlowFor(hex: string, alpha = 0.14) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function normalizeAccentFavorites(raw: unknown): AccentPresetId[] {
  const list = Array.isArray(raw)
    ? raw.filter((item): item is AccentPresetId => typeof item === 'string' && isAccentPresetId(item))
    : []
  const unique: AccentPresetId[] = []
  for (const id of list) {
    if (!unique.includes(id)) unique.push(id)
    if (unique.length >= 5) break
  }
  for (const id of DEFAULT_ACCENT_FAVORITES) {
    if (unique.length >= 5) break
    if (!unique.includes(id)) unique.push(id)
  }
  return unique.slice(0, 5)
}

export function replaceAccentFavorite(
  favorites: AccentPresetId[],
  slotIndex: number,
  id: AccentPresetId,
): AccentPresetId[] {
  const current = normalizeAccentFavorites(favorites)
  const index = Math.max(0, Math.min(4, slotIndex))
  if (current[index] === id) return current
  const without = current.filter((item) => item !== id)
  while (without.length < 5) {
    const filler = DEFAULT_ACCENT_FAVORITES.find((item) => !without.includes(item) && item !== id)
    if (!filler) break
    without.push(filler)
  }
  const next = without.slice(0, 5)
  next[index] = id
  return normalizeAccentFavorites(next)
}

export function resolveAccentColor(
  accent: AccentId,
  customColor?: string,
): { label: string; color: string } {
  if (accent === 'custom') {
    return {
      label: 'Custom',
      color: normalizeHexColor(customColor || DEFAULT_CUSTOM_ACCENT.color),
    }
  }
  const preset = getAccentPreset(accent)
  return { label: preset.label, color: preset.color }
}

export function applyAccentToDocument(
  accent: AccentId,
  custom?: { name?: string; color?: string },
) {
  const root = document.documentElement
  root.dataset.accent = accent
  if (accent === 'custom') {
    const color = normalizeHexColor(custom?.color || DEFAULT_CUSTOM_ACCENT.color)
    root.style.setProperty('--accent', color)
    root.style.setProperty('--accent-ink', accentInkFor(color))
    root.style.setProperty('--glow-a', accentGlowFor(color))
  } else {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-ink')
    root.style.removeProperty('--glow-a')
  }
}

/**
 * Aplica as cores escolhidas pelo dono por cima do tema.
 *
 * Cada campo ausente é removido do documento, e o tema volta a valer. É o
 * mesmo contrato de `applyAccentToDocument`: o que não foi customized não pode
 * ficar com o valor antigo grudado por estilo inline.
 *
 * A rampa de texto é inteira, não só o topo. `--text-primary` sozinho deixaria
 * os quatro degraus abaixo nos valores do tema, e o contraste entre eles
 * passaria a não significar nada.
 */
export function applyCustomColorsToDocument(
  custom: { bg?: string; panel?: string; text?: string; border?: string } | undefined,
  defaults: { bg: string; text: string },
) {
  const root = document.documentElement
  const antes = VARS_TEMA
  const depois: string[] = []

  const por = custom?.bg ? normalizeHexColor(custom.bg, defaults.bg) : ''
  const painel = custom?.panel ? normalizeHexColor(custom.panel, '') : ''

  if (por) {
    // A letra escolhida manda. Sem ela, a letra e derivada do FUNDO escolhido e
    // nao vem do tema: a letra do tema e a resposta certa para o fundo do tema e
    // a errada para qualquer outro. Herda-la fazia um fundo claro cair em
    // 1.08:1 — a pagina inteira virava um retangulo ilegivel.
    const letra = custom?.text
      ? normalizeHexColor(custom.text, defaults.text)
      : textDefaultFor(por)
    const tokens = deriveCustomTokens(por, letra, painel || undefined)
    // `--tone-lift` e a luz das superficies derivadas no CSS. Com fundo claro
    // ele precisa virar preto, ou `--card-surface` fica branco sobre branco. A
    // regra e a mesma de `surfaceRampFor`; se as duas divergirem, a superficie
    // fica meio caminho entre o que o JS calculou e o que o CSS pintou.
    root.style.setProperty('--tone-lift', toneLiftFor(por))
    depois.push('--tone-lift')
    for (const [chave, valor] of Object.entries(tokens)) {
      root.style.setProperty(`--${kebab(chave)}`, valor)
      depois.push(`--${kebab(chave)}`)
    }
    // A borda escolhida manda sobre a derivada: quem escolheu a borda escolheu a
    // borda, e o piso de contraste de um contorno nao e o de um texto.
    if (custom?.border) {
      root.style.setProperty('--border-subtle', normalizeHexColor(custom.border, tokens.borderSubtle))
    }
  } else {
    // Sem fundo escolhido o fundo continua sendo o do tema, e CADA campo escolhido
    // age sozinho sobre ele. Antes eles ficavam presos dentro do ramo do fundo:
    // escolher so a borda, ou so o painel, nao fazia nada. E o caso mais comum do
    // painel era exatamente esse — o tema esta bom, so os cartoes estao cinza demais.
    if (custom?.text) {
      const tokens = textRampFor(normalizeHexColor(custom.text, defaults.text), defaults.bg)
      for (const [chave, valor] of Object.entries(tokens)) {
        root.style.setProperty(`--${kebab(chave)}`, valor)
        depois.push(`--${kebab(chave)}`)
      }
    }
    if (painel) {
      // So o painel muda. `--surface-raised` e `--surface-raised-hover` sao
      // derivados do `--card-surface` no CSS, entao acompanham sozinhos.
      root.style.setProperty('--card-surface', painel)
      depois.push('--card-surface')
    }
    if (custom?.border) {
      // Uma borda e uma linha, e o piso de contraste dela nao e o do texto nem o
      // do painel. Ela vale com ou sem fundo escolhido.
      const derivado = surfaceRampFor(defaults.bg).borderSubtle
      root.style.setProperty('--border-subtle', normalizeHexColor(custom.border, derivado))
      depois.push('--border-subtle')
    }
  }

  // A limpeza e sempre, e nao so no ramo "nada escolhido". Qualquer campo que
  // deixou de valer precisa sair do documento: um valor antigo preso por estilo
  // inline sobrevive a trocar de tema e a "voltar ao tema".
  for (const v of antes) {
    if (!depois.includes(v)) root.style.removeProperty(v)
  }

  VARS_TEMA = [...new Set([...depois])]
}

/** `textPrimary` -> `text-primary`. */
function kebab(chave: string): string {
  return chave.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

let VARS_TEMA: string[] = []
