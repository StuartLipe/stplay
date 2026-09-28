import type { AppProfile, AppSettings, Channel, ContentKind, ContinueWatching, DensitySetting, FontSizeSetting, Playlist, SortMode } from '../types'
import {
  DEFAULT_ACCENT_FAVORITES,
  DEFAULT_CUSTOM_ACCENT,
  isAccentId,
  normalizeAccentFavorites,
  normalizeHexColor,
} from './accent'
import { DEFAULT_THEME_FAVORITES, isShellBackgroundId, normalizeThemeFavorites } from './appearance'

const KEY = 'sturplay.playlists'
const FAV_KEY = 'sturplay.favorites'
const ACTIVE_KEY = 'sturplay.active'
const CONTINUE_KEY = 'sturplay.continue-watching'
const SETTINGS_KEY = 'sturplay.settings'
const PROFILES_KEY = 'sturplay.profiles'
const ACTIVE_PROFILE_KEY = 'sturplay.active-profile'

/*
 * O app abre assim.
 *
 * Estes quatro campos sao a Aparencia que o dono escolheu e deixou salva, e
 * foram promovidos a padrao a pedido dele: era para o app ja nascer no tema
 * que ele usa, em vez de todo mundo abrir no "Dark" e ter que trocar quatro
 * telas de settings.
 *
 *   theme             amoled   — preto puro, e o que o dono tem
 *   shellBackground   horizon  — o "Cenario" que ele escolheu
 *   shellBrightness   105      — o valor empurrado, nao o 100 de fabrica
 *   accent            custom   — o destaque branco, nao o teal de fabrica
 *
 * `customAccent` NAO e repetido aqui: vem de `DEFAULT_CUSTOM_ACCENT`, no
 * `accent.ts`, que e o unico lugar onde essa cor mora. `accentFavorites`
 * continua a lista de atalhos e nao muda — e so a paleta de um clique.
 *
 * `customColors` segue de fora, sem valor. Com o fundo em `#000000` o cinza
 * dos paineis ja sai derivado do tema, e o card de "Cores do app" mostra
 * "Do tema" — que e o estado em que o app esta.
 *
 * Isto so vale para quem ainda nao tem nada salvo. Quem ja tem preferencias
 * gravadas continua com elas: `normalizeSettings` le o que existe no
 * armazenamento e so cai neste objeto quando o registro nao existe.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  player: 'auto',
  userAgent: 'VLC/3.0.4 LibVLC/3.0.4',
  mouseControls: true,
  theme: 'amoled',
  themeFavorites: [...DEFAULT_THEME_FAVORITES],
  accent: 'custom',
  accentFavorites: [...DEFAULT_ACCENT_FAVORITES],
  customAccent: { ...DEFAULT_CUSTOM_ACCENT },
  shellBackground: 'horizon',
  shellBrightness: 105,
  fontSize: 'default',
  density: 'comfortable',
  performanceMode: false,
}

const PLAYER_MIGRATE_KEY = 'sturplay.player-engine-v8'
const PLAYER_MIGRATE_V9_KEY = 'sturplay.player-engine-v9'
const PLAYER_MIGRATE_V10_KEY = 'sturplay.player-engine-v10'
const PLAYER_MIGRATE_V11_KEY = 'sturplay.player-engine-v11'
const PLAYER_MIGRATE_V12_KEY = 'sturplay.player-engine-v12'
const PLAYER_MIGRATE_V13_KEY = 'sturplay.player-engine-v13'

function normalizeSettings(raw: Partial<AppSettings> & { player?: string }): AppSettings {
  const rawPlayer = String(raw.player || '')
  const valid = new Set(['auto', 'internal', 'libmpv', 'mpv', 'mpv-one', 'stur', 'vlc', 'mpc'])
  let player: AppSettings['player'] = valid.has(rawPlayer) ? (rawPlayer as AppSettings['player']) : DEFAULT_SETTINGS.player

  // v8: Shaka e MPV saíram — quem estava neles vai para o player interno
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_KEY, '1')
      if (rawPlayer === 'shaka' || rawPlayer === 'mpv' || rawPlayer === 'mdk' || rawPlayer === 'playerone') {
        player = 'internal'
      }
    }
  } catch {
    // ignore
  }

  // v9: default Automático para quem ainda usa internal
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_V9_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_V9_KEY, '1')
      if (!rawPlayer || rawPlayer === 'internal') player = 'auto'
    }
  } catch {
    // ignore
  }

  // v10: reset — apenas player interno (mpv/libmpv refeitos depois)
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_V10_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_V10_KEY, '1')
      player = 'internal'
    }
  } catch {
    // ignore
  }

  // v11: interno + mpv embutido (sem auto/libmpv)
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_V11_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_V11_KEY, '1')
      if (player !== 'mpv') player = 'internal'
    }
  } catch {
    // ignore
  }

  // v12: filmes no mpv por padrão (modelo IPTV Player One); ao vivo continua interno
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_V12_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_V12_KEY, '1')
      player = 'mpv'
    }
  } catch {
    // ignore
  }

  // v13: só Interno + STUR + Auto; motores legados viram STUR
  try {
    if (!localStorage.getItem(PLAYER_MIGRATE_V13_KEY)) {
      localStorage.setItem(PLAYER_MIGRATE_V13_KEY, '1')
      if (
        player === 'mpv' ||
        player === 'mpv-one' ||
        player === 'libmpv' ||
        player === 'vlc' ||
        player === 'mpc'
      ) {
        player = 'stur'
      }
    }
  } catch {
    // ignore
  }

  if (player !== 'auto' && player !== 'internal' && player !== 'stur') player = 'auto'

  const themes = new Set(['dark', 'midnight', 'custom', 'amoled', 'ocean', 'slate'])
  const theme = themes.has(String(raw.theme)) ? (raw.theme as AppSettings['theme']) : DEFAULT_SETTINGS.theme
  const themeFavorites = normalizeThemeFavorites(raw.themeFavorites)
  const accent = isAccentId(String(raw.accent || '')) ? (raw.accent as AppSettings['accent']) : DEFAULT_SETTINGS.accent
  const accentFavorites = normalizeAccentFavorites(raw.accentFavorites)
  const customAccent = {
    name: String(raw.customAccent?.name || DEFAULT_CUSTOM_ACCENT.name).trim().slice(0, 18) || DEFAULT_CUSTOM_ACCENT.name,
    color: normalizeHexColor(raw.customAccent?.color || DEFAULT_CUSTOM_ACCENT.color),
  }
  const shellBackground = isShellBackgroundId(String(raw.shellBackground || ''))
    ? (String(raw.shellBackground) as AppSettings['shellBackground'])
    : DEFAULT_SETTINGS.shellBackground!
  const shellBrightnessRaw = Number(raw.shellBrightness)
  const shellBrightness = Number.isFinite(shellBrightnessRaw)
    ? Math.min(130, Math.max(70, Math.round(shellBrightnessRaw)))
    : DEFAULT_SETTINGS.shellBrightness!
  const fontSizes = new Set(['small', 'default', 'medium', 'large', 'xlarge'])
  const densities = new Set(['compact', 'cozy', 'comfortable'])
  const fontSize = fontSizes.has(String(raw.fontSize))
    ? (raw.fontSize as FontSizeSetting)
    : DEFAULT_SETTINGS.fontSize!
  const density = densities.has(String(raw.density))
    ? (raw.density as DensitySetting)
    : DEFAULT_SETTINGS.density!
  const performanceMode = typeof raw.performanceMode === 'boolean'
    ? raw.performanceMode
    : DEFAULT_SETTINGS.performanceMode!

  // As cores escolhidas pelo dono. `...raw` ja as traz, mas sem validar: um
  // localStorage editado a mao, ou uma versao futura que grave o campo com
  // outro formato, passaria lixo ate o `applyCustomColorsToDocument`. A
  // normalizacao e aqui porque e a unica porta de entrada de dado externo.
  const rawCustomColors = raw.customColors
  const customColors =
    rawCustomColors && typeof rawCustomColors === 'object'
      ? {
          ...(typeof rawCustomColors.bg === 'string'
            ? { bg: normalizeHexColor(rawCustomColors.bg) }
            : {}),
          ...(typeof rawCustomColors.panel === 'string'
              ? { panel: normalizeHexColor(rawCustomColors.panel) }
              : {}),
            ...(typeof rawCustomColors.text === 'string'
            ? { text: normalizeHexColor(rawCustomColors.text) }
            : {}),
          ...(typeof rawCustomColors.border === 'string'
            ? { border: normalizeHexColor(rawCustomColors.border) }
            : {}),
        }
      : undefined
  const customColorsVazio =
    customColors && Object.keys(customColors).length === 0 ? undefined : customColors

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    player,
    theme,
    themeFavorites,
    accent,
    accentFavorites,
    customAccent,
    shellBackground,
    shellBrightness,
    fontSize,
    density,
    performanceMode,
    customColors: customColorsVazio,
  }
}

// localStorage.setItem lança QuotaExceededError de forma síncrona quando estoura
// o limite (~5 MB). Sem este try/catch a exceção sobe de dentro de um useEffect
// no commit do React, não existe error boundary, e a árvore inteira desmonta —
// o app abre em branco sem forma de recuperar.
// Sem Space em disco cheio não dá para truncar: o que dá é não derrubar a UI.
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

// O `as T[]` do JSON.parse mente quando o valor gravado não é lista (escrita
// parcial, build antigo, edição manual). Sem isto, `loadPlaylists().map(...)`
// estoura no inicializador de useState e o app não passa do primeiro render.
function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function loadPlaylists(): Playlist[] {
  return readArray<Playlist>(KEY)
}

export function savePlaylists(playlists: Playlist[]) {
  write(KEY, JSON.stringify(playlists))
}

export function loadFavorites(): string[] {
  return readArray<string>(FAV_KEY)
}

export function saveFavorites(ids: string[]) {
  write(FAV_KEY, JSON.stringify(ids))
}

export const loadActiveId = (): string | null => readRaw(ACTIVE_KEY)

export function saveActiveId(id: string) {
  write(ACTIVE_KEY, id)
}

export function loadContinueWatching(): ContinueWatching[] {
  return readArray<ContinueWatching>(CONTINUE_KEY)
}

export function saveContinueWatching(items: ContinueWatching[]) {
  // `continueWatching` guarda o Channel inteiro (inclui `plot`) de cada item e
  // não tem teto. Corta o `plot` — é o campo pesado — e limita a lista.
  //
  // `updateProgress` empurra o item mais novo para o FIM do array, então o teto
  // tem que cortar pelo fim (`slice(-N)`), não pelo começo. Com `slice(0, 20)`
  // o fallback guardava justamente os 20 registros mais antigos e jogava fora
  // os que o usuário acabou de assistir.
  const newestFirst = (a: ContinueWatching, b: ContinueWatching) => (b.updatedAt || 0) - (a.updatedAt || 0)
  const recent = [...items].sort(newestFirst)
  const slim = recent.slice(0, 60).map((item) => ({ ...item, channel: { ...item.channel, plot: undefined } }))
  if (write(CONTINUE_KEY, JSON.stringify(slim))) return
  // Não coube. O DEGRADE PRECISA PRESERVAR `channel.kind` e `channel.url`:
  // todo leitor filtra por `item.channel.kind` (App.tsx: `continueWatching.filter
  // (item) => item.channel.kind === kind)`) e o clique precisa de `url` para
  // tocar. Emitir um objeto sem esses campos fazia a lista inteira sumir sem
  // erro nenhum — o pior tipo de bug.
  write(
    CONTINUE_KEY,
    JSON.stringify(
      recent.slice(0, 20).map((item) => ({
        playlistId: item.playlistId,
        seriesId: item.seriesId,
        seriesName: item.seriesName,
        seriesLogo: item.seriesLogo,
        episodeName: item.episodeName,
        currentTime: item.currentTime,
        duration: item.duration,
        updatedAt: item.updatedAt,
        channel: {
          id: item.channel.id,
          name: item.channel.name,
          kind: item.channel.kind,
          url: item.channel.url,
          streamId: item.channel.streamId,
          seriesId: item.channel.seriesId,
          logo: item.channel.logo,
          group: item.channel.group,
        },
      })),
    ),
  )
}

export function loadSettings(): AppSettings {
  try {
    const raw = readRaw(SETTINGS_KEY)
    return raw ? normalizeSettings(JSON.parse(raw) as Partial<AppSettings> & { player?: string }) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: AppSettings) {
  write(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadProfiles(): AppProfile[] {
  return readArray<AppProfile>(PROFILES_KEY)
}

export function saveProfiles(profiles: AppProfile[]) {
  if (write(PROFILES_KEY, JSON.stringify(profiles))) return
  // `saveProfiles` duplica favoritos + continueWatching de cada perfil, então é o
  // maior consumidor. Se estourou, tenta sem o histórico de cada perfil.
  write(PROFILES_KEY, JSON.stringify(profiles.map((p) => ({ ...p, continueWatching: [], favorites: [] }))))
}

export function loadActiveProfileId() {
  return readRaw(ACTIVE_PROFILE_KEY)
}

export function saveActiveProfileId(id: string) {
  write(ACTIVE_PROFILE_KEY, id)
}

const RECENT_LIVE_KEY = 'sturplay.recent-live'

export function loadRecentLiveChannels(): Channel[] {
  return readArray<Channel>(RECENT_LIVE_KEY).slice(0, 3)
}

export function saveRecentLiveChannels(channels: Channel[]) {
  write(RECENT_LIVE_KEY, JSON.stringify(channels.slice(0, 3)))
}

const SORT_KEY = 'sturplay.sort-modes'

const DEFAULT_SORT_MODES: Record<ContentKind, SortMode> = {
  live: 'default',
  movie: 'default',
  series: 'default',
}

function isSortMode(value: unknown): value is SortMode {
  return value === 'default' || value === 'az' || value === 'za' || value === 'newest' || value === 'rating'
}

export function loadSortModes(): Record<ContentKind, SortMode> {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (!raw) return { ...DEFAULT_SORT_MODES }
    const parsed = JSON.parse(raw) as Partial<Record<ContentKind, unknown>>
    return {
      live: isSortMode(parsed.live) ? parsed.live : 'default',
      movie: isSortMode(parsed.movie) ? parsed.movie : 'default',
      series: isSortMode(parsed.series) ? parsed.series : 'default',
    }
  } catch {
    return { ...DEFAULT_SORT_MODES }
  }
}

export function saveSortModes(modes: Record<ContentKind, SortMode>) {
  write(SORT_KEY, JSON.stringify(modes))
}

const HIDDEN_KEY = 'sturplay.hidden-items'

export type HiddenItems = {
  channels: string[]
  groups: string[]
  /**
   * id -> nome, para a tela de restauracao mostrar o que foi ocultado.
   *
   * Sem isto, a lista de "Itens ocultos" exibia `vod-5000` em vez do titulo do
   * filme, e restaurar era no escuro. Guarda o nome no momento em que o item e
   * ocultado, porque depois o id sozinho nao diz nada — e o catalogo pode nem
   * estar carregado quando o usuario abre a tela.
   */
  names?: Record<string, string>
}

