export type ThemeId = 'dark' | 'midnight' | 'custom' | 'amoled' | 'ocean' | 'slate'

export type ThemeOption = {
  id: ThemeId
  label: string
  hint: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'dark', label: 'Dark', hint: 'Clássico e limpo' },
  { id: 'midnight', label: 'Midnight', hint: 'Mais fundo, menos brilho' },
  { id: 'custom', label: 'Quente', hint: 'Tom acolhedor' },
  { id: 'amoled', label: 'AMOLED', hint: 'Preto puro (OLED)' },
  { id: 'ocean', label: 'Ocean', hint: 'Azul profundo' },
  { id: 'slate', label: 'Slate', hint: 'Cinza neutro' },
]

export const DEFAULT_THEME_FAVORITES: ThemeId[] = ['dark', 'midnight', 'amoled', 'ocean', 'slate']

/**
 * O fundo e a letra de cada tema, em JS.
 *
 * Precisam existir aqui e no `index.css` porque são usados em dois lugares com
 * exigências opostas: o CSS precisa do valor literal para o navegador não
 * recalcular nada no carregamento, e a UI precisa dele em runtime para derivar
 * a rampa quando o dono escolhe a própria letra. Um valor faria o trabalho dos
 * dois; dois valores divergem sem avisar.
 *
 * O teste `bate com a rampa que esta no CSS` em `theme-tokens.test.ts` fecha a
 * divergência: a conta de runtime tem que reproduzir os literais do stylesheet.
 */
export const THEME_COLORS: Record<ThemeId, { bg: string; text: string }> = {
  dark: { bg: '#07090f', text: '#eef3ff' },
  midnight: { bg: '#020617', text: '#eef3ff' },
  custom: { bg: '#101b24', text: '#eef3ff' },
  amoled: { bg: '#000000', text: '#eef3ff' },
  ocean: { bg: '#041018', text: '#eef3ff' },
  slate: { bg: '#111318', text: '#eef3ff' },
}

const THEME_IDS = new Set(THEME_OPTIONS.map((item) => item.id))

export function isThemeId(value: string): value is ThemeId {
  return THEME_IDS.has(value as ThemeId)
}

export function getThemeOption(id: ThemeId) {
  return THEME_OPTIONS.find((item) => item.id === id)!
}

export function normalizeThemeFavorites(raw: unknown): ThemeId[] {
  const list = Array.isArray(raw)
    ? raw.filter((item): item is ThemeId => typeof item === 'string' && isThemeId(item))
    : []
  const unique: ThemeId[] = []
  for (const id of list) {
    if (!unique.includes(id)) unique.push(id)
    if (unique.length >= 5) break
  }
  for (const id of DEFAULT_THEME_FAVORITES) {
    if (unique.length >= 5) break
    if (!unique.includes(id)) unique.push(id)
  }
  return unique.slice(0, 5)
}

export function replaceThemeFavorite(
  favorites: ThemeId[],
  slotIndex: number,
  id: ThemeId,
): ThemeId[] {
  const current = normalizeThemeFavorites(favorites)
  const index = Math.max(0, Math.min(4, slotIndex))
  if (current[index] === id) return current
  const without = current.filter((item) => item !== id)
  while (without.length < 5) {
    const filler = DEFAULT_THEME_FAVORITES.find((item) => !without.includes(item) && item !== id)
    if (!filler) break
    without.push(filler)
  }
  const next = without.slice(0, 5)
  next[index] = id
  return normalizeThemeFavorites(next)
}

export type ShellBackgroundId =
  | 'gradient'
  | 'aurora'
  | 'bloom'
  | 'ribbons'
  | 'horizon'
  | 'mesh'
  | 'accent'
  | 'subtle'
  | 'flat'

export type ShellBackgroundOption = {
  id: ShellBackgroundId
  label: string
  hint: string
}

export const SHELL_BACKGROUND_OPTIONS: ShellBackgroundOption[] = [
  { id: 'gradient', label: 'Cantos', hint: 'Brilho suave nos cantos' },
  { id: 'aurora', label: 'Aurora', hint: 'Faixas em diagonal' },
  { id: 'bloom', label: 'Bloom', hint: 'Halo no centro' },
  { id: 'ribbons', label: 'Faixas', hint: 'Laterais em luz' },
  { id: 'horizon', label: 'Horizonte', hint: 'Glow embaixo' },
  { id: 'mesh', label: 'Mesh', hint: 'Várias manchas' },
  { id: 'accent', label: 'Destaque', hint: 'Tom da cor ativa' },
  { id: 'subtle', label: 'Suave', hint: 'Quase plano' },
  { id: 'flat', label: 'Sólido', hint: 'Sem gradiente' },
]

export function isShellBackgroundId(value: string): value is ShellBackgroundId {
  return SHELL_BACKGROUND_OPTIONS.some((item) => item.id === value)
}
