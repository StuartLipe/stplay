export type PlaylistKind = 'm3u' | 'xtream'

export type ContentKind = 'live' | 'movie' | 'series'

export type SortMode = 'default' | 'az' | 'za' | 'newest' | 'rating'

export type Playlist = {
  id: string
  name: string
  kind: PlaylistKind
  m3uUrl?: string
  m3uText?: string
  xtream?: {
    host: string
    username: string
    password: string
    profile?: XtreamProfile
  }
}

export type XtreamProfile = {
  username: string
  expDate?: string | null
  domain: string
}

export type Channel = {
  id: string
  name: string
  group: string
  url: string
  logo?: string
  kind: ContentKind
  tvgId?: string
  streamId?: string
  categoryId?: string
  seriesId?: string
  seriesName?: string
  seriesLogo?: string
  extension?: string
  plot?: string
  duration?: string
  releasedate?: string
  rating?: string
  added?: string | number
}

export type ContentDetails = {
  name?: string
  plot?: string
  duration?: string
  releasedate?: string
  addedDate?: string
  rating?: string
  cast?: string
  director?: string
  genre?: string
  cover?: string
}

export type PlaybackEngine = 'auto' | 'internal' | 'libmpv' | 'mpv' | 'mpv-one' | 'stur' | 'mpeg' | 'vlc' | 'mpc'

export type FontSizeSetting = 'small' | 'default' | 'medium' | 'large' | 'xlarge'
export type DensitySetting = 'compact' | 'cozy' | 'comfortable'

export type AppSettings = {
  player: PlaybackEngine
  userAgent: string
  mouseControls: boolean
  theme: 'dark' | 'midnight' | 'custom' | 'amoled' | 'ocean' | 'slate'
  /** Até 5 temas favoritos na barra rápida */
  themeFavorites?: Array<'dark' | 'midnight' | 'custom' | 'amoled' | 'ocean' | 'slate'>
  accent: 'teal' | 'rose' | 'blue' | 'amber' | 'purple' | 'emerald' | 'orange' | 'cyan' | 'custom'
  /** Até 5 cores favoritas na barra (o 6º slot é sempre Custom) */
  accentFavorites?: Array<'teal' | 'rose' | 'blue' | 'amber' | 'purple' | 'emerald' | 'orange' | 'cyan'>
  /** Cor e nome do slot personalizado */
  customAccent?: { name: string; color: string }
  /** Fundo das telas internas (Downloads, Favoritos, Programação, etc.) */
  shellBackground?:
    | 'gradient'
    | 'aurora'
    | 'bloom'
    | 'ribbons'
    | 'horizon'
    | 'mesh'
    | 'accent'
    | 'subtle'
    | 'flat'
  /** Brilho geral da interface (70-130, padrão 100) */
  shellBrightness?: number
  /**
   * Cores escolhidas pelo dono, por cima do tema.
   *
   * Cada campo ausente usa o valor do tema. Quando `bg` ou `text` estão
   * presentes, a rampa inteira é recalculada em runtime a partir delas — ver
   * `src/lib/theme-tokens.ts`. Sem isso a letra mudaria e os quatro degraus
   * abaixo ficariam nos valores do tema, com contraste sem sentido entre eles.
   */
  customColors?: {
    /** Fundo da página. */
    bg?: string
    /** O cinza dos painéis: cartões, pôster, estado vazio, downloads. */
    panel?: string
    /** Cor da letra. Os cinco degraus derivam desta. */
    text?: string
    /** Cor das bordas. */
    border?: string
  }
  fontSize?: FontSizeSetting
  density?: DensitySetting
  performanceMode?: boolean
  epgUpdatedAt?: number
  /** PIN numérico de 4 dígitos para conteúdo adulto */
  parentalPin?: string
  /** Pasta onde os arquivos baixados são salvos */
  downloadFolder?: string
}

export type AppProfile = {
  id: string
  name: string
  color: string
  playlistIds: string[]
  /** Última playlist usada neste perfil (reabre o app nela). */
  lastPlaylistId?: string
  favorites: string[]
  continueWatching: ContinueWatching[]
}

export type ContinueWatching = {
  playlistId: string
  channel: Channel
  seriesId?: string
  seriesName?: string
  seriesLogo?: string
  episodeName?: string
  currentTime: number
  duration: number
  updatedAt: number
}

export type SeriesInfo = {
  seasons: Array<{
    season: number
    episodes: Channel[]
  }>
  info?: {
    name?: string
    cover?: string
    plot?: string
    cast?: string
    director?: string
    genre?: string
    releaseDate?: string
    rating?: string | number
    addedDate?: string
  }
}

export type ShortEpg = {
  title: string
  start?: string
  end?: string
  description?: string
}

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'canceled'

export type DownloadedItem = {
  id: string
  name: string
  kind: 'movie' | 'series'
  url: string
  date: string
  logo?: string
  duration?: string
  playlistId?: string
  status?: DownloadStatus
  filePath?: string
  folder?: string
  received?: number
  total?: number
  speed?: number
  error?: string
  extension?: string
}

export type View =
  | { name: 'profiles' }
  | { name: 'setup' }
  | { name: 'home' }
  | { name: 'downloads' }
  | { name: 'favorites' }
  | { name: 'epg' }
  | { name: 'settings' }
  | { name: 'browse'; kind: ContentKind }
  | { name: 'movie'; movie: Channel; list: Channel[]; startTime?: number; autoPlay?: boolean }
  | { name: 'series'; series: Channel; episode?: Channel; list?: Channel[]; startTime?: number; autoPlay?: boolean }
  | {
      name: 'player'
      channel: Channel
      list: Channel[]
      startTime?: number
      fromSeries?: Channel
      fromLive?: 'home' | 'browse'
      autoFullscreen?: boolean
    }