/**
 * Ocultacoes por playlist + tipo.
 *
 * "Ocultar filme" e "Ocultar categoria" viviam em `useState([])` local da grade
 * do browse. A grade desmonta a cada troca de view — abrir a ficha de um filme
 * ja era motivo suficiente — e sem persistencia o itemVoltava assim que a
 * grade remontava. O usuario ocultava, saia da pagina de filme, voltava, e o
 * item estava la de novo, sem nenhuma explicacao.
 *
 * A chave inclui playlist e tipo porque as grades sao separadas: ocultar a
 * categoria REELSHORT em Filmes nao pode esconder a categoria de mesmo nome em
 * Series, e trocar de conta nao pode herdar a lista de ocultacao da anterior.
 */
function hiddenScope(playlistId: string | undefined, kind: ContentKind) {
  return `${playlistId || 'sem-playlist'}|${kind}`
}

export function loadHiddenItems(playlistId: string | undefined, kind: ContentKind): HiddenItems {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return { channels: [], groups: [], names: {} }
    const all = JSON.parse(raw) as Record<string, Partial<HiddenItems>>
    const entry = all[hiddenScope(playlistId, kind)]
    if (!entry) return { channels: [], groups: [], names: {} }
    const names: Record<string, string> = {}
    if (entry.names && typeof entry.names === 'object') {
      for (const [key, value] of Object.entries(entry.names)) {
        if (typeof value === 'string') names[key] = value
      }
    }
    return {
      channels: Array.isArray(entry.channels) ? entry.channels.filter((v) => typeof v === 'string') : [],
      groups: Array.isArray(entry.groups) ? entry.groups.filter((v) => typeof v === 'string') : [],
      names,
    }
  } catch {
    return { channels: [], groups: [], names: {} }
  }
}

export function saveHiddenItems(playlistId: string | undefined, kind: ContentKind, value: HiddenItems) {
  let all: Record<string, HiddenItems> = {}
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed as Record<string, HiddenItems>
    }
  } catch {
    all = {}
  }
  if (value.channels.length === 0 && value.groups.length === 0) {
    delete all[hiddenScope(playlistId, kind)]
  } else {
    all[hiddenScope(playlistId, kind)] = {
      channels: value.channels,
      groups: value.groups,
      names: value.names ?? {},
    }
  }
  write(HIDDEN_KEY, JSON.stringify(all))
}

/** Todos os escopos gravados, para a tela de restauracao em Configuracoes. */
export function loadAllHiddenItems(): Record<string, HiddenItems> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, HiddenItems>
  } catch {
    return {}
  }
}

/** Apaga tudo que estiver oculto, em qualquer playlist e tipo. */
export function clearAllHiddenItems() {
  localStorage.removeItem(HIDDEN_KEY)
}

