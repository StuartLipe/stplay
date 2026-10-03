import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { playerLog } from './lib/players/playerLogger'
import { RestaurarOcultosSheet } from './RestaurarOcultosSheet'
import {
  categoriasVisiveis,
  deveMostrarRestaurar,
  linhasDoBotaoOcultar,
  podeOcultarCategoria,
  selecaoDeveVoltarParaTodos,
} from './lib/ocultos'
import {
  instalarDiagnosticoPlayerActive,
  registrarTrocaDeView,
} from './lib/players/diagnostico-player-active'
import {
  ESPERO_ENTRE_TENTATIVAS_MS,
  TENTATIVAS_AUTOMATICAS_MAX,
  type TentativaAutomaticaState,
  deveRepetirSozinho,
  estadoTentativaAutomatica,
  gastarTentativa,
} from './lib/players/tentativa-automatica'
import type { AppProfile, AppSettings, Channel, ContentDetails, ContentKind, ContinueWatching, DownloadedItem, PlaybackEngine, Playlist, ShortEpg, SortMode, View } from './types'
import type { UpdaterStatus } from './global'
import { cachedCount, clearCatalog, hydrateCatalogFromDisk, loadCatalog, loadCategories, loadCategoryContent, persistCatalogToDisk, seedMemoryCatalog, type XtreamCategory } from './lib/catalog'
import { clearDiskCatalog } from './lib/catalogDisk'
import { setPlayerKeepMuted, attachPlayerEx } from './lib/player'
import { PlayerManager } from './lib/players/playerManager'
import {
  playbackUiAfterFailed,
  playbackUiAfterRetry,
  shouldResetManagedEngine,
  shouldRestorePlayerChrome,
  shouldShowNativeRetrySpinner,
} from './lib/players/retryPlayback'
import {
  type LiveReresolveState,
  deveZerarReresolve,
  estadoInicialReresolve,
  podeRotacionarLive,
  registrarRotacao,
} from './lib/players/live-reresolve'
import type { AudioTrack, SubtitleTrack, PlayerControls } from './lib/player'
import { coverSrc, mediaSrc } from './lib/proxy'
import { isHeavyLiveChannel, isUhd4kChannel } from './lib/video-engine'
import { prefetchCovers } from './lib/covers'
import { favoritesFirstById } from './lib/favorites-first'
import { capDownloads, downloadIdFor, reconcileDownloads, withoutDownloadTarget } from './lib/download-id'
import { clearAllHiddenItems, loadActiveId, loadActiveProfileId, loadAllHiddenItems, loadContinueWatching, loadFavorites, loadHiddenItems, loadPlaylists, loadProfiles, loadRecentLiveChannels, loadSettings, loadSortModes, saveActiveId, saveActiveProfileId, saveContinueWatching, saveFavorites, saveHiddenItems, savePlaylists, saveProfiles, saveRecentLiveChannels, saveSettings, saveSortModes , type HiddenItems } from './lib/storage'
import { resolveLastPlaylistId, shouldRestoreLastSession } from './lib/last-playlist'
import { canPersistCatalog } from './lib/catalog-owner'
import { clearXtreamM3uCache, formatAddedDate, loadEpgDataTable, loadM3uAccountProfile, loadSeriesInfo, loadShortEpg, loadShortEpgList, loadVodInfo, peekLoadedSeriesInfo, prefetchSeriesInfo, testXtream, resolveFreshLiveChannel } from './lib/xtream'
import {
  ACCENT_PRESETS,
  accentInkFor,
  applyAccentToDocument,
  applyCustomColorsToDocument,
  normalizeHexColor,
  resolveAccentColor,
} from './lib/accent'
import {
  getThemeOption,
  SHELL_BACKGROUND_OPTIONS,
  THEME_COLORS,
  THEME_OPTIONS,
  type ThemeId,
} from './lib/appearance'
import {
  normalizeHex as normalizeColorHex,
  PANEL_TONES,
  panelToneColor,
  readability,
  textDefaultFor,
} from './lib/theme-tokens'
import { peekVodInfoCache, vodInfoCacheKey } from './lib/vod-info-cache'
import hamster from './assets/hamster.jpg'
import { VirtualWindow } from './lib/virtual'
import { filterGamesAreaLiveChannels, isGamesAreaGroup } from './lib/games-area'
import {
  findSeasonForEpisode,
  formatSeasonOptionLabel,
  groupEpisodesBySeason,
  resolveEpisodeSeason,
} from './lib/episode-seasons'
import { SeasonSelect } from './lib/SeasonSelect'
import { DetailTintView } from './DetailTintView'
import { withoutContinueItem } from './lib/continue-matching'
import { UpdateToast } from './lib/updater-ui'
import { useUpdater } from './lib/use-updater'
import type { UpdateToastState } from './lib/use-updater'
import { decideFullscreenAction, escapeShouldExitFullscreen } from './lib/player/fullscreen-decision'
import {
  ArrowLeft,
  AudioLines,
  Captions,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Clock,
  ChevronsUpDown,
  Download,
  FolderOpen,
  Home,
  List,
  Maximize,
  MonitorPlay,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Star,
  Heart,
  Eraser,
  EyeOff,
  Trash2,
  Tv,
  User,
  Volume2,
  VolumeX,
  X,
  Link2,
  Server,
  FileUp,
  Pencil,
  Check,
  Eye,
  Palette,
  HardDrive,
  Brain,
  CalendarDays,
  Shield,
  Lock,
  Unlock,
  Copy,
  Info,
} from 'lucide-react'

const DEMO: Channel[] = [{ id: 'demo-hls', name: 'Demo HLS (Mux)', group: 'Testes', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', kind: 'live' }]
const EMPTY: Record<ContentKind, Channel[]> = { live: [], movie: [], series: [] }
const PROFILE_COLORS = ['#2dd4bf', '#3b82f6', '#f59e0b', '#e879f9', '#fb7185']
function uid() { return crypto.randomUUID() }
function Cover({
  src,
  fallback,
  small,
  live,
}: {
  src?: string
  fallback?: string
  small?: boolean
  live?: boolean
}) {
  const primary = coverSrc(src)
  const backup = live ? coverSrc(fallback) : coverSrc(fallback) || hamster
  const [current, setCurrent] = useState(primary || backup)
  const [ready, setReady] = useState(!primary)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let cancelled = false
    const nextPrimary = coverSrc(src)
    const nextBackup = live ? coverSrc(fallback) : coverSrc(fallback) || hamster
    setBroken(false)

    if (!nextPrimary) {
      setCurrent(nextBackup)
      setReady(true)
      return
    }

    if (nextBackup && nextBackup !== nextPrimary) {
      setCurrent(nextBackup)
      setReady(true)
    } else {
      setCurrent(nextPrimary)
      setReady(false)
    }

    const probe = new Image()
    // A sondagem nao tinha prazo. Um `onerror` so dispara se a requisicao FALHA —
    // se ela TRAVAR (cache de imagem do Electron esperando um painel lento), nem
    // `onload` nem `onerror` chamam, e o cartao fica com o retangulo vazio para
    // sempre. O prazo cobre esse buraco: passados 8s, cai no backup.
    //
    // `probe.src = ''` cancela a requisicao pendente, que senao continua
    // consumindo memoria depois do componente ter trocado de imagem.
    const prazo = window.setTimeout(() => {
      if (cancelled) return
      probe.src = ''
      if (live) {
        setBroken(true)
        setReady(true)
        return
      }
      setCurrent(nextBackup)
      setReady(true)
    }, 8000)
    probe.onload = () => {
      if (cancelled) return
      window.clearTimeout(prazo)
      setCurrent(nextPrimary)
      setReady(true)
    }
    probe.onerror = () => {
      if (cancelled) return
      window.clearTimeout(prazo)
      if (live) {
        setBroken(true)
        setReady(true)
        return
      }
      setCurrent(nextBackup)
      setReady(true)
    }
    probe.src = nextPrimary
    if (probe.complete && probe.naturalWidth > 0) {
      window.clearTimeout(prazo)
      setCurrent(nextPrimary)
      setReady(true)
    }
    return () => {
      cancelled = true
      window.clearTimeout(prazo)
    }
  }, [src, fallback, live])

  if (live && (!primary || broken)) {
    return <span className={small ? 'cover-ph-sm' : 'cover-ph'} aria-hidden />
  }

  return (
    <img
      className={`${small ? 'cover-sm' : ''} ${ready ? 'cover-ready' : 'cover-pending'}`}
      src={current}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => {
        if (live) {
          setBroken(true)
          setReady(true)
          return
        }
        setCurrent(backup)
        setReady(true)
      }}
    />
  )
}

function profileStats(profile: AppProfile) {
  const watching = profile.continueWatching.length
  const favorites = profile.favorites.length
  const parts: string[] = []
  if (watching > 0) parts.push(`${watching} continuando`)
  if (favorites > 0) parts.push(`${favorites} favoritos`)
  return parts.join(' · ') || 'Perfil novo'
}

function ProfilePicker({
  profiles,
  playlists,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onDuplicate,
}: {
  profiles: AppProfile[]
  playlists: Playlist[]
  onSelect: (profile: AppProfile) => void
  onCreate: (name: string, color: string, playlistIds: string[]) => void
  onUpdate: (profile: AppProfile) => void
  onDelete: (id: string) => void
  onDuplicate: (profile: AppProfile) => void
}) {
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const [editing, setEditing] = useState<AppProfile | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(PROFILE_COLORS[0])
  const [createPlaylists, setCreatePlaylists] = useState<string[]>(() => playlists.map((item) => item.id))

  useEffect(() => {
    if (creating) {
      setCreatePlaylists(playlists.map((item) => item.id))
    }
  }, [creating, playlists])

  return (
    <main className="profile-picker">
      <div className="profile-picker-glow" aria-hidden />
      <div className="profile-picker-content">
        <div className="profile-picker-hero">
          <img className="profile-picker-hero-img" src={hamster} alt="" />
          <div className="profile-picker-hero-fade" aria-hidden />
        </div>

        <div className="profile-picker-copy">
          <p className="profile-picker-brand">ST PLAY</p>
          <h1>Quem está assistindo?</h1>
          <p className="profile-picker-sub">Escolha um perfil para continuar</p>
        </div>

        <div className="profile-grid">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={`profile-tile${managing ? ' is-managing' : ''}`}
              onClick={() => (managing ? setEditing(profile) : onSelect(profile))}
            >
              <span
                className="profile-tile-avatar"
                style={{ background: profile.color, color: accentInkFor(profile.color) }}
              >
                {profile.name.charAt(0).toUpperCase()}
                {managing && (
                  <span className="profile-tile-edit" aria-hidden>
                    <Pencil size={14} />
                  </span>
                )}
              </span>
              <strong>{profile.name}</strong>
            </button>
          ))}

          {!managing && profiles.length < 5 && (
            <button type="button" className="profile-tile profile-tile-add" onClick={() => setCreating(true)}>
              <span className="profile-tile-avatar profile-tile-avatar-add">+</span>
              <strong>Adicionar</strong>
            </button>
          )}
        </div>

        <div className="profile-picker-actions">
          <button
            type="button"
            className={`profile-manage-page${managing ? ' is-active' : ''}`}
            onClick={() => {
              setManaging((value) => !value)
              setCreating(false)
            }}
          >
            {managing ? 'Concluído' : 'Gerenciar perfis'}
          </button>
        </div>

        {creating && (
          <div className="profile-create">
            <h3>Criar perfil</h3>
            <label className="profile-field">
              <span>Nome</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Nome do perfil"
                maxLength={24}
              />
            </label>
            <div className="profile-field">
              <span>Cor</span>
              <div className="color-options">
                {PROFILE_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={color === option ? 'selected' : ''}
                    style={{ background: option }}
                    aria-label="Escolher cor"
                    onClick={() => setColor(option)}
                  />
                ))}
              </div>
            </div>
            {playlists.length > 0 && (
              <div className="profile-field">
                <span>Listas</span>
                <div className="profile-playlist-picks">
                  {playlists.map((playlist) => {
                    const checked = createPlaylists.includes(playlist.id)
                    return (
                      <label key={playlist.id} className={`profile-playlist-pick${checked ? ' is-on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setCreatePlaylists((current) =>
                              checked
                                ? current.filter((id) => id !== playlist.id)
                                : [...current, playlist.id],
                            )
                          }}
                        />
                        <span>{playlist.name}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="row profile-create-actions">
              <button type="button" className="ghost" onClick={() => setCreating(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={!name.trim()}
                onClick={() => {
                  onCreate(name, color, createPlaylists)
                  setCreating(false)
                  setName('')
                }}
              >
                Criar
              </button>
            </div>
          </div>
        )}

        {editing && (
          <ProfileEditModal
            profile={editing}
            playlists={playlists}
            canDelete={profiles.length > 1}
            onClose={() => setEditing(null)}
            onSave={(profile) => {
              onUpdate(profile)
              setEditing(null)
            }}
            onDelete={() => {
              if (profiles.length > 1 && window.confirm(`Excluir o perfil ${editing.name}?`)) {
                onDelete(editing.id)
                setEditing(null)
              }
            }}
            onDuplicate={() => {
              onDuplicate(editing)
              setEditing(null)
            }}
          />
        )}
      </div>
    </main>
  )
}

function ProfileEditModal({
  profile,
  playlists,
  canDelete,
  onClose,
  onSave,
  onDelete,
  onDuplicate,
}: {
  profile: AppProfile
  playlists: Playlist[]
  canDelete: boolean
  onClose: () => void
  onSave: (profile: AppProfile) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const [name, setName] = useState(profile.name)
  const [color, setColor] = useState(profile.color)
  const [playlistIds, setPlaylistIds] = useState<string[]>(profile.playlistIds)

  return (
    <div className="modal-backdrop profile-modal-backdrop" onClick={onClose}>
      <div
        className="modal profile-edit-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="profile-edit-head">
          <span
            className="profile-tile-avatar profile-tile-avatar-preview"
            style={{ background: color }}
          >
            {name.trim().charAt(0).toUpperCase() || 'P'}
          </span>
          <div>
            <h2>Editar perfil</h2>
            <p className="profile-edit-sub">{profileStats(profile)}</p>
          </div>
        </div>

        <label className="profile-field">
          <span>Nome</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
        </label>

        <div className="profile-field">
          <span>Cor do avatar</span>
          <div className="color-options">
            {PROFILE_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                className={color === option ? 'selected' : ''}
                style={{ background: option }}
                aria-label="Escolher cor"
                onClick={() => setColor(option)}
              />
            ))}
          </div>
        </div>

        {playlists.length > 0 && (
          <div className="profile-field">
            <span>Listas deste perfil</span>
            <div className="profile-playlist-picks">
              {playlists.map((playlist) => {
                const checked = playlistIds.includes(playlist.id)
                return (
                  <label key={playlist.id} className={`profile-playlist-pick${checked ? ' is-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setPlaylistIds((current) =>
                          checked
                            ? current.filter((id) => id !== playlist.id)
                            : [...current, playlist.id],
                        )
                      }}
                    />
                    <span>{playlist.name}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        <div className="profile-edit-tools">
          <button type="button" className="ghost profile-tool-btn" onClick={onDuplicate}>
            <Copy size={15} />
            Duplicar perfil
          </button>
        </div>

        <div className="row profile-edit-actions">
          <button type="button" className="danger" onClick={onDelete} disabled={!canDelete}>
            Excluir perfil
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            disabled={!name.trim()}
            onClick={() => onSave({ ...profile, name: name.trim(), color, playlistIds })}
          >
            Salvar alterações
          </button>
        </div>
      </div>
    </div>
  )
}

// Pré-aquecimento DESLIGADO por enquanto: conta de 1 tela bloqueia ("already
// connected") com qualquer conexão extra. Re-ligar só com modo 1-conexão.
const PREWARM_ENABLED = false
const prewarmTimers = new Map<string, number>()
function prewarmLiveChannel(channel: { id: string; kind: string; url: string }) {
  if (!PREWARM_ENABLED) return
  try {
    if (channel.kind !== 'live' || !/^https?:\/\//i.test(channel.url)) return
    const host = new URL(channel.url).host
    const n = Number(localStorage.getItem(`stplay.hostffmpeg:${host}`) || 0) || 0
    if (n < 2 || prewarmTimers.has(channel.id)) return
    const w = window as unknown as {
      sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number) => Promise<unknown> } }
    }
    if (!w.sturplay?.dev?.ffmpegWrap) return
    prewarmTimers.set(
      channel.id,
      window.setTimeout(() => {
        prewarmTimers.delete(channel.id)
        try {
          void w.sturplay?.dev?.ffmpegWrap?.(channel.url, 0)
        } catch {
          // ignore
        }
      }, 400),
    )
  } catch {
    // ignore
  }
}

export default function App() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists())
  const [profiles, setProfiles] = useState<AppProfile[]>(() => {
    const saved = loadProfiles()
    if (saved.length) return saved
    return [{
      id: uid(),
      name: 'Meu perfil',
      color: PROFILE_COLORS[0],
      playlistIds: loadPlaylists().map((playlist) => playlist.id),
      favorites: loadFavorites(),
      continueWatching: loadContinueWatching(),
    }]
  })

  useEffect(() => {
    const applyLayout = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      const landscape = w >= h
      const layout =
        w >= 1600 ? 'tv' : w >= 1100 ? 'desktop' : w >= 720 || landscape ? 'tablet' : 'phone'
      const compact = h <= 420 && w <= 900
      document.documentElement.dataset.layout = layout
      document.documentElement.dataset.orientation = landscape ? 'landscape' : 'portrait'
      document.documentElement.dataset.compact = compact ? 'true' : 'false'
    }
    applyLayout()
    window.addEventListener('resize', applyLayout)
    return () => window.removeEventListener('resize', applyLayout)
  }, [])

  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => loadActiveProfileId())
  const [recentLiveEpoch, setRecentLiveEpoch] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = loadActiveId()
    const profile = loadProfiles().find((item) => item.id === loadActiveProfileId())
    if (!profile) return saved
    return resolveLastPlaylistId(profile.playlistIds, saved, profile.lastPlaylistId)
  })
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites())
  const [continueWatching, setContinueWatching] = useState<ContinueWatching[]>(() => loadContinueWatching())
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sturplay:rail-collapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('sturplay:rail-collapsed', railCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
    document.documentElement.dataset.railCollapsed = railCollapsed ? 'true' : 'false'
  }, [railCollapsed])

  const [parentalUnlocked, setParentalUnlocked] = useState(false)
  const [parentalPrompt, setParentalPrompt] = useState<null | { title?: string; onSuccess: () => void }>(null)
  const [catalogs, setCatalogs] = useState<Record<ContentKind, Channel[]>>(EMPTY)
  const [serverCategories, setServerCategories] = useState<Record<'movie' | 'series', XtreamCategory[]>>({
    movie: [],
    series: [],
  })
  const [loadingKind, setLoadingKind] = useState<ContentKind | null>(null)
  const [epgRefreshing, setEpgRefreshing] = useState(false)
  const updater = useUpdater()
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const catalogOwnerRef = useRef<string | null>(null)
  const refreshRunRef = useRef(0)
  const [groupLoading, setGroupLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedGroups, setSelectedGroups] = useState<Record<ContentKind, string>>({
    live: 'Todos',
    movie: 'Todos',
    series: 'Todos',
  })
  /**
   * Texto da busca por tipo, elevado ao pai.
   *
   * Abrir a ficha de um filme/serie troca a view inteira (setView({ name:
   * 'movie' })) e a grade do browse DESMONTA. A query era useState('') local da
   * grade, entao voltando da ficha voltava vazia: o usuario pesquisou, abriu um
   * resultado, deu Voltar, e caiu na grade inteira sem filtro e com o campo de
   * busca limpo.
   *
   * Mesmo formato do savedScroll abaixo, que ja sofria exatamente esse problema
   * e foi resolvido do mesmo jeito.
   */
  const [browseQuery, setBrowseQuery] = useState<Partial<Record<ContentKind, string>>>({})
  const [savedScroll, setSavedScroll] = useState<Record<ContentKind, { channels: number; groups: number }>>({
    live: { channels: 0, groups: 0 },
    movie: { channels: 0, groups: 0 },
    series: { channels: 0, groups: 0 },
  })
  const [sortModes, setSortModes] = useState<Record<ContentKind, SortMode>>(loadSortModes)
  const [returnToId, setReturnToId] = useState<string | null>(null)
  const [view, setViewEstado] = useState<View>(() => {
    const profileId = loadActiveProfileId()
    const saved = loadProfiles()
    if (shouldRestoreLastSession(profileId, saved.map((profile) => profile.id))) {
      return { name: 'home' }
    }
    return { name: 'profiles' }
  })
  /**
   * Troca de view COM RASTRO no log.
   *
   * Sem isto nao existe como responder "quem colocou o app em tela cheia enquanto
   * a pessoa assistia no painel dividido": `setView` do React nao deixa rastro, e
   * o efeito que esconde o browse (L9476) roda depois, sem levar o motivo junto.
   *
   * A pilha vai no log porque o sintoma e justamente um `openLive` disparado de
   * um caminho inesperado — sem o `stack` isso vira adivinhacao.
   *
   * A pilha so e capturada no dev server: `new Error().stack` faz o V8 montar a
   * structured stack, e isso nao tem lugar em troca de view no build empacotado.
   * Fora do dev o registro vai vazio, e o log continua dizendo de qual view para
   * qual — que e o que interessa.
   */
  const setView = useCallback(
    (next: View | ((prev: View) => View)) => {
      const resolvido = typeof next === 'function' ? next(view) : next
      registrarTrocaDeView(
        view.name,
        resolvido.name,
        import.meta.env.DEV ? (new Error().stack || '').slice(0, 400) : '',
      )
      setViewEstado(resolvido)
    },
    [view],
  )
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  /**
   * Liga o rastreio de `player-active` assim que o app monta.
   *
   * Precisa ser no primeiro render: `document.body.classList.add('player-active')`
   * pode rodar em um efeito que dispara antes de qualquer interacao, e um
   * rastreador instalado depois ja teria perdido o culpado.
   */
  useEffect(() => instalarDiagnosticoPlayerActive(), [])
  const profilePlaylists = playlists.filter((playlist) => activeProfile?.playlistIds.includes(playlist.id))
  const active = profilePlaylists.find((p) => p.id === activeId) ?? profilePlaylists[0] ?? null
  const browseKind = view.name === 'browse' ? view.kind : 'all'
  const parkedBrowseKind: ContentKind | null =
    view.name === 'browse'
      ? view.kind
      : view.name === 'player'
        ? view.fromSeries || view.channel.kind === 'series'
          ? 'series'
          : view.channel.kind === 'movie'
            ? 'movie'
            : view.fromLive === 'browse'
              ? 'live'
              : null
        : null
  const vodReturnViewRef = useRef<View>({ name: 'home' })
  const activeContinueWatching = useMemo(
    () => continueWatching.filter((item) => item.playlistId === active?.id),
    [continueWatching, active?.id],
  )

  const prevViewRef = useRef<View['name']>(view.name)

  // Ao abrir ficha VOD: só esconde mpv (async) — hideSync travava a UI.
  useEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = view.name
    if (view.name === 'movie' || view.name === 'series') {
      resetPlayerChrome()
      return
    }
    if (prev === 'player' && view.name !== 'player') {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {})
      }
      exitNativePlayback()
    }
  }, [view.name])

  // Fora do player: garante shell React visível (Esc com mpv nativo deixava tela preta).
  useEffect(() => {
    if (view.name === 'player') return
    forceShellVisible()
    const id = window.requestAnimationFrame(() => forceShellVisible())
    return () => window.cancelAnimationFrame(id)
  }, [view.name])

  // Startup: restaura shell antes de qualquer warm do mpv (evita tela preta na abertura).
  useEffect(() => {
    forceShellVisible()
    const id = window.requestAnimationFrame(() => forceShellVisible())
    return () => window.cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    savePlaylists(playlists)
  }, [playlists])

  useEffect(() => {
    saveProfiles(profiles)
  }, [profiles])

  useEffect(() => {
    if (activeId) saveActiveId(activeId)
  }, [activeId])

  useEffect(() => {
    if (!activeProfileId || !activeId) return
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === activeProfileId && profile.lastPlaylistId !== activeId
          ? { ...profile, lastPlaylistId: activeId }
          : profile,
      ),
    )
  }, [activeProfileId, activeId])

  useEffect(() => {
    saveFavorites(favorites)
  }, [favorites])

  useEffect(() => {
    saveContinueWatching(continueWatching)
  }, [continueWatching])

  useEffect(() => {
    if (activeProfileId) saveActiveProfileId(activeProfileId)
  }, [activeProfileId])

  useEffect(() => {
    if (!activeProfileId) return
    setProfiles((current) => current.map((profile) => profile.id === activeProfileId
      ? { ...profile, favorites, continueWatching }
      : profile))
  }, [activeProfileId, favorites, continueWatching])

  useEffect(() => {
    if (!active) return
    if (!canPersistCatalog(catalogOwnerRef.current, active.id)) return
    for (const kind of ['live', 'movie', 'series'] as ContentKind[]) {
      const items = catalogs[kind]
      if (items.length >= 10) {
        seedMemoryCatalog(active.id, kind, items)
        persistCatalogToDisk(active.id, kind, items)
      }
    }
  }, [active?.id, catalogs])

  const [settingsInitialSection, setSettingsInitialSection] = useState<'playlist' | undefined>(undefined)

  useEffect(() => {
    if (view.name === 'setup') {
      setSettingsInitialSection('playlist')
      setView({ name: 'settings' })
    }
  }, [view.name])

  useEffect(() => {
    saveSettings(settings)
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.shellBg = settings.shellBackground || 'gradient'
    document.documentElement.style.setProperty(
      '--ui-brightness',
      String((settings.shellBrightness ?? 100) / 100),
    )
    applyAccentToDocument(settings.accent || 'teal', settings.customAccent)
    applyCustomColorsToDocument(settings.customColors, {
      bg: THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg,
      text: THEME_COLORS[(settings.theme || 'dark') as ThemeId].text,
    })
    document.documentElement.dataset.fontSize = settings.fontSize || 'default'
    document.documentElement.dataset.density = settings.density || 'comfortable'
    document.documentElement.dataset.performance = settings.performanceMode ? 'on' : 'off'
  }, [settings])

  useEffect(() => {
    if (view.name === 'player') return
    void window.sturplay?.nativePlayer?.stopExternal?.()
  }, [view.name])

  useEffect(() => {
    saveSortModes(sortModes)
  }, [sortModes])

  useEffect(() => {
    if (!settings.parentalPin || parentalUnlocked) return
    setSelectedGroups((prev) => {
      let changed = false
      const next = { ...prev }
      for (const kind of ['live', 'movie', 'series'] as ContentKind[]) {
        if (isAdultGroup(next[kind])) {
          next[kind] = 'Todos'
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [settings.parentalPin, parentalUnlocked])

  useEffect(() => {
    if (!active || (active.kind === 'm3u' && !active.m3uUrl)) return
    let cancelled = false
    const request = active.kind === 'xtream' ? testXtream(active).then((result) => result.profile) : loadM3uAccountProfile(active)
    void request
      .then((profile) => {
        if (!cancelled && profile) {
          const xtream = active.xtream ?? { host: profile.domain, username: profile.username, password: '' }
          setPlaylists((current) => current.map((playlist) => playlist.id === active.id
            ? { ...active, xtream: { ...xtream, profile } }
            : playlist))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active?.id, active?.kind, active?.m3uUrl, active?.xtream?.host, active?.xtream?.username])

  useEffect(() => {
    if (!active) {
      setCatalogs({ live: DEMO, movie: [], series: [] })
      setServerCategories({ movie: [], series: [] })
      return
    }

    let cancelled = false
    const switched = catalogOwnerRef.current !== null && catalogOwnerRef.current !== active.id
    if (switched || catalogOwnerRef.current !== active.id) {
      catalogOwnerRef.current = null
      setCatalogs(EMPTY)
      setServerCategories({ movie: [], series: [] })
    }

    const apply = (kind: ContentKind, items: Channel[]) => {
      if (cancelled) return
      catalogOwnerRef.current = active.id
      setCatalogs((prev) => ({
        ...prev,
        [kind]: items.length ? items : kind === 'live' ? DEMO : [],
      }))
    }

    const load = async (kind: ContentKind, force = false) => {
      // Já tem catálogo em memória: não recarrega (volta/entrar fica rápido)
      if (!force && cachedCount(active.id, kind) > 0) {
        const items = await loadCatalog(active, kind, false)
        if (!cancelled) {
          setCatalogs((prev) => {
            if (prev[kind].length > 0 && prev[kind].length >= items.length) return prev
            catalogOwnerRef.current = active.id
            return {
              ...prev,
              [kind]: items.length ? items : kind === 'live' ? DEMO : [],
            }
          })
        }
        if (kind === 'movie' || kind === 'series') {
          const cats = await loadCategories(active, kind)
          if (!cancelled) setServerCategories((prev) => ({ ...prev, [kind]: cats }))
        }
        // Filmes: o dump global para em ~21k; o celular/Extreme InfiniTV têm ~30.6k
        if (kind === 'movie' && items.length > 0 && items.length < 40_000) {
          void loadCatalog(active, 'movie', true, (partial) => {
            if (cancelled || partial.length === 0) return
            setCatalogs((prev) => {
              if (partial.length <= prev.movie.length) return prev
              return { ...prev, movie: partial }
            })
          }).then((full) => {
            if (cancelled || full.length === 0) return
            setCatalogs((prev) => {
              if (full.length <= prev.movie.length) return prev
              return { ...prev, movie: full }
            })
            if (canPersistCatalog(catalogOwnerRef.current, active.id)) {
              persistCatalogToDisk(active.id, 'movie', full)
            }
          })
        }
        // Séries: painel verde ~8500; cache de ~7k ainda está truncado
        if (kind === 'series' && items.length > 0 && items.length < 9000) {
          void loadCatalog(active, 'series', true, (partial) => {
            if (cancelled || partial.length === 0) return
            setCatalogs((prev) => {
              if (partial.length <= prev.series.length) return prev
              return { ...prev, series: partial }
            })
          }).then((full) => {
            if (cancelled || full.length === 0) return
            setCatalogs((prev) => {
              if (full.length <= prev.series.length) return prev
              return { ...prev, series: full }
            })
            if (canPersistCatalog(catalogOwnerRef.current, active.id)) {
              persistCatalogToDisk(active.id, 'series', full)
            }
          })
        }
        return
      }

      setLoadingKind(kind)
      try {
        if (kind === 'movie') {
          const cats = await loadCategories(active, kind)
          if (!cancelled) setServerCategories((prev) => ({ ...prev, movie: cats }))
          const items = await loadCatalog(active, 'movie', force, (partial) => {
            if (!cancelled) apply('movie', partial)
          })
          if (cancelled) return
          apply('movie', items)
          if (items.length > 0 && canPersistCatalog(catalogOwnerRef.current, active.id)) {
            persistCatalogToDisk(active.id, 'movie', items)
          }
          return
        }

        // Séries / ao vivo: caminho isolado (sem progress/API de filmes)
        if (kind === 'series') {
          const items = await loadCatalog(active, 'series', force)
          if (cancelled) return
          apply('series', items)
          const cats = await loadCategories(active, kind)
          if (!cancelled) setServerCategories((prev) => ({ ...prev, series: cats }))
          return
        }

        const items = await loadCatalog(active, kind, force)
        if (cancelled) return
        apply(kind, items)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar lista')
          if (kind === 'live') apply('live', DEMO)
        }
      }
    }

    void (async () => {
      setError(null)

      // Disco → memória/UI na hora (clique em Filmes/Séries fica instantâneo)
      const [diskLive, diskMovie, diskSeries] = await Promise.all([
        hydrateCatalogFromDisk(active.id, 'live'),
        hydrateCatalogFromDisk(active.id, 'movie'),
        hydrateCatalogFromDisk(active.id, 'series'),
      ])
      if (cancelled) return
      catalogOwnerRef.current = active.id
      setCatalogs({
        live: diskLive,
        movie: diskMovie,
        series: diskSeries,
      })

      if (view.name === 'browse') {
        await load(view.kind, switched)
        if (!cancelled) setLoadingKind(null)
        return
      }

      // Home: carrega rápido (sem pausas longas do modo "calmo")
      await load('live', switched)
      if (cancelled) return
      setLoadingKind(null)

      void load('series', switched)
      void load('movie', switched).finally(() => {
        if (!cancelled) setLoadingKind(null)
      })
    })()

    return () => {
      cancelled = true
    }
  }, [active, browseKind])

  // Ao clicar numa categoria, garante o conteúdo (filtra do M3U completo / API)
  useEffect(() => {
    if (!active || view.name !== 'browse') return
    const kind = view.kind
    if (kind !== 'movie' && kind !== 'series') return
    const selected = selectedGroups[kind] || 'Todos'
    const cat = serverCategories[kind].find((c) => c.name === selected)
    if (!cat) return

    let cancelled = false
    setGroupLoading(true)
    void loadCategoryContent(active, kind, cat, true)
      .then((items) => {
        if (cancelled || items.length === 0) return
        setCatalogs((prev) => {
          const map = new Map<string, Channel>()
          for (const item of prev[kind]) map.set(item.id, item)
          for (const item of items) map.set(item.id, item)
          return { ...prev, [kind]: [...map.values()] }
        })
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setGroupLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [active, view, selectedGroups, serverCategories])

  const counts = {
    live: active ? cachedCount(active.id, 'live') || catalogs.live.length : catalogs.live.length,
    movie: active ? cachedCount(active.id, 'movie') || catalogs.movie.length : catalogs.movie.length,
    series: active ? cachedCount(active.id, 'series') || catalogs.series.length : catalogs.series.length,
  }

  function addPlaylist(playlist: Playlist) {
    setPlaylists((prev) => [...prev, playlist])
    if (activeProfileId) {
      setProfiles((prev) => prev.map((profile) => profile.id === activeProfileId
        ? { ...profile, playlistIds: [...profile.playlistIds, playlist.id] }
        : profile))
    }
    setActiveId(playlist.id)
    setView({ name: 'home' })
  }

  function updatePlaylist(updated: Playlist) {
    // Fora do updater do setState. O updater tem que ser PURO: o React pode
    // chamá-lo mais de uma vez (bailout eager descartado por update de maior
    // prioridade, replay de render, StrictMode) e pode chamá-lo DURANTE a fase
    // de render. Com `clearCatalog` e os outros setState dentro dele, o catálogo
    // recém-carregado era apagado depois de populado, e o setCatalogs([]) da
    // chamada descartada continuava na fila — grade vazia e re-download inteiro.
    const before = playlists.find((p) => p.id === updated.id)
    const changedIdentity =
      !before ||
      before.xtream?.host !== updated.xtream?.host ||
      before.xtream?.username !== updated.xtream?.username ||
      before.xtream?.password !== updated.xtream?.password ||
      before.m3uUrl !== updated.m3uUrl
    if (changedIdentity) {
      // Sem isto, corrigir um usuário/host digitado errado continuava mostrando
      // o catálogo inteiro da conta anterior — `cachedCount()` era > 0, então o
      // App nem refazia a busca.
      clearCatalog(updated.id)
      clearXtreamM3uCache(updated.id)
      setCatalogs({ live: [], movie: [], series: [] })
      setServerCategories({ movie: [], series: [] })
      setSelectedGroups({ live: 'Todos', movie: 'Todos', series: 'Todos' })
    }
    setPlaylists((prev) => (prev.some((p) => p.id === updated.id && p === updated) ? prev : prev.map((playlist) => (playlist.id === updated.id ? updated : playlist))))
  }

  function chooseProfile(profile: AppProfile) {
    startTransition(() => {
      setActiveProfileId(profile.id)
      setFavorites(profile.favorites)
      setContinueWatching(profile.continueWatching)
      setActiveId(resolveLastPlaylistId(profile.playlistIds, loadActiveId(), profile.lastPlaylistId))
      setView(profile.playlistIds.some((id) => playlists.some((playlist) => playlist.id === id))
        ? { name: 'home' }
        : { name: 'settings' })
      if (!profile.playlistIds.some((id) => playlists.some((playlist) => playlist.id === id))) {
        setSettingsInitialSection('playlist')
      }
    })
  }

  function switchProfile() {
    setActiveProfileId(null)
    setView({ name: 'profiles' })
  }

  function createProfile(name: string, color: string, playlistIds: string[]) {
    const profile: AppProfile = {
      id: uid(),
      name: name.trim() || 'Novo perfil',
      color,
      playlistIds: playlistIds.length ? playlistIds : playlists.map((item) => item.id),
      favorites: [],
      continueWatching: [],
    }
    setProfiles((current) => [...current, profile])
    chooseProfile(profile)
  }

  function duplicateProfile(profile: AppProfile) {
    const copy: AppProfile = {
      ...profile,
      id: uid(),
      name: `${profile.name} (cópia)`.slice(0, 24),
      favorites: [...profile.favorites],
      continueWatching: [...profile.continueWatching],
      playlistIds: [...profile.playlistIds],
    }
    setProfiles((current) => [...current, copy])
  }

  const [downloads, setDownloads] = useState<DownloadedItem[]>(() => {
    try {
      const raw = localStorage.getItem('sturplay:downloads')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  /**
   * Um job salvo como `downloading`/`queued` nao tem processo correspondente: o
   * Map do processo principal morreu com o app anterior. A logica esta em
   * `reconcileDownloads`, com testes, porque o que importa nao e "mudar o
   * status" e sim "o item ficou retryavel em vez de ser um dead-end".
   */
  useEffect(() => {
    setDownloads((prev) => reconcileDownloads(prev))
  }, [])

  useEffect(() => {
    // Teto antes de gravar. Sem isso a lista so cresce, e o `catch` vazio
    // engolia o estouro de cota: a partir dele TODO o estado de download se
    // perdia a cada reinicio, sem aviso nenhum.
    const trimmed = capDownloads(downloads)
    if (trimmed !== downloads) {
      setDownloads(trimmed)
      return
    }
    try {
      localStorage.setItem('sturplay:downloads', JSON.stringify(trimmed))
    } catch {
      // cota estourada: nao derruba a UI, so nao persiste
    }
  }, [downloads])

  useEffect(() => {
    const api = window.sturplay?.downloads
    if (!api?.onProgress) return
    return api.onProgress((payload) => {
      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === payload.id)
        if (idx < 0) return prev
        if (payload.status === 'canceled') {
          return prev.filter((d) => d.id !== payload.id)
        }
        const current = prev[idx]
        const copy = prev.slice()
        copy[idx] = {
          ...current,
          status:
            payload.status === 'completed'
              ? 'completed'
              : payload.status === 'paused'
                ? 'paused'
                : payload.status === 'queued'
                  ? 'queued'
                  : payload.status === 'error'
                    ? 'error'
                    : 'downloading',
          received: payload.received ?? current.received,
          total: payload.total ?? current.total,
          speed: payload.speed ?? 0,
          filePath: payload.filePath || current.filePath,
          folder: payload.folder || current.folder,
          error: payload.error,
        }
        return copy
      })
      if (payload.folder) {
        updateSettings({ downloadFolder: payload.folder })
      }
    })
  }, [])

  useEffect(() => {
    void window.sturplay?.downloads?.getFolder?.().then((res) => {
      if (res?.ok && res.path) {
        updateSettings({ downloadFolder: res.path })
      }
    })
  }, [])

  async function handleStartDownload(item: DownloadedItem) {
    const api = window.sturplay?.downloads
    const extension =
      item.extension || item.url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1] || 'mp4'
    const pending: DownloadedItem = {
      ...item,
      status: 'downloading',
      received: 0,
      total: 0,
      speed: 0,
      extension,
      date: item.date || new Date().toLocaleDateString('pt-BR'),
      // O retry reaproveita a linha antiga, entao o erro da tentativa anterior
      // e um filePath de uma tentativa que morreu no meio vêm junto pelo
      // `...item`. Sem limpar, o item aparece como ativo carregando a mensagem
      // de erro velha, e o "Baixado" depois mostra um caminho invalido.
      error: undefined,
      filePath: undefined,
    }
    setDownloads((prev) => [pending, ...withoutDownloadTarget(prev, pending)])
    setView({ name: 'downloads' })

    if (!api?.start) {
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === item.id
            ? { ...d, status: 'error', error: 'Download disponível apenas no app desktop.' }
            : d,
        ),
      )
      return
    }

    const result = await api.start({
      id: item.id,
      url: item.url,
      name: item.name,
      extension,
    })
    if (result?.canceled) {
      setDownloads((prev) => prev.filter((d) => d.id !== item.id))
      return
    }
    if (!result?.ok) {
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === item.id
            ? { ...d, status: 'error', error: result?.error || 'Falha ao iniciar download' }
            : d,
        ),
      )
      return
    }
    setDownloads((prev) =>
      prev.map((d) =>
        d.id === item.id
          ? {
              ...d,
              filePath: result.filePath,
              folder: result.folder,
              status: 'downloading',
            }
          : d,
      ),
    )
    if (result.folder) updateSettings({ downloadFolder: result.folder })
  }

  function handleRemoveDownload(id: string) {
    void window.sturplay?.downloads?.cancel?.(id)
    setDownloads((prev) => prev.filter((d) => d.id !== id))
  }

  function handlePauseDownload(id: string) {
    void window.sturplay?.downloads?.pause?.(id)
  }

  function handleResumeDownload(id: string) {
    void window.sturplay?.downloads?.resume?.(id)
  }

  function toggleFav(id: string) {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function updateProgress(channel: Channel, currentTime: number, duration: number) {
    if (!active || channel.kind === 'live' || !Number.isFinite(currentTime) || !Number.isFinite(duration)) {
      return
    }
    setContinueWatching((prev) => {
      const existing = prev.find(
        (item) =>
          item.playlistId === active.id &&
          (channel.seriesId
            ? item.seriesId === channel.seriesId || item.channel.id === channel.id
            : item.channel.id === channel.id),
      )
      if (currentTime < 5 || duration <= 0 || currentTime >= duration - 15) {
        return existing
          ? prev.filter((item) => item !== existing)
          : prev
      }
      const next = prev.filter((item) => item !== existing)
      return [
        ...next,
        {
          playlistId: active.id,
          channel,
          seriesId: channel.seriesId,
          seriesName: channel.seriesName,
          seriesLogo: channel.seriesLogo,
          episodeName: channel.kind === 'series' ? channel.name : undefined,
          currentTime,
          duration,
          updatedAt: Date.now(),
        },
      ]
    })
  }

  function removeContinueWatching(channelId: string, seriesId?: string) {
    setContinueWatching((prev) => withoutContinueItem(prev, active?.id, channelId, seriesId))
  }

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => {
      const next = { ...current, ...patch }
      if ('parentalPin' in patch && (patch.parentalPin === undefined || patch.parentalPin === '')) {
        delete next.parentalPin
      }
      return next
    })
    if (patch.downloadFolder && window.sturplay?.downloads?.setFolder) {
      void window.sturplay.downloads.setFolder(patch.downloadFolder)
    }
  }

  async function refreshServerCatalog() {
    if (!active) {
      setError('Selecione uma lista antes de atualizar o servidor')
      return
    }
    if (catalogRefreshing) return
    const runId = ++refreshRunRef.current
    const playlistId = active.id
    const isCurrent = () => refreshRunRef.current === runId && active.id === playlistId
    setCatalogRefreshing(true)
    setError(null)
    // NÃO limpa o catálogo antigo: live entra primeiro e o resto completa em
    // segundo plano. Antes zerava tudo e travava no dump mais lento (séries 240s).
    setLoadingKind('live')
    try {
      const live = await loadCatalog(active, 'live', true)
      if (!isCurrent()) return
      catalogOwnerRef.current = active.id
      setCatalogs((current) => ({
        ...current,
        live: live.length ? live : current.live.length ? current.live : DEMO,
      }))
      if (live.length >= 10) persistCatalogToDisk(active.id, 'live', live)
      setLoadingKind('movie')
      const [movie, series] = await Promise.all([
        loadCatalog(active, 'movie', true),
        loadCatalog(active, 'series', true),
      ])
      if (!isCurrent()) return
      setCatalogs((current) => ({
        ...current,
        movie,
        series,
      }))
      if (movie.length >= 10) persistCatalogToDisk(active.id, 'movie', movie)
      if (series.length >= 10) persistCatalogToDisk(active.id, 'series', series)
      const [movieCats, seriesCats] = await Promise.all([
        loadCategories(active, 'movie').catch(() => [] as XtreamCategory[]),
        loadCategories(active, 'series').catch(() => [] as XtreamCategory[]),
      ])
      if (!isCurrent()) return
      setServerCategories({ movie: movieCats, series: seriesCats })
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : 'Não foi possível atualizar o servidor')
    } finally {
      if (isCurrent()) {
        setCatalogRefreshing(false)
        setLoadingKind(null)
      }
    }
  }

  async function refreshEpg() {
    if (!active) {
      setError('Selecione uma lista antes de atualizar o EPG')
      return
    }
    if (epgRefreshing) return
    setEpgRefreshing(true)
    setError(null)
    const previousLive = catalogs.live
    clearCatalog(active.id, 'live')
    clearXtreamM3uCache(active.id)
    try {
      await clearDiskCatalog(active.id, 'live')
      const live = await Promise.race([
        loadCatalog(active, 'live', true),
        new Promise<Channel[]>((_, reject) => {
          window.setTimeout(() => reject(new Error('Tempo esgotado ao atualizar os canais ao vivo')), 90_000)
        }),
      ])
      setCatalogs((current) => ({
        ...current,
        live: live.length ? live : previousLive.length ? previousLive : DEMO,
      }))
      if (live.length >= 10) persistCatalogToDisk(active.id, 'live', live)
      updateSettings({ epgUpdatedAt: Date.now() })
    } catch (err) {
      setCatalogs((current) => ({
        ...current,
        live: previousLive.length ? previousLive : current.live.length ? current.live : DEMO,
      }))
      setError(err instanceof Error ? err.message : 'Não foi possível atualizar o EPG')
    } finally {
      setEpgRefreshing(false)
    }
  }

  function requireAdultAccess(action: () => void, title = 'Conteúdo adulto') {
    if (!settings.parentalPin) {
      action()
      return
    }
    if (parentalUnlocked) {
      action()
      return
    }
    setParentalPrompt({
      title,
      onSuccess: () => {
        setParentalUnlocked(true)
        action()
      },
    })
  }

  function resolveSeriesFromEpisode(channel: Channel): Channel | undefined {
    const actualSeriesId = channel.seriesId || channel.streamId
    if (!actualSeriesId || !active) return undefined
    if (active.kind === 'xtream') {
      const found = catalogs.series.find(
        (s) =>
          s.streamId === actualSeriesId ||
          s.id === `series-${actualSeriesId}` ||
          s.id === actualSeriesId,
      )
      if (found) return found
    }
    return {
      id: `series-${actualSeriesId}`,
      name: channel.seriesName || channel.name,
      logo: channel.seriesLogo || channel.logo,
      group: channel.group,
      url: actualSeriesId,
      kind: 'series',
      streamId: actualSeriesId,
      seriesId: actualSeriesId,
    }
  }

  function isPlayableEpisode(channel: Channel) {
    return channel.id.startsWith('ep-') || /^https?:\/\//i.test(channel.url)
  }

  async function resolveSeriesEpisodeList(episode: Channel, fallback: Channel[]): Promise<Channel[]> {
    if (fallback.length > 1) return fallback
    const seriesId = episode.seriesId || episode.streamId
    if (!seriesId || !active || active.kind !== 'xtream') {
      return fallback.length > 0 ? fallback : [episode]
    }
    const cached = peekLoadedSeriesInfo(active, seriesId)
    if (cached?.seasons?.length) {
      const eps = cached.seasons.flatMap((season) => season.episodes)
      if (eps.length > 0) return eps
    }
    try {
      const info = await loadSeriesInfo(active, seriesId)
      const eps = info.seasons.flatMap((season) => season.episodes)
      if (eps.length > 0) return eps
    } catch {
      /* ignore */
    }
    return fallback.length > 0 ? fallback : [episode]
  }

  function openBrowse(kind: ContentKind) {
    if (kind !== 'live') {
      resetPlayerChrome()
      void window.sturplay?.player?.hide?.()
    }
    // Sempre abre em Padrão — "Mais Recentes" persistido bugava a ordem no 1º paint
    if (kind === 'movie' || kind === 'series') {
      setSortModes((prev) => (prev[kind] === 'default' ? prev : { ...prev, [kind]: 'default' }))
    }
    startTransition(() => setView({ name: 'browse', kind }))
  }

  function openContent(
    channel: Channel,
    list: Channel[],
    startTime?: number,
    opts?: { autoFullscreen?: boolean; autoPlay?: boolean },
  ) {
    const resume = startTime !== undefined && startTime > 0
    const autoPlay = Boolean(opts?.autoPlay)

    if (autoPlay && channel.kind === 'series') {
      let episode: Channel | undefined
      const playAt = startTime ?? 0

      if (isPlayableEpisode(channel)) {
        episode = channel
      } else {
        const saved = continueWatching.find(
          (item) =>
            item.playlistId === active?.id &&
            (item.channel.id === channel.id ||
              (channel.streamId &&
                (item.seriesId === channel.streamId || item.channel.seriesId === channel.streamId))),
        )
        if (saved) episode = saved.channel
      }

      if (episode && isPlayableEpisode(episode)) {
        setReturnToId(episode.id)
        const fromSeries = resolveSeriesFromEpisode(episode)
        const openEpisode = () => {
          void (async () => {
            const epList = await resolveSeriesEpisodeList(
              episode,
              isPlayableEpisode(channel) && list.length > 0 ? list : [episode],
            )
            const enriched = {
              ...episode,
              seriesId: episode.seriesId || episode.streamId,
              seriesName: episode.seriesName || fromSeries?.name,
              seriesLogo: episode.seriesLogo || fromSeries?.logo,
            }
            if (fromSeries) {
              vodReturnViewRef.current = view
              resetPlayerChrome()
              void window.sturplay?.player?.hide?.()
              startTransition(() =>
                setView({
                  name: 'series',
                  series: fromSeries,
                  episode: enriched,
                  list: epList,
                  startTime: playAt,
                  autoPlay: true,
                }),
              )
            } else {
              setView({
                name: 'player',
                channel: enriched,
                list: epList,
                startTime: playAt,
              })
            }
          })()
        }
        if (isAdultChannel(episode)) requireAdultAccess(openEpisode)
        else openEpisode()
        return
      }
    }

    if (resume && channel.kind === 'series' && !autoPlay) {
      let episode: Channel | undefined
      if (isPlayableEpisode(channel)) {
        episode = channel
      } else {
        const saved = continueWatching.find(
          (item) =>
            item.playlistId === active?.id &&
            item.currentTime > 0 &&
            (item.channel.id === channel.id ||
              (channel.streamId &&
                (item.seriesId === channel.streamId || item.channel.seriesId === channel.streamId))),
        )
        if (saved) episode = saved.channel
      }
      const fromSeries = episode ? resolveSeriesFromEpisode(episode) : resolveSeriesFromEpisode(channel)
      if (fromSeries) {
        setReturnToId(fromSeries.id)
        const openSeries = () => {
          vodReturnViewRef.current = view
          resetPlayerChrome()
          void window.sturplay?.player?.hide?.()
          startTransition(() => setView({ name: 'series', series: fromSeries }))
        }
        if (isAdultChannel(fromSeries)) requireAdultAccess(openSeries)
        else openSeries()
        return
      }
    }

    if (channel.kind === 'series') {
      const actualSeriesId = channel.seriesId || channel.streamId
      setReturnToId(channel.id)
      const openSeries = () => {
        vodReturnViewRef.current = view
        resetPlayerChrome()
        void window.sturplay?.player?.hide?.()
        startTransition(() => {
          if (active?.kind === 'xtream' && actualSeriesId) {
            const found = catalogs.series.find(
              (s) => s.streamId === actualSeriesId || s.id === `series-${actualSeriesId}` || s.id === actualSeriesId,
            )
            if (found) {
              setView({ name: 'series', series: found })
            } else {
              setView({
                name: 'series',
                series: {
                  ...channel,
                  id: channel.seriesId ? `series-${channel.seriesId}` : channel.id,
                  name: channel.seriesName || channel.name,
                  logo: channel.seriesLogo || channel.logo,
                  streamId: actualSeriesId,
                },
              })
            }
          } else {
            setView({ name: 'player', channel, list, startTime })
          }
        })
      }
      if (isAdultChannel(channel)) requireAdultAccess(openSeries)
      else openSeries()
      return
    }

    if (channel.kind === 'movie') {
      const fresh = freshenChannel(channel, catalogs)
      setReturnToId(fresh.id)
      vodReturnViewRef.current = view
      const openMovie = () => {
        resetPlayerChrome()
        void window.sturplay?.player?.hide?.()
        startTransition(() =>
          setView({
            name: 'movie',
            movie: fresh,
            list,
            startTime: autoPlay ? startTime : undefined,
            autoPlay,
          }),
        )
      }
      if (isAdultChannel(fresh)) requireAdultAccess(openMovie)
      else openMovie()
      return
    }

    const openLive = () =>
      setView({
        name: 'player',
        channel: { ...channel, kind: channel.kind || 'live' },
        list,
        startTime,
        fromLive: view.name === 'browse' ? 'browse' : 'home',
        autoFullscreen: opts?.autoFullscreen,
      })
    if (isAdultChannel(channel)) requireAdultAccess(openLive)
    else openLive()
  }

  /** Grava lançamento/nota dos detalhes de volta no catálogo (pra ordenar a lista certo). */
  const patchCatalogMeta = useCallback((kind: 'movie' | 'series', id: string, patch: Partial<Channel>) => {
    setCatalogs((prev) => {
      const list = prev[kind]
      const index = list.findIndex((c) => c.id === id)
      if (index < 0) return prev
      const current = list[index]
      if (
        (patch.releasedate === undefined || patch.releasedate === current.releasedate) &&
        (patch.rating === undefined || patch.rating === current.rating) &&
        (patch.plot === undefined || patch.plot === current.plot)
      ) {
        return prev
      }
      const next = list.slice()
      next[index] = { ...current, ...patch }
      return { ...prev, [kind]: next }
    })
  }, [])

  return (
    <div className={`app${view.name === 'home' ? ' app-home' : ''}`}>
      {view.name === 'profiles' && (
        <ProfilePicker
          profiles={profiles}
          playlists={playlists}
          onSelect={chooseProfile}
          onCreate={createProfile}
          onUpdate={(updated) => setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile))}
          onDelete={(id) => setProfiles((current) => current.filter((profile) => profile.id !== id))}
          onDuplicate={duplicateProfile}
        />
      )}
      {view.name !== 'player' &&
        view.name !== 'profiles' &&
        view.name !== 'home' &&
        view.name !== 'browse' &&
        view.name !== 'movie' &&
        view.name !== 'series' &&
        view.name !== 'favorites' &&
        view.name !== 'downloads' &&
        view.name !== 'epg' &&
        view.name !== 'settings' &&
        view.name !== 'setup' && (
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src={hamster} alt="" />
            ST PLAY
          </div>
          <button className="ghost" onClick={() => startTransition(() => setView({ name: 'home' }))}>
            Início
          </button>
          {activeProfile && (
            <button
              className="active-profile-button"
              style={{ marginLeft: 'auto' }}
              onClick={switchProfile}
              title="Trocar perfil"
            >
              <span className="active-profile-avatar" style={{ background: activeProfile.color }}>
                {activeProfile.name.charAt(0).toUpperCase()}
              </span>
              <span>{activeProfile.name}</span>
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Abrir configurações"
            title="Configurações"
            onClick={() => setView({ name: 'settings' })}
            style={activeProfile ? undefined : { marginLeft: 'auto' }}
          >
            ⚙
          </button>
        </header>
      )}

      {error && view.name !== 'player' && (
        <div className="error" style={{ padding: '0 22px' }}>
          {error}
        </div>
      )}
      {loadingKind && view.name !== 'player' && (
        <div className="muted" style={{ padding: '0 22px' }}>
          Carregando {loadingKind === 'live' ? 'canais' : loadingKind === 'movie' ? 'filmes' : 'séries'}…
        </div>
      )}

      {(view.name === 'home' ||
        view.name === 'browse' ||
        view.name === 'favorites' ||
        view.name === 'movie' ||
        view.name === 'series' ||
        view.name === 'downloads' ||
        view.name === 'epg' ||
        view.name === 'settings' ||
        view.name === 'player') && (
        <div className={`app-shell${railCollapsed ? ' rail-collapsed' : ''}`}>
          <nav className="home-rail" aria-label="Menu principal">
            <button
              type="button"
              className="home-rail-btn home-rail-toggle"
              title={railCollapsed ? 'Expandir menu' : 'Recolher menu'}
              aria-expanded={!railCollapsed}
              onClick={() => setRailCollapsed((current) => !current)}
            >
              {railCollapsed ? <PanelLeft size={20} /> : <PanelLeftClose size={20} />}
              <span className="home-rail-label">Menu</span>
            </button>
            <div className="home-rail-top">
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'home' ? 'active' : ''}`}
                title="Início"
                onClick={() => startTransition(() => setView({ name: 'home' }))}
              >
                <Home size={20} />
                <span className="home-rail-label">Início</span>
              </button>
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'browse' && view.kind === 'live' ? 'active' : ''}`}
                title={`Ao vivo (${counts.live.toLocaleString('pt-BR')})`}
                onClick={() => openBrowse('live')}
              >
                <Tv size={20} />
                <span className="home-rail-label">Ao vivo</span>
                {counts.live > 0 && <span className="home-rail-count">{formatRailCount(counts.live)}</span>}
              </button>
              <button
                type="button"
                className={`home-rail-btn ${(view.name === 'browse' && view.kind === 'movie') || view.name === 'movie' ? 'active' : ''}`}
                title={`Filmes (${counts.movie.toLocaleString('pt-BR')})`}
                onClick={() => openBrowse('movie')}
              >
                <Clapperboard size={20} />
                <span className="home-rail-label">Filmes</span>
                {counts.movie > 0 && <span className="home-rail-count">{formatRailCount(counts.movie)}</span>}
              </button>
              <button
                type="button"
                className={`home-rail-btn ${(view.name === 'browse' && view.kind === 'series') || view.name === 'series' ? 'active' : ''}`}
                title={`Séries (${counts.series.toLocaleString('pt-BR')})`}
                onClick={() => openBrowse('series')}
              >
                <MonitorPlay size={20} />
                <span className="home-rail-label">Séries</span>
                {counts.series > 0 && <span className="home-rail-count">{formatRailCount(counts.series)}</span>}
              </button>
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'favorites' ? 'active' : ''}`}
                title={`Favoritos (${favorites.length})`}
                onClick={() => startTransition(() => setView({ name: 'favorites' }))}
              >
                <Heart size={20} />
                <span className="home-rail-label">Favoritos</span>
                {favorites.length > 0 && <span className="home-rail-count">{favorites.length}</span>}
              </button>
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'epg' ? 'active' : ''}`}
                title="Programação"
                onClick={() => startTransition(() => setView({ name: 'epg' }))}
              >
                <CalendarDays size={20} />
                <span className="home-rail-label">Programação</span>
              </button>
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'downloads' ? 'active' : ''}`}
                title="Downloads"
                onClick={() => setView({ name: 'downloads' })}
              >
                <Download size={20} />
                <span className="home-rail-label">Downloads</span>
                {downloads.length > 0 && (
                  <span className="home-rail-badge">{downloads.length}</span>
                )}
              </button>
            </div>

            <div className="home-rail-bottom">
              <button
                type="button"
                className={`home-rail-btn ${view.name === 'settings' ? 'active' : ''}`}
                title="Configurações"
                onClick={() => setView({ name: 'settings' })}
              >
                <Settings size={20} />
                <span className="home-rail-label">Configurações</span>
              </button>
              {activeProfile && (
                <button
                  type="button"
                  className="home-rail-btn home-rail-profile"
                  title={`Perfil: ${activeProfile.name}`}
                  onClick={switchProfile}
                >
                  <span className="home-rail-user" style={{ '--profile-color': activeProfile.color } as CSSProperties}>
                    <User size={18} />
                  </span>
                  <span className="home-rail-label">{activeProfile.name}</span>
                </button>
              )}
            </div>
          </nav>

          {/*
            O cartaz fica no shell, e nao dentro de `.app-shell-main`.

            Ele precisa aparecer sobre qualquer tela — inclusive a de Filmes e a
            home — e sobreviver a troca de view. Dentro de `app-shell-main` ele
            nasceria e morreria junto com a tela, e o `position: fixed` do CSS
            resolveria para o container errado. Fora do fluxo de views, o
            unico lugar do JSX onde ele pode ser desmontado e nao volta.
          */}
          <UpdateToast
            toast={updater.toast}
            progress={updater.progress}
            onClose={updater.fechar}
            onInstall={() => void updater.instalar()}
            onOpenReleases={() => void updater.abrirReleases()}
          />

          <div className="app-shell-main">
            {view.name === 'home' && (
              <HomeDiscover
                continueWatching={activeContinueWatching}
                movies={catalogs.movie}
                series={catalogs.series}
                live={catalogs.live}
                playlist={active}
                expiration={active?.xtream?.profile?.expDate}
                onOpen={openContent}
                onToggleFavorite={toggleFav}
                onRemoveContinue={removeContinueWatching}
                favorites={favorites}
              />
            )}

            {view.name === 'epg' && (
              <EpgGuide
                playlist={active}
                channels={catalogs.live}
                epgUpdatedAt={settings.epgUpdatedAt}
                onEpgRefreshed={() => updateSettings({ epgUpdatedAt: Date.now() })}
                onOpen={(channel, list) => {
                  const go = () => setView({ name: 'player', channel, list, fromLive: 'browse' })
                  if (isAdultChannel(channel)) requireAdultAccess(go)
                  else go()
                }}
              />
            )}

            {view.name === 'downloads' && (
              <DownloadsView
                downloads={downloads}
                downloadFolder={settings.downloadFolder}
                onPlay={(channel, list) => {
                  const go = () => {
                    if (channel.kind === 'movie') {
                      setView({ name: 'movie', movie: channel, list })
                    } else {
                      setView({ name: 'player', channel, list, startTime: 0 })
                    }
                  }
                  if (isAdultChannel(channel)) requireAdultAccess(go)
                  else go()
                }}
                onRemove={handleRemoveDownload}
                onPause={handlePauseDownload}
                onResume={handleResumeDownload}
                onRetry={handleStartDownload}
                onChangeFolder={async () => {
                  const res = await window.sturplay?.downloads?.pickFolder?.()
                  if (res?.ok && res.path) updateSettings({ downloadFolder: res.path })
                }}
                onOpenFolder={() => {
                  void window.sturplay?.downloads?.openFolder?.(settings.downloadFolder)
                }}
                onOpenSettings={() => setView({ name: 'settings' })}
              />
            )}

            {view.name === 'favorites' && (
              <FavoritesView
                favorites={favorites}
                catalogs={catalogs}
                continueWatching={activeContinueWatching}
                onOpen={openContent}
                onToggleFavorite={toggleFav}
              />
            )}

            {view.name === 'settings' && (
              <SettingsPage
                settings={settings}
                playlists={profilePlaylists}
                activePlaylistId={active?.id}
                onAddPlaylist={addPlaylist}
                onSelectPlaylist={(id) => {
                  if (id !== active?.id) {
                    catalogOwnerRef.current = null
                    setCatalogs(EMPTY)
                    setServerCategories({ movie: [], series: [] })
                  }
                  setActiveId(id)
                }}
                onRefreshCatalog={() => void refreshServerCatalog()}
                catalogRefreshing={catalogRefreshing}
                onRemovePlaylist={(id) => {
                  setPlaylists((prev) => prev.filter((p) => p.id !== id))
                  // O catálogo ficava residente em quatro Maps + um registro
                  // do IndexedDB pelo resto do processo, para sempre.
                  clearCatalog(id)
                  clearXtreamM3uCache(id)
                  if (activeProfileId) {
                    setProfiles((prev) =>
                      prev.map((profile) =>
                        profile.id === activeProfileId
                          ? { ...profile, playlistIds: profile.playlistIds.filter((playlistId) => playlistId !== id) }
                          : profile,
                      ),
                    )
                  }
                }}
                onUpdatePlaylist={updatePlaylist}
                continueWatching={activeContinueWatching}
                parentalUnlocked={parentalUnlocked}
                onChange={updateSettings}
                onLockAdult={() => setParentalUnlocked(false)}
                onUnlockAdult={() => requireAdultAccess(() => undefined, 'Desbloquear conteúdo adulto')}
                onRefreshEpg={() => void refreshEpg()}
                epgRefreshing={epgRefreshing}
                updaterStatus={updater.status}
                updaterToast={updater.toast}
                updaterChecking={updater.checking}
                updaterProgress={updater.progress}
                onCheckUpdates={() => void updater.checarManual()}
                onInstallUpdate={() => void updater.instalar()}
                onOpenReleases={() => void updater.abrirReleases()}
                hasActivePlaylist={Boolean(active)}
                onRemoveContinueItem={removeContinueWatching}
                onRemoveRecentLive={(channelId) => {
                  const next = loadRecentLiveChannels().filter((channel) => channel.id !== channelId)
                  saveRecentLiveChannels(next)
                  setRecentLiveEpoch((n) => n + 1)
                }}
                onClearAllHistory={() => {
                  setContinueWatching((prev) => prev.filter((item) => item.playlistId !== active?.id))
                  saveRecentLiveChannels([])
                  setRecentLiveEpoch((n) => n + 1)
                }}
                onClearHistoryKind={(kind) => {
                  if (kind === 'live') {
                    saveRecentLiveChannels([])
                    setRecentLiveEpoch((n) => n + 1)
                    return
                  }
                  setContinueWatching((prev) =>
                    prev.filter((item) => item.playlistId !== active?.id || item.channel.kind !== kind),
                  )
                }}
                initialSection={settingsInitialSection}
              />
            )}

            {view.name === 'movie' && active && (
              <div className="vod-detail-page">
                <MovieView
                  playlist={active}
                  movie={view.movie}
                  list={view.list}
                  favorites={favorites}
                  continueWatching={activeContinueWatching}
                  playbackEngine={settings.player}
                  autoStartTime={view.autoPlay ? view.startTime : undefined}
                  autoPlay={view.autoPlay}
                  onBack={() => {
                    const back = vodReturnViewRef.current
                    if (back.name === 'home') startTransition(() => setView({ name: 'home' }))
                    else if (back.name === 'browse' && back.kind === 'movie') {
                      startTransition(() => setView({ name: 'browse', kind: 'movie' }))
                    } else {
                      startTransition(() => setView({ name: 'browse', kind: 'movie' }))
                    }
                  }}
                  onToggleFavorite={toggleFav}
                  onDownloadItem={handleStartDownload}
                  onProgress={(currentTime, duration) => updateProgress(view.movie, currentTime, duration)}
                  onMeta={(patch) => patchCatalogMeta('movie', view.movie.id, patch)}
                  onPlayFull={(channel, startTime) =>
                    setView({ name: 'player', channel, list: view.list, startTime })
                  }
                />
              </div>
            )}

            {view.name === 'series' && active && (
              <div className="vod-detail-page">
                <SeriesView
                  playlist={active}
                  series={view.series}
                  favorites={favorites}
                  continueWatching={activeContinueWatching}
                  playbackEngine={settings.player}
                  autoStartEpisode={view.episode}
                  autoStartList={view.list}
                  autoStartTime={view.autoPlay ? view.startTime : undefined}
                  autoPlay={view.autoPlay}
                  onBack={() => {
                    const back = vodReturnViewRef.current
                    if (back.name === 'home') startTransition(() => setView({ name: 'home' }))
                    else startTransition(() => setView({ name: 'browse', kind: 'series' }))
                  }}
                  onToggleFavorite={toggleFav}
                  onDownloadItem={handleStartDownload}
                  onProgress={(channel, currentTime, duration) =>
                    updateProgress(channel, currentTime, duration)
                  }
                  onMeta={(patch) => patchCatalogMeta('series', view.series.id, patch)}
                  onPlayFull={(channel, list, startTime) =>
                    setView({ name: 'player', channel, list, fromSeries: view.series, startTime })
                  }
                />
              </div>
            )}

            {parkedBrowseKind && (
              <Browse
                key={parkedBrowseKind}
                kind={parkedBrowseKind}
                playlist={active}
                channels={catalogs[parkedBrowseKind]}
                serverCategories={
                  parkedBrowseKind === 'movie' || parkedBrowseKind === 'series'
                    ? serverCategories[parkedBrowseKind]
                    : []
                }
                groupLoading={groupLoading || loadingKind === parkedBrowseKind}
                favorites={favorites}
                continueWatching={activeContinueWatching}
                selectedGroup={selectedGroups[parkedBrowseKind] || 'Todos'}
                onSelectGroup={(group) => {
                  const apply = () => setSelectedGroups((prev) => ({ ...prev, [parkedBrowseKind]: group }))
                  if (isAdultGroup(group)) requireAdultAccess(apply, 'Categoria adulta')
                  else apply()
                }}
                parentalLocked={Boolean(settings.parentalPin) && !parentalUnlocked}
                onUnlockAdult={() => requireAdultAccess(() => undefined, 'Desbloquear conteúdo adulto')}
                savedScroll={savedScroll[parkedBrowseKind] || { channels: 0, groups: 0 }}
                onSaveScroll={(scroll) => setSavedScroll((prev) => ({ ...prev, [parkedBrowseKind]: scroll }))}
                query={parkedBrowseKind ? browseQuery[parkedBrowseKind] || '' : ''}
                onQueryChange={(next) => {
                  if (!parkedBrowseKind) return
                  setBrowseQuery((prev) => (prev[parkedBrowseKind] === next ? prev : { ...prev, [parkedBrowseKind]: next }))
                }}
                sortMode={sortModes[parkedBrowseKind] || 'default'}
                onSortMode={(mode) => setSortModes((prev) => ({ ...prev, [parkedBrowseKind]: mode }))}
                onToggleFavorite={toggleFav}
                onRemoveContinue={removeContinueWatching}
                onOpen={openContent}
                onDownloadItem={handleStartDownload}
                recentLiveEpoch={recentLiveEpoch}
                returnToId={returnToId}
                onReturned={() => setReturnToId(null)}
                suspendLivePreview={view.name === 'player'}
                playbackEngine={settings.player}
              />
            )}
          </div>
        </div>
      )}

      {view.name === 'player' &&
        !(
          settings.player === 'internal' &&
          (view.channel.kind === 'movie' ||
            (view.channel.kind === 'series' && view.fromSeries))
        ) && (
        <div className="details-overlay details-overlay-player">
        <Player
          channel={view.channel}
          list={view.list}
          playlist={active}
          favorite={favorites.includes(view.channel.id)}
          favorites={favorites}
          progress={continueWatching.find(
            (item) => item.playlistId === active?.id && item.channel.id === view.channel.id,
          )}
          startTime={view.startTime}
          autoFullscreen={view.autoFullscreen}
          playbackEngine={settings.player}
          onFav={() => toggleFav(view.channel.id)}
          onToggleFavorite={toggleFav}
          onProgress={(currentTime, duration) => updateProgress(view.channel, currentTime, duration)}
          onChange={(channel) => {
            const go = () =>
              setView({
                name: 'player',
                channel,
                list: view.list,
                fromSeries: view.fromSeries,
                fromLive: view.fromLive,
              })
            if (isAdultChannel(channel)) requireAdultAccess(go)
            else go()
          }}
          onBack={() => {
            exitNativePlayback()
            void window.sturplay?.nativePlayer?.stopExternal?.()
            if (document.fullscreenElement) {
              void document.exitFullscreen().catch(() => {})
            }
            const go = (next: View) => flushSync(() => setView(next))
            if (view.fromSeries) {
              go({ name: 'series', series: view.fromSeries })
            } else if (view.channel.kind === 'series') {
              const actualSeriesId = view.channel.seriesId || view.channel.streamId
              const foundSeries = catalogs.series.find(
                (s) =>
                  (actualSeriesId &&
                    (s.streamId === actualSeriesId || s.id === `series-${actualSeriesId}` || s.id === actualSeriesId)) ||
                  (view.channel.seriesName && s.name === view.channel.seriesName),
              )
              if (foundSeries) {
                go({ name: 'series', series: foundSeries })
              } else {
                go({
                  name: 'series',
                  series: {
                    ...view.channel,
                    id: view.channel.seriesId ? `series-${view.channel.seriesId}` : view.channel.id,
                    name: view.channel.seriesName || view.channel.name,
                    logo: view.channel.seriesLogo || view.channel.logo,
                    streamId: actualSeriesId,
                  },
                })
              }
            } else if (view.channel.kind === 'movie') {
              go({ name: 'movie', movie: view.channel, list: view.list })
            } else if (view.fromLive === 'browse') {
              go({ name: 'browse', kind: 'live' })
            } else {
              go({ name: 'home' })
            }
          }}
        />
        </div>
      )}

      {parentalPrompt && settings.parentalPin && (
        <ParentalPinModal
          title={parentalPrompt.title || 'Conteúdo adulto'}
          expectedPin={settings.parentalPin}
          onCancel={() => setParentalPrompt(null)}
          onSuccess={() => {
            const next = parentalPrompt.onSuccess
            setParentalPrompt(null)
            next()
          }}
        />
      )}
    </div>
  )
}

function isFootballChannel(channel: Channel): boolean {
  const hay = `${channel.name || ''} ${channel.group || ''}`
  return /JOGOS?|AREA DE JOGOS|FUTEBOL|FOOTBALL|SOCCER|PREMIERE|SPORTV|ESPN|DAZN|BANDSPORTS|FOX\s*SPORTS|TNT\s*SPORTS|EUROSPORT|NBA|UFC|COMBATE|SPORT\s*TV|CANAL\s*GOAT|CRAZY\s*FOX|ONE\s*FOOTBALL|ESPORTES?\s*PPV|ESPORTES|BAND\s*SPORTS|DISNEY\s*SPORTS|PARAMOUNT\s*SPORTS|NOS\s*SO|GE\s*TV|SPORTVN|COMBATE|FIGHT|BOXE|MMA|F1|FORMULA|MOTORSPORT|OLYMPIC|OLIMPI/i.test(
    hay,
  )
}

function isSportsLiveGroup(groupName: string): boolean {
  const g = normalizeForMatching(groupName)
  return /JOGOS?|AREA DE JOGOS|ESPORTE|SPORT|PPV|FUTEBOL|PREMIERE|CHAMPIONS|NBA|UFC|MMA|F1|FORMULA/.test(g)
}

/** Confronto no texto do EPG: "Fluminense x Palmeiras", "SEA vs NE", etc. */
function hasMatchupInText(t: string): boolean {
  if (/\bVS\b|\bVERSUS\b|\bCONTRA\b/.test(t)) return true
  return /(?:[A-Z0-9]{2,}\s+){0,3}[A-Z0-9]{2,}\s+X\s+[A-Z0-9]{2,}(?:\s+[A-Z0-9]{2,}){0,3}/.test(t)
}

/** Chamada institucional / promo — evita card lixo tipo "Com o PREMIERE dá jogo!". */
function isPromoEpgText(t: string): boolean {
  return /DA JOGO|ASSISTA JA|ASSISTA AGORA|PROMOCAO|COMERCIAL|CHAMADA|TRAILER|INSTITUCIONAL|COM O PREMIERE|SO NO PREMIERE|CONFIRA|NAO PERCA|PROGRAMACAO DO CANAL/.test(
    t,
  )
}

/** Detecção ampliada: VT, replay, TIME x TIME, confronto + termos de esporte no EPG. */
function isSportsEpgText(text?: string): boolean {
  const raw = decodeEpgText(text)
  if (!raw) return false
  const t = normalizeForMatching(raw)
  if (!t || isPromoEpgText(t)) return false
  if (/\bVT\b|\bREPLAY\b|\bREPRISE\b|\bMELHORES MOMENTOS\b|\bJOGO COMPLETO\b|\bRESUMO DO JOGO\b|\bAO VIVO\b/.test(t)) {
    return true
  }
  if (hasMatchupInText(t)) return true
  return /FUTEBOL|FOOTBALL|SOCCER|JOGO|PARTIDA|CAMPEONATO|BRASILEIRAO|LIBERTADORES|COPA DO|COPA |PREMIERE|SPORTV|ESPN|NBA|NFL|NHL|UFC|MMA|BOXE|LUTA|FORMULA|F1 |TENIS|VOLEI|HANDEBOL|BASQUETE|OLIMPI|CLASSICO|SUPERCOPA|CHAMPIONS|EUROPA LEAGUE|MUNDIAL|SELECAO| GOLS? |ESTADIO|ARENA|TORNEIO|LIGA |SERIE A|SERIE B|PLAYOFF|GRAND PRIX|MOTOG|NASCAR|SURF|SKATE|RODADA|PLACAR|DERBY|WIMBLEDON|WORLD CUP|COPA DO MUNDO|SUPER BOWL|E PRIX|EPRIX/.test(
    t,
  )
}

function sportsCatchScore(title: string, live: boolean): number {
  const t = normalizeForMatching(title)
  let score = 0
  if (/\bVT\b|\bREPLAY\b|\bREPRISE\b/.test(t)) score += 48
  if (hasMatchupInText(t)) score += 44
  if (live) score += 22
  if (/BRASILEIRAO|LIBERTADORES|CHAMPIONS|COPA|PREMIERE|UFC|NBA|NFL|FINAL|CLASSICO|RODADA|WIMBLEDON|WORLD CUP/.test(t)) {
    score += 18
  }
  if (/AO VIVO|LIVE/.test(t)) score += 10
  if (title.length >= 10 && title.length <= 90) score += 6
  return score
}

function parseEpgInstant(value?: string): number {
  if (!value) return 0
  const raw = String(value).trim()
  if (!raw) return 0
  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw)
    return num < 1e12 ? num * 1000 : num
  }
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (compact) {
    const ms = Date.UTC(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
    )
    // Xtream costuma mandar horário do painel (BR) sem fuso — interpreta como local
    const local = new Date(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
    ).getTime()
    return Number.isFinite(local) ? local : ms
  }
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (parts) {
    return new Date(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6] || 0),
    ).getTime()
  }
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const spaced = Date.parse(normalized)
  if (Number.isFinite(spaced)) return spaced
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatEpgClock(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function formatEpgWindow(startMs: number, endMs: number): string {
  const a = formatEpgClock(startMs)
  const b = formatEpgClock(endMs)
  if (a && b) return `${a}–${b}`
  return a || b
}

function formatClockDate(now: Date) {
  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  })
  return { time, date }
}

function formatRemainingWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatRailCount(value: number): string {
  if (value >= 10_000) {
    const k = value / 1000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return value.toLocaleString('pt-BR')
}

function toLocalMediaUrl(filePath: string): string {
  if (!filePath) return filePath
  if (/^https?:\/\//i.test(filePath) || filePath.startsWith('file://')) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return `file://${normalized}`
  return `file:///${normalized}`
}

function movieRatingValue(channel: Channel): number {
  return parseFloat(String(channel.rating || '0').replace(',', '.')) || 0
}

/** Arrastar horizontal com o mouse (click + hold + puxar). Clique curto ainda abre o canal. */
function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [node, setNode] = useState<T | null>(null)

  const setRef = useCallback((el: T | null) => {
    ref.current = el
    setNode((prev) => (prev === el ? prev : el))
  }, [])

  useEffect(() => {
    const el = node
    if (!el) return

    let active = false
    let dragging = false
    let startX = 0
    let startScroll = 0
    let pointerId: number | null = null
    let suppressClick = false

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      active = true
      dragging = false
      suppressClick = false
      pointerId = event.pointerId
      startX = event.clientX
      startScroll = el.scrollLeft
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!active || pointerId !== event.pointerId) return
      const dx = event.clientX - startX
      // Só vira arraste depois de um movimento claro (clique continua funcionando)
      if (!dragging && Math.abs(dx) > 14) {
        dragging = true
        suppressClick = true
        el.classList.add('is-dragging')
        try {
          el.setPointerCapture(event.pointerId)
        } catch {
          // ignore
        }
      }
      if (!dragging) return
      el.scrollLeft = startScroll - dx
    }

    const endDrag = (event: PointerEvent) => {
      if (!active) return
      if (pointerId !== null && event.pointerId !== pointerId) return
      const wasDragging = dragging
      active = false
      pointerId = null
      dragging = false
      el.classList.remove('is-dragging')
      if (wasDragging) {
        try {
          el.releasePointerCapture(event.pointerId)
        } catch {
          // ignore
        }
        window.setTimeout(() => {
          suppressClick = false
        }, 120)
      } else {
        suppressClick = false
      }
    }

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressClick = false
    }

    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    el.addEventListener('click', onClickCapture, true)

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      el.removeEventListener('click', onClickCapture, true)
      el.classList.remove('is-dragging')
    }
  }, [node])

  return { ref: setRef }
}

function HomePosterRail({
  title,
  items,
  onOpen,
}: {
  title: string
  items: Channel[]
  onOpen: (channel: Channel, list: Channel[]) => void
}) {
  const drag = useDragScroll<HTMLDivElement>()
  if (items.length === 0) return null

  return (
    <section className="home-section home-section-rec">
      <div className="home-section-head">
        <h2>{title}</h2>
      </div>
      <div className="home-rec-row-wrap">
        <div className="home-rec-row" ref={drag.ref}>
          {items.map((channel) => {
            const rating = movieRatingValue(channel)
            return (
              // `div` com `role="button"`, e nao `<button>`: o card carrega o
              // play e a insignia dentro, e botao nao se aninha em botao. Mesmo
              // padrao do `home-continue-poster`.
              <div
                key={channel.id}
                className="home-rec-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(channel, items)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpen(channel, items)
                  }
                }}
              >
                <div className="home-rec-poster">
                  <Cover src={channel.logo} />

                  {/*
                   * O play aparece no hover, por cima da capa, com scrim
                   * translucido — um fundo opaco aqui apagaria a imagem, que foi
                   * exatamente o defeito do "Continuar assistindo".
                   */}
                  <span className="home-rec-play" aria-hidden>
                    <Play size={18} fill="currentColor" />
                  </span>

                  {rating > 0 && (
                    <span className="home-rec-rating">
                      <Star size={10} fill="#fb7185" color="#fb7185" strokeWidth={0} />
                      {rating.toFixed(1)}
                    </span>
                  )}
                </div>
                <span className="home-rec-title" title={channel.name}>
                  {titleWithYear(channel.name, channel.releasedate)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function HomeDiscover({
  continueWatching,
  movies,
  series,
  live,
  playlist,
  favorites,
  expiration,
  onOpen,
  onToggleFavorite,
  onRemoveContinue,
}: {
  continueWatching: ContinueWatching[]
  movies: Channel[]
  series: Channel[]
  live: Channel[]
  playlist: Playlist | null
  favorites: string[]
  expiration?: string | number | null
  onOpen: (channel: Channel, list: Channel[], startTime?: number) => void
  onToggleFavorite: (id: string) => void
  onRemoveContinue: (channelId: string, seriesId?: string) => void
}) {
  const [now, setNow] = useState(() => new Date())
  const [footballEpg, setFootballEpg] = useState<Record<string, ShortEpg[]>>({})
  const [compactLayout, setCompactLayout] = useState(
    () => document.documentElement.dataset.compact === 'true',
  )
  const homeScrollRef = useRef<HTMLDivElement>(null)
  const didScrollBottomRef = useRef(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const syncCompact = () => setCompactLayout(document.documentElement.dataset.compact === 'true')
    const observer = new MutationObserver(syncCompact)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-compact'] })
    window.addEventListener('resize', syncCompact)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncCompact)
    }
  }, [])

  const continueItems = useMemo(
    () =>
      continueWatching
        .filter((item) => item.channel.kind === 'movie' || item.channel.kind === 'series')
        .slice(0, 14),
    [continueWatching],
  )

  const recommendationRows = useMemo(
    () => buildHomeRecommendationRows(continueWatching, movies, series),
    [continueWatching, movies, series],
  )

  // Nova ordem a cada montagem (entrar no app / voltar ao Início após remount)
  const [heroSessionSeed] = useState(() => Date.now() ^ (Math.random() * 1e9))
  const [featuredIndex, setFeaturedIndex] = useState(0)
  const [heroPaused, setHeroPaused] = useState(false)
  const [featuredSlides, setFeaturedSlides] = useState<Channel[]>([])
  const heroLockedRef = useRef(false)

  useEffect(() => {
    if (heroLockedRef.current) return
    const pool = matchHeroFeaturedMovies(movies)
    if (pool.length === 0) {
      // Ainda carregando, ou catálogo sem TREND/UHD
      if (movies.length < 30) return
      heroLockedRef.current = true
      setFeaturedSlides([])
      return
    }
    // Espera mais títulos TREND/UHD enquanto o catálogo ainda cresce
    if (pool.length < 5 && movies.length < 80) return

    const shuffled = [...pool]
    let state = heroSessionSeed >>> 0 || 1
    const rand = () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0
      return state / 0x100000000
    }
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    const slides = shuffled.slice(0, Math.min(8, shuffled.length))
    setFeaturedSlides(slides)
    setFeaturedIndex(0)
    heroLockedRef.current = true
  }, [movies, heroSessionSeed])

  const featured = featuredSlides[featuredIndex % Math.max(featuredSlides.length, 1)] || null
  const featuredQuality = featured ? heroQualityLabel(featured) : null

  useEffect(() => {
    if (featuredSlides.length < 2 || heroPaused) return
    const timer = window.setInterval(() => {
      setFeaturedIndex((current) => (current + 1) % featuredSlides.length)
    }, 6500)
    return () => window.clearInterval(timer)
  }, [featuredSlides, heroPaused])

  useEffect(() => {
    if (featuredSlides.length === 0) return
    prefetchCovers(featuredSlides.map((item) => item.logo).filter(Boolean) as string[])
  }, [featuredSlides])

  const featuredKey = featuredSlides.map((item) => item.id).join('|')
  useEffect(() => {
    if (!playlist?.xtream || !featuredKey) return
    let cancelled = false
    const slides = featuredSlides
    void (async () => {
      for (const slide of slides) {
        if (cancelled || !slide.streamId) continue
        if (String(slide.plot || '').replace(/\s+/g, ' ').trim().length >= 20) continue
        try {
          const details = await loadVodInfo(playlist, slide.streamId)
          if (cancelled || !details.plot) continue
          setFeaturedSlides((prev) =>
            prev.map((item) => (item.id === slide.id ? { ...item, plot: details.plot } : item)),
          )
        } catch {
          // sinopse pode faltar no painel
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // slides travam depois do primeiro fill; featuredKey evita loop ao gravar o plot
  }, [playlist, featuredKey])

  const footballChannels = useMemo(() => {
    const sports = live.filter(isFootballChannel)
    const extra = live.filter(
      (c) =>
        !sports.some((s) => s.id === c.id) &&
        /SPORT|ESPORT|PREMIERE|COMBATE|DAZN|ESPN|UFC|NBA|FUTEBOL|FOOTBALL|GE\s*TV|BAND\s*SPORT|NOS\s*SO|PPV|TNT\s*SPORT|FOX\s*SPORT/i.test(
          `${c.name || ''} ${c.group || ''}`,
        ),
    )
    const merged = [...sports, ...extra]
    // Prioriza Premiere / SporTV / ESPN (onde costuma ter jogo/VT no EPG)
    const ranked = merged
      .filter((c) => c.streamId)
      .sort((a, b) => {
        const weight = (c: Channel) => {
          const hay = `${c.group || ''} ${c.name || ''}`.toUpperCase()
          let w = 0
          if (/PREMIERE/.test(hay)) w += 40
          if (/SPORTV|ESPN|DAZN|BAND\s*SPORT|GE\s*TV/.test(hay)) w += 28
          if (/ESPORT|FUTEBOL|PPV/.test(hay)) w += 12
          if (c.logo) w += 8
          return w
        }
        const dw = weight(b) - weight(a)
        if (dw !== 0) return dw
        return String(a.name).localeCompare(String(b.name), 'pt-BR')
      })
    if (ranked.length > 0) return ranked.slice(0, 40)
    return live.filter((c) => c.streamId).slice(0, 16)
  }, [live])

  // Trava a lista de scan pra o EPG não reiniciar enquanto o catálogo cresce
  const scanChannelsRef = useRef<Channel[]>([])
  const scanPlaylistRef = useRef<string | null>(null)
  const footballScanChannels = useMemo(() => {
    const playlistKey = playlist?.id || 'none'
    if (scanPlaylistRef.current !== playlistKey) {
      scanPlaylistRef.current = playlistKey
      scanChannelsRef.current = []
    }
    if (scanChannelsRef.current.length >= 12) return scanChannelsRef.current
    if (footballChannels.length >= 10 || live.length > 400) {
      scanChannelsRef.current = footballChannels
    }
    return scanChannelsRef.current.length > 0 ? scanChannelsRef.current : footballChannels
  }, [footballChannels, live.length, playlist?.id])

  useEffect(() => {
    if (!playlist || playlist.kind !== 'xtream' || footballScanChannels.length === 0) {
      setFootballEpg({})
      return
    }
    let cancelled = false
    const targets = footballScanChannels.filter((c) => c.streamId).slice(0, 36)

    void (async () => {
      const next: Record<string, ShortEpg[]> = {}
      for (let i = 0; i < targets.length; i += 4) {
        if (cancelled) return
        const batch = targets.slice(i, i + 4)
        const results = await Promise.all(
          batch.map(async (channel) => {
            try {
              const rows = await loadShortEpgList(playlist, String(channel.streamId), 6)
              return [channel.id, rows] as const
            } catch {
              return [channel.id, [] as ShortEpg[]] as const
            }
          }),
        )
        for (const [id, rows] of results) next[id] = rows
        // Atualiza parcial pra os horários aparecerem sem esperar o lote inteiro
        if (!cancelled) setFootballEpg({ ...next })
      }
      if (!cancelled) setFootballEpg({ ...next })
    })()

    return () => {
      cancelled = true
    }
  }, [playlist, footballScanChannels])

  type FootballCard = {
    key: string
    channel: Channel
    title: string
    meta: string
    cover?: string
    live: boolean
    startMs: number
    endMs: number
    score: number
  }

  const footballCardsFresh = useMemo(() => {
    const nowMs = now.getTime()
    const liveNow: FootballCard[] = []
    const upcoming: FootballCard[] = []
    const seenTitles = new Set<string>()

    const pushUnique = (bucket: FootballCard[], card: FootballCard) => {
      const norm = normalizeForMatching(card.title)
      if (norm && seenTitles.has(norm)) return
      if (norm) seenTitles.add(norm)
      bucket.push(card)
    }

    for (const channel of footballScanChannels) {
      const rows = footballEpg[channel.id] || []
      // Sem EPG = não entra
      if (rows.length === 0) continue

      for (const row of rows) {
        const title = decodeEpgText(row.title)
        const desc = decodeEpgText(row.description)
        if (!title && !desc) continue
        if (!isSportsEpgText(title) && !isSportsEpgText(desc)) continue

        const startMs = parseEpgInstant(row.start)
        let endMs = parseEpgInstant(row.end)
        if (startMs && !endMs) endMs = startMs + 2 * 60 * 60 * 1000
        if (!startMs && !endMs) endMs = nowMs + 90 * 60 * 1000

        const cover = channel.logo
        const channelLabel = channel.name || channel.group || 'Ao vivo'
        const timeLabel = formatEpgWindow(startMs, endMs)
        const meta = timeLabel ? `${timeLabel} · ${channelLabel}` : channelLabel
        const titleNorm = normalizeForMatching(title)
        const descNorm = normalizeForMatching(desc)
        const preferDesc =
          Boolean(desc) &&
          (!title ||
            (!hasMatchupInText(titleNorm) &&
              !/\bVT\b/.test(titleNorm) &&
              (hasMatchupInText(descNorm) || /\bVT\b/.test(descNorm))))
        const displayTitle = preferDesc
          ? desc.split(/[.\n]/)[0]!.trim().slice(0, 90) || title || channel.name
          : title || desc.split(/[.\n]/)[0]!.trim().slice(0, 90) || channel.name
        const scoreBase = `${displayTitle} ${desc}`

        if (startMs > nowMs + 60_000) {
          pushUnique(upcoming, {
            key: `${channel.id}-${startMs}`,
            channel,
            title: displayTitle,
            meta,
            cover,
            live: false,
            startMs,
            endMs: endMs || startMs + 2 * 60 * 60 * 1000,
            score: sportsCatchScore(scoreBase, false),
          })
        } else if (!endMs || endMs > nowMs) {
          pushUnique(liveNow, {
            key: `${channel.id}-live-${startMs || displayTitle}`,
            channel,
            title: displayTitle,
            meta,
            cover,
            live: true,
            startMs: startMs || 0,
            endMs: endMs || nowMs + 90 * 60 * 1000,
            score: sportsCatchScore(scoreBase, true),
          })
          break
        }
      }
    }

    liveNow.sort((a, b) => b.score - a.score || a.startMs - b.startMs || a.channel.id.localeCompare(b.channel.id))
    upcoming.sort((a, b) => a.startMs - b.startMs || b.score - a.score)
    return [...liveNow, ...upcoming].slice(0, 12)
  }, [footballScanChannels, footballEpg, now])

  // Mantém o card até o fim do horário do EPG
  const [footballCards, setFootballCards] = useState<FootballCard[]>([])
  useEffect(() => {
    const nowMs = now.getTime()
    setFootballCards((prev) => {
      const stillOn = prev.filter((card) => {
        if (card.live) return card.endMs > nowMs
        return card.startMs > nowMs - 60_000
      })
      const byChannel = new Map(stillOn.map((c) => [c.channel.id, c]))
      for (const card of footballCardsFresh) {
        const existing = byChannel.get(card.channel.id)
        if (!existing) {
          byChannel.set(card.channel.id, card)
          continue
        }
        // Mesmo canal: só troca se o programa do EPG mudou de verdade
        if (existing.live && existing.endMs > nowMs && card.startMs === existing.startMs) {
          continue
        }
        if (card.startMs !== existing.startMs || card.title !== existing.title) {
          byChannel.set(card.channel.id, card)
        }
      }
      const merged = [...byChannel.values()]
      const livePart = merged.filter((c) => c.live && c.endMs > nowMs)
      const soonPart = merged.filter((c) => !c.live)
      livePart.sort((a, b) => b.score - a.score || a.startMs - b.startMs)
      soonPart.sort((a, b) => a.startMs - b.startMs)
      const next = [...livePart, ...soonPart].slice(0, 12)
      const sig = (rows: FootballCard[]) => rows.map((r) => `${r.channel.id}|${r.title}|${r.endMs}|${r.live}`).join('~')
      return sig(next) === sig(prev) ? prev : next
    })
  }, [footballCardsFresh, now])

  useEffect(() => {
    if (compactLayout) {
      didScrollBottomRef.current = false
      if (homeScrollRef.current) homeScrollRef.current.scrollTop = 0
      return
    }

    const root = homeScrollRef.current
    if (!root) return

    const scrollToBottom = () => {
      const max = root.scrollHeight - root.clientHeight
      if (max <= 0) return false
      root.scrollTop = max
      return true
    }

    // Ao abrir o Início, começa embaixo (futebol / continuar)
    const run = () => {
      if (scrollToBottom()) didScrollBottomRef.current = true
    }

    run()
    const t1 = window.setTimeout(run, 80)
    const t2 = window.setTimeout(run, 320)
    const t3 = window.setTimeout(run, 900)
    const t4 = window.setTimeout(run, 1600)

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      if (!didScrollBottomRef.current) run()
      else {
        // Reajusta uma vez quando o layout estabiliza depois do primeiro scroll
        const max = root.scrollHeight - root.clientHeight
        if (Math.abs(root.scrollTop - max) < 80) root.scrollTop = max
      }
    }) : null
    ro?.observe(root)

    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
      window.clearTimeout(t4)
      ro?.disconnect()
    }
  }, [compactLayout, footballCards.length, continueItems.length, featuredSlides.length])

  const clock = formatClockDate(now)
  const expirationLabel = formatExpiration(expiration)

  return (
    <div className="home-main home-discover" ref={homeScrollRef}>
      {featured && featuredSlides.length > 0 && (
        <section
          className="home-hero"
          onMouseEnter={() => setHeroPaused(true)}
          onMouseLeave={() => setHeroPaused(false)}
        >
          {featuredSlides.map((slide, index) => (
            <div
              key={slide.id}
              className={`home-hero-slide${index === featuredIndex % featuredSlides.length ? ' is-active' : ''}`}
              aria-hidden={index !== featuredIndex % featuredSlides.length}
            >
              <div className="home-hero-bg">
                <Cover src={slide.logo} />
              </div>
            </div>
          ))}
          <div className="home-hero-brand">
            <div className="brand brand-in-content">
              <img className="brand-mark" src={hamster} alt="" />
              ST PLAY
            </div>
          </div>
          <div className="home-hero-content">
            <div className="home-hero-badges">
              <span className="home-hero-badge">Featured</span>
              {featuredQuality && <span className="home-hero-badge muted-badge">{featuredQuality}</span>}
            </div>
            <h2 key={featured.id} title={featured.name}>
              {titleWithYear(featured.name, featured.releasedate)}
            </h2>
            {featured.plot ? (
              <p className="home-hero-plot">{featured.plot}</p>
            ) : (
              <p>{featured.group || 'Filme'}</p>
            )}
            <div className="home-hero-actions">
              <button type="button" className="home-hero-play" onClick={() => onOpen(featured, featuredSlides)}>
                <Play size={16} fill="currentColor" />
                Assistir
              </button>
              <button
                type="button"
                className="home-hero-ghost"
                onClick={() => onToggleFavorite(featured.id)}
              >
                <Heart size={15} fill={favorites.includes(featured.id) ? 'currentColor' : 'none'} />
                {favorites.includes(featured.id) ? 'Favorito' : 'Favoritar'}
              </button>
              <button type="button" className="home-hero-ghost" onClick={() => onOpen(featured, featuredSlides)}>
                Mais info
              </button>
            </div>
          </div>
          <div className="home-hero-bottom-right">
            <div className="home-top-meta" aria-label="Expiração e horário">
              <div className="home-exp">
                <span>exp</span>
                <strong>{expirationLabel}</strong>
              </div>
              <div className="home-clock">
                <strong>{clock.time}</strong>
                <span>{clock.date}</span>
              </div>
            </div>
            {featuredSlides.length > 1 && (
              <div className="home-hero-dots" role="tablist" aria-label="Destaques">
                {featuredSlides.map((slide, index) => (
                  <button
                    key={slide.id}
                    type="button"
                    role="tab"
                    aria-selected={index === featuredIndex % featuredSlides.length}
                    className={`home-hero-dot${index === featuredIndex % featuredSlides.length ? ' is-active' : ''}`}
                    onClick={() => setFeaturedIndex(index)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {recommendationRows.map((row) => (
        <HomePosterRail key={row.title} title={row.title} items={row.items} onOpen={onOpen} />
      ))}

      {!(featured && featuredSlides.length > 0) && (
        <div className="home-top-meta home-top-meta-fallback" aria-label="Expiração e horário">
          <div className="home-exp">
            <span>exp</span>
            <strong>{expirationLabel}</strong>
          </div>
          <div className="home-clock">
            <strong>{clock.time}</strong>
            <span>{clock.date}</span>
          </div>
        </div>
      )}

      {continueItems.length > 0 && (
        <section className="home-section">
          <div className="home-section-head">
            <h2>Continuar assistindo</h2>
          </div>
          <div className="home-continue-row">
            {continueItems.map((item) => {
              const channel = item.channel
              const title = item.seriesName || channel.seriesName || channel.name
              const logo = item.seriesLogo || channel.seriesLogo || channel.logo
              const kindLabel =
                channel.kind === 'live' ? 'Ao vivo' : channel.kind === 'series' ? 'Série' : 'Filme'
              const progress =
                item.duration > 0 ? Math.min(100, (item.currentTime / item.duration) * 100) : 0
              const leftLabel =
                channel.kind !== 'live' &&
                item.duration > item.currentTime &&
                item.duration > 0
                  ? `${formatRemainingWatch(item.duration - item.currentTime)} restantes`
                  : null
              const quality = isUhd4kChannel(channel) ? '4K' : null
              return (
                <div
                  key={`${item.playlistId}-${channel.id}-${item.seriesId || ''}`}
                  className="home-continue-card home-continue-wide"
                >
                  <div
                    className="home-continue-poster"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(channel, [channel])}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpen(channel, [channel])
                      }
                    }}
                  >
                    <Cover src={logo} />
                    {quality && <span className="home-continue-badge">{quality}</span>}
                    <button
                      type="button"
                      className="home-continue-remove"
                      title="Remover de Continuar assistindo"
                      aria-label={`Remover ${title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveContinue(channel.id, item.seriesId || channel.seriesId)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                    {progress > 2 && (
                      <div className="home-continue-progress">
                        <div style={{ width: `${progress}%` }} />
                      </div>
                    )}
                    <span className="home-continue-play" aria-hidden>
                      <Play size={18} fill="currentColor" />
                    </span>
                  </div>
                  <button
                    type="button"
                    className="home-continue-meta"
                    onClick={() => onOpen(channel, [channel])}
                  >
                    <strong className="home-continue-title" title={title}>
                      {title}
                    </strong>
                    <span className="home-continue-ep">
                      {kindLabel}
                      {leftLabel ? ` · ${leftLabel}` : ''}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

    </div>
  )
}

function Setup({
  playlists,
  activeId,
  onAdd,
  onSelect,
  onRemove,
  onUpdate,
  embedded = false,
}: {
  playlists: Playlist[]
  activeId?: string
  onAdd: (playlist: Playlist) => void
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onUpdate: (playlist: Playlist) => void
  embedded?: boolean
}) {
  // Xtream Codes primeiro: e o formato que o app realmente usa (o catalogo vem
// por `player_api.php`, nao pela playlist). M3U/URL e a alternativa para quem
// so tem um link de arquivo. A ordem segue a mesma do segmented control abaixo.
const [tab, setTab] = useState<'m3u' | 'xtream'>('xtream')
  const [name, setName] = useState('Minha lista')
  const [m3uUrl, setM3uUrl] = useState('')
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Playlist | null>(null)
  const [editName, setEditName] = useState('')
  const [editEndpoint, setEditEndpoint] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [showEditPassword, setShowEditPassword] = useState(false)
  const [deletingPlaylist, setDeletingPlaylist] = useState<Playlist | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function openEditor(playlist: Playlist) {
    setEditing(playlist)
    setEditName(playlist.name)
    setEditEndpoint(playlist.kind === 'm3u' ? playlist.m3uUrl ?? '' : playlist.xtream?.host ?? '')
    setEditUsername(playlist.xtream?.username ?? '')
    setEditPassword(playlist.xtream?.password ?? '')
    setShowEditPassword(false)
  }
  function closeEditor() {
    setEditing(null)
    setShowEditPassword(false)
  }

  function saveEdit() {
    if (!editing || !editName.trim() || !editEndpoint.trim()) return
    const updated: Playlist =
      editing.kind === 'm3u'
        ? {
            ...editing,
            name: editName.trim(),
            m3uUrl: editEndpoint.trim(),
            m3uText: undefined,
          }
        : {
            ...editing,
            name: editName.trim(),
            xtream: {
              host: editEndpoint.trim(),
              username: editUsername.trim(),
              password: editPassword,
              profile: undefined,
            },
          }
    onUpdate(updated)
    closeEditor()
  }

  async function saveM3u() {
    if (!m3uUrl.trim()) {
      setError('Informe a URL do M3U')
      return
    }
    onAdd({ id: uid(), name, kind: 'm3u', m3uUrl: m3uUrl.trim() })
  }

  async function saveXtream() {
    setBusy(true)
    setError(null)
    const playlist: Playlist = {
      id: uid(),
      name,
      kind: 'xtream',
      xtream: { host: host.trim(), username: username.trim(), password },
    }
    try {
      const { profile } = await testXtream(playlist)
      onAdd({ ...playlist, xtream: { ...playlist.xtream!, profile } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível conectar')
    } finally {
      setBusy(false)
    }
  }

  async function onFile(file: File) {
    const text = await file.text()
    onAdd({ id: uid(), name: name || file.name, kind: 'm3u', m3uText: text })
  }

  return (
    <div className={`setup setup-page${embedded ? ' setup-embedded' : ''}`}>
      {!embedded && <ShellBrand />}
      {!embedded && (
        <div className="setup-page-head">
          <h1>Playlist</h1>
          <p className="muted">Adicione e gerencie suas listas M3U ou Xtream</p>
        </div>
      )}

      <div className="playlist-layout">
        <section className="playlist-panel">
          <div className="playlist-panel-kicker">Nova lista</div>
          <div className="playlist-segment" role="tablist" aria-label="Tipo de lista">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'xtream'}
              className={tab === 'xtream' ? 'active' : ''}
              onClick={() => setTab('xtream')}
            >
              <Server size={15} strokeWidth={2.2} />
              Xtream Codes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'm3u'}
              className={tab === 'm3u' ? 'active' : ''}
              onClick={() => setTab('m3u')}
            >
              <Link2 size={15} strokeWidth={2.2} />
              M3U / URL
            </button>
          </div>

          <div className="field">
            <label>Nome da lista</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Casa, Trabalho…" />
          </div>

          {tab === 'm3u' ? (
            <>
              <div className="field">
                <label>URL da lista M3U</label>
                <input
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  placeholder="http://servidor/get.php?…"
                />
              </div>
              <div className="playlist-actions">
                <button type="button" className="primary playlist-btn-main" onClick={() => void saveM3u()}>
                  <Link2 size={15} strokeWidth={2.2} />
                  Adicionar por URL
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".m3u,.m3u8,.txt"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void onFile(file)
                  }}
                />
                <button type="button" className="ghost playlist-btn-secondary" onClick={() => fileRef.current?.click()}>
                  <FileUp size={15} strokeWidth={2.2} />
                  Carregar arquivo .m3u
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Servidor (URL / Host)</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="http://host:porta" />
              </div>
              <div className="playlist-fields-split">
                <div className="field">
                  <label>Usuário</label>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="field">
                  <label>Senha</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </div>
              <div className="playlist-actions">
                <button
                  type="button"
                  className="primary playlist-btn-main"
                  disabled={busy}
                  onClick={() => void saveXtream()}
                >
                  <Server size={15} strokeWidth={2.2} />
                  {busy ? 'Testando…' : 'Conectar'}
                </button>
              </div>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </section>

        <section className="playlist-panel playlist-saved">
          <div className="playlist-saved-head">
            <h2>Suas listas</h2>
            <span className="playlist-count">{playlists.length}</span>
          </div>

          {playlists.length === 0 ? (
            <div className="playlist-empty">
              <List size={22} strokeWidth={1.8} />
              <p>Nenhuma lista ainda. Adicione uma M3U ou Xtream ao lado.</p>
            </div>
          ) : (
            <div className="playlist-list">
              {playlists.map((p) => {
                const isActive = p.id === activeId
                const endpoint = p.kind === 'm3u' ? p.m3uUrl || 'Arquivo local' : p.xtream?.host || '—'
                return (
                  <article key={p.id} className={`playlist-item${isActive ? ' is-active' : ''}`}>
                    <div className="playlist-item-icon" aria-hidden>
                      {p.kind === 'm3u' ? <Link2 size={16} /> : <Server size={16} />}
                    </div>
                    <div className="playlist-item-body">
                      <div className="playlist-item-title">
                        <strong>{p.name}</strong>
                        <span className={`playlist-kind-badge${p.kind === 'xtream' ? ' is-xtream' : ''}`}>
                          {p.kind === 'm3u' ? 'M3U' : 'Xtream'}
                        </span>
                        {isActive && (
                          <span className="playlist-active-badge">
                            <Check size={11} strokeWidth={2.6} />
                            Ativa
                          </span>
                        )}
                      </div>
                      <p className="playlist-item-meta" title={endpoint}>
                        {endpoint}
                      </p>
                    </div>
                    <div className="playlist-item-actions">
                      {!isActive && (
                        <button type="button" className="ghost" onClick={() => onSelect(p.id)}>
                          Usar
                        </button>
                      )}
                      <button type="button" className="ghost" onClick={() => openEditor(p)}>
                        <Pencil size={14} strokeWidth={2.2} />
                        Editar
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={closeEditor}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-playlist-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="edit-playlist-title">Editar lista</h2>
            <div className="field">
              <label>Nome</label>
              <input value={editName} onChange={(event) => setEditName(event.target.value)} />
            </div>
            <div className="field">
              <label>{editing.kind === 'm3u' ? 'URL do M3U' : 'Servidor'}</label>
              <input
                value={editEndpoint}
                onChange={(event) => setEditEndpoint(event.target.value)}
                placeholder={editing.kind === 'm3u' ? 'http://servidor/get.php?...' : 'http://host:port'}
              />
            </div>
            {editing.kind === 'xtream' && (
              <>
                <div className="field">
                  <label>Usuário</label>
                  <input value={editUsername} onChange={(event) => setEditUsername(event.target.value)} />
                </div>
                <div className="field">
                  <label>Senha</label>
                  <div className="password-field">
                    <input
                      type={showEditPassword ? 'text' : 'password'}
                      value={editPassword}
                      onChange={(event) => setEditPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      aria-label={showEditPassword ? 'Ocultar senha' : 'Mostrar senha'}
                      title={showEditPassword ? 'Ocultar senha' : 'Mostrar senha'}
                      onClick={() => setShowEditPassword((visible) => !visible)}
                    >
                      {showEditPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className="row modal-actions" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const target = editing
                  closeEditor()
                  setDeletingPlaylist(target)
                }}
              >
                Excluir Lista
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button className="ghost" onClick={closeEditor}>Cancelar</button>
                <button className="primary" disabled={!editName.trim() || !editEndpoint.trim()} onClick={saveEdit}>
                  Salvar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deletingPlaylist && (
        <div className="modal-backdrop" onClick={() => setDeletingPlaylist(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: 440 }}
          >
            <h2 id="confirm-delete-title">Remover Lista</h2>
            <p style={{ margin: '14px 0 20px', color: '#cbd5e1', lineHeight: 1.5 }}>
              Tem certeza que deseja remover a lista <strong>{deletingPlaylist.name}</strong>?
            </p>
            <div className="row modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button className="ghost" onClick={() => setDeletingPlaylist(null)}>
                Cancelar
              </button>
              <button
                className="danger"
                onClick={() => {
                  onRemove(deletingPlaylist.id)
                  setDeletingPlaylist(null)
                }}
              >
                Confirmar e Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatExpiration(expDate?: string | number | null) {
  if (expDate === null || expDate === undefined || expDate === 0 || expDate === '0' || expDate === 'null' || expDate === 'unlimited') {
    return 'Sem expiração'
  }
  const expTimestamp = Number(expDate)
  if (!Number.isNaN(expTimestamp) && expTimestamp > 0) {
    return new Date(expTimestamp * 1000).toLocaleDateString('pt-BR')
  }
  return String(expDate)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

function measureLocalStorageBytes(): number {
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      const value = localStorage.getItem(key) || ''
      total += (key.length + value.length) * 2
    }
  } catch {
    // ignore
  }
  return total
}

async function measureIndexedDbBytes(): Promise<number> {
  try {
    if (!('indexedDB' in window)) return 0
    const dbName = 'sturplay-catalog-v1'
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!db.objectStoreNames.contains('catalog')) {
      db.close()
      return 0
    }
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('catalog', 'readonly')
      const req = tx.objectStore('catalog').getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    db.close()
    return new Blob([JSON.stringify(rows)]).size
  } catch {
    return 0
  }
}

function ParentalPinModal({
  title,
  expectedPin,
  onCancel,
  onSuccess,
}: {
  title: string
  expectedPin: string
  onCancel: () => void
  onSuccess: () => void
}) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function submit(value = pin) {
    if (!/^\d{4}$/.test(value)) {
      setError('Digite os 4 dígitos.')
      return
    }
    if (value !== expectedPin) {
      setError('Senha incorreta.')
      setPin('')
      inputRef.current?.focus()
      return
    }
    onSuccess()
  }

  return (
    <div className="modal-backdrop parental-backdrop" onClick={onCancel}>
      <div
        className="modal parental-pin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parental-pin-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="parental-pin-icon" aria-hidden>
          <Shield size={22} strokeWidth={1.9} />
        </div>
        <h2 id="parental-pin-title">{title}</h2>
        <p className="muted">Digite a senha de 4 dígitos do controle parental.</p>
        <div className="parental-pin-dots" aria-hidden>
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={`parental-pin-dot${pin.length > index ? ' filled' : ''}`} />
          ))}
        </div>
        <input
          ref={inputRef}
          className="parental-pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          aria-label="Senha de 4 dígitos"
          onChange={(event) => {
            const next = event.target.value.replace(/\D/g, '').slice(0, 4)
            setPin(next)
            setError(null)
            if (next.length === 4) window.setTimeout(() => submit(next), 40)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        {error && <div className="error">{error}</div>}
        <div className="row modal-actions" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={() => submit()}>
            Desbloquear
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsPage({
  settings,
  playlists,
  activePlaylistId,
  onAddPlaylist,
  onSelectPlaylist,
  onRemovePlaylist,
  onUpdatePlaylist,
  continueWatching,
  parentalUnlocked,
  onChange,
  onLockAdult,
  onUnlockAdult,
  onRefreshEpg,
  epgRefreshing,
  updaterStatus,
  updaterToast,
  updaterChecking,
  updaterProgress,
  onCheckUpdates,
  onInstallUpdate,
  onOpenReleases,
  onRefreshCatalog,
  catalogRefreshing,
  hasActivePlaylist,
  onRemoveContinueItem,
  onRemoveRecentLive,
  onClearAllHistory,
  onClearHistoryKind,
  initialSection,
}: {
  settings: AppSettings
  playlists: Playlist[]
  activePlaylistId?: string
  onAddPlaylist: (playlist: Playlist) => void
  onSelectPlaylist: (id: string) => void
  onRemovePlaylist: (id: string) => void
  onUpdatePlaylist: (playlist: Playlist) => void
  continueWatching: ContinueWatching[]
  parentalUnlocked: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onLockAdult: () => void
  onUnlockAdult: () => void
  onRefreshEpg: () => void
  epgRefreshing: boolean
  updaterStatus: UpdaterStatus | null
  updaterToast: UpdateToastState
  updaterChecking: boolean
  updaterProgress: number
  onCheckUpdates: () => void
  onInstallUpdate: () => void
  onOpenReleases: () => void
  onRefreshCatalog: () => void
  catalogRefreshing: boolean
  hasActivePlaylist: boolean
  onRemoveContinueItem: (channelId: string, seriesId?: string) => void
  onRemoveRecentLive: (channelId: string) => void
  onClearAllHistory: () => void
  onClearHistoryKind: (kind: 'movie' | 'series' | 'live') => void
  initialSection?: 'playlist'
}) {
  type SettingsSection = 'player' | 'epg' | 'updates' | 'theme' | 'screen' | 'storage' | 'parental' | 'playlist' | 'hidden'
type AppearanceFolder = 'theme' | 'shellBg' | 'colors' | 'accent' | null
  // Abre em "Playlist / Login", que e a primeira aba do menu lateral. O padrao
  // anterior era 'player', entao Configuracoes ja abria no Reprodutor e o
  // usuario tinha que clicar para chegar na lista.
  const [section, setSection] = useState<SettingsSection>(initialSection || 'playlist')
  const [appearanceFolder, setAppearanceFolder] = useState<AppearanceFolder>(null)
  const settingsPageRef = useRef<HTMLDivElement>(null)
  const appearanceCardRef = useRef<HTMLDivElement>(null)
  const screenCardRef = useRef<HTMLDivElement>(null)
  const playlistCardRef = useRef<HTMLDivElement>(null)
  const [cacheFeedback, setCacheFeedback] = useState<string | null>(null)
  const [historyKind, setHistoryKind] = useState<'movie' | 'series' | 'live' | null>(null)
  const [recentLive, setRecentLive] = useState<Channel[]>(() => loadRecentLiveChannels())
  const [storageBytes, setStorageBytes] = useState({ local: 0, disk: 0, total: 0 })
  const [storageBusy, setStorageBusy] = useState(false)
  const [detected, setDetected] = useState<{
    stur?: boolean
  }>({})
  const [pinDraft, setPinDraft] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinCurrent, setPinCurrent] = useState('')
  const [pinMode, setPinMode] = useState<'create' | 'change' | 'disable' | 'reset'>('create')
  const [pinError, setPinError] = useState<string | null>(null)
  const [pinOk, setPinOk] = useState<string | null>(null)
  const [resetStep, setResetStep] = useState(false)
  // Recarrega a lista de ocultados a cada vez que a secao abre: restaurar um
  // item tem que sumir da tela na hora, sem depender de trocar de aba.
  const [hiddenItems, setHiddenItems] = useState(() => loadAllHiddenItems())
  // Qual escopo esta aberto. null = nenhum.
  const [expanded, setExpanded] = useState<string | null>(null)
  /** id -> nome dos itens ocultados, montado a partir de todas as listas salvas. */
  const hiddenNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const entry of Object.values(hiddenItems)) {
      for (const [id, name] of Object.entries(entry.names ?? {})) out[id] = name
    }
    return out
  }, [hiddenItems])

  const KIND_LABEL: Record<ContentKind, string> = {
    live: 'Ao vivo',
    movie: 'Filmes',
    series: 'Séries',
  }

  /** "playlist-id|movie" -> linha legivel na tela. */
  const hiddenEntries = useMemo(() => {
    const playlistNames = new Map(playlists.map((p) => [p.id, p.name]))
    return Object.entries(hiddenItems)
      .map(([scope, value]) => {
        const sep = scope.lastIndexOf('|')
        const playlistId = scope.slice(0, sep)
        const kind = scope.slice(sep + 1) as ContentKind
        const counts = (value.channels?.length ?? 0) + (value.groups?.length ?? 0)
        if (counts === 0) return null
        const playlistName = playlistId === 'sem-playlist' ? 'Sem playlist' : playlistNames.get(playlistId)
        return {
          scope,
          label: `${KIND_LABEL[kind] ?? kind} · ${playlistName ?? 'Playlist removida'}`,
          channels: value.channels ?? [],
          groups: value.groups ?? [],
          names: value.names ?? {},
        }
      })
      .filter(
        (entry): entry is {
          scope: string
          label: string
          channels: string[]
          groups: string[]
          names: Record<string, string>
        } => entry !== null,
      )
  }, [hiddenItems, playlists])

  /**
   * Desoculta UM item (ou uma categoria) e reescreve o escopo.
   *
   * Antes so existia "restaurar tudo" em dois niveis. Na pratica esconder um
   * canal por engano deixava o usuario preso na escolha entre devolver a
   * categoria inteira ou nada — e a categoria inteira tem outras dezenas de
   * canais que ele nao tinha occultado.
   */
  const unhideOne = (scope: string, id: string, isGroup: boolean) => {
    const entry = hiddenItems[scope]
    if (!entry) return
    const drop = (list: string[]) => list.filter((value) => value !== id)
    const nextEntry: HiddenItems = {
      channels: isGroup ? entry.channels ?? [] : drop(entry.channels ?? []),
      groups: isGroup ? drop(entry.groups ?? []) : entry.groups ?? [],
      names: entry.names ?? {},
    }
    const all = { ...hiddenItems }
    if (!isGroup && nextEntry.names) delete nextEntry.names[id]
    const empty = nextEntry.channels.length === 0 && nextEntry.groups.length === 0
    if (empty) {
      delete all[scope]
    } else {
      all[scope] = nextEntry
    }
    try {
      localStorage.setItem('sturplay.hidden-items', JSON.stringify(all))
    } catch {
      // quota: a lista e pequena, e sem escrita a ocultacao persiste mais uma
      // vez, que e o comportamento antigo.
    }
    setHiddenItems(all)
  }

  useEffect(() => {
    if (initialSection) setSection(initialSection)
  }, [initialSection])

  const movieHistory = useMemo(
    () =>
      continueWatching
        .filter((item) => item.channel.kind === 'movie')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [continueWatching],
  )
  const seriesHistory = useMemo(
    () =>
      continueWatching
        .filter((item) => item.channel.kind === 'series')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [continueWatching],
  )

  const refreshStorage = useCallback(async () => {
    setStorageBusy(true)
    try {
      const local = measureLocalStorageBytes()
      const disk = await measureIndexedDbBytes()
      let total = local + disk
      try {
        const estimate = await navigator.storage?.estimate?.()
        if (estimate?.usage && estimate.usage > total) total = estimate.usage
      } catch {
        // ignore
      }
      setStorageBytes({ local, disk, total })
    } finally {
      setStorageBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  useEffect(() => {
    void window.sturplay?.player?.detect?.().then((res) => {
      if (!res?.ok) return
      setDetected({
        stur: res.stur,
      })
    })
  }, [])

  useEffect(() => {
    if (section === 'storage') setRecentLive(loadRecentLiveChannels())
  }, [section])

  useEffect(() => {
    if (historyKind === 'live') setRecentLive(loadRecentLiveChannels())
  }, [historyKind])

  const historyTitle =
    historyKind === 'movie' ? 'Histórico de filmes' : historyKind === 'series' ? 'Histórico de séries' : 'Histórico ao vivo'

  const historyCount =
    historyKind === 'live'
      ? recentLive.length
      : historyKind === 'movie'
        ? movieHistory.length
        : historyKind === 'series'
          ? seriesHistory.length
          : 0

  function clearCurrentHistory() {
    if (!historyKind) return
    onClearHistoryKind(historyKind)
    if (historyKind === 'live') setRecentLive([])
    void refreshStorage()
  }

  const scrollToSettingsTarget = useCallback((target: HTMLElement | null) => {
    if (!target) return
    const root = settingsPageRef.current
    if (!root) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12
    root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])

  const openAppearanceSection = useCallback(() => {
    setSection('theme')
    window.setTimeout(() => scrollToSettingsTarget(appearanceCardRef.current), 0)
  }, [scrollToSettingsTarget])

  const openScreenSection = useCallback(() => {
    setSection('screen')
    window.setTimeout(() => scrollToSettingsTarget(screenCardRef.current), 0)
  }, [scrollToSettingsTarget])

  const openPlaylistSection = useCallback(() => {
    setSection('playlist')
    window.setTimeout(() => scrollToSettingsTarget(playlistCardRef.current), 0)
  }, [scrollToSettingsTarget])

  const appearanceOpen = section === 'theme' || section === 'screen'

  return (
    <div className="settings-page" ref={settingsPageRef}>
      <ShellBrand />
      <div className="settings-page-head">
        <h1>Configurações</h1>
        <p className="muted">Listas, reprodutor, aparência, EPG, armazenamento e controle parental</p>
      </div>

      <div className="settings-page-layout">
        <aside className="settings-page-side">
          <nav className="settings-page-nav" aria-label="Seções de configurações">
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'playlist' ? ' active' : ''}`}
              onClick={openPlaylistSection}
            >
              <List size={15} strokeWidth={2.2} />
              Playlist / Login
            </button>
            <div className={`settings-nav-group${appearanceOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className={`settings-page-nav-btn${section === 'theme' ? ' active' : section === 'screen' ? ' active-parent' : ''}`}
                onClick={openAppearanceSection}
              >
                <Palette size={15} strokeWidth={2.2} />
                Aparência
              </button>
              {appearanceOpen && (
                <div className="settings-nav-sub-wrap">
                  <button
                    type="button"
                    className={`settings-nav-sub-btn${section === 'screen' ? ' active' : ''}`}
                    onClick={openScreenSection}
                  >
                    <Brain size={14} strokeWidth={2.2} />
                    Tela
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'player' ? ' active' : ''}`}
              onClick={() => setSection('player')}
            >
              <MonitorPlay size={15} strokeWidth={2.2} />
              Reprodutor
            </button>
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'epg' ? ' active' : ''}`}
              onClick={() => setSection('epg')}
            >
              <CalendarDays size={15} strokeWidth={2.2} />
              EPG
            </button>
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'parental' ? ' active' : ''}`}
              onClick={() => setSection('parental')}
            >
              <Shield size={15} strokeWidth={2.2} />
              Controle parental
            </button>
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'storage' ? ' active' : ''}`}
              onClick={() => setSection('storage')}
            >
              <HardDrive size={15} strokeWidth={2.2} />
              Armazenamento
            </button>
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'hidden' ? ' active' : ''}`}
              onClick={() => setSection('hidden')}
            >
              <EyeOff size={15} strokeWidth={2.2} />
              Itens ocultos
            </button>
            {/*
              "Atualizacoes" fica no fim, e nao entre EPG e Controle parental.

              Ela e a unica secao que ninguem configura: e uma leitura do estado
              do app com um botao de acao. Ficar no meio da lista punha um item
              de manutencao entre as secoes que a gente realmente ajusta, e
              empurrava "Controle parental" para baixo por causa disso. No fim,
              ela fica onde o olho so chega quando ja terminou de configurar o
              resto — que e a frequencia real de uso.
            */}
            <button
              type="button"
              className={`settings-page-nav-btn${section === 'updates' ? ' active' : ''}`}
              onClick={() => setSection('updates')}
            >
              <Download size={15} strokeWidth={2.2} />
              Atualizações
              {/*
                O ponto e o que resolve o sumico. O cartaz de "pronto" se fecha
                em 10 s, e o instalador fica em `pending`. Sem um marcador fixo
                ao lado do item, a unica forma de saber que ha algo pronto era
                lembrar de ir em "Verificar agora" — que e o que o dono
                reclamou. O ponto e silencioso: nao repete, nao pulsa, e fica
                ate a pessoa resolver.
              */}
              {updaterStatus?.disponivelParaInstalar && updaterStatus.installing === false && (
                <span className="settings-nav-dot" title="Atualização pronta para instalar" />
              )}
            </button>
          </nav>
        </aside>

        <section className="settings-page-content">
          {section === 'hidden' && (
            <div className="settings-card settings-card-spaced">
              <h2>Itens ocultos</h2>

              {hiddenEntries.length === 0 ? (
                <p className="muted" style={{ marginTop: 16 }}>
                  Nenhum item oculto.
                </p>
              ) : (
                <>
                  <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
                    {hiddenEntries.map((entry) => (
                      <div
                        key={entry.scope}
                        className="hidden-scope-row"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '12px 14px',
                          borderRadius: 12,
                          border: '1px solid var(--border-subtle)',
                          background: 'var(--bg-surface)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <strong style={{ fontSize: 14 }}>{entry.label}</strong>
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            {entry.channels.length} item(ns) · {entry.groups.length} categoria(s)
                          </div>
                        </div>
                        <button
                          type="button"
                          className="settings-row-action"
                          onClick={() => setExpanded((cur) => (cur === entry.scope ? null : entry.scope))}
                        >
                          {expanded === entry.scope ? 'Esconder lista' : 'Ver o que foi ocultado'}
                        </button>
                        {expanded === entry.scope && (
                          <div className="hidden-scope-detail">
                            {entry.groups.length > 0 && (
                              <div className="hidden-scope-group">
                                <span className="hidden-scope-group-title">Categorias</span>
                                <div className="hidden-scope-chips">
                                  {entry.groups.map((name) => (
                                    <button
                                      type="button"
                                      key={`g-${name}`}
                                      className="hidden-item-chip"
                                      onClick={() => unhideOne(entry.scope, name, true)}
                                      title={`Desocultar a categoria ${name}`}
                                    >
                                      {name}
                                      <X size={12} strokeWidth={2.4} />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                            {entry.channels.length > 0 && (
                              <div className="hidden-scope-group">
                                <span className="hidden-scope-group-title">Itens</span>
                                <div className="hidden-scope-chips">
                                  {entry.channels.map((id) => (
                                    <button
                                      type="button"
                                      key={`c-${id}`}
                                      className="hidden-item-chip"
                                      onClick={() => unhideOne(entry.scope, id, false)}
                                      title={`Desocultar ${hiddenNames[id] || id}`}
                                    >
                                      {hiddenNames[id] || id}
                                      <X size={12} strokeWidth={2.4} />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="danger"
                    style={{ marginTop: 16 }}
                    onClick={() => {
                      clearAllHiddenItems()
                      setHiddenItems(loadAllHiddenItems())
                    }}
                  >
                    Restaurar todos os itens ocultos
                  </button>
                </>
              )}
            </div>
          )}
          {section === 'theme' && (
              <div className="settings-card settings-card-spaced" ref={appearanceCardRef}>
                <h3>Aparência</h3>
                <p className="muted">Escolha o clima do app e a cor de destaque.</p>

                {(() => {
                  const shellBg = settings.shellBackground || 'gradient'
                  const shellBgLabel =
                    SHELL_BACKGROUND_OPTIONS.find((item) => item.id === shellBg)?.label || 'Cantos'
                  const accent = settings.accent || 'teal'
                  const customAccent = {
                    name: settings.customAccent?.name?.trim() || 'Custom',
                    color: normalizeHexColor(settings.customAccent?.color ?? ''),
                  }
                  const activeAccent = resolveAccentColor(accent, customAccent.color)
                  const activeAccentLabel = accent === 'custom' ? customAccent.name : activeAccent.label
                  const customColors = settings.customColors
                  const customBg = customColors?.bg
                  const customPanel = customColors?.panel
                  const customText = customColors?.text
                  const customBorder = customColors?.border
                  // O painel derivado: sem cor escolhida, o que vale e o que o
                  // tema produz. E a mesma conta que o CSS faz, para a amostra da
                  // paleta mostrar o tom que estara valendo DEPOIS do clique.
                  const fundoDoTema = customBg || THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg
                  // Leitura ao vivo do par letra/fundo que estara valendo DEPOIS da
                  // escolha. E o par efetivo, nao o do tema: se a pessoa mudou so
                  // a letra, o fundo que continua valendo e o do tema; e se mudou
                  // so o fundo SEM escolher letra, a letra que vale e a derivada
                  // do fundo — a do tema seria mentira aqui e mostraria 1.08:1
                  // para uma página que está lendo 15:1.
                  const bgEfetivo = customBg || THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg
                  const textEfetivo =
                    customText || (customBg ? textDefaultFor(bgEfetivo) : THEME_COLORS[(settings.theme || 'dark') as ThemeId].text)
                  const contrast = readability(textEfetivo, bgEfetivo)
                  const toggleFolder = (folder: Exclude<AppearanceFolder, null>) => {
                    setAppearanceFolder((current) => (current === folder ? null : folder))
                  }

                  return (
                    <div className="appearance-folders">
                      <div className={`appearance-folder${appearanceFolder === 'theme' ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="appearance-folder-toggle"
                          aria-expanded={appearanceFolder === 'theme'}
                          onClick={() => toggleFolder('theme')}
                        >
                          <span className="appearance-folder-copy">
                            <strong>Tema base</strong>
                            <span>{getThemeOption(settings.theme).label}</span>
                          </span>
                          <ChevronDown size={18} className="appearance-folder-chevron" />
                        </button>
                        {appearanceFolder === 'theme' && (
                          <div className="appearance-folder-body">
                            <div className="theme-options">
                              {THEME_OPTIONS.map((theme) => (
                                <button
                                  key={theme.id}
                                  type="button"
                                  className={`theme-option theme-option-${theme.id}${settings.theme === theme.id ? ' active' : ''}`}
                                  onClick={() => onChange({ theme: theme.id })}
                                >
                                  <span className="theme-option-swatch" aria-hidden />
                                  <span className="theme-option-copy">
                                    <strong>{theme.label}</strong>
                                    <span>{theme.hint}</span>
                                  </span>
                                  {settings.theme === theme.id && (
                                    <Check size={16} className="theme-option-check" strokeWidth={2.6} />
                                  )}
                                </button>
                              ))}
                            </div>

                            <label className="accent-custom-field accent-custom-color theme-custom-color">
                              <span>Cor personalizada do fundo</span>
                              <div className="accent-custom-color-row">
                                <input
                                  type="color"
                                  value={customBg || THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg}
                                  onChange={(event) =>
                                    onChange({ customColors: { ...customColors, bg: event.target.value } })
                                  }
                                  aria-label="Escolher cor de fundo personalizada"
                                />
                                <input
                                  type="text"
                                  className="accent-custom-hex"
                                  placeholder={THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg}
                                  value={customBg || ''}
                                  maxLength={7}
                                  onChange={(event) => {
                                    const raw = event.target.value.trim()
                                    const next = !raw
                                      ? undefined
                                      : raw.startsWith('#')
                                        ? raw.slice(0, 7)
                                        : `#${raw.slice(0, 6)}`
                                    onChange({ customColors: { ...customColors, bg: next } })
                                  }}
                                  onBlur={(event) => {
                                    const raw = event.target.value.trim()
                                    if (!raw) return
                                    onChange({
                                      customColors: {
                                        ...customColors,
                                        bg: normalizeColorHex(
                                          raw,
                                          THEME_COLORS[(settings.theme || 'dark') as ThemeId].bg,
                                        ),
                                      },
                                    })
                                  }}
                                  spellCheck={false}
                                />
                              </div>
                            </label>
                            {customBg && (
                              <button
                                type="button"
                                className="ghost playlist-btn-secondary"
                                onClick={() => {
                                  const { bg, ...resto } = customColors
                                  void bg
                                  onChange({
                                    customColors: Object.keys(resto).length ? resto : undefined,
                                  })
                                }}
                              >
                                Voltar ao fundo do tema
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className={`appearance-folder${appearanceFolder === 'shellBg' ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="appearance-folder-toggle"
                          aria-expanded={appearanceFolder === 'shellBg'}
                          onClick={() => toggleFolder('shellBg')}
                        >
                          <span className="appearance-folder-copy">
                            <strong>Cenário</strong>
                            <span>{shellBgLabel}</span>
                          </span>
                          <ChevronDown size={18} className="appearance-folder-chevron" />
                        </button>
                        {appearanceFolder === 'shellBg' && (
                          <div className="appearance-folder-body">
                            <div className="shell-bg-options">
                              {SHELL_BACKGROUND_OPTIONS.map((option) => (
                                <button
                                  key={option.id}
                                  type="button"
                                  className={`shell-bg-option shell-bg-option-${option.id}${shellBg === option.id ? ' active' : ''}`}
                                  onClick={() => onChange({ shellBackground: option.id })}
                                  aria-pressed={shellBg === option.id}
                                >
                                  <span className="shell-bg-option-swatch" aria-hidden />
                                  <span className="shell-bg-option-copy">
                                    <strong>{option.label}</strong>
                                    <span>{option.hint}</span>
                                  </span>
                                  {shellBg === option.id && (
                                    <Check size={16} className="shell-bg-option-check" strokeWidth={2.6} />
                                  )}
                                </button>
                              ))}
                            </div>
                            <p className="appearance-colors-note">
                              O brilho que fica por trás do conteúdo. Não mexe em nenhuma cor —
                              a cor do fundo está em “Tema base” e a dos painéis, em “Cores do
                              app”.
                            </p>
                          </div>
                        )}
                      </div>

                      <div className={`appearance-folder${appearanceFolder === 'colors' ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="appearance-folder-toggle"
                          aria-expanded={appearanceFolder === 'colors'}
                          onClick={() => toggleFolder('colors')}
                        >
                          <span className="appearance-folder-copy">
                            <strong>Cores do app</strong>
                            <span>
                              {customPanel || customText || customBorder ? 'Personalizado' : 'Do tema'}
                            </span>
                          </span>
                          <ChevronDown size={18} className="appearance-folder-chevron" />
                        </button>
                        {appearanceFolder === 'colors' && (
                          <div className="appearance-folder-body">
                            <p className="appearance-colors-note">
                              O cinza dos painéis — cartões, pôster, estados vazios — e a rampa de
                              cinco tons da letra saem daqui. O fundo da página é outra coisa, e
                              está em “Tema base”.
                            </p>

                            <div className="panel-tone-grid">
                              {PANEL_TONES.map((tone) => {
                                const cor = panelToneColor(fundoDoTema, tone.lift)
                                return (
                                  <button
                                    key={tone.label}
                                    type="button"
                                    className={`panel-tone${customPanel?.toLowerCase() === cor.toLowerCase() ? ' active' : ''}`}
                                    onClick={() =>
                                      onChange({ customColors: { ...customColors, panel: cor } })
                                    }
                                    aria-pressed={customPanel?.toLowerCase() === cor.toLowerCase()}
                                    title={`${tone.label} — ${tone.hint}`}
                                  >
                                    <span className="panel-tone-chip" style={{ background: cor }} aria-hidden />
                                    <span className="panel-tone-copy">
                                      <strong>{tone.label}</strong>
                                      <span>{tone.hint}</span>
                                    </span>
                                  </button>
                                )
                              })}
                            </div>

                            <div className="custom-color-grid">
                              <label className="accent-custom-field accent-custom-color">
                                <span>Cor dos painéis</span>
                                <div className="accent-custom-color-row">
                                  <input
                                    type="color"
                                    value={customPanel || panelToneColor(fundoDoTema, PANEL_TONES[0].lift)}
                                    onChange={(event) =>
                                      onChange({ customColors: { ...customColors, panel: event.target.value } })
                                    }
                                    aria-label="Escolher a cor dos painéis"
                                  />
                                  <input
                                    type="text"
                                    className="accent-custom-hex"
                                    placeholder={panelToneColor(fundoDoTema, PANEL_TONES[0].lift)}
                                    value={customPanel || ''}
                                    maxLength={7}
                                    onChange={(event) => {
                                      const raw = event.target.value.trim()
                                      const next = !raw
                                        ? undefined
                                        : raw.startsWith('#')
                                          ? raw.slice(0, 7)
                                          : `#${raw.slice(0, 6)}`
                                      onChange({ customColors: { ...customColors, panel: next } })
                                    }}
                                    onBlur={(event) => {
                                      const raw = event.target.value.trim()
                                      if (!raw) return
                                      onChange({
                                        customColors: {
                                          ...customColors,
                                          panel: normalizeColorHex(
                                            raw,
                                            panelToneColor(fundoDoTema, PANEL_TONES[0].lift),
                                          ),
                                        },
                                      })
                                    }}
                                    spellCheck={false}
                                  />
                                </div>
                                {/*
                                 * Limpar SO o painel.
                                 *
                                 * O "Voltar ao tema" do fim da pasta limpa letra e
                                 * borda junto, entao nao servia para desfazer so o
                                 * cinza dos cartoes — que e o que o dono queria
                                 * voltar. Aqui sai apenas o campo `panel`, e o
                                 * resto da escolha dele fica como estava.
                                 */}
                                {customPanel && (
                                  <button
                                    type="button"
                                    className="ghost playlist-btn-secondary panel-clear-btn"
                                    onClick={() => {
                                      const { panel, ...resto } = customColors
                                      void panel
                                      onChange({
                                        customColors: Object.keys(resto).length ? resto : undefined,
                                      })
                                    }}
                                  >
                                    Voltar ao painel do tema
                                  </button>
                                )}
                              </label>

                              <label className="accent-custom-field accent-custom-color">
                                <span>Cor da letra</span>
                                <div className="accent-custom-color-row">
                                  <input
                                    type="color"
                                    value={customText || THEME_COLORS[(settings.theme || 'dark') as ThemeId].text}
                                    onChange={(event) =>
                                      onChange({ customColors: { ...customColors, text: event.target.value } })
                                    }
                                    aria-label="Escolher cor da letra"
                                  />
                                  <input
                                    type="text"
                                    className="accent-custom-hex"
                                    placeholder={THEME_COLORS[(settings.theme || 'dark') as ThemeId].text}
                                    value={customText || ''}
                                    maxLength={7}
                                    onChange={(event) => {
                                      const raw = event.target.value.trim()
                                      const next = !raw
                                        ? undefined
                                        : raw.startsWith('#')
                                          ? raw.slice(0, 7)
                                          : `#${raw.slice(0, 6)}`
                                      onChange({ customColors: { ...customColors, text: next } })
                                    }}
                                    onBlur={(event) => {
                                      const raw = event.target.value.trim()
                                      if (!raw) return
                                      onChange({
                                        customColors: {
                                          ...customColors,
                                          text: normalizeColorHex(raw, THEME_COLORS[(settings.theme || 'dark') as ThemeId].text),
                                        },
                                      })
                                    }}
                                    spellCheck={false}
                                  />
                                </div>
                              </label>

                              <label className="accent-custom-field accent-custom-color">
                                <span>Cor das bordas</span>
                                <div className="accent-custom-color-row">
                                  <input
                                    type="color"
                                    value={customBorder || '#141414'}
                                    onChange={(event) =>
                                      onChange({ customColors: { ...customColors, border: event.target.value } })
                                    }
                                    aria-label="Escolher cor das bordas"
                                  />
                                  <input
                                    type="text"
                                    className="accent-custom-hex"
                                    placeholder="Do tema"
                                    value={customBorder || ''}
                                    maxLength={7}
                                    onChange={(event) => {
                                      const raw = event.target.value.trim()
                                      const next = !raw
                                        ? undefined
                                        : raw.startsWith('#')
                                          ? raw.slice(0, 7)
                                          : `#${raw.slice(0, 6)}`
                                      onChange({ customColors: { ...customColors, border: next } })
                                    }}
                                    onBlur={(event) => {
                                      const raw = event.target.value.trim()
                                      if (!raw) return
                                      onChange({
                                        customColors: {
                                          ...customColors,
                                          border: normalizeColorHex(raw, '#141414'),
                                        },
                                      })
                                    }}
                                    spellCheck={false}
                                  />
                                </div>
                              </label>
                            </div>

                            <div
                              className={`custom-color-readout${contrast.ok ? '' : ' is-low'}${contrast.bodyOk ? '' : ' is-bad'}`}
                              role="status"
                            >
                              <span>
                                Contraste letra/fundo <strong>{contrast.ratio.toFixed(2)}:1</strong>
                              </span>
                              <span className="custom-color-readout-hint">
                                {contrast.ok
                                  ? 'Acima de 4.5:1 (AA) para texto de corpo.'
                                  : contrast.bodyOk
                                    ? 'Só para texto grande. Acima de 3:1, abaixo de 4.5:1.'
                                    : 'Abaixo de 3:1. Dá para navegar, mas ler fica difícil.'}
                              </span>
                            </div>

                            {(customBg || customText || customBorder) && (
                              <button
                                type="button"
                                className="ghost playlist-btn-secondary"
                                onClick={() => onChange({ customColors: undefined })}
                              >
                                Voltar ao tema
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className={`appearance-folder${appearanceFolder === 'accent' ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="appearance-folder-toggle"
                          aria-expanded={appearanceFolder === 'accent'}
                          onClick={() => toggleFolder('accent')}
                        >
                          <span className="appearance-folder-copy">
                            <strong>Cor de destaque</strong>
                            <span className="appearance-folder-accent-value">
                              <span
                                className="appearance-folder-accent-dot"
                                style={{ background: activeAccent.color }}
                              />
                              {activeAccentLabel}
                            </span>
                          </span>
                          <ChevronDown size={18} className="appearance-folder-chevron" />
                        </button>
                        {appearanceFolder === 'accent' && (
                          <div className="appearance-folder-body">
                            <div className="accent-palette-simple">
                              {ACCENT_PRESETS.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  className={`accent-swatch${accent === item.id ? ' active' : ''}`}
                                  onClick={() => onChange({ accent: item.id })}
                                  aria-pressed={accent === item.id}
                                  title={item.label}
                                >
                                  <span className="accent-swatch-dot" style={{ background: item.color }} />
                                  <span>{item.label}</span>
                                </button>
                              ))}
                              <button
                                type="button"
                                className={`accent-swatch accent-swatch-custom${accent === 'custom' ? ' active' : ''}`}
                                onClick={() => onChange({ accent: 'custom' })}
                                aria-pressed={accent === 'custom'}
                                title={customAccent.name}
                              >
                                <span
                                  className="accent-swatch-dot"
                                  style={{ background: customAccent.color }}
                                >
                                  <Pencil size={12} />
                                </span>
                                <span>{customAccent.name}</span>
                              </button>
                            </div>

                            {accent === 'custom' && (
                              <div className="accent-custom-editor">
                                <label className="accent-custom-field">
                                  <span>Nome</span>
                                  <input
                                    type="text"
                                    value={customAccent.name}
                                    maxLength={18}
                                    onChange={(event) =>
                                      onChange({
                                        customAccent: {
                                          ...customAccent,
                                          name: event.target.value.slice(0, 18),
                                        },
                                      })
                                    }
                                    placeholder="Custom"
                                  />
                                </label>
                                <label className="accent-custom-field accent-custom-color">
                                  <span>Cor</span>
                                  <div className="accent-custom-color-row">
                                    <input
                                      type="color"
                                      value={normalizeHexColor(customAccent.color)}
                                      onChange={(event) =>
                                        onChange({
                                          accent: 'custom',
                                          customAccent: {
                                            ...customAccent,
                                            color: normalizeHexColor(event.target.value),
                                          },
                                        })
                                      }
                                      aria-label="Escolher cor personalizada"
                                    />
                                    <input
                                      type="text"
                                      className="accent-custom-hex"
                                      value={customAccent.color}
                                      maxLength={7}
                                      onChange={(event) => {
                                        const next = event.target.value.trim()
                                        onChange({
                                          accent: 'custom',
                                          customAccent: {
                                            ...customAccent,
                                            color: next.startsWith('#') ? next.slice(0, 7) : `#${next.slice(0, 6)}`,
                                          },
                                        })
                                      }}
                                      onBlur={(event) =>
                                        onChange({
                                          accent: 'custom',
                                          customAccent: {
                                            ...customAccent,
                                            color: normalizeHexColor(event.target.value),
                                          },
                                        })
                                      }
                                      spellCheck={false}
                                    />
                                  </div>
                                </label>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </div>
          )}

          {section === 'screen' && (
              <div className="settings-card settings-card-spaced" ref={screenCardRef} id="settings-screen-section">
                

                <div className="appearance-setting-row">
                  <div className="appearance-setting-copy">
                    <strong>Tamanho da fonte</strong>
                    <p>
                      Aumenta o tamanho da fonte. Use Grande ou Muito grande ao assistir em uma TV de
                      longe.
                    </p>
                  </div>
                  <div className="appearance-segment" role="group" aria-label="Tamanho da fonte">
                    {(
                      [
                        { id: 'small' as const, label: 'Pequeno' },
                        { id: 'default' as const, label: 'Padrão' },
                        { id: 'medium' as const, label: 'Médio' },
                        { id: 'large' as const, label: 'Grande' },
                        { id: 'xlarge' as const, label: 'Muito grande' },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={(settings.fontSize || 'default') === option.id ? 'active' : ''}
                        aria-pressed={(settings.fontSize || 'default') === option.id}
                        onClick={() => onChange({ fontSize: option.id })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="appearance-setting-row">
                  <div className="appearance-setting-copy">
                    <strong>Densidade</strong>
                    <p>Aumenta ou reduz o espaçamento em listas e menus. Independente do tamanho da fonte.</p>
                  </div>
                  <div
                    className="appearance-segment appearance-segment-density"
                    role="group"
                    aria-label="Densidade"
                  >
                    {(
                      [
                        { id: 'compact' as const, label: 'Compacta' },
                        { id: 'cozy' as const, label: 'Aconchegante' },
                        { id: 'comfortable' as const, label: 'Confortável' },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={(settings.density || 'comfortable') === option.id ? 'active' : ''}
                        aria-pressed={(settings.density || 'comfortable') === option.id}
                        onClick={() => onChange({ density: option.id })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="appearance-setting-row">
                  <div className="appearance-setting-copy">
                    <strong>Brilho da interface</strong>
                    <p>
                      Diminua quando o fundo ou os destaques estiverem muito claros. Aumente um pouco em
                      telas escuras.
                    </p>
                  </div>
                  <div className="appearance-brightness">
                    <input
                      type="range"
                      min={70}
                      max={130}
                      step={5}
                      value={settings.shellBrightness ?? 100}
                      aria-label="Brilho da interface"
                      onChange={(event) =>
                        onChange({ shellBrightness: Number(event.target.value) })
                      }
                    />
                    <span className="appearance-brightness-value">
                      {settings.shellBrightness ?? 100}%
                    </span>
                  </div>
                </div>

                <div className="appearance-setting-row">
                  <div className="appearance-setting-copy">
                    <strong>Animações da interface</strong>
                    <p>Só efeitos decorativos. Vídeo e navegação não mudam.</p>
                  </div>
                  <div className="appearance-segment appearance-segment-compact" role="group" aria-label="Animações da interface">
                    <button
                      type="button"
                      className={settings.performanceMode ? 'active' : ''}
                      aria-pressed={Boolean(settings.performanceMode)}
                      onClick={() => onChange({ performanceMode: true })}
                    >
                      Desligadas
                    </button>
                    <button
                      type="button"
                      className={!settings.performanceMode ? 'active' : ''}
                      aria-pressed={!settings.performanceMode}
                      onClick={() => onChange({ performanceMode: false })}
                    >
                      Ligadas
                    </button>
                  </div>
                </div>
              </div>
          )}

          {section === 'playlist' && (
              <div className="settings-card settings-card-spaced" ref={playlistCardRef}>
                <h3>Playlist / Login do servidor</h3>
                <p className="muted">Adicione e gerencie suas listas M3U ou Xtream (host, usuário e senha)</p>
                <Setup
                  embedded
                  playlists={playlists}
                  activeId={activePlaylistId}
                  onAdd={onAddPlaylist}
                  onSelect={onSelectPlaylist}
                  onRemove={onRemovePlaylist}
                  onUpdate={onUpdatePlaylist}
                />
              </div>
          )}

          {section === 'player' && (
            <div className="settings-card">
              <h3>Reprodutor de Vídeo</h3>
              <p className="muted">
                <strong>Automático</strong> tenta o player interno e, se falhar, usa o <strong>STUR</strong> (mpv nativo) no app.
                Use <strong>STUR</strong> direto para filmes e séries pesados. <strong>MPEG</strong> é o novo estilo
                Smarters — remux primeiro para .ts/mpeg, liso em modo janela e tela cheia.
              </p>

              <div className="settings-block">
                <span className="settings-block-label">Player</span>
                <div className="player-engine-options player-engine-options-stack" role="radiogroup" aria-label="Motor de vídeo">
                  {(
                    [
                      {
                        id: 'auto' as const,
                        label: 'Automático',
                        hint: 'Interno primeiro; STUR se não tocar',
                        status: 'ok' as const,
                      },
                      {
                        id: 'internal' as const,
                        label: 'Player interno',
                        hint: 'HTML5 + HLS.js — leve, ao vivo e navegador',
                        status: 'ok' as const,
                      },
                      {
                        id: 'mpeg' as const,
                        label: 'MPEG',
                        hint: 'Estilo Smarters — remux .ts/mpeg, janela + tela cheia',
                        status: 'ok' as const,
                      },
                      {
                        id: 'stur' as const,
                        label: 'STUR',
                        hint: 'mpv nativo — filmes, séries e codecs pesados',
                        status: detected.stur ? ('ok' as const) : ('missing' as const),
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={settings.player === opt.id}
                      className={`player-engine-card player-engine-card-row${settings.player === opt.id ? ' active' : ''}`}
                      onClick={() => onChange({ player: opt.id })}
                    >
                      <span className="player-engine-card-copy">
                        <strong>{opt.label}</strong>
                        <span>{opt.hint}</span>
                      </span>
                      {settings.player === opt.id ? (
                        <span className="player-engine-badge is-active">ATIVO</span>
                      ) : opt.status === 'missing' ? (
                        <span className="player-engine-badge is-missing">Não detectado</span>
                      ) : (
                        <span className="player-engine-badge is-ready">OK</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>User-Agent personalizado</label>
                <input
                  value={settings.userAgent}
                  onChange={(event) => onChange({ userAgent: event.target.value })}
                  placeholder="VLC/3.0.4 LibVLC/3.0.4"
                />
              </div>

              <button
                type="button"
                className={`settings-switch-row${settings.mouseControls ? ' is-on' : ''}`}
                onClick={() => onChange({ mouseControls: !settings.mouseControls })}
                aria-pressed={settings.mouseControls}
              >
                <span className="settings-switch-copy">
                  <strong>Controles ao mover o mouse</strong>
                  <span>Mostra a barra do player quando o cursor se mexe</span>
                </span>
                <span className="settings-switch" aria-hidden>
                  <span className="settings-switch-knob" />
                </span>
              </button>
            </div>
          )}

          {section === 'epg' && (
            <div className="settings-card">
              <h3>EPG (Guia de TV)</h3>
              <p className="muted">Atualize o catálogo ao vivo para sincronizar a programação.</p>
              <div className="settings-epg-box">
                <div className="settings-epg-icon" aria-hidden>
                  <CalendarDays size={22} strokeWidth={1.8} />
                </div>
                <div className="settings-epg-copy">
                  <strong>Sincronizar guia</strong>
                  <span>
                    {epgRefreshing
                      ? 'Sincronizando catálogo ao vivo…'
                      : settings.epgUpdatedAt
                        ? `Última atualização: ${new Date(settings.epgUpdatedAt).toLocaleString('pt-BR')}`
                        : 'Ainda não sincronizado'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`primary settings-epg-btn${epgRefreshing ? ' is-busy' : ''}`}
                  onClick={onRefreshEpg}
                  disabled={epgRefreshing || !hasActivePlaylist}
                >
                  <RotateCcw size={15} className={epgRefreshing ? 'spin' : undefined} />
                  {epgRefreshing ? 'Atualizando…' : 'Atualizar EPG'}
                </button>
              </div>
            </div>
          )}

          {section === 'updates' && (
            <div className="settings-card">
              <h3>Atualizações</h3>
              <p className="muted">
                O app verifica sozinho uma vez por dia e baixa em segundo plano. Ele só pede para
                reiniciar quando a instalação está pronta.
              </p>
              {/*
                "Atualizar servidor" (catalogo do painel) fica aqui, e nao em
                Playlist/Login: e manutencao de dados, nao configuracao de
                conta. Em Playlist so ficam os campos e a lista.
              */}
              <div className="settings-epg-box" style={{ marginBottom: 16 }}>
                <div className="settings-epg-icon" aria-hidden>
                  <Server size={22} strokeWidth={1.8} />
                </div>
                <div className="settings-epg-copy">
                  <strong>Atualizar servidor</strong>
                  <span>
                    {catalogRefreshing
                      ? 'Baixando canais, filmes e séries desta lista…'
                      : hasActivePlaylist
                        ? 'Recarrega o catálogo da playlist ativa a partir do servidor'
                        : 'Nenhuma playlist ativa para atualizar'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`primary settings-epg-btn${catalogRefreshing ? ' is-busy' : ''}`}
                  onClick={onRefreshCatalog}
                  disabled={catalogRefreshing || !hasActivePlaylist}
                >
                  <RotateCcw size={15} className={catalogRefreshing ? ' spin' : undefined} />
                  {catalogRefreshing ? 'Atualizando…' : 'Atualizar servidor'}
                </button>
              </div>
              <div className="settings-epg-box">
                <div className="settings-epg-icon" aria-hidden>
                  <Download size={22} strokeWidth={1.8} />
                </div>
                <div className="settings-epg-copy">
                  <strong>Versão do app</strong>
                  <span>
                    {updaterStatus?.portable
                      ? 'Versão portátil — não se atualiza sozinha'
                      : updaterStatus?.dev
                        ? 'Disponível só no app instalado'
                        : updaterStatus?.current
                          ? `Instalada: ${updaterStatus.current}`
                          : 'Verificando…'}
                  </span>
                </div>
                {updaterStatus?.portable ? (
                  <button
                    type="button"
                    className="primary settings-update-btn"
                    onClick={onOpenReleases}
                  >
                    <Download size={15} />
                    Baixar instalador
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`primary settings-update-btn${updaterChecking ? ' is-busy' : ''}`}
                    onClick={onCheckUpdates}
                    disabled={updaterChecking || updaterStatus?.dev}
                  >
                    <RotateCcw size={15} className={updaterChecking ? 'spin' : undefined} />
                    {updaterChecking ? 'Verificando…' : 'Verificar agora'}
                  </button>
                )}
                {updaterChecking && updaterProgress > 0 && (
                  <div className="settings-update-progress">
                    <div style={{ width: `${updaterProgress}%` }} />
                  </div>
                )}
              </div>
              {/*
                A caixa de "reiniciar" segue `disponivelParaInstalar`, e nao a fase
                do cartaz. Sao coisas diferentes de proposito: o cartaz se fecha
                em 10 s, mas o instalador continua esperando ate a pessoa decidir.
                Se esta caixa dependesse do cartaz, sumiria junto com ele.

                O campo vem do estado em disco do main, entao a caixa acende
                assim que o download termina e NAO depende de ninguem clicar em
                "Verificar agora" para reaparecer.
              */}
              {updaterStatus?.disponivelParaInstalar && updaterStatus.installing === false && !updaterStatus.portable && (
                <div className="settings-epg-box" style={{ marginTop: 12 }}>
                  <div className="settings-epg-copy">
                    <strong>
                      Atualização {updaterToast.version || updaterStatus.shownVersion} pronta
                    </strong>
                    <span>
                      Reiniciar para instalar. O instalador vai abrir e pedir confirmação — leva
                      cerca de 15 segundos.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="primary settings-update-btn"
                    onClick={onInstallUpdate}
                  >
                    <RotateCcw size={15} />
                    Reiniciar agora
                  </button>
                </div>
              )}
            </div>
          )}

          {section === 'parental' && (
            <div className="settings-card parental-card">
              <div className="parental-card-head">
                <div className="parental-card-copy">
                  <h3>Controle parental</h3>
                  <p className="muted">
                    Senha de <strong>4 dígitos</strong> para ocultar categorias adultas. Sem a senha, ninguém abre esse
                    conteúdo.
                  </p>
                </div>
                <button
                  type="button"
                  className={`parental-clear-top${settings.parentalPin ? '' : ' is-empty'}${pinMode === 'reset' ? ' is-active' : ''}`}
                  title={settings.parentalPin ? 'Limpar senha' : 'Nenhuma senha salva ainda'}
                  aria-label={settings.parentalPin ? 'Limpar senha' : 'Nenhuma senha salva ainda'}
                  disabled={!settings.parentalPin}
                  onClick={() => {
                    if (!settings.parentalPin) return
                    setPinMode('reset')
                    setResetStep(false)
                    setPinError(null)
                    setPinOk(null)
                  }}
                >
                  <span className="parental-clear-emote" aria-hidden>
                    🗝️
                  </span>
                </button>
              </div>

              <div className={`parental-status${settings.parentalPin ? ' is-on' : ''}`}>
                <div className="parental-status-icon" aria-hidden>
                  {settings.parentalPin ? (
                    parentalUnlocked ? (
                      <span className="parental-status-emote">🔓</span>
                    ) : (
                      <span className="parental-status-emote">🔒</span>
                    )
                  ) : (
                    <span className="parental-status-emote">🔓</span>
                  )}
                </div>
                <div className="parental-status-copy">
                  <strong>{settings.parentalPin ? 'Proteção ativa' : 'Proteção desligada'}</strong>
                  <span>
                    {settings.parentalPin
                      ? parentalUnlocked
                        ? 'Adulto desbloqueado nesta sessão'
                        : 'Categorias adultas ocultas até digitar a senha'
                      : 'Crie uma senha de 4 números para ativar'}
                  </span>
                </div>
              </div>

              {settings.parentalPin && (
                <div className="parental-session-actions">
                  {parentalUnlocked ? (
                    <button type="button" className="ghost" onClick={onLockAdult}>
                      <Lock size={14} />
                      Bloquear de novo
                    </button>
                  ) : (
                    <button type="button" className="primary parental-btn" onClick={onUnlockAdult}>
                      <Unlock size={14} />
                      Desbloquear sessão
                    </button>
                  )}
                </div>
              )}

              <div className="parental-form">
                {settings.parentalPin && pinMode !== 'reset' && (
                  <div className="playlist-segment parental-mode-tabs" role="tablist" aria-label="Ação da senha">
                    <button
                      type="button"
                      className={pinMode === 'change' || pinMode === 'create' ? 'active' : ''}
                      onClick={() => {
                        setPinMode('change')
                        setResetStep(false)
                        setPinError(null)
                        setPinOk(null)
                      }}
                    >
                      Trocar senha
                    </button>
                    <button
                      type="button"
                      className={pinMode === 'disable' ? 'active' : ''}
                      onClick={() => {
                        setPinMode('disable')
                        setResetStep(false)
                        setPinError(null)
                        setPinOk(null)
                      }}
                    >
                      Desativar
                    </button>
                  </div>
                )}

                {settings.parentalPin && (pinMode === 'change' || pinMode === 'disable') && (
                  <div className="field">
                    <label>Senha atual</label>
                    <input
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={4}
                      value={pinCurrent}
                      onChange={(e) => setPinCurrent(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="••••"
                    />
                  </div>
                )}

                {settings.parentalPin && pinMode === 'reset' && (
                  <div className="parental-reset-box">
                    <p>
                      <span aria-hidden>🔓 </span>
                      Isso <strong>quebra / apaga a senha atual</strong> sem pedir os 4 dígitos. Depois você cria outra
                      ou deixa vazio.
                    </p>
                    {!resetStep ? (
                      <button
                        type="button"
                        className="ghost parental-reset-btn"
                        onClick={() => {
                          setResetStep(true)
                          setPinError(null)
                          setPinOk(null)
                        }}
                      >
                        <span aria-hidden>🔓</span> Quero limpar a senha
                      </button>
                    ) : (
                      <div className="parental-reset-confirm">
                        <span>Confirma limpar a senha agora?</span>
                        <div className="row" style={{ gap: 8 }}>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              setResetStep(false)
                              setPinMode('change')
                            }}
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              onChange({ parentalPin: undefined })
                              onLockAdult()
                              setPinCurrent('')
                              setPinDraft('')
                              setPinConfirm('')
                              setResetStep(false)
                              setPinMode('create')
                              setPinError(null)
                              setPinOk('Senha apagada 🔓 — crie uma nova ou deixe vazio.')
                            }}
                          >
                            <span aria-hidden>🔓</span> Limpar senha
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(!settings.parentalPin || pinMode === 'change' || pinMode === 'create') &&
                  pinMode !== 'disable' &&
                  pinMode !== 'reset' && (
                  <>
                    <div className="field">
                      <label>{settings.parentalPin ? 'Nova senha (4 dígitos)' : 'Senha (4 dígitos)'}</label>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        value={pinDraft}
                        onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••"
                      />
                    </div>
                    <div className="field">
                      <label>Confirmar senha</label>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        value={pinConfirm}
                        onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••"
                      />
                    </div>
                  </>
                )}

                {pinError && <div className="error">{pinError}</div>}
                {pinOk && <div className="parental-ok">{pinOk}</div>}

                {pinMode !== 'reset' && (
                <div className="playlist-actions">
                  <button
                    type="button"
                    className="primary parental-btn"
                    onClick={() => {
                      setPinError(null)
                      setPinOk(null)
                      const isFour = (value: string) => /^\d{4}$/.test(value)

                      if (!settings.parentalPin) {
                        if (!isFour(pinDraft) || !isFour(pinConfirm)) {
                          setPinError('A senha precisa ter exatamente 4 números.')
                          return
                        }
                        if (pinDraft !== pinConfirm) {
                          setPinError('As senhas não conferem.')
                          return
                        }
                        onChange({ parentalPin: pinDraft })
                        onLockAdult()
                        setPinDraft('')
                        setPinConfirm('')
                        setPinOk('Controle parental ativado 🔒')
                        return
                      }

                      if (pinMode === 'disable') {
                        if (pinCurrent !== settings.parentalPin) {
                          setPinError('Senha atual incorreta.')
                          return
                        }
                        onChange({ parentalPin: undefined })
                        onLockAdult()
                        setPinCurrent('')
                        setPinMode('create')
                        setPinOk('Controle parental desativado 🔓')
                        return
                      }

                      if (pinCurrent !== settings.parentalPin) {
                        setPinError('Senha atual incorreta.')
                        return
                      }
                      if (!isFour(pinDraft) || !isFour(pinConfirm)) {
                        setPinError('A nova senha precisa ter exatamente 4 números.')
                        return
                      }
                      if (pinDraft !== pinConfirm) {
                        setPinError('As senhas não conferem.')
                        return
                      }
                      onChange({ parentalPin: pinDraft })
                      onLockAdult()
                      setPinCurrent('')
                      setPinDraft('')
                      setPinConfirm('')
                      setPinOk('Senha atualizada 🔒')
                    }}
                  >
                    {!settings.parentalPin
                      ? 'Ativar controle parental'
                      : pinMode === 'disable'
                        ? 'Desativar proteção'
                        : 'Salvar nova senha'}
                  </button>
                </div>
                )}
              </div>
            </div>
          )}

          {section === 'storage' && (
            <div className="settings-card">
              <h3>Armazenamento</h3>
                

              <div className="settings-download-folder">
                <h4 className="storage-subhead">Pasta de downloads</h4>
                <p className="muted">Filmes e episódios baixados são salvos nesta pasta.</p>
                <div className="settings-download-path">
                  <FolderOpen size={16} />
                  <span title={settings.downloadFolder || 'Pasta padrão'}>
                    {settings.downloadFolder || 'Pasta padrão do sistema'}
                  </span>
                </div>
                <div className="settings-download-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      void window.sturplay?.downloads?.pickFolder?.().then((res) => {
                        if (res?.ok && res.path) onChange({ downloadFolder: res.path })
                      })
                    }}
                  >
                    Alterar pasta
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void window.sturplay?.downloads?.openFolder?.(settings.downloadFolder)}
                  >
                    Abrir pasta
                  </button>
                </div>
              </div>

              <div className="storage-total">
                <span className="storage-total-label">Total em uso</span>
                <strong className="storage-total-value">
                  {storageBusy ? '…' : formatBytes(storageBytes.total)}
                </strong>
                <div className="storage-breakdown">
                  <span>Preferências / histórico: {formatBytes(storageBytes.local)}</span>
                  <span>Catálogo em disco: {formatBytes(storageBytes.disk)}</span>
                </div>
                <button type="button" className="ghost storage-refresh" onClick={() => void refreshStorage()} disabled={storageBusy}>
                  <RotateCcw size={14} />
                  Atualizar tamanho
                </button>
              </div>

              <h4 className="storage-subhead">Histórico</h4>
              <div className="cache-grid">
                <button type="button" className="cache-card-btn" onClick={() => setHistoryKind('movie')}>
                  <Clapperboard size={22} className="cache-icon" strokeWidth={1.75} />
                  <span className="cache-card-title">Filmes</span>
                  <span className="cache-card-count">{movieHistory.length}</span>
                </button>
                <button type="button" className="cache-card-btn" onClick={() => setHistoryKind('series')}>
                  <MonitorPlay size={22} className="cache-icon" strokeWidth={1.75} />
                  <span className="cache-card-title">Séries</span>
                  <span className="cache-card-count">{seriesHistory.length}</span>
                </button>
                <button
                  type="button"
                  className="cache-card-btn"
                  onClick={() => {
                    setRecentLive(loadRecentLiveChannels())
                    setHistoryKind('live')
                  }}
                >
                  <Tv size={22} className="cache-icon" strokeWidth={1.75} />
                  <span className="cache-card-title">Ao vivo</span>
                  <span className="cache-card-count">{recentLive.length}</span>
                </button>
                <button
                  type="button"
                  className="cache-card-btn cache-card-danger"
                  onClick={() => {
                    onClearAllHistory()
                    setRecentLive([])
                    setCacheFeedback('all')
                    setTimeout(() => setCacheFeedback(null), 2000)
                    void refreshStorage()
                  }}
                >
                  <Eraser size={22} className="cache-icon" strokeWidth={1.75} />
                  <span className="cache-card-title">
                    {cacheFeedback === 'all' ? 'Histórico limpo ✓' : 'Limpar histórico'}
                  </span>
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {historyKind && (
        <div className="history-modal-backdrop" onClick={() => setHistoryKind(null)}>
          <div
            className="history-modal"
            role="dialog"
            aria-modal="true"
            aria-label={historyTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="history-modal-head">
              <h3>{historyTitle}</h3>
              <div className="history-modal-actions">
                {historyCount > 0 && (
                  <button
                    type="button"
                    className="history-modal-clear"
                    onClick={clearCurrentHistory}
                  >
                    <Trash2 size={14} />
                    Limpar tudo
                  </button>
                )}
                <button type="button" className="icon-button" onClick={() => setHistoryKind(null)} aria-label="Fechar">
                  <X size={18} />
                </button>
              </div>
            </div>

            {historyKind === 'live' ? (
              recentLive.length === 0 ? (
                <p className="muted history-empty">Nenhum canal recente.</p>
              ) : (
                <ul className="history-list">
                  {recentLive.map((channel) => (
                    <li key={channel.id} className="history-item">
                      <div className="history-item-cover">
                        <Cover src={channel.logo} small live />
                      </div>
                      <div className="history-item-meta">
                        <strong title={channel.name}>{channel.name}</strong>
                        <span>{channel.group || 'Ao vivo'}</span>
                      </div>
                      <button
                        type="button"
                        className="history-item-delete"
                        title="Excluir"
                        aria-label={`Excluir ${channel.name}`}
                        onClick={() => {
                          onRemoveRecentLive(channel.id)
                          setRecentLive((prev) => prev.filter((item) => item.id !== channel.id))
                          void refreshStorage()
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (historyKind === 'movie' ? movieHistory : seriesHistory).length === 0 ? (
              <p className="muted history-empty">Nada no histórico.</p>
            ) : (
              <ul className="history-list">
                {(historyKind === 'movie' ? movieHistory : seriesHistory).map((item) => {
                  const title = item.seriesName || item.channel.seriesName || item.channel.name
                  const logo = item.seriesLogo || item.channel.seriesLogo || item.channel.logo
                  const subtitle =
                    item.episodeName ||
                    item.channel.group ||
                    (item.duration > 0
                      ? `${Math.round((item.currentTime / item.duration) * 100)}% assistido`
                      : 'Continuar assistindo')
                  return (
                    <li key={`${item.playlistId}-${item.channel.id}-${item.seriesId || ''}`} className="history-item">
                      <div className="history-item-cover">
                        <Cover src={logo} small />
                      </div>
                      <div className="history-item-meta">
                        <strong title={title}>{title}</strong>
                        <span>{subtitle}</span>
                      </div>
                      <button
                        type="button"
                        className="history-item-delete"
                        title="Excluir"
                        aria-label={`Excluir ${title}`}
                        onClick={() => {
                          onRemoveContinueItem(item.channel.id, item.seriesId)
                          void refreshStorage()
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const PRIORITY_KEYWORDS: Record<ContentKind, string[][]> = {
  movie: [
    ['TREND'], // 1st: TREND FILMES, TRENDING, etc.
    ['OSCAR'], // 2nd: OSCAR 2026, OSCAR
    ['UHD', '4K'], // 3rd: UHD | 4K, 4K ULTRA HD
    ['CINEMA'], // 4th: CINEMA, CINE NOSTALGIA
    ['LANCAMENTO', 'ESTREIA', 'NOVIDADE'], // 5th: LANÇAMENTOS
  ],
  series: [
    ['TREND'], // 1st: TREND SERIES, TREND SÉRIES, TRENDING
    ['LANCAMENTO', 'ESTREIA', 'NOVIDADE'], // 2nd: LANÇAMENTOS
    ['UHD', '4K'], // 3rd: 4K, UHD
    ['NETFLIX', 'HBO', 'MAX', 'AMAZON', 'PRIME', 'DISNEY', 'APPLE', 'GLOBOPLAY', 'PARAMOUNT'],
  ],
  live: [
    ['UHD', '4K'],
    ['ABERTO'],
    ['ESPORTE', 'FUTEBOL'],
    ['PREMIERE'],
  ],
}

function normalizeForMatching(text?: string) {
  if (!text) return ''
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeForSearch(text?: string) {
  if (!text) return ''
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function searchWords(text: string): string[] {
  return normalizeForSearch(text)
    .split(/\s+/)
    .filter((w) => w.length >= 2)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

function searchWordMatches(hay: string, word: string): boolean {
  if (word.length < 2) return true
  if (hay.includes(word)) return true
  const parts = hay.split(/\s+/).filter(Boolean)
  for (const part of parts) {
    if (part.startsWith(word) || word.startsWith(part)) return true
    if (word.length >= 4 && part.length >= 4 && levenshtein(part, word) <= 1) return true
  }
  return false
}

/** Pontuação de busca: ignora acento; tolera 1 letra errada em palavras longas. */
function searchMatchScore(channel: Channel, query: string, haystack?: string): number {
  const q = normalizeForSearch(query)
  if (!q) return 0

  const title = normalizeForSearch(channel.name || '')
  const hay =
    haystack ||
    normalizeForSearch(
      `${titleWithYear(channel.name, channel.releasedate)} ${channel.name || ''} ${channel.group || ''} ${channel.releasedate || ''}`,
    )
  const hayCompact = hay.replace(/\s+/g, '')
  const qCompact = q.replace(/\s+/g, '')

  const words = searchWords(query)
  // `searchWords` descarta tokens de 1 letra, porque uma letra sozinha casa com
  // quase tudo e a distancia de edicao nao faz sentido com 1 caractere. Mas
  // DESCARTAR a consulta inteira era o pior dos dois mundos: digitar "a" dava
  // score 0 para todos os canais e a tela dizia "nenhum item encontrado" com
  // 8.271 series carregadas.
  //
  // Aqui a query curta vira busca por substring, com pontuacao baixa e
  // ordenacao por posicao — "a" traz os titulos que comecam com "a" primeiro,
  // que e o que quem digita espera.
  if (words.length === 0) {
    if (!q) return 0
    if (title.startsWith(q)) return 400
    if (title.includes(q)) return 300
    if (hay.includes(q)) return 200
    if (hayCompact.includes(qCompact)) return 100
    return 0
  }

  const phraseHit = hay.includes(q) || hayCompact.includes(qCompact)
  const allWordsInTitle = words.every((w) => searchWordMatches(title, w))
  const allWordsInHay = words.every((w) => searchWordMatches(hay, w))

  if (!phraseHit && !allWordsInHay) return 0

  if (title === q || hayCompact === qCompact) return 10_000
  if (title.startsWith(q) || hayCompact.startsWith(qCompact)) return 9_000
  if (new RegExp(`(^|\\s)${q.replace(/\s+/g, '\\s+')}(\\s|$)`).test(title)) return 8_500
  if (allWordsInTitle && words.length > 1) return 8_000
  if (phraseHit) {
    const idx = title.indexOf(q)
    if (idx >= 0) {
      const atWordStart = idx === 0 || !/[a-z0-9]/.test(title[idx - 1] || '')
      if (atWordStart) return 7_500
    }
    if (hay.includes(q)) return 7_000
    return 3_000
  }
  if (allWordsInTitle) return 7_000
  if (allWordsInHay) return 5_000
  return 1_000
}

function sortSearchResults(items: Channel[], query: string, hayById: Map<string, string>): Channel[] {
  const q = query.trim()
  if (!q) return items
  return [...items].sort((a, b) => {
    const scoreA = searchMatchScore(a, q, hayById.get(a.id))
    const scoreB = searchMatchScore(b, q, hayById.get(b.id))
    if (scoreB !== scoreA) return scoreB - scoreA
    return normalizeForSearch(a.name).localeCompare(normalizeForSearch(b.name), 'pt-BR')
  })
}

/** URL do catálogo atual (continuar assistindo pode ter link antigo salvo). */
function freshenChannel(
  channel: Channel,
  catalogs: { live: Channel[]; movie: Channel[]; series: Channel[] },
): Channel {
  const pool =
    channel.kind === 'live' ? catalogs.live : channel.kind === 'series' ? catalogs.series : catalogs.movie
  const hit = pool.find(
    (c) =>
      c.id === channel.id ||
      (channel.streamId && c.streamId && String(c.streamId) === String(channel.streamId)),
  )
  if (!hit) return channel
  return { ...channel, url: hit.url, logo: hit.logo ?? channel.logo, name: hit.name || channel.name }
}

/** Contagem/filtro de categoria: nome exato ou soft-match (COMEDIA≈COMÉDIA). */
function channelInGroup(channel: Channel, groupName: string, serverCategories: XtreamCategory[] = []) {
  if (channel.group === groupName) return true
  const cat = serverCategories.find((c) => c.name === groupName)
  if (cat?.id && channel.categoryId && String(channel.categoryId) === String(cat.id)) return true
  const a = normalizeForMatching(channel.group)
  const b = normalizeForMatching(groupName)
  if (!a || !b) return false
  if (a === b) return true
  if (a.replace(/S$/, '') === b.replace(/S$/, '')) return true
  return false
}

function isAdultGroup(group?: string): boolean {
  if (!group) return false
  // `ADULT` sem o `O` final e o que faltava. O painel deste provedor nomeia as
  // categorias em ingles: "ADULT SWIN", "ADULT SWIN 4K", "ADULT SWIN UHD". Com
  // so `ADULTO|ADULTA` no padrao, essas tres passavam como categoria comum: a
  // categoria trancada nao aparecia na coluna e os canais apareciam dentro de
  // "CANAIS 4K" — que e a falha observada.
  //
  // O limite de palavra e obrigatorio: `ADULT` cru pega "ADULTADO", e o resto
  // do padrao ja usa `\b` justamente para isso.
  return /\bADULT\b|\bADULTO\b|\bADULTA\b|\+18|18\+|XXX|ONLYFANS|ONLY\s*FANS|PRIVACY|PORNO|PORNÔ|PORN|HENTAI|SEXTREME|EROTIC|PRIVE|PRIVÊ|CINE\s*PRIV|BRAZZER|BANG\s*BROS|BANGBROS|VIXEN|BLACKED|TUSHY|SWEET\s*SINNER|EVIL\s*ANGEL|PLAYBOY|VENUS|FETISH|FETICHE|REDLIGHT|SEXXX|HARDCORE|SOFTCORE/i.test(
    group,
  )
}

function isAdultChannel(channel?: Channel): boolean {
  if (!channel) return false
  if (isAdultGroup(channel.group) || isAdultGroup(channel.name)) return true
  // Prefixo comum no painel: [XXX], (XXX), XXX -
  return /(?:^|[\s\[\(\-_])XXX(?:$|[\s\]\)\-_])/i.test(String(channel.name || ''))
}

/** Mantém a ordem interna; só empurra conteúdo adulto para o fim. */
function moveAdultToEnd(items: Channel[]): Channel[] {
  if (items.length < 2) return items
  const normal: Channel[] = []
  const adult: Channel[] = []
  for (const item of items) {
    if (isAdultChannel(item)) adult.push(item)
    else normal.push(item)
  }
  if (adult.length === 0) return items
  return [...normal, ...adult]
}

function recentlyAddedMovies(items: Channel[], meta?: Map<string, ChannelSortMeta> | null): Channel[] {
  return items
    .filter((channel) => !isAdultChannel(channel))
    .sort((a, b) => {
      const timeA = meta?.get(a.id)?.added || getItemAddedTime(a)
      const timeB = meta?.get(b.id)?.added || getItemAddedTime(b)
      if (timeA !== timeB) return timeB - timeA
      return 0
    })
    .slice(0, 100)
}

function matchTrendChannels(channels: Channel[], kind: 'movie' | 'series'): Channel[] {
  const exact = channels.filter((c) => normalizeForMatching(c.group).includes('TREND'))
  if (exact.length > 0) return exact
  if (kind === 'movie') {
    return channels.filter((c) => {
      const g = normalizeForMatching(c.group)
      return (
        g.includes('OSCAR') ||
        g.includes('LANCAMENTO') ||
        g.includes('CINEMA') ||
        g.includes('ESTREIA') ||
        /\b(2026|2025)\b/.test(c.name)
      )
    })
  }
  return channels.filter((c) => {
    const g = normalizeForMatching(c.group)
    return (
      g.includes('LANCAMENTO') ||
      g.includes('ESTREIA') ||
      g.includes('NETFLIX') ||
      g.includes('HBO') ||
      g.includes('PRIME') ||
      /\b(2026|2025)\b/.test(c.name)
    )
  })
}



function isTrendMovieGroup(channel: Channel): boolean {
  return normalizeForMatching(channel.group).includes('TREND')
}

/** Carrossel do Início: só TREND / UHD·4K e sem adulto. */
function matchHeroFeaturedMovies(movies: Channel[]): Channel[] {
  const seen = new Set<string>()
  const out: Channel[] = []
  const push = (items: Channel[]) => {
    for (const item of items) {
      if (!item || item.kind === 'series' || seen.has(item.id) || isAdultChannel(item)) continue
      if (!isTrendMovieGroup(item) && !isUhd4kChannel(item)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  push(movies.filter(isTrendMovieGroup))
  push(movies.filter(isUhd4kChannel))
  return out
}

function heroQualityLabel(channel: Channel): string | null {
  if (isUhd4kChannel(channel)) return '4K · UHD'
  if (isTrendMovieGroup(channel)) return 'Trend'
  return null
}

function truncateDisplayTitle(title: string, max = 30): string {
  const clean = String(title || '')
    .replace(/\s*\[[^\]]+\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

function recommendSimilarMovies(
  anchor: Channel,
  pool: Channel[],
  usedIds: Set<string>,
  limit = 18,
): Channel[] {
  const anchorGroup = normalizeForMatching(anchor.group || '')
  const anchorTokens = new Set(
    normalizeForMatching(anchor.name || '')
      .split(' ')
      .filter((token) => token.length >= 4),
  )

  const scored = pool
    .filter((item) => item.id !== anchor.id && !usedIds.has(item.id) && !isAdultChannel(item))
    .map((item) => {
      const group = normalizeForMatching(item.group || '')
      let score = movieRatingValue(item) * 2
      if (anchorGroup && group === anchorGroup) score += 60
      else if (anchorGroup && group.includes(anchorGroup.slice(0, Math.min(8, anchorGroup.length)))) score += 28
      if (isTrendMovieGroup(item)) score += 8
      if (isUhd4kChannel(item)) score += 4
      for (const token of anchorTokens) {
        if (group.includes(token)) score += 6
      }
      return { item, score }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || movieRatingValue(b.item) - movieRatingValue(a.item))

  const picks: Channel[] = []
  for (const row of scored) {
    picks.push(row.item)
    usedIds.add(row.item.id)
    if (picks.length >= limit) break
  }

  if (picks.length < 8) {
    const fallback = [...pool]
      .filter((item) => item.id !== anchor.id && !usedIds.has(item.id) && !isAdultChannel(item))
      .sort((a, b) => movieRatingValue(b) - movieRatingValue(a) || String(a.name).localeCompare(String(b.name), 'pt-BR'))
    for (const item of fallback) {
      picks.push(item)
      usedIds.add(item.id)
      if (picks.length >= limit) break
    }
  }

  return picks
}

type HomeRecommendationRow = {
  title: string
  items: Channel[]
}

function buildHomeRecommendationRows(
  continueWatching: ContinueWatching[],
  movies: Channel[],
  series: Channel[],
): HomeRecommendationRow[] {
  const pool = [...movies, ...series]
  const usedIds = new Set<string>()
  const latest = [...continueWatching]
    .filter((item) => item.channel.kind === 'movie' || item.channel.kind === 'series')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]

  if (!latest) return []

  const anchor = latest.channel
  const anchorTitle = latest.seriesName || anchor.seriesName || anchor.name
  const picks = recommendSimilarMovies(anchor, pool, usedIds, 18)
  if (picks.length < 3) return []

  return [
    {
      title: `Porque você assistiu '${truncateDisplayTitle(anchorTitle)}'`,
      items: picks,
    },
  ]
}

/** Ano no título tipo "Blade Runner 2049" não é lançamento — só vale (2023) e datas reais. */
const MAX_PLAUSIBLE_YEAR = new Date().getFullYear() + 1

function yearIsPlausible(year: number): boolean {
  return year >= 1900 && year <= MAX_PLAUSIBLE_YEAR
}

function extractYearFromText(...sources: Array<string | number | undefined | null>): string | undefined {
  for (const source of sources) {
    if (source === undefined || source === null || source === '') continue
    const match = String(source).match(/\b((?:19|20)\d{2})\b/)
    if (!match) continue
    const year = parseInt(match[1], 10)
    if (yearIsPlausible(year)) return match[1]
  }
  return undefined
}

function extractParentheticalYear(name?: string): string | undefined {
  if (!name) return undefined
  const matches = [...String(name).matchAll(/\(\s*((?:19|20)\d{2})\s*\)/g)]
  if (matches.length === 0) return undefined
  const year = parseInt(matches[matches.length - 1][1], 10)
  return yearIsPlausible(year) ? String(year) : undefined
}

/** Replay de F1/GP no catálogo de filmes — não deve ocupar o topo do Padrão. */
function isVodSportsDump(channel: Channel): boolean {
  const hay = normalizeForMatching(`${channel.name || ''} ${channel.group || ''}`)
  if (/FORMULA\s*1|\bF1\b|MOTO\s*GP|NASCAR|INDYCAR|\bWEC\b/.test(hay)) return true
  if (/GRAND PRIX/.test(hay)) return true
  if (/\bROUND\s+\d+\b/.test(hay) && /\b(TL\d|QUALI|QUALIFYING|CORRIDA|GP)\b/.test(hay)) return true
  return false
}

/** Mostra o ano no nome se existir (1967, 2021, 2026…), sem inventar nem duplicar. */
function titleWithYear(name: string, ...yearSources: Array<string | number | undefined | null>): string {
  let base = String(name || '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim()
  if (!base) return base

  // Já veio "Título (2026) (2026)" do cache/painel → fica um só
  const yearSuffixes = [...base.matchAll(/\(\s*((?:19|20)\d{2})\s*\)/g)].map((m) => m[1])
  if (yearSuffixes.length > 0) {
    const year = yearSuffixes[yearSuffixes.length - 1]
    const withoutYears = base.replace(/\s*\(\s*(?:19|20)\d{2}\s*\)/g, '').trim()
    return `${withoutYears} (${year})`
  }

  const year = extractYearFromText(...yearSources)
  if (!year) return base
  return `${base} (${year})`
}

function getItemAddedTime(channel?: Channel): number {
  if (!channel) return 0
  if (channel.added !== undefined && channel.added !== null && channel.added !== '') {
    const raw = String(channel.added).trim()
    const num = Number(raw)
    if (!isNaN(num) && num > 1000000) {
      return num < 10000000000 ? num * 1000 : num
    }
    const parsed = Date.parse(raw)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return 0
}

function getItemReleaseTime(channel?: Channel): number {
  if (!channel) return 0
  // 1. Campo Lançamento completo (ano-mês-dia)
  if (channel.releasedate) {
    const raw = String(channel.releasedate).trim()
    const parsed = Date.parse(raw)
    if (!isNaN(parsed) && parsed > 0) {
      const year = new Date(parsed).getUTCFullYear()
      if (yearIsPlausible(year)) return parsed
    }
    const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/)
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10)
      if (yearIsPlausible(year)) return Date.UTC(year, 0, 1)
    }
  }
  // 2. Só ano entre parênteses no nome — "2049" / "Formula 1 2025" no meio do título não conta
  const fromName = extractParentheticalYear(channel.name)
  if (fromName) return Date.UTC(parseInt(fromName, 10), 0, 1)
  return 0
}

/** Nome limpo pra A-Z (ignora "...", "+", "007 -" / "007 Título" no começo — igual leitura das séries). */
function sortCleanName(name?: string): string {
  return String(name || '')
    .replace(/^[\s.…·•]+/, '')
    .replace(/^\++\s*/, '')
    .replace(/^\d{1,4}(?:\.\d{3})*(?:\s*[-–.:)])?\s+/, '')
    .replace(/^[#([\s\-_]+/, '')
    .trim()
}

type ChannelSortMeta = {
  cleanName: string
  release: number
  rating: number
  added: number
  sportsDump: boolean
  hasPlot: boolean
}

function hasContentDescription(channel: Channel): boolean {
  const plot = String(channel.plot || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (plot.length < 12) return false
  return !/^(n\/a|na|null|undefined|-|sem (sinopse|descricao|descrição))$/i.test(plot)
}

function buildChannelSortMeta(channels: Channel[]): Map<string, ChannelSortMeta> {
  const map = new Map<string, ChannelSortMeta>()
  for (const channel of channels) {
    map.set(channel.id, {
      cleanName: sortCleanName(channel.name).toLocaleLowerCase('pt-BR'),
      release: getItemReleaseTime(channel),
      rating: parseFloat(String(channel.rating || '0').replace(',', '.')) || 0,
      added: getItemAddedTime(channel),
      sportsDump: isVodSportsDump(channel),
      hasPlot: hasContentDescription(channel),
    })
  }
  return map
}

const EMPTY_SORT_META: ChannelSortMeta = {
  cleanName: '',
  release: 0,
  rating: 0,
  added: 0,
  sportsDump: false,
  hasPlot: false,
}

function applyChannelSorting(
  items: Channel[],
  mode: SortMode,
  meta?: Map<string, ChannelSortMeta>,
): Channel[] {
  if (items.length <= 1) return items
  const arr = items.slice()
  const get = (channel: Channel) => meta?.get(channel.id) ?? EMPTY_SORT_META

  switch (mode) {
    case 'az':
      arr.sort((a, b) => get(a).cleanName.localeCompare(get(b).cleanName, 'pt-BR'))
      return arr
    case 'za':
      arr.sort((a, b) => get(b).cleanName.localeCompare(get(a).cleanName, 'pt-BR'))
      return arr
    case 'rating':
      arr.sort((a, b) => {
        const ma = get(a)
        const mb = get(b)
        if (ma.rating !== mb.rating) return mb.rating - ma.rating
        return ma.cleanName.localeCompare(mb.cleanName, 'pt-BR')
      })
      return arr
    case 'newest':
      arr.sort((a, b) => {
        const ma = get(a)
        const mb = get(b)
        const timeA = ma.release > 0 ? ma.release : 0
        const timeB = mb.release > 0 ? mb.release : 0
        if (timeA !== timeB) return timeB - timeA
        return ma.cleanName.localeCompare(mb.cleanName, 'pt-BR')
      })
      return arr
    case 'default':
    default:
      // Ordem que o servidor mandou. Só empurra replay de F1/GP pro fim.
      arr.sort((a, b) => {
        const dumpA = get(a).sportsDump
        const dumpB = get(b).sportsDump
        if (dumpA !== dumpB) return dumpA ? 1 : -1
        return 0
      })
      return arr
  }
}

function Browse({
  kind,
  playlist,
  channels,
  serverCategories = [],
  groupLoading = false,
  favorites,
  continueWatching,
  selectedGroup,
  onSelectGroup,
  parentalLocked = false,
  onUnlockAdult,
  savedScroll,
  onSaveScroll,
  query: queryProp,
  onQueryChange,
  sortMode,
  onSortMode,
  onToggleFavorite,
  onRemoveContinue,
  onOpen,
  onDownloadItem,
  recentLiveEpoch = 0,
  returnToId = null,
  onReturned,
  suspendLivePreview = false,
  playbackEngine = 'internal',
  detailPane = null,
  detailChannelId = null,
}: {
  kind: ContentKind
  playlist: Playlist | null
  channels: Channel[]
  serverCategories?: XtreamCategory[]
  groupLoading?: boolean
  favorites: string[]
  continueWatching: ContinueWatching[]
  selectedGroup: string
  onSelectGroup: (group: string) => void
  parentalLocked?: boolean
  onUnlockAdult?: () => void
  savedScroll: { channels: number; groups: number }
  onSaveScroll: (scroll: { channels: number; groups: number }) => void
  /** Texto da busca, controlado pelo pai para sobreviver a troca de view. */
  query?: string
  onQueryChange?: (next: string) => void
  sortMode: SortMode
  onSortMode: (mode: SortMode) => void
  onToggleFavorite: (id: string) => void
  onRemoveContinue?: (channelId: string, seriesId?: string) => void
  onOpen: (channel: Channel, list: Channel[], startTime?: number, opts?: { autoFullscreen?: boolean; autoPlay?: boolean }) => void
  onDownloadItem?: (item: DownloadedItem) => void | Promise<void>
  recentLiveEpoch?: number
  returnToId?: string | null
  onReturned?: () => void
  suspendLivePreview?: boolean
  playbackEngine?: PlaybackEngine
  detailPane?: React.ReactNode
  detailChannelId?: string | null
}) {
  const groupsRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // VirtualWindow precisa do nó como callback ref (ver virtual.tsx). O RefObject
  // continua existindo porque scroll restore, prefetch de capa e os onScroll
  // leem scrollRef.current diretamente.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollEl(node)
  }, [])
  const orderLockRef = useRef<{ key: string; ids: string[] } | null>(null)
  // Colunas: quem decide é o CSS (`repeat(auto-fill, minmax(...))`), e o valor
  // aqui é lido de volta do DOM pela janela virtual. Antes era calculado em JS com
  // um palpite inicial de 6: o primeiro paint desenhava com 6 colunas e, quando a
  // medição rodava, o número mudava e os cartões encolhiam na frente do usuário.
  // Sem palpite, sem correção visível.
  const [cols, setCols] = useState(6)
  const [compactLayout, setCompactLayout] = useState(
    () => document.documentElement.dataset.compact === 'true',
  )
  const posterRowHeightGuess = compactLayout ? 188 : 310
  const [measuredPosterRowHeight, setMeasuredPosterRowHeight] = useState(0)
  // Medido no DOM quando disponível; a estimativa é só o valor inicial.
  const posterRowHeight = measuredPosterRowHeight || posterRowHeightGuess
  const handlePosterRowHeight = useCallback((height: number) => {
    if (height > 0) setMeasuredPosterRowHeight(height)
  }, [])
  // A linha de canal ao vivo também não é constante: `--ui-pad` muda com
  // data-density, e a miniatura tem altura fixa que não segue a fonte.
  const [measuredLiveRowHeight, setMeasuredLiveRowHeight] = useState(0)
  const handleLiveRowHeight = useCallback((height: number) => {
    if (height > 0) setMeasuredLiveRowHeight(height)
  }, [])
  // rAF em curso do onScroll do grid, e o último valor de savedScroll para
  // os handlers não lerem um closure velho.
  const scrollFrameRef = useRef(0)
  const groupsFrameRef = useRef(0)
  const savedScrollRef = useRef(savedScroll)
  savedScrollRef.current = savedScroll
  useEffect(
    () => () => {
      window.cancelAnimationFrame(scrollFrameRef.current)
      window.cancelAnimationFrame(groupsFrameRef.current)
    },
    [],
  )
  const deferredSortMode = useDeferredValue(sortMode)
  // Espelho do pai. Um useState local nao sobreviveria a desmontar da grade, e
  // quem desmonta e justamente abrir a ficha.
  const [localQuery, setLocalQuery] = useState(queryProp || '')
  useEffect(() => {
    setLocalQuery(queryProp || '')
  }, [queryProp])
  const query = localQuery
  const setQuery = (next: string) => {
    setLocalQuery(next)
    onQueryChange?.(next)
  }
  const [menuChannel, setMenuChannel] = useState<Channel | null>(null)
  // channel e so para exibir o nome no modal. 	argetId e o id REAL do alvo e e
  // ele que vai para a remocao — sem essa separacao, confirmar o modal usava
  // \channel.id\ (o card do browse, ex.: 'series-123') contra um item guardado
  // com \channel.id\ de EPISODIO ('ep-456'), nao casava com nada, e o botao
  // 'Sim, remover' nao removia nada.
  const [itemToDelete, setItemToDelete] = useState<{ channel: Channel; seriesId?: string; targetId?: string } | null>(null)
  // Ocultacoes persistidas por playlist+tipo. Antes eram useState([]) local
  // desta grade: a grade desmonta a cada troca de view (abrir a ficha ja
  // bastava) e o itemVoltava sem explicacao.
  const [hiddenChannels, setHiddenChannels] = useState<string[]>(() => loadHiddenItems(playlist?.id, kind).channels)
  // Nome do que foi ocultado, para a tela de restauracao mostrar o titulo em vez
  // do id cru do catalogo.
  const [hiddenNames, setHiddenNames] = useState<Record<string, string>>(
    () => loadHiddenItems(playlist?.id, kind).names ?? {},
  )
  const [hiddenGroups, setHiddenGroups] = useState<string[]>(() => loadHiddenItems(playlist?.id, kind).groups)
  /** Folha de restaurar aberta? So o contexto atual — playlist + tipo. */
  const [folhaRestaurar, setFolhaRestaurar] = useState(false)

  /** Os ocultados deste contexto, no formato que a folha e o storage usam. */
  const ocultosDoContexto = useMemo<HiddenItems>(
    () => ({ channels: hiddenChannels, groups: hiddenGroups, names: hiddenNames }),
    [hiddenChannels, hiddenGroups, hiddenNames],
  )

  /**
   * Oculta a categoria selecionada e devolve a selecao para "Todos".
   *
   * As quatro do app nunca chegam aqui: `podeOcultarCategoria` barra, e o botao
   * nem aparece para elas. Sem o volta para "Todos" a selecao ficaria apontando
   * para uma categoria que acabou de sair da coluna.
   */
  const ocultarCategoriaAtual = () => {
    if (!podeOcultarCategoria(group)) return
    setHiddenGroups((atual) => (atual.includes(group) ? atual : [...atual, group]))
    startTransition(() => onSelectGroup('Todos'))
  }

  /**
   * Restaura o que foi marcado na folha.
   *
   * Quando a categoria selecionada era uma das restauradas, a selecao volta para
   * "Todos": senao o conteudo volta para o armazenamento mas nao aparece na
   * lista, e a pessoa conclui que o botao nao funcionou.
   */
  const restaurarSelecionados = (grupos: string[], ids: string[]) => {
    if (grupos.length) setHiddenGroups((atual) => atual.filter((g) => !grupos.includes(g)))
    if (ids.length) {
      setHiddenChannels((atual) => atual.filter((id) => !ids.includes(id)))
      setHiddenNames((atual) => {
        const copia = { ...atual }
        for (const id of ids) delete copia[id]
        return copia
      })
    }
    if (selecaoDeveVoltarParaTodos(selectedGroup, grupos)) {
      startTransition(() => onSelectGroup('Todos'))
    }
    setFolhaRestaurar(false)
  }

  /*
   * Conjuntos de busca para os ocultados. Ficam AQUI, logo acima de quem os
   * usa: a coluna filtrada (`visibleGroups`) e a selecao que volta para
   * "Todos" sao os primeiros consumidores, e um `useMemo` declarado depois
   * do uso nao compila.
   */
  const hiddenChannelSet = useMemo(() => new Set(hiddenChannels), [hiddenChannels])
  const hiddenGroupSet = useMemo(() => new Set(hiddenGroups), [hiddenGroups])

  // Trocar de playlist ou de tipo tem que recarregar o escopo certo.
  useEffect(() => {
    const next = loadHiddenItems(playlist?.id, kind)
    setHiddenChannels(next.channels)
    setHiddenGroups(next.groups)
    setHiddenNames(next.names ?? {})
  }, [playlist?.id, kind])

  useEffect(() => {
    saveHiddenItems(playlist?.id, kind, { channels: hiddenChannels, groups: hiddenGroups, names: hiddenNames })
  }, [playlist?.id, kind, hiddenChannels, hiddenGroups, hiddenNames])
  const continueItems = useMemo(
    () => continueWatching.filter((item) => item.channel.kind === kind),
    [continueWatching, kind],
  )

  const groups = useMemo(() => {
    // Categorias do servidor (Xtream) têm prioridade — evita listas fantasma vazias
    const originalOrder: string[] = []
    const seen = new Set<string>()
    if (serverCategories.length > 0) {
      for (const cat of serverCategories) {
        if (cat.name && !seen.has(cat.name)) {
          seen.add(cat.name)
          originalOrder.push(cat.name)
        }
      }
    } else {
      for (const channel of channels) {
        if (channel.group && !seen.has(channel.group)) {
          seen.add(channel.group)
          originalOrder.push(channel.group)
        }
      }
    }

    const top: string[] = ['Todos']
    if (kind !== 'live') {
      top.push('Continuar Assistindo')
    }
    if (kind === 'movie') {
      top.push('Adicionado Recentemente')
      top.push('TREND FILMES')
    } else if (kind === 'series') {
      top.push('TREND SERIES')
    }

    const added = new Set<string>(top)
    const priorityGroups: string[] = []
    const keywordGroups = PRIORITY_KEYWORDS[kind] || []

    for (const tier of keywordGroups) {
      for (const groupName of originalOrder) {
        if (!added.has(groupName) && !isAdultGroup(groupName)) {
          const norm = normalizeForMatching(groupName)
          const matches = tier.some((keyword) => norm.includes(keyword))
          if (matches) {
            priorityGroups.push(groupName)
            added.add(groupName)
          }
        }
      }
    }

    const regular = originalOrder
      .filter((g) => !added.has(g) && !isAdultGroup(g))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))

    const adult = originalOrder
      .filter((g) => !added.has(g) && isAdultGroup(g))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))

    return [...top, ...priorityGroups, ...regular, ...adult]
  }, [channels, kind, serverCategories])

  const visibleGroups = useMemo(() => {
    let lista = groups
    /*
      SO ESCONDE ADULTO QUANDO A PROTECAO ESTA TRANCADA.

      Era `if (!parentalLocked) filtrar adulto` — o oposto. Com a protecao
      DESLIGADA (sem PIN) isso apagava as 6 categorias "ADULTOS XXX" da coluna,
      enquanto `browseList` nao filtrava nada: os canais apareciam dentro de
      "CANAIS 4K". Categoria sumindo e conteudo adulto visivel ao mesmo tempo,
      que e a falha que a pessoa reportou.

      Trancado -> esconde coluna e canais, e a categoria entra como item de cadeiro.
      Desligado -> mostra tudo, que e o que nao configurar protecao significa.
    */
    if (parentalLocked) lista = lista.filter((g) => !isAdultGroup(g))
    // A COLUNA TAMBEM E FILTRADA, e nao so a grade.
    //
    // Sem isto a categoria oculta continuava listada com contagem zero, e
    // contagem zero e pior do que nao ter clicado: parece que a acao nao
    // funcionou. E como `group` abaixo resolve pela lista, a selecao volta
    // sozinha para "Todos" quando a selecionada e a categoria que sumiu.
    return categoriasVisiveis(lista, hiddenGroupSet)
  }, [groups, parentalLocked, hiddenGroupSet])

  const group = visibleGroups.includes(selectedGroup)
    ? selectedGroup
    : // Este segundo caminho existe para o cadeado de adulto: uma categoria
      // adulta some da lista enquanto trancada, mas a selecao nao pode pular
      // para "Todos" so por causa disso.
      //
      // A categoria OCULTA pela pessoa tambem nao esta em `visibleGroups` e
      // continua em `groups` — entao sem o `!hiddenGroupSet.has(...)` ela
      // entraria por aqui, e a selecao ficaria presa num alvo invisivel sem
      // nenhum sinal na tela. E o que a especificacao pede: ocultar devolve
      // para "Todos".
      groups.includes(selectedGroup) &&
      !parentalLocked &&
      !hiddenGroupSet.has(selectedGroup)
      ? selectedGroup
      : 'Todos'

  useEffect(() => {
    if (groupsRef.current && savedScroll?.groups) {
      groupsRef.current.scrollTop = savedScroll.groups
    }
    const timer = window.setTimeout(() => {
      const activeBtn = groupsRef.current?.querySelector('.group.active') as HTMLElement | null
      if (activeBtn) {
        activeBtn.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      }
    }, 40)
    return () => window.clearTimeout(timer)
  }, [group])

  // Scroll restore. Rodava UMA vez, no primeiro commit, com deps []. Em boot
  // frio, troca de playlist ou primeira visita a uma aba, o catálogo ainda
  // estava vazio (scrollHeight === 0), o browser clampava scrollTop para 0, e o
  // valor salvo sumia. Nada reaplicava quando a lista chegava. "Voltar onde
  // parei" nunca funcionou nesses casos. Agora espera o conteúdo existir, e
  // reaplica se o container ainda não consegue honoursr o offset.
  const selectGroup = (item: string) => {
    // Igual Player One: trocar categoria não mata o preview ao vivo (evita IPC sync + stop do mpv).
    startTransition(() => {
      onSelectGroup(item)
      if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: 0 })
      }
      onSaveScroll({
        channels: 0,
        groups: groupsRef.current?.scrollTop ?? savedScroll.groups,
      })
    })
  }

  const handleOpenChannel = (
    channel: Channel,
    list: Channel[],
    startTime?: number,
    opts?: { autoFullscreen?: boolean; autoPlay?: boolean },
  ) => {
    onSaveScroll({
      channels: scrollRef.current?.scrollTop ?? 0,
      groups: groupsRef.current?.scrollTop ?? 0,
    })
    onOpen(channel, list, startTime, opts)
  }

  const deferredChannels = useDeferredValue(channels)
  const deferredQuery = useDeferredValue(query)
  const search = normalizeForSearch(deferredQuery)

  useEffect(() => {
    if (selectedGroup === 'Favoritos') onSelectGroup('Todos')
  }, [selectedGroup, onSelectGroup])

  // Abre a tela na hora; índices pesados montam no próximo tick
  const [catalogReady, setCatalogReady] = useState(false)
  useEffect(() => {
    setCatalogReady(false)
    let idleId = 0
    const timer = window.setTimeout(() => {
      const ric = window.requestIdleCallback
      if (typeof ric === 'function') {
        idleId = ric(() => setCatalogReady(true), { timeout: 180 })
      } else {
        setCatalogReady(true)
      }
    }, 0)
    return () => {
      window.clearTimeout(timer)
      if (idleId && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
    }
  }, [kind])

  const searchHaystack = useMemo(() => {
    if (channels.length === 0) return null
    const map = new Map<string, string>()
    for (const channel of channels) {
      // Nome + ano na tela (titleWithYear) + releasedate — busca "2026" / "homem-aranha" como no TiviMate
      const titled = titleWithYear(channel.name, channel.releasedate)
      map.set(
        channel.id,
        normalizeForSearch(`${titled} ${channel.name || ''} ${channel.group || ''} ${channel.releasedate || ''}`),
      )
    }
    return map
  }, [channels])

  const sortMeta = useMemo(
    () => (catalogReady ? buildChannelSortMeta(channels) : null),
    [channels, catalogReady],
  )

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    // Entrada rápida: só totais baratos
    if (!catalogReady) {
      counts.set('Todos', channels.length)
      counts.set('Continuar Assistindo', continueItems.length)
      return counts
    }

    const byExactGroup = new Map<string, number>()
    const byCatId = new Map<string, number>()
    let visibleTotal = 0
    let recentCount = 0

    for (const c of channels) {
      if (hiddenChannelSet.has(c.id) || hiddenGroupSet.has(c.group)) continue
      visibleTotal += 1
      if (kind === 'movie' && !isAdultChannel(c) && (sortMeta?.get(c.id)?.added || getItemAddedTime(c)) > 0) {
        recentCount += 1
      }

      if (c.group) byExactGroup.set(c.group, (byExactGroup.get(c.group) || 0) + 1)
      if (c.categoryId != null && c.categoryId !== '') {
        const id = String(c.categoryId)
        byCatId.set(id, (byCatId.get(id) || 0) + 1)
      }
    }

    counts.set('Todos', visibleTotal)
    counts.set('Continuar Assistindo', continueItems.length)
    if (kind === 'movie') counts.set('Adicionado Recentemente', Math.min(100, recentCount))

    // TREND: uma passada leve só nas chaves de grupo
    let trendMovie = 0
    let trendSeries = 0
    for (const [groupName, n] of byExactGroup) {
      const g = normalizeForMatching(groupName)
      if (g.includes('TREND')) {
        trendMovie += n
        trendSeries += n
        continue
      }
      if (g.includes('OSCAR') || g.includes('LANCAMENTO') || g.includes('CINEMA') || g.includes('ESTREIA')) {
        trendMovie += n
      }
      if (
        g.includes('LANCAMENTO') ||
        g.includes('ESTREIA') ||
        g.includes('NETFLIX') ||
        g.includes('SERIES') && g.includes('NOVA')
      ) {
        trendSeries += n
      }
    }
    counts.set('TREND FILMES', trendMovie)
    counts.set('TREND SERIES', trendSeries)

    const catNameToId = new Map(serverCategories.map((cat) => [cat.name, String(cat.id)]))
    const normalizedGroups = new Map<string, number>()
    for (const [groupName, n] of byExactGroup) {
      const key = normalizeForMatching(groupName)
      if (!key) continue
      normalizedGroups.set(key, (normalizedGroups.get(key) || 0) + n)
      const stripped = key.replace(/S$/, '')
      if (stripped !== key) normalizedGroups.set(stripped, (normalizedGroups.get(stripped) || 0) + n)
    }

    for (const item of groups) {
      if (counts.has(item)) continue
      const catId = catNameToId.get(item)
      if (catId && byCatId.has(catId)) {
        counts.set(item, byCatId.get(catId) || 0)
        continue
      }
      if (byExactGroup.has(item)) {
        counts.set(item, byExactGroup.get(item) || 0)
        continue
      }
      const b = normalizeForMatching(item)
      const stripped = b.replace(/S$/, '')
      counts.set(item, normalizedGroups.get(b) || normalizedGroups.get(stripped) || 0)
    }

    if (kind === 'live') {
      for (const item of groups) {
        if (!isGamesAreaGroup(item)) continue
        const visible = channels.filter(
          (c) => !hiddenChannelSet.has(c.id) && !hiddenGroupSet.has(c.group),
        )
        const inGroup = visible.filter((c) => channelInGroup(c, item, serverCategories))
        counts.set(item, filterGamesAreaLiveChannels(inGroup, item).length)
      }
    }

    return counts
  }, [
    catalogReady,
    channels,
    continueItems.length,
    groups,
    hiddenChannelSet,
    hiddenGroupSet,
    kind,
    serverCategories,
    sortMeta,
  ])

  const browseList = useMemo(() => {
    const source = catalogReady ? deferredChannels : channels
    const visibleChannels = source.filter(
      (channel) =>
        !hiddenChannelSet.has(channel.id) &&
        !hiddenGroupSet.has(channel.group) &&
        !(parentalLocked && isAdultChannel(channel)),
    )

    // Primeiro paint: sem sort/adulto — virtualização mostra a tela na hora
    if (!catalogReady || !sortMeta) {
      if (group === 'Continuar Assistindo') {
        return continueItems.map((item) => ({
          ...item.channel,
          name: item.seriesName || item.channel.seriesName || item.channel.name,
          logo: item.seriesLogo || item.channel.seriesLogo || item.channel.logo,
          seriesId: item.seriesId || item.channel.seriesId,
          seriesName: item.seriesName || item.channel.seriesName,
          seriesLogo: item.seriesLogo || item.channel.seriesLogo,
        }))
      }
      if (group === 'Adicionado Recentemente' && kind === 'movie') {
        return recentlyAddedMovies(visibleChannels, sortMeta)
      }
      if (group !== 'Todos' && group !== 'TREND FILMES' && group !== 'TREND SERIES') {
        const inGroup = visibleChannels.filter((channel) => channelInGroup(channel, group, serverCategories))
        return kind === 'live' ? filterGamesAreaLiveChannels(inGroup, group) : inGroup
      }
      return kind === 'live' ? favoritesFirstById(visibleChannels, favorites) : visibleChannels
    }

    if (group === 'Todos') {
      return kind !== 'live'
        ? moveAdultToEnd(applyChannelSorting(visibleChannels, deferredSortMode, sortMeta))
        // Live em "Todos" nao passa por sort nenhum — era a ordem do painel, e um
        // canal favoritado no fim de 2.064 continuava no fim de 2.064, o que
        // anulava favoritar. A particao e estavel: os favoritos sobem
        // inteiros e os outros nao se movem, senao o usuario perde a posicao
        // da lista a cada re-render.
        : favoritesFirstById(visibleChannels, favorites)
    }
    if (group === 'Continuar Assistindo') {
      return continueItems.map((item) => ({
        ...item.channel,
        name: item.seriesName || item.channel.seriesName || item.channel.name,
        logo: item.seriesLogo || item.channel.seriesLogo || item.channel.logo,
        seriesId: item.seriesId || item.channel.seriesId,
        seriesName: item.seriesName || item.channel.seriesName,
        seriesLogo: item.seriesLogo || item.channel.seriesLogo,
      }))
    }
    if (group === 'Adicionado Recentemente' && kind === 'movie') {
      return recentlyAddedMovies(visibleChannels, sortMeta)
    }
    if (group === 'TREND FILMES') {
      return applyChannelSorting(matchTrendChannels(visibleChannels, 'movie'), deferredSortMode, sortMeta)
    }
    if (group === 'TREND SERIES') {
      return applyChannelSorting(matchTrendChannels(visibleChannels, 'series'), deferredSortMode, sortMeta)
    }
    const inGroup = visibleChannels.filter((channel) => channelInGroup(channel, group, serverCategories))
    if (kind !== 'live') return applyChannelSorting(inGroup, deferredSortMode, sortMeta)
    return filterGamesAreaLiveChannels(inGroup, group)
  }, [
    catalogReady,
    channels,
    continueItems,
    deferredChannels,
    deferredSortMode,
    group,
    hiddenChannelSet,
    hiddenGroupSet,
    kind,
    serverCategories,
    sortMeta,
    parentalLocked,
    favorites,
  ])

  // A assinatura de favoritos entra na chave: favoritar ou desfavoritar precisa
  // invalidar a ordem memorizada. `stableBrowseList` reaplica a ordem antiga e so
  // joga no fim o que ainda nao estava na lista — um canal favoritado JA esta
  // nela, entao sem isso a particao de `browseList` seria desfeita em silencio.
  const orderLockKey = `${kind}|${group}|${deferredSortMode}|${parentalLocked}|${hiddenChannelSet.size}|${hiddenGroupSet.size}|fav:${favorites.join(',')}|${sortMeta ? 'ready' : 'boot'}`
  const stableBrowseList = useMemo(() => {
    const prev = orderLockRef.current
    // Antes do sortMeta, não trava ordem — senão "Mais Recentes" fica com ordem do servidor até trocar o pill
    if (!sortMeta) {
      orderLockRef.current = null
      return browseList
    }
    if (prev && prev.key === orderLockKey) {
      const byId = new Map(browseList.map((channel) => [channel.id, channel]))
      const kept = prev.ids.map((id) => byId.get(id)).filter((channel): channel is Channel => Boolean(channel))
      const seen = new Set(prev.ids)
      const added = browseList.filter((channel) => !seen.has(channel.id))
      const next = [...kept, ...added]
      orderLockRef.current = { key: orderLockKey, ids: next.map((channel) => channel.id) }
      return next
    }
    orderLockRef.current = { key: orderLockKey, ids: browseList.map((channel) => channel.id) }
    return browseList
  }, [browseList, orderLockKey, sortMeta])

  const list = useMemo(() => {
    // Busca: filtro leve. Ao apagar, volta pro browseList já cacheado (não reordena tudo).
    if (!search) return stableBrowseList

    if (group === 'Continuar Assistindo') {
      const filtered = continueItems
        .map((item) => ({
          ...item.channel,
          name: item.seriesName || item.channel.seriesName || item.channel.name,
          logo: item.seriesLogo || item.channel.seriesLogo || item.channel.logo,
          seriesId: item.seriesId || item.channel.seriesId,
          seriesName: item.seriesName || item.channel.seriesName,
          seriesLogo: item.seriesLogo || item.channel.seriesLogo,
        }))
        .filter((channel) => {
          if (!isAdultGroup(group) && isAdultChannel(channel)) return false
          return searchMatchScore(channel, search, searchHaystack?.get(channel.id)) > 0
        })
      return sortSearchResults(filtered, search, searchHaystack || new Map()).slice(0, 250)
    }

    const matched: Channel[] = []
    const limit = kind === 'live' ? 250 : 1200

    const allowAdult = isAdultGroup(group)
    for (const channel of channels) {
      if (hiddenChannelSet.has(channel.id) || hiddenGroupSet.has(channel.group)) continue
      if (!allowAdult && isAdultChannel(channel)) continue
      const score = searchMatchScore(channel, search, searchHaystack?.get(channel.id))
      if (score <= 0) continue
      matched.push(channel)
      if (matched.length >= limit * 3) break
    }
    return sortSearchResults(matched, search, searchHaystack || new Map()).slice(0, limit)
  }, [    stableBrowseList,
    channels,
    continueItems,
    group,
    kind,
    search,
    searchHaystack,
    hiddenChannelSet,
    hiddenGroupSet,
  ])

  useEffect(() => {
    if (!search || !scrollRef.current) return
    scrollRef.current.scrollTop = 0
  }, [search, kind, group])

  // Scroll restore, aqui depois que `list` existe.
  //
  // Guarda e reset no MESMO hook. Antes o reset vivia num `useEffect` passivo e
  // a guarda era lida num `useLayoutEffect`: o React roda TODOS os layout
  // effects antes de QUALQUER passivo, então ao trocar `kind` o layout effect
  // ainda lia a guarda `true` da montagem anterior e saia cedo. O reset vinha
  // depois, e nada mais re-disparava o restore. Em carga fria o catálogo
  // ainda chega e `list.length` muda, curando sozinho; com as duas listas já em
  // cache, `list.length` é idêntico e o restore ficava morto para sempre.
  const restoredKeyRef = useRef('')
  useLayoutEffect(() => {
    const key = `${playlist?.id ?? 'none'}:${kind}`
    if (restoredKeyRef.current === key) return
    const el = scrollRef.current
    const target = Number(savedScroll?.channels)
    // Sem container, sem offset salvo, ou catálogo ainda sem altura de rolagem:
    // não marca como feito, para tentar de novo quando a lista chegar.
    if (!el || !Number.isFinite(target) || target <= 0) return
    if (el.scrollHeight <= el.clientHeight) return
    const apply = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = target
    }
    apply()
    // O clamp do browser segura o valor enquanto a janela virtual ainda não
    // renderizou o spacer de baixo. A flag só é marcada DEPOIS do re-tentativo,
    // senão qualquer mudança de dep nos 120ms cancelava a escrita e, com a
    // guarda já travada, o offset se perdia para sempre.
    let id = 0
    if (el.scrollTop + 8 < target) {
      id = window.setTimeout(() => {
        apply()
        restoredKeyRef.current = key
      }, 120)
    } else {
      restoredKeyRef.current = key
    }
    return () => {
      if (id) window.clearTimeout(id)
    }
  }, [savedScroll?.channels, list.length, kind, group, playlist?.id])

  useEffect(() => {
    if (kind === 'live' || list.length === 0 || search) return
    const el = scrollRef.current
    const run = () => {
      const rowHeight = posterRowHeight
      const startRow = el ? Math.max(0, Math.floor(el.scrollTop / rowHeight) - 1) : 0
      const start = startRow * cols
      prefetchCovers(
        list.slice(start, start + cols * 8).map((c) => c.logo),
        cols * 8,
      )
    }
    run()
    if (!el) return
    el.addEventListener('scroll', run, { passive: true })
    return () => el.removeEventListener('scroll', run)
  }, [kind, list, cols, search, posterRowHeight])

  const posters = kind !== 'live'

  useEffect(() => {
    if (!returnToId) return
    const index = list.findIndex((channel) => channel.id === returnToId)
    const el = scrollRef.current
    if (index < 0 || !el) {
      onReturned?.()
      return
    }
    const rowHeight = posters ? posterRowHeight : 68
    const columns = posters ? Math.max(1, cols) : 1
    el.scrollTop = Math.floor(index / columns) * rowHeight
    onReturned?.()
  }, [returnToId, list, posters, cols, posterRowHeight, onReturned])

  useEffect(() => {
    const syncCompact = () => setCompactLayout(document.documentElement.dataset.compact === 'true')
    syncCompact()
    window.addEventListener('resize', syncCompact)
    return () => window.removeEventListener('resize', syncCompact)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !posters || detailPane) return
    // Não calcula mais colunas aqui. A geometria é do CSS; a contagem real chega
    // por onColumns, lida das posições já renderizadas. Calcular em JS e deixar o
    // CSS desenhar outro número era a origem do salto de tamanho.
    const measure = () => {}
    const schedule = () => requestAnimationFrame(measure)
    schedule()
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => ro.disconnect()
  }, [posters, detailPane])

  const [selectedLiveChannel, setSelectedLiveChannel] = useState<Channel | null>(null)
  const [livePlayerFullscreenPulse, setLivePlayerFullscreenPulse] = useState(0)
  const [recentLiveChannels, setRecentLiveChannels] = useState<Channel[]>(() => loadRecentLiveChannels())
  const [liveNowPlaying, setLiveNowPlaying] = useState<Record<string, string>>({})

  useEffect(() => {
    saveRecentLiveChannels(recentLiveChannels)
  }, [recentLiveChannels])

  useEffect(() => {
    if (recentLiveEpoch > 0) setRecentLiveChannels([])
  }, [recentLiveEpoch])

  const liveListIds = useMemo(() => list.map((c) => c.id).join('|'), [list])

  useEffect(() => {
    if (kind !== 'live' || !playlist || playlist.kind !== 'xtream' || list.length === 0) return
    // Área de jogos/esportes: sem prefetch EPG — travava ao entrar/sair do grupo
    if (group !== 'Todos' && isSportsLiveGroup(group)) {
      startTransition(() => setLiveNowPlaying({}))
      return
    }

    let cancelled = false
    startTransition(() => setLiveNowPlaying({}))

    const maxTargets = Math.min(list.length, 28)
    const sportsFirst = [
      ...list.filter((c) => c.streamId && isFootballChannel(c)),
      ...list.filter((c) => c.streamId && !isFootballChannel(c)),
    ]
    const targets = sportsFirst.slice(0, maxTargets)

    const run = async () => {
      const next: Record<string, string> = {}
      for (let i = 0; i < targets.length; i += 5) {
        if (cancelled) return
        const batch = targets.slice(i, i + 5)
        const results = await Promise.all(
          batch.map(async (channel) => {
            try {
              const row = await loadShortEpg(playlist, String(channel.streamId))
              const title = decodeEpgText(row?.title)
              const desc = decodeEpgText(row?.description)
              if (!title && !desc) return null
              const sports = isSportsEpgText(title) || isSportsEpgText(desc)
              // Em canais de esporte (ou com jogo/VT no EPG), mostra o que está no ar
              if (!sports && !isFootballChannel(channel)) return null
              let label = title
              if (
                desc &&
                (!title ||
                  (!hasMatchupInText(normalizeForMatching(title)) &&
                    !/\bVT\b/.test(normalizeForMatching(title)) &&
                    (hasMatchupInText(normalizeForMatching(desc)) || /\bVT\b/.test(normalizeForMatching(desc)))))
              ) {
                label = desc.split(/[.\n]/)[0]!.trim().slice(0, 72) || title
              }
              if (!label) return null
              return [channel.id, label] as const
            } catch {
              return null
            }
          }),
        )
        for (const item of results) {
          if (item) next[item[0]] = item[1]
        }
      }
      if (!cancelled) setLiveNowPlaying(next)
    }

    let idleId = 0
    const timer = window.setTimeout(() => {
      const ric = window.requestIdleCallback
      if (typeof ric === 'function') {
        idleId = ric(() => void run(), { timeout: 500 })
      } else {
        void run()
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (idleId && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
    }
    // liveListIds evita cancelar o fetch a cada render do array `list`
  }, [kind, playlist, group, liveListIds])

  const trackRecentChannel = (ch: Channel) => {
    setRecentLiveChannels((prev) => [ch, ...prev.filter((c) => c.id !== ch.id)].slice(0, 6))
  }

  const showGrid = !detailPane

  return (
    <div
      className={`browse ${kind === 'live' ? 'browse-live' : ''}${detailPane ? ' browse-with-details browse-detail-focus' : ''}`}
    >
      {folhaRestaurar && (
        <RestaurarOcultosSheet
          ocultos={ocultosDoContexto}
          catalogo={channels}
          onClose={() => setFolhaRestaurar(false)}
          onRestaurar={restaurarSelecionados}
        />
      )}
      <aside
        ref={groupsRef}
        className="groups"
        onScroll={() => {
          // Mesmo problema do grid: escrita de state a cada frame. Coalesce em rAF.
          if (groupsFrameRef.current) return
          groupsFrameRef.current = window.requestAnimationFrame(() => {
            groupsFrameRef.current = 0
            if (groupsRef.current) {
              onSaveScroll({
                channels: scrollRef.current?.scrollTop ?? savedScrollRef.current.channels,
                groups: groupsRef.current.scrollTop,
              })
            }
          })
        }}
      >
        {visibleGroups.map((item) => {
          const count = groupCounts.get(item)
          return (
            <button
              key={item}
              className={`group ${item === group ? 'active' : ''}`}
              onClick={() => selectGroup(item)}
            >
              <span className="group-name">{item}</span>
              {count !== undefined && <span className="group-count">{count}</span>}
            </button>
          )
        })}
        {parentalLocked && onUnlockAdult && (
          <button type="button" className="group group-adult-lock" onClick={onUnlockAdult}>
            <Lock size={14} strokeWidth={2.2} />
            <span className="group-name">Conteúdo adulto</span>
          </button>
        )}
      </aside>
      <section className="channels">
        {showGrid ? (
          <>
        <div className="browse-filter-bar">
          <div className="brand brand-in-content">
            <img className="brand-mark" src={hamster} alt="" />
            ST PLAY
          </div>
          {kind !== 'live' && group !== 'Adicionado Recentemente' && (
            <div className="browse-sort-pills">
              <button
                className={`sort-pill ${sortMode === 'default' ? 'active' : ''}`}
                onClick={() => onSortMode('default')}
              >
                Padrão
              </button>
              <button
                className={`sort-pill ${sortMode === 'az' ? 'active' : ''}`}
                onClick={() => onSortMode('az')}
              >
                A–Z
              </button>
              <button
                className={`sort-pill ${sortMode === 'za' ? 'active' : ''}`}
                onClick={() => onSortMode('za')}
              >
                Z–A
              </button>
              <button
                className={`sort-pill ${sortMode === 'newest' ? 'active' : ''}`}
                onClick={() => onSortMode('newest')}
              >
                Mais Recentes
              </button>
              <button
                className={`sort-pill ${sortMode === 'rating' ? 'active' : ''}`}
                onClick={() => onSortMode('rating')}
              >
                ★ Nota
              </button>
              {/*
                Restaurar fica NA MESMA barra das pilhas, e nao no bloco
                `browse-hide-actions` de baixo.

                FIXO, sem condicao: antes ele so aparecia com item oculto, e o
                botao saltava dentro e fora da barra conforme a pessoa ocultava.
                A posicao de um controle nao pode depender do estado dos dados —
                quando ha nada, a folha abre vazia e diz isso.

                Nota: `deveMostrarRestaurar` continua em uso no bloco do ao vivo,
                que nao tem pílhas e portanto nao tem barra para receber este.
              */}
              <button
                type="button"
                className="sort-pill sort-pill-restore"
                onClick={() => setFolhaRestaurar(true)}
                title={
                  deveMostrarRestaurar(ocultosDoContexto)
                    ? 'Abrir a lista do que foi ocultado'
                    : 'Nada oculto neste tipo de conteúdo'
                }
              >
                <RotateCcw size={14} strokeWidth={2.2} />
                Restaurar
              </button>
            </div>
          )}
          {/*
              Acoes de ocultar. O MESMO bloco em paginas diferentes:
              
              em filme/serie, logo depois das pilhas de ordenacao — "imediatamente ao
              lado do star Nota";
              
              no ao vivo, que nao tem pilhas, logo depois do campo de busca.

              As duas condicoes sao EXCLUSIVAS: sem elas a pagina de filme, que tem
              pilhas, mostrava os dois botoes ao mesmo tempo, a 538px de distancia
              um do outro (medido em left 810 e left 1348).

              O botao de ocultar so existe com categoria REAL selecionada: as quatro do
              app nunca podem ser ocultadas, e sem categoria nao ha o que ocultar.

              O de restaurar so existe com algo oculto NESTE contexto, e abre a lista em
              vez de restaurar tudo direto.
              */}
          {kind !== 'live' && (
            <div className="browse-hide-actions">
              {/* Chamada direta em vez de IIFE: o rotulo e o nome sao duas leituras de funcoes puras e o JSX fica legivel. */}
              {podeOcultarCategoria(group) && (
                <button
                  type="button"
                  className="browse-hide-btn"
                  onClick={ocultarCategoriaAtual}
                  title={linhasDoBotaoOcultar(group).completo}
                  aria-label={linhasDoBotaoOcultar(group).completo}
                >
                  <span className="browse-hide-btn-rotulo">{linhasDoBotaoOcultar(group).rotulo}</span>
                  <span className="browse-hide-btn-nome">{linhasDoBotaoOcultar(group).nome}</span>
                </button>
              )}
            </div>
          )}
          <div className="browse-search-wrapper">
            <Search className="browse-search-icon" size={16} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={kind === 'movie' ? 'Buscar filmes...' : kind === 'series' ? 'Buscar séries...' : 'Buscar canais...'}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
            />
            {query && (
              <button
                className="browse-search-clear"
                onClick={() => setQuery('')}
                title="Limpar busca"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {/*
              Acoes de ocultar. O MESMO bloco em paginas diferentes:
              
              em filme/serie, logo depois das pilhas de ordenacao — "imediatamente ao
              lado do star Nota";
              
              no ao vivo, que nao tem pilhas, logo depois do campo de busca.

              As duas condicoes sao EXCLUSIVAS: sem elas a pagina de filme, que tem
              pilhas, mostrava os dois botoes ao mesmo tempo, a 538px de distancia
              um do outro (medido em left 810 e left 1348).

              O botao de ocultar so existe com categoria REAL selecionada: as quatro do
              app nunca podem ser ocultadas, e sem categoria nao ha o que ocultar.

              O de restaurar so existe com algo oculto NESTE contexto, e abre a lista em
              vez de restaurar tudo direto.
              */}
          {kind === 'live' && (
            <div className="browse-hide-actions">
              {/* Chamada direta em vez de IIFE: o rotulo e o nome sao duas leituras de funcoes puras e o JSX fica legivel. */}
              {podeOcultarCategoria(group) && (
                <button
                  type="button"
                  className="browse-hide-btn"
                  onClick={ocultarCategoriaAtual}
                  title={linhasDoBotaoOcultar(group).completo}
                  aria-label={linhasDoBotaoOcultar(group).completo}
                >
                  <span className="browse-hide-btn-rotulo">{linhasDoBotaoOcultar(group).rotulo}</span>
                  <span className="browse-hide-btn-nome">{linhasDoBotaoOcultar(group).nome}</span>
                </button>
              )}
              {deveMostrarRestaurar(ocultosDoContexto) && (
                <button
                  type="button"
                  className="browse-restore-btn"
                  onClick={() => setFolhaRestaurar(true)}
                  title="Abrir a lista do que foi ocultado"
                >
                  <RotateCcw size={16} />
                  Restaurar
                </button>
              )}
            </div>
          )}
        </div>
        <div
          ref={attachScroll}
          className="channels-scroll"
          onScroll={() => {
            // Era um onScroll puro, sem throttle: escrevia um objeto NOVO em
            // state a cada frame de rolagem. Como não existe nenhum React.memo
            // no projeto inteiro, isso re-renderava a árvore toda — 60 a 120
            // vezes por segundo, arrastando o grid de posteres junto. Agora
            // coalesce em rAF: no máximo uma escrita por frame desenhado.
            if (scrollFrameRef.current) return
            scrollFrameRef.current = window.requestAnimationFrame(() => {
              scrollFrameRef.current = 0
              if (scrollRef.current) {
                onSaveScroll({
                  channels: scrollRef.current.scrollTop,
                  groups: groupsRef.current?.scrollTop ?? savedScrollRef.current.groups,
                })
              }
            })
          }}
        >
        {list.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
            {groupLoading
              ? `Carregando ${kind === 'series' ? 'séries' : kind === 'movie' ? 'filmes' : 'itens'} desta categoria…`
              : search
                ? `Nenhum item encontrado para "${query}"`
                : 'Nenhum item nesta categoria'}
          </div>
        ) : posters ? (
          <VirtualWindow
            count={list.length}
            rowHeight={posterRowHeight}
            columns={cols}
            overscan={1}
            scrollEl={scrollEl}
            onRowHeight={handlePosterRowHeight}
            onColumns={setCols}
            innerClassName="poster-grid"
          >
              {(index) => {
                const channel = list[index]
                if (!channel) return null
                const isFav = favorites.includes(channel.id)
                const rating = movieRatingValue(channel)
                const prog = continueWatching.find(
                  (item) =>
                    item.channel.id === channel.id ||
                    (channel.streamId && (item.channel.streamId === channel.streamId || item.seriesId === channel.streamId)),
                )
                return (
                  <div
                    key={channel.id}
                    className={`poster-card${detailChannelId === channel.id ? ' poster-card-active' : ''}`}
                    onMouseEnter={() => {
                      if (kind !== 'series') return
                      const seriesId = channel.seriesId || channel.streamId || channel.url
                      if (seriesId && playlist) prefetchSeriesInfo(playlist, seriesId)
                    }}
                  >
                    <div
                      className="poster-media"
                      onClick={() =>
                        handleOpenChannel(
                          channel,
                          list,
                        )
                      }
                    >
                      <Cover src={channel.logo} />
                      {prog && prog.currentTime > 5 && prog.duration > 0 && (
                        <div className="poster-progress-bar">
                          <div
                            className="poster-progress-fill"
                            style={{ width: `${Math.min(100, (prog.currentTime / prog.duration) * 100)}%` }}
                          />
                        </div>
                      )}
                      {kind === 'series' || kind === 'movie' ? (
                        <>
                          {kind === 'series' && <span className="poster-kind-badge">SERIES</span>}
                          {kind === 'movie' && <span className="poster-kind-badge is-movie">FILME</span>}
                          {rating > 0 && (
                            <span className="poster-rating-badge">
                              <Star size={11} fill="#facc15" color="#facc15" strokeWidth={0} />
                              {rating.toFixed(1)}
                            </span>
                          )}
                          <div className="poster-top-actions">
                            {prog && (
                              <button
                                className="poster-trash-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setItemToDelete({ channel, seriesId: channel.seriesId, targetId: channel.id })
                                }}
                                title="Remover de Continuar Assistindo"
                                aria-label="Remover de Continuar Assistindo"
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
                            <button
                              className={`poster-fav-btn poster-heart-btn ${isFav ? 'active' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                onToggleFavorite(channel.id)
                              }}
                              title={isFav ? 'Remover favorito' : 'Favoritar'}
                              aria-label="Favoritar"
                            >
                              <Heart size={15} fill={isFav ? 'currentColor' : 'none'} />
                            </button>
                            <button
                              className="poster-menu-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setMenuChannel(channel)
                              }}
                              title="Opções"
                              aria-label="Opções"
                            >
                              ⋮
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <button
                            className={`poster-fav-btn poster-heart-btn ${isFav ? 'active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              onToggleFavorite(channel.id)
                            }}
                            title={isFav ? 'Remover favorito' : 'Favoritar'}
                            aria-label="Favoritar"
                          >
                            <Heart size={15} fill={isFav ? 'currentColor' : 'none'} />
                          </button>
                          {prog && (
                            <button
                              className="poster-trash-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setItemToDelete({ channel, seriesId: channel.seriesId, targetId: channel.id })
                              }}
                              title="Remover de Continuar Assistindo"
                              aria-label="Remover de Continuar Assistindo"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                          <button
                            className="poster-menu-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setMenuChannel(channel)
                            }}
                            title="Opções"
                            aria-label="Opções"
                          >
                            ⋮
                          </button>
                        </>
                      )}
                    </div>
                    <div
                      className="poster-info"
                      onClick={() =>
                        handleOpenChannel(
                          channel,
                          list,
                        )
                      }
                    >
                      <div
                        className="poster-title"
                        title={titleWithYear(channel.name, channel.releasedate)}
                      >
                        {titleWithYear(channel.name, channel.releasedate)}
                      </div>
                      {prog && prog.currentTime > 5 && (
                        <div className="poster-subtitle-badge">
                          {prog.episodeName && prog.episodeName !== channel.name ? `${prog.episodeName} · ` : ''}
                          {formatPlayerTime(prog.currentTime)} / {formatPlayerTime(prog.duration)}
                        </div>
                      )}
                    </div>
                  </div>
                )
              }}
            </VirtualWindow>
        ) : (
          <VirtualWindow
            key="l"
            count={list.length}
            rowHeight={measuredLiveRowHeight || 68}
            columns={1}
            overscan={2}
            scrollEl={scrollEl}
            onRowHeight={handleLiveRowHeight}
            innerClassName="live-grid"
            innerStyle={{ gridTemplateColumns: '1fr' }}
          >
            {(index) => {
              const channel = list[index]
              if (!channel) return null
              const isSelected = selectedLiveChannel?.id === channel.id
              const nowTitle = liveNowPlaying[channel.id]
              return (
                <div
                  key={channel.id}
                  className={`live-channel-row ${isSelected ? 'active-live-channel' : ''}`}
                  onMouseEnter={() => prewarmLiveChannel(channel)}
                >
                  <button
                    className="channel"
                    onClick={() => {
                      setSelectedLiveChannel(channel)
                      trackRecentChannel(channel)
                    }}
                    onDoubleClick={() => {
                      setSelectedLiveChannel(channel)
                      trackRecentChannel(channel)
                      setLivePlayerFullscreenPulse((tick) => tick + 1)
                    }}
                  >
                    <Cover src={channel.logo} small live />
                    <div className="live-channel-text">
                      <div className="live-channel-name">{channel.name}</div>
                      <div className={`muted${nowTitle ? ' live-channel-now' : ''}`}>
                        {nowTitle || channel.group}
                      </div>
                    </div>
                  </button>
                  <button
                    className={`live-action ${favorites.includes(channel.id) ? 'selected' : ''}`}
                    onClick={() => onToggleFavorite(channel.id)}
                    title={favorites.includes(channel.id) ? 'Remover dos favoritos' : 'Favoritar'}
                    aria-label={favorites.includes(channel.id) ? 'Remover dos favoritos' : 'Favoritar'}
                  >
                    <Heart size={17} fill={favorites.includes(channel.id) ? 'currentColor' : 'none'} />
                  </button>
                  <button className="live-action live-action-menu" onClick={() => setMenuChannel(channel)} title="Mais opções" aria-label="Mais opções">
                    <MoreVertical size={18} strokeWidth={2.4} />
                  </button>
                </div>
              )
            }}
          </VirtualWindow>
        )}
        </div>
        {menuChannel && (() => {
          const prog = continueWatching.find(
            (item) =>
              item.channel.id === menuChannel.id ||
              (menuChannel.streamId && (item.channel.streamId === menuChannel.streamId || item.seriesId === menuChannel.streamId)),
          )
          return (
            <ContentOptionsMenu
              channel={menuChannel}
              favorite={favorites.includes(menuChannel.id)}
              progress={prog}
              onPlayDirect={(startTime) => {
                const target = menuChannel
                setMenuChannel(null)
                onOpen(target, list, startTime, { autoPlay: true })
              }}
              onFavorite={() => onToggleFavorite(menuChannel.id)}
              onRemoveContinue={(channelId, sId) => {
                const target = menuChannel
                setMenuChannel(null)
                setItemToDelete({ channel: target, seriesId: sId || target.seriesId, targetId: channelId || target.id })
              }}
              onShowDetails={() => {
                const target = menuChannel
                setMenuChannel(null)
                onOpen(target, list)
              }}
              onDownload={() => {
                void onDownloadItem?.({
                  id: menuChannel.id,
                  name: menuChannel.name,
                  kind: menuChannel.kind === 'series' ? 'series' : 'movie',
                  url: menuChannel.url,
                  date: new Date().toLocaleDateString('pt-BR'),
                  logo: menuChannel.logo,
                  duration: menuChannel.duration,
                  extension: menuChannel.extension || 'mp4',
                })
              }}
              onHideChannel={() => {
                // Deduplica: o mesmo cartao pode ser ocultado pelo menu duas
                // vezes, e a lista de restauracao mostraria o titulo duplicado
                // — com "Restaurar 2" para uma coisa so.
                setHiddenChannels((current) =>
                  current.includes(menuChannel.id) ? current : [...current, menuChannel.id],
                )
                setHiddenNames((current) => ({ ...current, [menuChannel.id]: menuChannel.name }))
                setMenuChannel(null)
              }}
              onHideGroup={() => {
                // `podeOcultarCategoria` e o portao das quatro do app: ocultar
                // "Todos" deixaria a tela sem lista e sem volta. A regra mora
                // AQUI, no handler, e nao no JSX — os dois lugares que ocultam
                // categoria passam por aqui, e um guarda em cada um diverge.
                if (podeOcultarCategoria(menuChannel.group)) {
                  setHiddenGroups((current) =>
                    current.includes(menuChannel.group) ? current : [...current, menuChannel.group],
                  )
                  // A selecao volta para "Todos": a categoria acaba de sair da
                  // coluna, e deixar a selecao apontando para ela e um estado
                  // sem sinal na tela.
                  if (selecaoDeveVoltarParaTodos(selectedGroup, [menuChannel.group])) {
                    startTransition(() => onSelectGroup('Todos'))
                  }
                }
                setMenuChannel(null)
              }}
              onClose={() => setMenuChannel(null)}
            />
          )
        })()}
        {/* Confirmation Modal to Delete from Continue Watching */}
        {itemToDelete && (
          <div className="live-options-backdrop" onClick={() => setItemToDelete(null)}>
            <div
              className="content-options-modal confirm-delete-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="confirm-delete-icon">
                <Trash2 size={26} color="#ef4444" />
              </div>
              <h3 style={{ margin: '0 0 8px', fontSize: 17, color: '#fff', textAlign: 'center' }}>
                Remover de Continuar Assistindo?
              </h3>
              <p className="muted" style={{ margin: '0 0 20px', fontSize: 13, textAlign: 'center', lineHeight: 1.5 }}>
                Deseja remover <strong>"{itemToDelete.channel.name}"</strong> da sua lista de continuar assistindo?
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
                <button
                  className="content-option-pill"
                  style={{
                    background: '#ef4444',
                    borderColor: '#ef4444',
                    color: '#fff',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                  onClick={() => {
                    onRemoveContinue?.(itemToDelete.targetId || itemToDelete.channel.id, itemToDelete.seriesId)
                    setItemToDelete(null)
                  }}
                >
                  <Trash2 size={16} /> Sim, remover
                </button>
                <button
                  className="content-option-pill"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => setItemToDelete(null)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}
          </>
        ) : (
          <div className="channels-detail-pane">{detailPane}</div>
        )}
      </section>
      {kind === 'live' && (
        selectedLiveChannel && !suspendLivePreview ? (
          <aside className="live-preview-panel live-preview-player">
            <Player
              embedded
              channel={selectedLiveChannel}
              list={list}
              playlist={playlist}
              favorite={favorites.includes(selectedLiveChannel.id)}
              favorites={favorites}
              playbackEngine={playbackEngine}
              fullscreenRequest={livePlayerFullscreenPulse}
              onFav={() => onToggleFavorite(selectedLiveChannel.id)}
              onToggleFavorite={onToggleFavorite}
              onChange={(ch) => {
                setSelectedLiveChannel(ch)
                trackRecentChannel(ch)
              }}
              onProgress={() => {}}
              onBack={() => setSelectedLiveChannel(null)}
            />
          </aside>
        ) : !selectedLiveChannel ? (
          <aside className="live-preview-panel live-preview-placeholder">
            <div className="live-placeholder-content">
              <div className="live-placeholder-icon">📺</div>
              <h3>Selecione um canal</h3>
              <p>Clique em qualquer canal da lista ao lado para assistir ao vivo aqui no painel</p>
            </div>
          </aside>
        ) : null
      )}
    </div>
  )
}

function decodeEpgText(text?: string): string {
  if (!text) return ''
  const trimmed = String(text).trim()
  if (/^[A-Za-z0-9+/=]{8,}$/.test(trimmed)) {
    try {
      const decoded = atob(trimmed)
      const hasBadControl = [...decoded].some((ch) => {
        const code = ch.charCodeAt(0)
        return (code >= 0 && code <= 8) || (code >= 14 && code <= 31)
      })
      if (decoded && !hasBadControl) {
        return decodeURIComponent(escape(decoded))
      }
    } catch {
      try {
        return atob(trimmed)
      } catch {}
    }
  }
  return trimmed
}

type CastMember = {
  name: string
  photo?: string
}

function parseCast(rawCast: unknown): CastMember[] {
  if (!rawCast) return []
  if (Array.isArray(rawCast)) {
    return rawCast
      .map((item) => {
        if (typeof item === 'string') return { name: item.trim() }
        if (typeof item === 'object' && item !== null) {
          const name = (item as any).name || (item as any).actor || ''
          const photo = (item as any).profile_path || (item as any).photo || (item as any).image || (item as any).thumb
          return name ? { name: String(name).trim(), photo: photo ? String(photo) : undefined } : null
        }
        return null
      })
      .filter((x): x is CastMember => Boolean(x && x.name))
  }
  if (typeof rawCast === 'string') {
    return rawCast
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((name) => ({ name }))
  }
  return []
}

function CastRow({ cast }: { cast: unknown }) {
  const members = parseCast(cast)
  if (!members.length) return null
  return (
    <div className="cast-section">
      <h3 className="cast-title">Elenco</h3>
      <div className="cast-list">
        {members.map((member, i) => (
          <div key={i} className="cast-card">
            <div className="cast-avatar">
              {member.photo ? (
                <img
                  src={mediaSrc(member.photo)}
                  alt={member.name}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              ) : null}
              <span className="cast-initial">{member.name.charAt(0).toUpperCase()}</span>
            </div>
            <span className="cast-name" title={member.name}>
              {member.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MovieView({
  playlist,
  movie,
  list,
  favorites,
  continueWatching = [],
  playbackEngine = 'auto',
  autoStartTime,
  autoPlay = false,
  onBack,
  onToggleFavorite,
  onDownloadItem,
  onProgress,
  onMeta,
  onPlayFull,
}: {
  playlist: Playlist
  movie: Channel
  list: Channel[]
  favorites: string[]
  continueWatching?: ContinueWatching[]
  playbackEngine?: PlaybackEngine
  autoStartTime?: number
  autoPlay?: boolean
  onBack: () => void
  onToggleFavorite: (id: string) => void
  onDownloadItem?: (item: DownloadedItem) => void | Promise<void>
  onProgress: (currentTime: number, duration: number) => void
  onMeta?: (patch: Partial<Channel>) => void
  /** Assistir vai direto pro player cheio (sem mini). */
  onPlayFull?: (channel: Channel, startTime: number) => void
}) {
  const [details, setDetails] = useState<ContentDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playSession, setPlaySession] = useState<{ startTime: number } | null>(null)
  const autoStartRef = useRef<number | undefined>(undefined)
  const isFav = favorites.includes(movie.id)
  const onPlayFullRef = useRef(onPlayFull)
  onPlayFullRef.current = onPlayFull
  const movieRef = useRef(movie)
  movieRef.current = movie

  const progress = useMemo(() => {
    return continueWatching.find(
      (item) => item.channel.id === movie.id || (movie.streamId && item.channel.streamId === movie.streamId),
    )
  }, [continueWatching, movie])

  const startPlayback = (startTime = 0) => {
    if (onPlayFullRef.current) {
      onPlayFullRef.current(movieRef.current, startTime)
      return
    }
    setPlaySession({ startTime })
  }

  useEffect(() => {
    setPlaySession(null)
    autoStartRef.current = undefined
    resetPlayerChrome()
    void window.sturplay?.player?.hide?.()
  }, [movie.id])

  useEffect(() => {
    if (playSession) return
    void window.sturplay?.player?.hide?.()
  }, [playSession])

  useEffect(() => {
    if (!autoPlay) return
    if (autoStartRef.current === autoStartTime) return
    if (autoStartTime !== undefined && autoStartTime >= 0) {
      autoStartRef.current = autoStartTime
      if (onPlayFullRef.current) onPlayFullRef.current(movieRef.current, autoStartTime)
      else setPlaySession({ startTime: autoStartTime })
    }
  }, [movie.id, autoStartTime, autoPlay])

  useEffect(() => {
    if (!movie.streamId) {
      setLoading(false)
      return
    }
    let cancelled = false
    loadVodInfo(playlist, movie.streamId)
      .then((res) => {
        if (cancelled) return
        setDetails(res)
        setLoading(false)
        if (res.releasedate || res.rating || res.plot) {
          onMeta?.({
            releasedate: res.releasedate || movie.releasedate,
            rating: res.rating || movie.rating,
            plot: res.plot || movie.plot,
          })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Erro ao carregar detalhes')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // onMeta estável via useCallback no App
  }, [playlist, movie.streamId, movie.releasedate, movie.rating, movie.plot, onMeta])

  useEffect(() => {
    if (!movie.streamId || details?.plot) return
    const key = vodInfoCacheKey(playlist.id, movie.streamId)
    let ticks = 0
    const id = window.setInterval(() => {
      ticks += 1
      if (ticks > 30) {
        window.clearInterval(id)
        return
      }
      const fresh = peekVodInfoCache(key) as ContentDetails | null
      if (fresh?.plot) {
        setDetails((prev) => (prev ? { ...prev, plot: fresh.plot } : fresh))
        window.clearInterval(id)
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [playlist.id, movie.streamId, details?.plot])

  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await onDownloadItem?.({
        id: downloadIdFor(playlist.id, 'movie', movie.id) ?? movie.id,
        name: details?.name || movie.name,
        kind: 'movie',
        url: movie.url,
        date: new Date().toLocaleDateString('pt-BR'),
        logo: details?.cover || movie.logo,
        duration: details?.duration || movie.duration,
        extension: movie.extension || 'mp4',
        playlistId: playlist.id,
      })
    } finally {
      setDownloading(false)
    }
  }

  const plot = details?.plot || movie.plot
  const rating = details?.rating || movie.rating
  const releaseDate = details?.releasedate || movie.releasedate
  const addedDate = details?.addedDate
  const duration = details?.duration || movie.duration
  const cover = details?.cover || movie.logo
  const displayTitle = titleWithYear(
    movie.name,
    releaseDate,
    details?.releasedate,
    movie.releasedate,
  )

  return (
    <DetailTintView cover={cover} className="movie-view">
      <div className="movie-detail-scroll">
        <div className="movie-header">
          <button className="series-back-btn" onClick={onBack} title="Voltar"><ArrowLeft size={18} /></button>
          <div className="movie-header-content">
            <h1 className="movie-title">{displayTitle}</h1>
            {plot && <p className="movie-plot">{plot}</p>}

            <div className="movie-metadata-grid">
              {rating && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Nota:</span>
                  {/*
                    `Star` do lucide em vez do emoji ⭐. O emoji renderiza
                    colorido e com proportions diferentes em cada plataforma — na
                    imagem ele aparecia laranja e grande, brigando com o resto da
                    linha. O icone herda `currentColor` e o tamanho da fonte.
                  */}
                  <span className="movie-meta-val">
                    <Star size={13} strokeWidth={2.4} fill="#fbbf24" color="#fbbf24" />
                    {rating}
                  </span>
                </div>
              )}
              {releaseDate && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Lançamento:</span>
                  <span className="movie-meta-val">{releaseDate}</span>
                </div>
              )}
              {addedDate && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Adicionado no servidor:</span>
                  <span className="movie-meta-val">{addedDate}</span>
                </div>
              )}
              {duration && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Duração:</span>
                  <span className="movie-meta-val">{duration}</span>
                </div>
              )}
              {details?.genre && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Gênero:</span>
                  <span className="movie-meta-val">{details.genre}</span>
                </div>
              )}
              {details?.director && (
                <div className="movie-meta-item">
                  <span className="movie-meta-label">Diretor:</span>
                  <span className="movie-meta-val">{details.director}</span>
                </div>
              )}
            </div>

            <CastRow cast={details?.cast} />

            <div className="movie-actions-row">
              {/* Primario em linha propria, fundo claro — como no app movel.
                  O secundario fica num par abaixo. Nenhum dos dois e esticado:
                  a pultura no celular e larga porque a tela e estreita, e
                  esticar em desktop so deixa o botao enorme. */}
              {progress && progress.currentTime > 5 ? (
                <button className="movie-play-btn movie-play-btn-strong" onClick={() => startPlayback(progress.currentTime)}>
                  <Play size={18} />
                  Continuar {formatPlayerTime(progress.currentTime)}
                </button>
              ) : (
                <button className="movie-play-btn movie-play-btn-strong" onClick={() => startPlayback(0)}>
                  <Play size={18} />
                  Assistir
                </button>
              )}
              <div className="movie-actions-pair">
                <button
                  className={`series-fav-btn ${isFav ? 'active' : ''}`}
                  onClick={() => onToggleFavorite(movie.id)}
                >
                  {isFav ? '★ Nos favoritos' : '☆ Adicionar aos favoritos'}
                </button>
                <button className="movie-action-pill" onClick={() => void handleDownload()} disabled={downloading}>
                  {downloading ? 'Iniciando...' : '⬇ Baixar'}
                </button>
              </div>
            </div>

          </div>

          <div className="movie-header-poster">
            <Cover src={cover} />
          </div>
        </div>

        {loading && <p className="muted movie-detail-status">Carregando informações...</p>}
        {error && <div className="error movie-detail-status">{error}</div>}
      </div>

      {playSession ? (
        <aside className="movie-embedded-panel vod-windowed-panel live-preview-panel live-preview-player">
          <Player
            key={`${movie.id}-${playSession.startTime}`}
            embedded
            channel={{
              ...movie,
              duration: details?.duration || movie.duration,
            }}
            list={list}
            playlist={playlist}
            favorite={isFav}
            favorites={favorites}
            playbackEngine={playbackEngine}
            startTime={playSession.startTime}
            onFav={() => onToggleFavorite(movie.id)}
            onToggleFavorite={onToggleFavorite}
            onChange={() => {}}
            onProgress={onProgress}
            onBack={() => setPlaySession(null)}
          />
        </aside>
      ) : null}
    </DetailTintView>
  )
}

function ContentOptionsMenu({
  channel,
  favorite,
  progress,
  onPlayDirect,
  onFavorite,
  onRemoveContinue,
  onShowDetails,
  onDownload,
  onHideChannel,
  onHideGroup,
  onClose,
}: {
  channel: Channel
  favorite: boolean
  progress?: ContinueWatching
  onPlayDirect?: (startTime?: number) => void
  onFavorite: () => void
  onRemoveContinue?: (channelId: string, seriesId?: string) => void
  onShowDetails?: () => void
  onDownload: () => void
  onHideChannel: () => void
  onHideGroup: () => void
  onClose: () => void
}) {
  const isLive = channel.kind === 'live'
  const isSeries = channel.kind === 'series'
  const kindLabel = channel.kind === 'movie' ? 'filme' : channel.kind === 'series' ? 'série' : 'canal'

  return (
    <div className="live-options-backdrop" onClick={onClose}>
      <div className="content-options-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="content-options-header">
          <button
            className={`content-options-fav ${favorite ? 'active' : ''}`}
            onClick={onFavorite}
            title={favorite ? 'Remover favorito' : 'Favoritar'}
            aria-label={favorite ? 'Remover favorito' : 'Favoritar'}
          >
            <Heart size={20} strokeWidth={1.75} fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <h3>{channel.name}</h3>
        </div>

        {onPlayDirect && (
          progress && progress.currentTime > 5 ? (
            <button
              className="content-option-pill primary"
              onClick={() => onPlayDirect(progress.currentTime)}
            >
              <Play size={16} /> Continuar ({formatPlayerTime(progress.currentTime)})
            </button>
          ) : (
            <button
              className="content-option-pill primary"
              onClick={() => onPlayDirect(0)}
            >
              <Play size={16} /> Assistir
            </button>
          )
        )}

        {progress && onRemoveContinue && (
          <button
            className="content-option-pill danger"
            onClick={() => {
              onRemoveContinue(channel.id, channel.seriesId)
              onClose()
            }}
          >
            <Trash2 size={16} /> Remover de Continuar Assistindo
          </button>
        )}

        {/*
          Par de secundarios, no mesmo desenho do par de perigo abaixo.

          Sem este wrapper cada `.content-option-pill` ocupava `width: 100%` e
          empilhava uma por linha. No app movel elas ficam lado a lado, e a
          pessoa pediu o mesmo desenho aqui — porem SEM esticar: na captura do
          celular o botao ocupa meia linha porque a tela e estreita; em desktop
          a mesma regra espremeria o texto numa caixa enorme. Por isso o CSS deste
          par tira o `width: 100%`.
        */}
        <div className="content-options-pair">
          {onShowDetails && (
            <button className="content-option-pill" onClick={onShowDetails}>
              <Info size={16} />
              Detalhes
            </button>
          )}
          {!isSeries && !isLive && (
            <button className="content-option-pill" onClick={onDownload}>
              <Download size={16} />
              Baixar
            </button>
          )}
        </div>

        <div className="live-options-split">
          {/*
            Os dois sao `danger` e nao so por cor: "Ocultar filme" e "Ocultar
            categoria" tiram o item da tela, que e a mesma acao destrutiva de
            "Remover de Continuar Assistindo". Sem esta classe eles caiam na
            regra neutra do `.live-options-split button` e saiam sem vermelho
            nenhum, enquanto o terceiro saia vermelho — tres botoes com a mesma
            acao, cores diferentes.
          */}
          <button className="danger" onClick={onHideChannel}>
            Ocultar {kindLabel}
          </button>
          {/*
            O botao some quando a categoria e uma das quatro do app. O handler
            JA recusa (esta e a razao de a regra morar la), mas um botao que
            aparece e nao faz nada e pior do que um botao ausente: a pessoa
            clica e conclui que o app travou.
          */}
          {podeOcultarCategoria(channel.group) && (
            <button className="danger" onClick={onHideGroup}>
              Ocultar categoria
              <small>{channel.group}</small>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const EPG_PAST_MS = 2 * 60 * 60 * 1000
const EPG_FUTURE_MS = 10 * 60 * 60 * 1000
const EPG_PX_PER_MIN = 3.5
const EPG_CHANNEL_W = 220
const EPG_ROW_H = 72
const EPG_LOAD_TIMEOUT_MS = 18_000
const EPG_MAX_CONCURRENT = 8
const EPG_MAX_RETRIES = 2

type EpgProgram = {
  title: string
  description?: string
  startMs: number
  endMs: number
}

function mapEpgRows(rows: ShortEpg[]): EpgProgram[] {
  return rows
    .map((row): EpgProgram | null => {
      const title = decodeEpgText(row.title)
      const description = decodeEpgText(row.description)
      if (!title && !description) return null
      const startMs = parseEpgInstant(row.start)
      let endMs = parseEpgInstant(row.end)
      if (!startMs) return null
      if (!endMs) endMs = startMs + 60 * 60 * 1000
      return {
        title: title || description.split(/[.\n]/)[0]!.trim().slice(0, 90),
        description: description || undefined,
        startMs,
        endMs,
      }
    })
    .filter((row): row is EpgProgram => row !== null)
}

function epgStartOfDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function epgDayLabel(dayOffset: number, date: Date) {
  if (dayOffset === 0) return 'Hoje'
  if (dayOffset === -1) return 'Ontem'
  if (dayOffset === 1) return 'Amanhã'
  return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
}

function EpgGuide({
  playlist,
  channels,
  onOpen,
  onEpgRefreshed,
  epgUpdatedAt,
}: {
  playlist: Playlist | null
  channels: Channel[]
  onOpen: (channel: Channel, list: Channel[]) => void
  onEpgRefreshed?: () => void
  epgUpdatedAt?: number
}) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('Todos')
  const [groupOpen, setGroupOpen] = useState(false)
  const groupMenuRef = useRef<HTMLDivElement>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [epgMap, setEpgMap] = useState<Record<string, EpgProgram[]>>({})
  const [epgLoadingIds, setEpgLoadingIds] = useState<Set<string>>(() => new Set())
  const [epgRefreshing, setEpgRefreshing] = useState(false)
  const epgRefreshPendingRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const xScrollRef = useRef<HTMLDivElement>(null)
  const [epgScrollEl, setEpgScrollEl] = useState<HTMLElement | null>(null)
  const attachEpgScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setEpgScrollEl(node)
  }, [])
  const epgQueueRef = useRef<Channel[]>([])
  const epgActiveRef = useRef(0)
  const epgQueuedRef = useRef(new Set<string>())
  const epgFailCountRef = useRef(new Map<string, number>())
  const epgMapRef = useRef(epgMap)
  epgMapRef.current = epgMap

  useEffect(() => {
    setEpgMap({})
    setEpgLoadingIds(new Set())
    epgQueueRef.current = []
    epgQueuedRef.current = new Set()
    epgActiveRef.current = 0
    epgFailCountRef.current = new Map()
  }, [playlist?.id])

  useEffect(() => {
    if (!groupOpen) return
    const close = (event: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target as Node)) {
        setGroupOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [groupOpen])

  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(tick)
  }, [])

  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    return d
  }, [dayOffset])

  const isToday = dayOffset === 0
  const dayStart = epgStartOfDay(selectedDate)
  const dayEnd = dayStart + 24 * 60 * 60 * 1000
  // Hoje: janela larga (não só 3h) — senão parece que “só carregou isso”
  const windowStart = isToday ? Math.min(dayStart, nowMs - EPG_PAST_MS) : dayStart
  const windowEnd = isToday ? Math.max(dayEnd, nowMs + EPG_FUTURE_MS) : dayEnd
  const timelineWidth = ((windowEnd - windowStart) / 60_000) * EPG_PX_PER_MIN
  const nowLeft = isToday ? ((nowMs - windowStart) / 60_000) * EPG_PX_PER_MIN : -1

  const scrollToNow = useCallback(() => {
    setDayOffset(0)
    const instant = Date.now()
    setNowMs(instant)
    requestAnimationFrame(() => {
      const el = xScrollRef.current
      if (!el) return
      const start = instant - EPG_PAST_MS
      const left = ((instant - start) / 60_000) * EPG_PX_PER_MIN
      el.scrollLeft = Math.max(0, left - el.clientWidth / 2 + EPG_CHANNEL_W / 2)
    })
  }, [])

  const groups = useMemo(() => {
    const set = new Set<string>()
    for (const channel of channels) {
      if (channel.group) set.add(channel.group)
    }
    return ['Todos', ...[...set].sort((a, b) => a.localeCompare(b, 'pt-BR'))]
  }, [channels])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return channels.filter((channel) => {
      if (group !== 'Todos' && channel.group !== group) return false
      if (!q) return true
      return channel.name.toLowerCase().includes(q) || channel.group.toLowerCase().includes(q)
    })
  }, [channels, group, query])

  const timeMarks = useMemo(() => {
    const marks: { ms: number; label: string }[] = []
    const step = 30 * 60 * 1000
    let cursor = Math.ceil(windowStart / step) * step
    while (cursor <= windowEnd) {
      marks.push({ ms: cursor, label: formatEpgClock(cursor) })
      cursor += step
    }
    return marks
  }, [windowEnd, windowStart])

  const finishEpgRefreshIfIdle = useCallback(() => {
    if (!epgRefreshPendingRef.current) return
    if (epgActiveRef.current > 0 || epgQueueRef.current.length > 0) return
    epgRefreshPendingRef.current = 0
    setEpgRefreshing(false)
    onEpgRefreshed?.()
  }, [onEpgRefreshed])

  const pumpEpgQueue = useCallback(() => {
    if (!playlist?.xtream) return
    while (epgActiveRef.current < EPG_MAX_CONCURRENT && epgQueueRef.current.length > 0) {
      const channel = epgQueueRef.current.shift()
      if (!channel?.streamId) continue
      epgActiveRef.current += 1
      setEpgLoadingIds((current) => new Set(current).add(channel.id))

      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('timeout')), EPG_LOAD_TIMEOUT_MS)
      })

      void Promise.race([loadEpgDataTable(playlist, String(channel.streamId)), timeout])
        .then((rows) => {
          const mapped = mapEpgRows(rows)
          setEpgMap((current) => ({ ...current, [channel.id]: mapped }))
          epgFailCountRef.current.delete(channel.id)
        })
        .catch(() => {
          const fails = (epgFailCountRef.current.get(channel.id) || 0) + 1
          epgFailCountRef.current.set(channel.id, fails)
          if (fails >= EPG_MAX_RETRIES) {
            // Só marca vazio depois de esgotar tentativas
            setEpgMap((current) => (current[channel.id] !== undefined ? current : { ...current, [channel.id]: [] }))
          }
          // senão deixa undefined → pode pedir de novo no scroll
        })
        .finally(() => {
          epgActiveRef.current = Math.max(0, epgActiveRef.current - 1)
          epgQueuedRef.current.delete(channel.id)
          setEpgLoadingIds((current) => {
            const next = new Set(current)
            next.delete(channel.id)
            return next
          })
          pumpEpgQueue()
          finishEpgRefreshIfIdle()
        })
    }
  }, [finishEpgRefreshIfIdle, playlist])

  const refreshEpgData = useCallback(() => {
    if (!playlist?.xtream || epgRefreshing) return
    setEpgRefreshing(true)
    epgRefreshPendingRef.current = 1
    setEpgMap({})
    setEpgLoadingIds(new Set())
    epgQueueRef.current = []
    epgQueuedRef.current = new Set()
    epgActiveRef.current = 0
    epgFailCountRef.current = new Map()

    const targets = channels.filter((channel) => {
      if (group !== 'Todos' && channel.group !== group) return false
      const q = query.trim().toLowerCase()
      if (!q) return true
      return channel.name.toLowerCase().includes(q) || channel.group.toLowerCase().includes(q)
    })

    if (!targets.length) {
      epgRefreshPendingRef.current = 0
      setEpgRefreshing(false)
      return
    }

    for (const channel of targets.slice(0, 120)) {
      if (!channel.streamId) {
        setEpgMap((current) => ({ ...current, [channel.id]: [] }))
        continue
      }
      epgQueuedRef.current.add(channel.id)
      epgQueueRef.current.push(channel)
    }

    if (!epgQueueRef.current.length) {
      epgRefreshPendingRef.current = 0
      setEpgRefreshing(false)
      onEpgRefreshed?.()
      return
    }

    pumpEpgQueue()
  }, [channels, epgRefreshing, group, onEpgRefreshed, playlist?.xtream, pumpEpgQueue, query])

  const requestEpg = useCallback(
    (channel: Channel) => {
      if (!playlist?.xtream) return
      if (!channel.streamId) {
        setEpgMap((current) => (current[channel.id] ? current : { ...current, [channel.id]: [] }))
        return
      }
      if (epgMapRef.current[channel.id] !== undefined) return
      if (epgQueuedRef.current.has(channel.id)) return
      const fails = epgFailCountRef.current.get(channel.id) || 0
      if (fails >= EPG_MAX_RETRIES) {
        setEpgMap((current) => (current[channel.id] !== undefined ? current : { ...current, [channel.id]: [] }))
        return
      }
      epgQueuedRef.current.add(channel.id)
      epgQueueRef.current.push(channel)
      pumpEpgQueue()
    },
    [playlist?.xtream, pumpEpgQueue],
  )

  useEffect(() => {
    if (!playlist?.xtream) return
    for (const channel of filtered.slice(0, 60)) requestEpg(channel)
  }, [filtered, playlist?.xtream, requestEpg])

  useEffect(() => {
    if (!playlist?.xtream) return
    const el = scrollRef.current
    if (!el) return

    const loadVisible = () => {
      const startRow = Math.max(0, Math.floor(el.scrollTop / EPG_ROW_H) - 2)
      const visibleRows = Math.ceil(el.clientHeight / EPG_ROW_H) + 8
      const end = Math.min(filtered.length, startRow + visibleRows)
      for (let index = startRow; index < end; index += 1) {
        const channel = filtered[index]
        if (channel) requestEpg(channel)
      }
    }

    loadVisible()
    el.addEventListener('scroll', loadVisible, { passive: true })
    return () => el.removeEventListener('scroll', loadVisible)
  }, [filtered, playlist?.xtream, requestEpg])

  if (!playlist) {
    return (
      <div className="epg-guide">
        <ShellBrand />
        <div className="epg-guide-empty">
          <h1>Programação</h1>
          <p className="muted">Selecione uma playlist para ver o guia de TV.</p>
        </div>
      </div>
    )
  }

  if (playlist.kind !== 'xtream') {
    return (
      <div className="epg-guide">
        <ShellBrand />
        <div className="epg-guide-empty">
          <h1>Programação</h1>
          <p className="muted">O guia EPG completo está disponível apenas para listas Xtream.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="epg-guide">
      <ShellBrand />
      <header className="epg-guide-head">
        <div className="epg-guide-head-copy">
          <h1>Programação</h1>
          <p className="epg-guide-sub">
            {filtered.length.toLocaleString('pt-BR')} canais
            {(() => {
              const withEpg = filtered.reduce((n, ch) => n + ((epgMap[ch.id]?.length || 0) > 0 ? 1 : 0), 0)
              return withEpg > 0 ? ` · ${withEpg.toLocaleString('pt-BR')} com grade` : ''
            })()}
            {epgUpdatedAt ? ` · atualizado ${new Date(epgUpdatedAt).toLocaleString('pt-BR')}` : ''}
          </p>
        </div>
        <div className="epg-guide-toolbar">
          <div className="epg-guide-filters">
            <div className="epg-guide-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar canal…"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {query && (
                <button type="button" className="epg-guide-search-clear" onClick={() => setQuery('')} aria-label="Limpar">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="epg-guide-group-wrap" ref={groupMenuRef}>
              <button
                type="button"
                className={`epg-guide-group-btn${groupOpen ? ' is-open' : ''}`}
                onClick={() => setGroupOpen((value) => !value)}
                aria-expanded={groupOpen}
              >
                <span className="epg-guide-group-label">{group}</span>
                <ChevronsUpDown size={15} />
              </button>
              {groupOpen && (
                <div className="epg-guide-group-menu" role="listbox">
                  {groups.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={group === option}
                      className={`epg-guide-group-item${group === option ? ' active' : ''}`}
                      onClick={() => {
                        setGroup(option)
                        setGroupOpen(false)
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="epg-guide-nav">
            <div className="epg-guide-day">
              <button
                type="button"
                className="epg-guide-icon-btn"
                onClick={() => setDayOffset((value) => value - 1)}
                aria-label="Dia anterior"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="epg-guide-day-label">{epgDayLabel(dayOffset, selectedDate)}</span>
              <button
                type="button"
                className="epg-guide-icon-btn"
                onClick={() => setDayOffset((value) => value + 1)}
                aria-label="Próximo dia"
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <button type="button" className="epg-guide-now-btn" onClick={scrollToNow}>
              <Clock size={15} />
              Agora
            </button>
            <button type="button" className="primary epg-guide-refresh" onClick={refreshEpgData} disabled={epgRefreshing}>
              <RotateCcw size={15} className={epgRefreshing ? 'spin' : undefined} />
              {epgRefreshing ? 'Atualizando…' : 'Atualizar'}
            </button>
          </div>
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="epg-guide-empty">
          <p className="muted">Nenhum canal encontrado.</p>
        </div>
      ) : (
        <div className="epg-guide-board">
          <div ref={xScrollRef} className="epg-guide-xscroll">
            <div className="epg-guide-ruler" style={{ minWidth: EPG_CHANNEL_W + timelineWidth }}>
              <div className="epg-guide-ruler-spacer" style={{ width: EPG_CHANNEL_W }} />
              <div className="epg-guide-ruler-track" style={{ width: timelineWidth }}>
                {timeMarks.map((mark) => (
                  <span
                    key={mark.ms}
                    className="epg-time-mark"
                    style={{ left: ((mark.ms - windowStart) / 60_000) * EPG_PX_PER_MIN }}
                  >
                    {mark.label}
                  </span>
                ))}
              </div>
            </div>

            <div ref={attachEpgScroll} className="epg-guide-scroll">
              <VirtualWindow
                count={filtered.length}
                rowHeight={EPG_ROW_H}
                columns={1}
                overscan={3}
                scrollEl={epgScrollEl}
                innerClassName="epg-guide-rows"
                innerStyle={{ minWidth: EPG_CHANNEL_W + timelineWidth }}
              >
              {(index) => {
                const channel = filtered[index]
                if (!channel) return null
                const programs = (epgMap[channel.id] || []).filter(
                  (row) => row.endMs > windowStart && row.startMs < windowEnd,
                )
                const loading = epgLoadingIds.has(channel.id)
                const loaded = epgMap[channel.id] !== undefined
                return (
                  <div key={channel.id} className="epg-guide-row" style={{ height: EPG_ROW_H }}>
                    <button
                      type="button"
                      className="epg-guide-channel"
                      style={{ width: EPG_CHANNEL_W }}
                      onClick={() => onOpen(channel, filtered)}
                      title={channel.name}
                    >
                      <Cover src={channel.logo} small live />
                      <span className="epg-guide-channel-name">{channel.name}</span>
                    </button>
                    <div className="epg-guide-track" style={{ width: timelineWidth }}>
                      {isToday && <div className="epg-now-line" style={{ left: nowLeft }} aria-hidden />}
                      {loading && <span className="epg-guide-loading muted">Carregando…</span>}
                      {!loading && loaded && programs.length === 0 && (
                        <span className="epg-guide-empty-slot muted">Sem programação</span>
                      )}
                      {!loading &&
                        programs.map((program) => {
                          const left = Math.max(0, ((program.startMs - windowStart) / 60_000) * EPG_PX_PER_MIN)
                          const rawWidth = ((program.endMs - program.startMs) / 60_000) * EPG_PX_PER_MIN
                          const width = Math.max(84, rawWidth - 6)
                          const live = program.startMs <= nowMs && program.endMs > nowMs
                          return (
                            <button
                              key={`${program.startMs}-${program.title}`}
                              type="button"
                              className={`epg-block${live ? ' is-live' : ''}`}
                              style={{ left: left + 3, width }}
                              title={`${program.title}\n${formatEpgWindow(program.startMs, program.endMs)}`}
                              onClick={() => onOpen(channel, filtered)}
                            >
                              <span className="epg-block-title">{program.title}</span>
                              <span className="epg-block-time">{formatEpgWindow(program.startMs, program.endMs)}</span>
                            </button>
                          )
                        })}
                    </div>
                  </div>
                )
              }}
              </VirtualWindow>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SeriesView({
  playlist,
  series,
  favorites,
  continueWatching = [],
  playbackEngine = 'auto',
  autoStartEpisode,
  autoStartList,
  autoStartTime,
  autoPlay = false,
  onBack,
  onToggleFavorite,
  onDownloadItem,
  onProgress,
  onMeta,
  onPlayFull,
}: {
  playlist: Playlist
  series: Channel
  favorites: string[]
  continueWatching?: ContinueWatching[]
  playbackEngine?: PlaybackEngine
  autoStartEpisode?: Channel
  autoStartList?: Channel[]
  autoStartTime?: number
  autoPlay?: boolean
  onBack: () => void
  onToggleFavorite: (id: string) => void
  onDownloadItem?: (item: DownloadedItem) => void | Promise<void>
  onProgress: (channel: Channel, currentTime: number, duration: number) => void
  onMeta?: (patch: Partial<Channel>) => void
  /** Assistir vai direto pro player cheio (sem mini). */
  onPlayFull?: (channel: Channel, list: Channel[], startTime: number) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [selectedEp, setSelectedEp] = useState<Channel | null>(null)
  const [epList, setEpList] = useState<Channel[]>([])
  const [playSession, setPlaySession] = useState<{
    channel: Channel
    list: Channel[]
    startTime: number
  } | null>(null)
  const autoStartRef = useRef<string | null>(null)
  const isFav = favorites.includes(series.id)

  const seriesIdToLoad = series.seriesId || series.streamId || series.url
  const [info, setInfo] = useState<Awaited<ReturnType<typeof loadSeriesInfo>> | null>(
    () => peekLoadedSeriesInfo(playlist, seriesIdToLoad) ?? null,
  )
  const onMetaRef = useRef(onMeta)
  onMetaRef.current = onMeta

  useEffect(() => {
    let cancelled = false
    const cached = peekLoadedSeriesInfo(playlist, seriesIdToLoad)
    if (cached) setInfo(cached)

    void loadSeriesInfo(playlist, seriesIdToLoad)
      .then((res) => {
        if (cancelled) return
        setInfo(res)
        const release = res.info?.releaseDate || series.releasedate
        const rating = res.info?.rating !== undefined && res.info?.rating !== null
          ? String(res.info.rating)
          : series.rating
        const plot = res.info?.plot || series.plot
        if (release || rating || plot) {
          onMetaRef.current?.({
            releasedate: release ? String(release) : series.releasedate,
            rating,
            plot,
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Erro ao carregar episódios')
      })
    return () => {
      cancelled = true
    }
  }, [playlist, seriesIdToLoad])

  const seriesProgress = useMemo(() => {
    const sId = series.seriesId || series.streamId
    return continueWatching.find(
      (item) =>
        item.playlistId === playlist.id &&
        ((sId && (item.seriesId === sId || item.channel.seriesId === sId)) ||
          item.channel.name === series.name ||
          item.seriesName === series.name),
    )
  }, [continueWatching, playlist.id, series])

  const getEpProgress = (ep: Channel) => {
    return continueWatching.find(
      (item) =>
        item.playlistId === playlist.id &&
        (item.channel.id === ep.id || (ep.streamId && item.channel.streamId === ep.streamId)),
    )
  }

  const savedEp = useMemo(() => {
    if (!seriesProgress || !info) return null
    return (
      info.seasons.flatMap((s) => s.episodes).find(
        (ep) => ep.id === seriesProgress.channel.id || ep.streamId === seriesProgress.channel.streamId,
      ) || seriesProgress.channel
    )
  }, [seriesProgress, info])

  const allEpisodes = useMemo(() => info?.seasons.flatMap((season) => season.episodes) ?? [], [info])
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)

  useEffect(() => {
    if (!info?.seasons?.length) return
    setSelectedSeason((prev) => {
      if (prev !== null && info.seasons.some((season) => season.season === prev)) return prev
      if (savedEp) {
        const hit = info.seasons.find((season) =>
          season.episodes.some((ep) => ep.id === savedEp.id || ep.streamId === savedEp.streamId),
        )
        if (hit) return hit.season
      }
      return info.seasons[0].season
    })
  }, [info, savedEp])

  const activeSeason =
    info?.seasons.find((season) => season.season === selectedSeason) ?? info?.seasons[0] ?? null

  const enrichEpisode = (ep: Channel): Channel => ({
    ...ep,
    seriesId: series.seriesId || series.streamId || series.id,
    seriesName: info?.info?.name || series.name,
    seriesLogo: info?.info?.cover || series.logo,
  })

  const startPlayback = (ep: Channel, list: Channel[], startTime = 0) => {
    if (onPlayFull) {
      onPlayFull(enrichEpisode(ep), list, startTime)
      return
    }
    setPlaySession({ channel: enrichEpisode(ep), list, startTime })
  }

  useEffect(() => {
    setPlaySession(null)
    autoStartRef.current = null
    resetPlayerChrome()
    void window.sturplay?.player?.hide?.()
  }, [series.id])

  useEffect(() => {
    if (playSession) return
    void window.sturplay?.player?.hide?.()
  }, [playSession])

  useEffect(() => {
    if (!autoPlay || !autoStartEpisode) return
    const key = `${autoStartEpisode.id}-${autoStartTime ?? 0}`
    if (autoStartRef.current === key) return
    const list =
      autoStartList && autoStartList.length > 0
        ? autoStartList
        : allEpisodes.length > 0
          ? allEpisodes
          : null
    if (!list) return
    autoStartRef.current = key
    startPlayback(autoStartEpisode, list, autoStartTime ?? 0)
  }, [series.id, autoStartEpisode?.id, autoStartTime, autoStartList, allEpisodes, autoPlay])

  const handleDownloadEp = (ep: Channel) => {
    void onDownloadItem?.({
      id: downloadIdFor(playlist.id, 'series', ep.id) ?? ep.id,
      name: `${info?.info?.name || series.name} - ${ep.name}`,
      kind: 'series',
      url: ep.url,
      date: new Date().toLocaleDateString('pt-BR'),
      logo: ep.logo || info?.info?.cover || series.logo,
      duration: ep.duration,
      extension: ep.extension || 'mp4',
      playlistId: playlist.id,
    })
  }

  const seriesCover = info?.info?.cover || series.logo

  return (
    <DetailTintView cover={seriesCover} className="series-view">
      <div className="series-detail-scroll movie-detail-scroll">
      {/* Header */}
      <div className="series-header">
        <button className="series-back-btn" onClick={onBack} title="Voltar"><ArrowLeft size={18} /></button>
        <div className="series-header-content">
          <h1 className="series-title">
            {titleWithYear(
              info?.info?.name || series.name,
              series.name,
              info?.info?.releaseDate,
              series.releasedate,
            )}
          </h1>
          {(info?.info?.plot || series.plot) && (
            <p className="series-plot">{info?.info?.plot || series.plot}</p>
          )}
          <div className="movie-metadata-grid">
            {(info?.info?.rating || series.rating) && (
              <div className="movie-meta-item">
                <span className="movie-meta-label">Nota:</span>
                <span className="movie-meta-val">
                  <Star size={13} strokeWidth={2.4} fill="#fbbf24" color="#fbbf24" />
                  {info?.info?.rating || series.rating}
                </span>
              </div>
            )}
            {(info?.info?.releaseDate || series.releasedate) && (
              <div className="movie-meta-item">
                <span className="movie-meta-label">Lançamento:</span>
                <span className="movie-meta-val">{info?.info?.releaseDate || series.releasedate}</span>
              </div>
            )}
            {(info?.info?.addedDate || formatAddedDate(series.added)) && (
              <div className="movie-meta-item">
                <span className="movie-meta-label">Adicionado no servidor:</span>
                <span className="movie-meta-val">{info?.info?.addedDate || formatAddedDate(series.added)}</span>
              </div>
            )}
            {info?.info?.genre && (
              <div className="movie-meta-item">
                <span className="movie-meta-label">Gênero:</span>
                <span className="movie-meta-val">{info.info.genre}</span>
              </div>
            )}
            {info?.info?.director && (
              <div className="movie-meta-item">
                <span className="movie-meta-label">Diretor:</span>
                <span className="movie-meta-val">{info.info.director}</span>
              </div>
            )}
          </div>

          <CastRow cast={info?.info?.cast || (series as any).cast} />

          <div className="movie-actions-row">
            {/* Mesmo desenho do filme: primario claro em linha propria e o par
                abaixo. O `style` inline de fundo rosa saiu — o PRIMARY_ faz o
                papel, e um botao com dois lugares para dizer a cor e um lugar
                que sempre diverge. */}
            {savedEp && seriesProgress && seriesProgress.currentTime > 5 ? (
              <button
                className="movie-play-btn movie-play-btn-strong"
                onClick={() => {
                  startPlayback(
                    savedEp,
                    allEpisodes.length > 0 ? allEpisodes : [savedEp],
                    seriesProgress.currentTime,
                  )
                }}
              >
                <Play size={17} />
                Continuar {formatPlayerTime(seriesProgress.currentTime)}
              </button>
            ) : info?.seasons?.[0]?.episodes?.[0] ? (
              <button
                className="movie-play-btn movie-play-btn-strong"
                onClick={() => {
                  const firstEp = info.seasons[0].episodes[0]
                  startPlayback(
                    firstEp,
                    allEpisodes.length > 0 ? allEpisodes : info.seasons[0].episodes,
                    0,
                  )
                }}
              >
                <Play size={17} />
                Assistir
              </button>
            ) : null}
            <div className="movie-actions-pair">
              <button
                className={`series-fav-btn ${isFav ? 'active' : ''}`}
                onClick={() => onToggleFavorite(series.id)}
              >
                {isFav ? '★ Nos favoritos' : '☆ Adicionar aos favoritos'}
              </button>
            </div>
          </div>
        </div>
        <div className="movie-header-poster">
          <Cover src={info?.info?.cover || series.logo} />
        </div>
      </div>

      {/* Error */}
      {error && <div className="error" style={{ padding: '0 24px 12px' }}>{error}</div>}

      {/* Seasons + Episodes */}
      <div className="series-seasons">
        {!info && !error && <p className="muted" style={{ padding: '0 24px 16px' }}>A carregar episódios…</p>}
        {info && activeSeason && (
          <>
            <div className="series-season-toolbar">
              <SeasonSelect
                value={String(activeSeason.season)}
                onChange={(next) => setSelectedSeason(Number(next))}
                options={info.seasons.map((season) => ({
                  value: String(season.season),
                  label: formatSeasonOptionLabel(`Temporada ${season.season}`, season.episodes.length),
                }))}
              />
            </div>
            <div className="series-season">
              <div className="series-ep-grid">
                {activeSeason.episodes.map((ep) => {
                  const epProg = getEpProgress(ep)
                  return (
                    <div
                      key={ep.id}
                      className="series-ep-card"
                      onClick={() => {
                        setSelectedEp(ep)
                        setEpList(allEpisodes)
                      }}
                    >
                      <div className="series-ep-thumb">
                        <Cover src={ep.logo} fallback={info?.info?.cover || series.logo} />
                        {epProg && epProg.currentTime > 5 && epProg.duration > 0 && (
                          <div className="poster-progress-bar">
                            <div
                              className="poster-progress-fill"
                              style={{ width: `${Math.min(100, (epProg.currentTime / epProg.duration) * 100)}%` }}
                            />
                          </div>
                        )}
                        <button
                          className="series-ep-play-overlay"
                          title={`Assistir: ${ep.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            startPlayback(
                              ep,
                              allEpisodes,
                              epProg && epProg.currentTime > 5 ? epProg.currentTime : 0,
                            )
                          }}
                        >
                          <Play size={22} />
                        </button>
                        {ep.duration && (
                          <div className="series-ep-duration-badge">
                            {ep.duration.replace(/\s*minutos?/i, "'")}
                          </div>
                        )}
                        <div
                          className="series-ep-menu-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedEp(ep)
                            setEpList(allEpisodes)
                          }}
                          title="Opções"
                        >
                          ⋮
                        </div>
                      </div>
                      <div className="series-ep-name">{ep.name}</div>
                      {epProg && epProg.currentTime > 5 && (
                        <div className="poster-subtitle-badge" style={{ padding: '0 4px' }}>
                          {formatPlayerTime(epProg.currentTime)} / {formatPlayerTime(epProg.duration)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
      </div>

      {playSession ? (
        <aside className="movie-embedded-panel vod-windowed-panel live-preview-panel live-preview-player">
          <Player
            key={`${playSession.channel.id}-${playSession.startTime}`}
            embedded
            channel={playSession.channel}
            list={playSession.list}
            playlist={playlist}
            favorite={favorites.includes(playSession.channel.id)}
            favorites={favorites}
            playbackEngine={playbackEngine}
            startTime={playSession.startTime}
            onFav={() => onToggleFavorite(playSession.channel.id)}
            onToggleFavorite={onToggleFavorite}
            onChange={(ch) =>
              setPlaySession((prev) =>
                prev ? { ...prev, channel: enrichEpisode(ch), startTime: 0 } : null,
              )
            }
            onProgress={(currentTime, duration) =>
              onProgress(playSession.channel, currentTime, duration)
            }
            onBack={() => setPlaySession(null)}
          />
        </aside>
      ) : null}

      {/* Episode options bottom sheet */}
      {selectedEp && (() => {
        const epProg = getEpProgress(selectedEp)
        return (
          <div className="live-options-backdrop" onClick={() => setSelectedEp(null)}>
            <div
              className="content-options-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="content-options-header">
                <span style={{ fontSize: 22, color: '#94a3b8' }}>▶</span>
                <h3>{selectedEp.name}</h3>
              </div>
              {selectedEp.releasedate && (
                <p className="muted" style={{ margin: '0 0 4px', fontSize: 13 }}>
                  {selectedEp.releasedate}
                </p>
              )}
              {selectedEp.duration && (
                <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
                  {selectedEp.duration}
                </p>
              )}
              {selectedEp.plot && (
                <p className="muted" style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.5 }}>
                  {selectedEp.plot}
                </p>
              )}
              {epProg && epProg.currentTime > 5 ? (
                <button
                  className="content-option-pill"
                  style={{ background: '#e0115f', borderColor: '#e0115f', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => {
                    startPlayback(selectedEp, epList, epProg.currentTime)
                    setSelectedEp(null)
                  }}
                >
                  <Play size={16} />
                  Continuar ({formatPlayerTime(epProg.currentTime)})
                </button>
              ) : (
                <button
                  className="content-option-pill"
                  style={{ background: '#e0115f', borderColor: '#e0115f', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => {
                    startPlayback(selectedEp, epList, 0)
                    setSelectedEp(null)
                  }}
                >
                  <Play size={16} />
                  Assistir
                </button>
              )}
              <button
                className="content-option-pill"
                onClick={() => {
                  handleDownloadEp(selectedEp)
                  setSelectedEp(null)
                }}
              >
                Baixar
              </button>
              <button
                className="content-option-pill"
                onClick={() => setSelectedEp(null)}
              >
                Fechar
              </button>
            </div>
          </div>
        )
      })()}
    </DetailTintView>
  )
}

function ShellBrand() {
  return (
    <div className="shell-view-brand">
      <div className="brand brand-in-content">
        <img className="brand-mark" src={hamster} alt="" />
        ST PLAY
      </div>
    </div>
  )
}

function FavoritesView({
  favorites,
  catalogs,
  continueWatching,
  onOpen,
  onToggleFavorite,
}: {
  favorites: string[]
  catalogs: Record<ContentKind, Channel[]>
  continueWatching: ContinueWatching[]
  onOpen: (channel: Channel, list: Channel[], startTime?: number) => void
  onToggleFavorite: (id: string) => void
}) {
  const items = useMemo(() => {
    const byId = new Map<string, Channel>()
    for (const channel of [...catalogs.live, ...catalogs.movie, ...catalogs.series]) {
      byId.set(channel.id, channel)
    }
    return favorites.map((id) => byId.get(id)).filter((channel): channel is Channel => Boolean(channel))
  }, [favorites, catalogs])

  const kindLabel = (kind: ContentKind) =>
    kind === 'live' ? 'Ao vivo' : kind === 'movie' ? 'Filme' : 'Série'

  return (
    <div className="favorites-view">
      <ShellBrand />
      <header className="favorites-head">
        <h1 className="favorites-title">Favoritos</h1>
        <p className="favorites-subtitle">
          Cada canal, filme e série marcado com coração nas suas listas. Toque para abrir.
        </p>
      </header>

      <div className="favorites-panel">
        {items.length === 0 ? (
          <div className="favorites-empty">
            <Heart size={42} strokeWidth={1.25} className="favorites-empty-icon" />
            <p>Ainda não há favoritos.</p>
            <span>Marque um canal, filme ou série com coração para vê-lo aqui.</span>
          </div>
        ) : (
          <div className="favorites-grid poster-grid">
            {items.map((channel) => {
              const isFav = favorites.includes(channel.id)
              const rating = movieRatingValue(channel)
              const prog = continueWatching.find(
                (item) =>
                  item.channel.id === channel.id ||
                  (channel.streamId &&
                    (item.channel.streamId === channel.streamId || item.seriesId === channel.streamId)),
              )
              return (
                <div key={channel.id} className="poster-card">
                  <div
                    className="poster-media"
                    onClick={() => onOpen(channel, items)}
                  >
                    <Cover src={channel.logo} />
                    {prog && prog.currentTime > 5 && prog.duration > 0 && (
                      <div className="poster-progress-bar">
                        <div
                          className="poster-progress-fill"
                          style={{ width: `${Math.min(100, (prog.currentTime / prog.duration) * 100)}%` }}
                        />
                      </div>
                    )}
                    {rating > 0 && (
                      <div className="poster-rating">
                        <Star size={11} fill="#facc15" color="#facc15" />
                        {rating.toFixed(1)}
                      </div>
                    )}
                    <button
                      type="button"
                      className={`poster-fav ${isFav ? 'active' : ''}`}
                      title={isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleFavorite(channel.id)
                      }}
                    >
                      <Heart size={15} fill={isFav ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                  <div className="favorites-card-meta">
                    <span className="favorites-kind">{kindLabel(channel.kind)}</span>
                    <strong title={channel.name}>{channel.name}</strong>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function formatDownloadBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function formatSpeed(bps?: number) {
  if (!bps || bps <= 0) return '0 B/s'
  return `${formatDownloadBytes(bps)}/s`
}

function DownloadSpeedGraph({
  samples,
  current,
  max,
}: {
  samples: number[]
  current: number
  max: number
}) {
  const width = 360
  const height = 92
  const pad = 10
  const safeMax = Math.max(max, 1)
  const points =
    samples.length > 1
      ? samples
          .map((value, index) => {
            const x = pad + (index / (samples.length - 1)) * (width - pad * 2)
            const y = height - pad - (Math.min(1, value / safeMax) * (height - pad * 2))
            return `${x},${y}`
          })
          .join(' ')
      : `${pad},${height - pad} ${width - pad},${height - pad}`
  const positive = samples.filter((v) => v > 0)
  const min = positive.length ? Math.min(...positive) : 0

  return (
    <div className="dl-speed-card">
      <div className="dl-speed-head">
        <span>TAXA</span>
        <strong>{formatSpeed(current)}</strong>
      </div>
      <svg className="dl-speed-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline fill="none" stroke="#ff2d7a" strokeWidth="2.4" points={points} />
      </svg>
      <div className="dl-speed-foot">
        <span>min {formatSpeed(min)}</span>
        <span>últimos {Math.max(1, Math.round(samples.length * 0.4))}s</span>
        <span>{formatSpeed(max)} max</span>
      </div>
    </div>
  )
}

function DownloadsView({
  downloads,
  downloadFolder,
  onPlay,
  onRemove,
  onPause,
  onResume,
  onRetry,
  onChangeFolder,
  onOpenFolder,
  onOpenSettings,
}: {
  downloads: DownloadedItem[]
  downloadFolder?: string
  onPlay: (channel: Channel, list: Channel[]) => void
  onRemove: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onRetry: (item: DownloadedItem) => void | Promise<void>
  onChangeFolder: () => void | Promise<void>
  onOpenFolder: () => void
  onOpenSettings: () => void
}) {
  const active = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'paused' || d.status === 'queued',
  )
  const completed = downloads.filter((d) => !d.status || d.status === 'completed')
  const errored = downloads.filter((d) => d.status === 'error')
  const [speedSamples, setSpeedSamples] = useState<number[]>([])
  const currentSpeed = active.reduce((sum, item) => sum + (item.speed || 0), 0)

  useEffect(() => {
    if (active.length === 0) {
      setSpeedSamples([])
      return
    }
    setSpeedSamples((prev) => [...prev.slice(-48), currentSpeed])
  }, [currentSpeed, active.length])

  const maxSpeed = Math.max(currentSpeed, ...speedSamples, 1)

  return (
    <div className="downloads-view downloads-view-pro">
      <ShellBrand />
      <header className="dl-hero">
        <div>
          <h1 className="dl-title">Downloads</h1>
          <p className="dl-subtitle">
            {active.length > 0
              ? `${active.length} ativo${active.length > 1 ? 's' : ''}`
              : completed.length > 0
                ? `${completed.length} arquivo${completed.length > 1 ? 's' : ''} baixado${completed.length > 1 ? 's' : ''}`
                : 'Nenhum download no momento'}
          </p>
        </div>
      </header>

      <div className="dl-path-bar">
        <div className="dl-path-left">
          <Settings size={16} />
          <span title={downloadFolder || 'Pasta padrão'}>
            Salvando em {downloadFolder || 'pasta padrão do sistema'}
          </span>
        </div>
        <div className="dl-path-actions">
          <button type="button" className="dl-link" onClick={() => void onChangeFolder()}>
            Alterar pasta
          </button>
          <button type="button" className="dl-link muted" onClick={onOpenSettings}>
            Configurações
          </button>
          <button type="button" className="dl-link muted" onClick={onOpenFolder}>
            <FolderOpen size={15} />
            Abrir pasta
          </button>
        </div>
      </div>

      <div className="dl-scroll">
        <section className="dl-section">
          <h2 className="dl-section-title">Em andamento</h2>
          {active.length === 0 ? (
            <div className="dl-empty-inline">Nenhum download em andamento.</div>
          ) : (
            <>
              <DownloadSpeedGraph samples={speedSamples} current={currentSpeed} max={maxSpeed} />
              <div className="dl-active-list">
                {active.map((item) => {
                  const pct =
                    item.total && item.total > 0
                      ? Math.min(100, Math.round(((item.received || 0) / item.total) * 100))
                      : 0
                  return (
                    <div key={item.id} className="dl-active-card">
                      <div className="dl-active-top">
                        <strong title={item.name}>{item.name}</strong>
                        <div className="dl-active-actions">
                          {item.status === 'paused' ? (
                            <button type="button" onClick={() => onResume(item.id)}>
                              Continuar
                            </button>
                          ) : (
                            <button type="button" onClick={() => onPause(item.id)}>
                              Pausar
                            </button>
                          )}
                          <button type="button" className="danger" onClick={() => onRemove(item.id)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                      <div className="dl-active-status">
                        <span
                          className={`dl-dot ${item.status === 'paused' || item.status === 'queued' ? 'is-paused' : ''}`}
                        />
                        {item.status === 'paused'
                          ? 'Pausado'
                          : item.status === 'queued'
                            ? 'Na fila'
                            : 'Baixando'}{' '}
                        {formatDownloadBytes(item.received)} / {item.total ? formatDownloadBytes(item.total) : '—'}
                        {item.total ? ` · ${pct}%` : ''}
                        {item.status === 'downloading' ? ` · ${formatSpeed(item.speed)}` : ''}
                      </div>
                      <div className="dl-progress-track">
                        <div className="dl-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>

        {errored.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-title">Com erro</h2>
            <div className="dl-active-list">
              {errored.map((item) => (
                <div key={item.id} className="dl-active-card is-error">
                  <div className="dl-active-top">
                    <strong>{item.name}</strong>
                    <div className="dl-error-actions">
                      {/* O item guardado tem url, name e extension, entao o retry e
                          um start normal. Antes o unico caminho era "Remover", e um
                          erro de rede banal custava refazer tudo do zero. */}
                      <button
                        type="button"
                        className="dl-retry-btn"
                        onClick={() => onRetry(item)}
                        title={`Tentar baixar ${item.name} de novo`}
                      >
                        Tentar de novo
                      </button>
                      <button type="button" className="danger" onClick={() => onRemove(item.id)}>
                        Remover
                      </button>
                    </div>
                  </div>
                  <div className="dl-active-status">{item.error || 'Falha no download'}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="dl-section">
          <h2 className="dl-section-title">Baixado</h2>
          {completed.length === 0 ? (
            <div className="dl-empty-panel">
              <Download size={42} strokeWidth={1.4} />
              <p>Ainda não há arquivos baixados.</p>
              <span>Abra um filme ou episódio e toque em Baixar para salvar aqui.</span>
            </div>
          ) : (
            <div className="dl-done-grid">
              {completed.map((item) => (
                <div key={item.id} className="dl-done-card">
                  <div className="dl-done-main">
                    {item.logo ? (
                      <img src={coverSrc(item.logo) || hamster} alt="" />
                    ) : (
                      <div className="dl-done-fallback">
                        <Download size={18} />
                      </div>
                    )}
                    <div className="dl-done-meta">
                      <strong title={item.name}>{item.name}</strong>
                      <span>
                        {item.kind === 'movie' ? 'Filme' : 'Série'} · {item.date}
                        {item.total ? ` · ${formatDownloadBytes(item.total)}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="dl-done-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        const ch: Channel = {
                          id: item.id,
                          name: item.name,
                          group: 'Downloads',
                          url: toLocalMediaUrl(item.filePath || item.url),
                          logo: item.logo,
                          kind: item.kind,
                        }
                        onPlay(ch, [ch])
                      }}
                    >
                      Assistir
                    </button>
                    {item.filePath && (
                      <button
                        type="button"
                        onClick={() => void window.sturplay?.downloads?.reveal?.(item.filePath!)}
                      >
                        Pasta
                      </button>
                    )}
                    <button type="button" className="danger" onClick={() => onRemove(item.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function parseVodDurationSec(channel: Channel, progress?: ContinueWatching): number {
  if (progress?.duration && progress.duration > 1) return progress.duration
  const raw = channel.duration?.trim()
  if (!raw) return 0
  const hms = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])
  const apostropheMin = raw.match(/^(\d+(?:[.,]\d+)?)\s*'$/)
  if (apostropheMin) return Math.round(Number.parseFloat(apostropheMin[1].replace(',', '.')) * 60)
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum > 500 ? asNum : asNum * 60
  }
  const minMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*min/i)
  if (minMatch) return Math.round(Number.parseFloat(minMatch[1].replace(',', '.')) * 60)
  const digits = raw.match(/(\d+)/)
  if (!digits) return 0
  const v = Number(digits[1])
  return raw.toLowerCase().includes('min') || v < 500 ? v * 60 : v
}

function noteFullscreenFailure(reason: string) {
  // `console-message` no main grava isto em internal-debug.log. Antes o
  // `.catch(() => {})` jogava a recusa fora e nao sobrava nenhum rastro de
  // POR QUE o botao de tela cheia nao fazia nada.
  console.warn('[stplay] fullscreen recusado pelo container, indo para a janela:', reason)
}

function forceShellVisible() {
  document.body.classList.remove('player-active', 'native-vod-active', 'electron-fullscreen')
  document.documentElement.style.background = ''
  document.body.style.background = ''
  for (const el of document.querySelectorAll<HTMLElement>('.app-shell, .topbar')) {
    el.style.visibility = ''
    el.style.pointerEvents = ''
  }
  // Async — sendSync (restoreShell) travava o renderer na abertura.
  void window.sturplay?.player?.hide?.()
}

function resetPlayerChrome() {
  forceShellVisible()
  void window.sturplay?.window?.setFullscreen?.(false)
}

/** Restaura janela React após mpv (Esc / voltar) — evita tela preta. */
function exitNativePlayback(opts = { exitFullscreen: true }) {
  forceShellVisible()
  /*
    Sair da tela cheia aqui e OPCIONAL.

    O `back` do overlay passa `exitFullscreen: false` quando a tela cheia era do
    dono (`origin: 'app'`): o video para e o catalogo volta, mas a janela continua
    em tela cheia, porque foi o usuario quem colocou.

    Sem essa opcao, os dois caminhos brigavam: o `back` decidia corretamente nao
    sair, e logo em seguida `resetPlayerChrome` tirava a janela de tela cheia
    assim mesmo — que e exatamente o "sai da tela cheia sozinho" que o dono
    mandou nao acontecer.
  */
  if (opts.exitFullscreen !== false) {
    void window.sturplay?.window?.setFullscreen?.(false)
  }
  void window.sturplay?.player?.hide?.()
  void window.sturplay?.player?.stop?.()
  void window.sturplay?.nativePlayer?.stopExternal?.()
}

function readStoredVolume() {
  try {
    const raw = localStorage.getItem('stplay.volume')
    const value = raw === null ? 1 : Number(raw)
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
  } catch {
    return 1
  }
}

const LIVE_ZAP_FEEDBACK_MS = 450

function Player({
  channel,
  list,
  playlist,
  favorite,
  favorites,
  progress,
  startTime,
  autoFullscreen = false,
  embedded = false,
  fullscreenRequest = 0,
  playbackEngine = 'internal',
  onFav,
  onToggleFavorite,
  onChange,
  onProgress,
  onBack,
}: {
  channel: Channel
  list: Channel[]
  playlist: Playlist | null
  favorite: boolean
  favorites: string[]
  progress?: ContinueWatching
  startTime?: number
  autoFullscreen?: boolean
  embedded?: boolean
  fullscreenRequest?: number
  playbackEngine?: PlaybackEngine
  onFav: () => void
  onToggleFavorite: (id: string) => void
  onChange: (channel: Channel) => void
  onProgress: (currentTime: number, duration: number) => void
  onBack: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerWrapRef = useRef<HTMLDivElement>(null)
  const overlayOn = useRef(true)
  const hideTimer = useRef(0)
  const [overlay, setOverlay] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerSearch, setDrawerSearch] = useState('')
  const [drawerTab, setDrawerTab] = useState<'channels' | 'categories'>('channels')
  const [drawerCategory, setDrawerCategory] = useState<string | null>(null)
  const [drawerSeason, setDrawerSeason] = useState<string | null>(null)
  const drawerOpenRef = useRef(false)
  const channelListRef = useRef(list)
  const onChangeRef = useRef(onChange)
  channelListRef.current = list
  onChangeRef.current = onChange
  const [aspect] = useState<'fit' | 'fill' | 'wide'>('fit')
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [bufferPercent, setBufferPercent] = useState(0)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [mediaRetry, setMediaRetry] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [seeking, setSeeking] = useState(false)
  const seekPointerRef = useRef(false)
  const [seekTime, setSeekTime] = useState(0)
  const [epg, setEpg] = useState<ShortEpg | null>(null)
  const progressHandler = useRef(onProgress)
  progressHandler.current = onProgress
  const playbackClockRef = useRef({ current: 0, duration: 0 })
  playbackClockRef.current = { current: currentTime, duration }
  const lastNativeProgressSave = useRef(0)
  const lastNativeProgressSig = useRef('')
  // Seek do player interno: o efeito que escuta o <video> precisa destes sem
  // depender deles, senão cada `seeking` recria o efeito.
  const seekingRef = useRef(seeking)
  seekingRef.current = seeking
  const durationRef = useRef(duration)
  durationRef.current = duration
  const lastVideoSaveRef = useRef(0)
  /**
   * Indicador de espera do zape de live com motor nativo.
   *
   * `LIVE_ZAP_FEEDBACK_MS` é a janela em que o app se cala. Abaixo dela, um zape
   * normal (300ms) não acende nada. Acima dela, a origem demorou e o usuario
   * precisa saber que algo está acontecendo — antes disso, ele via 15 segundos
   * de video congelado sem nenhuma pista.
   */
  const liveZapWaitRef = useRef(0)
  const clearLiveZapWait = useCallback(() => {
    if (liveZapWaitRef.current) {
      window.clearTimeout(liveZapWaitRef.current)
      liveZapWaitRef.current = 0
    }
  }, [])
  const channelRef = useRef(channel)
  channelRef.current = channel
  /**
   * Re-resolução de stream_id de live, uma vez por tentativa.
   *
   * usy evita ailed repetido (o motor pode emitir mais de um) virando
   * N requisições de catálogo. `trocas` impede o caso patológico em que o painel
   * devolve sempre um id novo que também está morrendo: depois de duas trocas o
   * app para de insistir e mostra o erro.
   *
   * O `esperado` e o que impede o laço MEDIDO, que antes vivia aqui:
   *
   *   22:31:01  de 709067 para 709686
   *   22:31:05  de 709686 para 709067
   *   22:31:08  de 709067 para 709686
   *   22:31:12  de 709686 para 709067   <- e continuava
   *
   * A chave do reset NAO pode ser `channel.id`: a própria rotação monta
   * `id: 'live-' + stream_id` (xtream.ts:558), então voltar e meia disparava o
   * reset, zerava `trocas`, e o contador nunca chegava a 1. O laço não era de
   * rotação demais, era de contador sem memória.
   *
   * E como o ramo de rotação termina em `return` ANTES do `setPlaybackError`, um
   * laço aqui é o que produzia a tela preta sem mensagem nenhuma.
   */
  const liveReresolveRef = useRef<LiveReresolveState>(estadoInicialReresolve(channel.id))
  /**
   * Tentativas automaticas de live antes de mostrar a caixa de erro.
   *
   * Zera a cada troca de canal — e uma escolha nova da pessoa, nao a mesma
   * tentativa. Sem o zero, um canal que falhou duas vezes nunca mais abriria
   * sem clique, nem depois de o painel voltar.
   */
  const tentativaAutomaticaRef = useRef<TentativaAutomaticaState>(estadoTentativaAutomatica())
  const tentativaAutomaticaTimerRef = useRef(0)
  useEffect(() => {
    tentativaAutomaticaRef.current = estadoTentativaAutomatica()
    window.clearTimeout(tentativaAutomaticaTimerRef.current)
    tentativaAutomaticaTimerRef.current = 0
  }, [channel.id])
  /**
   * Limpeza no unmount.
   *
   * Sem isto o timer de 2,5s sobrevive ao componente: quem navega para outra
   * tela dentro desses 2,5s receives `iniciarRetry`rodando em um componente que
   * ja nao esta na ar — `setMediaRetry` reacende o motor para um canal que a
   * pessoa ja deixou, e o React avisa de setState em componente desmontado.
   *
   * O efeito de `[channel.id]` acima nao cobre isto: trocar de canal mantem o
   * componente montado, desmontar e que nao passa por ele.
   */
  useEffect(
    () => () => {
      window.clearTimeout(tentativaAutomaticaTimerRef.current)
      tentativaAutomaticaTimerRef.current = 0
    },
    [],
  )
  useEffect(() => {
    const novo = deveZerarReresolve(liveReresolveRef.current, channel.id)
    if (novo) liveReresolveRef.current = novo
  }, [channel.id])
  const progressRef = useRef(progress)
  progressRef.current = progress
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([])
  const [activeAudioTrack, setActiveAudioTrack] = useState<number>(0)
  const [activeSubtitleTrack, setActiveSubtitleTrack] = useState<number | null>(null)
  const [showAudioMenu, setShowAudioMenu] = useState(false)
  const [showCaptionsMenu, setShowCaptionsMenu] = useState(false)
  const [showResumeToast, setShowResumeToast] = useState(false)
  const playerControls = useRef<PlayerControls>({ setAudioTrack: () => {}, setSubtitleTrack: () => {} })
  const managerRef = useRef<PlayerManager | null>(null)
  const [nativeEmbedded, setNativeEmbedded] = useState(false)
  const [nativeBooting, setNativeBooting] = useState(false)
  // Espelho de `nativeBooting` em ref, pelo mesmo motivo do `winFsRef`.
  //
  // `handlePlayerEscape` le `nativeBooting`, e ela e chamada de um `keydown`
  // cujo array de deps NAO a inclui. `nativeBooting` e o estado mais volatil do
  // player: muda em oito lugares, e um retry do MESMO canal nao muda `channel` —
  // entao o efeito do teclado nao re-rodava e o closure ficava com o valor velho.
  const nativeBootingRef = useRef(false)
  nativeBootingRef.current = nativeBooting
  const [retryingNative, setRetryingNative] = useState(false)
  const [managedEngine, setManagedEngine] = useState<'internal' | 'stur' | 'mpeg' | null>(null)
  const managedEngineRef = useRef(managedEngine)
  managedEngineRef.current = managedEngine
  const nativePlayedRef = useRef(false)
  const lastPlayUrlRef = useRef(channel.url)
  const usePlayerManager = playbackEngine === 'auto' || playbackEngine === 'stur' || playbackEngine === 'mpeg'
  const useNativePlayer =
    playbackEngine === 'stur' ||
    playbackEngine === 'mpeg' ||
    (playbackEngine === 'auto' && managedEngine === 'stur')
  const useBufferedNative = useNativePlayer

  useEffect(() => {
    if (embedded) return
    document.body.classList.add('player-active')
    return () => {
      forceShellVisible()
    }
  }, [embedded])

  // requestFullscreen precisa de user gesture. setTimeout/useEffect nao contam.
  // O botao de fullscreen (toggleFullscreen) ja chama direto — esse autoFullscreen
  // ficava no automático e o Chromium recusava silenciosamente.
  useEffect(() => {
    if (!autoFullscreen || embedded || nativeBooting || !playing) return
    // Sem user gesture, o Chromium recusa. O botao de fullscreen resolve isso.
    // Aqui so garante que o overlay nao cobre o video enquanto carrega.
    return () => {}
  }, [autoFullscreen, channel.url, embedded, nativeBooting, playing])

  useEffect(() => {
    if (!embedded || !fullscreenRequest) return
    // fullscreenRequest vem de um clique do usuario — mas o useEffect roda depois
    // do paint, e o Chromium pode perder o gesto. Se falhar, o botao resolve.
    const root = playerWrapRef.current
    if (!root || document.fullscreenElement) return
    void root.requestFullscreen().catch(() => {})
  }, [embedded, fullscreenRequest])

  const initialTime =
    startTime !== undefined
      ? startTime
      : progress?.currentTime && progress.currentTime > 5
        ? progress.currentTime
        : 0
  const initialTimeRef = useRef(initialTime)
  initialTimeRef.current = initialTime

  useEffect(() => {
    if (!showResumeToast) return
    const timer = window.setTimeout(() => setShowResumeToast(false), 6000)
    return () => window.clearTimeout(timer)
  }, [showResumeToast])

  const zap = useMemo(() => {
    const index = Math.max(0, list.findIndex((item) => item.id === channel.id))
    const from = Math.max(0, index - 50)
    return list.slice(from, index + 51)
  }, [channel.id, list])

  const drawerCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of list) {
      const group = item.group?.trim() || 'Outros'
      counts.set(group, (counts.get(group) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
  }, [list])

  const seriesSeasonGroups = useMemo(() => {
    if (channel.kind !== 'series') return []
    return groupEpisodesBySeason(list)
  }, [channel.kind, list])

  const filteredZap = useMemo(() => {
    const q = drawerSearch.trim().toLowerCase()
    let items = list
    if (channel.kind === 'series') {
      if (!q && drawerSeason) {
        items = items.filter((item) => resolveEpisodeSeason(item) === drawerSeason)
      }
    } else if (drawerCategory) {
      items = items.filter((item) => (item.group?.trim() || 'Outros') === drawerCategory)
    }
    if (q) {
      items = items.filter(
        (item) =>
          item.name?.toLowerCase().includes(q) ||
          resolveEpisodeSeason(item).toLowerCase().includes(q),
      )
    } else if (channel.kind !== 'series' && !drawerCategory && items.length > 180) {
      items = zap
    }
    return items
  }, [list, zap, drawerSearch, drawerCategory, drawerSeason, channel.kind])

  const channelIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    list.forEach((item, index) => map.set(item.id, index + 1))
    return map
  }, [list])

  useEffect(() => {
    drawerOpenRef.current = drawerOpen
    if (drawerOpen) bumpOverlay()
  }, [drawerOpen])

  useEffect(() => {
    if (channel.kind !== 'series' || seriesSeasonGroups.length === 0) return
    const currentSeason =
      findSeasonForEpisode(list, channel.id) || seriesSeasonGroups[0]?.[0] || null
    setDrawerSeason((prev) => {
      if (prev && seriesSeasonGroups.some(([season]) => season === prev)) return prev
      return currentSeason
    })
  }, [channel.kind, channel.id, list, seriesSeasonGroups])

  useEffect(() => {
    if (!drawerOpen) return
    const active = document.querySelector('.channel-drawer-item.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest' })
  }, [drawerOpen, channel.id, drawerTab, drawerSeason])

  useEffect(() => {
    if (channel.kind === 'live') {
      const recents = loadRecentLiveChannels()
      const updated = [channel, ...recents.filter((c) => c.id !== channel.id)].slice(0, 3)
      saveRecentLiveChannels(updated)
    }
  }, [channel])

  /**
   * Tela cheia em duas camadas, porque sao dois mecanismos diferentes.
   *
   * O botao usava so `requestFullscreen()` no container do video e engolia a
   * rejeicao com `.catch(() => {})`. Quando o Chromium recusa — e recusa: o
   * container esta dentro de um scroller com `overflow: hidden` e, no motor
   * nativo, o wrap e so um placeholder porque quem desenha e o overlay/mpv — o
   * botao virava um no-op silencioso. Sem erro, sem feedback: clique e nada.
   *
   * Agora: tenta o container (igual IPTV Player One, e o que faz o overlay
   * acompanhar via `setBounds`), e se recusar cai para a tela cheia DE JANELA,
   * que ja existia no main (`window:set-fullscreen` + `setAlwaysOnTop` para
   * cobrir a taskbar) e nunca era usada por este botao. O estado das duas
   * camadas e o mesmo `isFs`, senao o segundo clique entraria de novo em vez de
   * sair.
   */
  const [domFs, setDomFs] = useState(false)
  const [winFs, setWinFs] = useState(false)

  // Espelho de `winFs` em ref. Ver o comentario do uso, em `exitPlayerFullscreen`.
  const winFsRef = useRef(false)

  useEffect(() => {
    const onFs = () => setDomFs(document.fullscreenElement === playerWrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    const off = window.sturplay?.window?.onFullscreenChanged?.((payload) => {
      const v = Boolean((payload as { fullscreen?: boolean } | undefined)?.fullscreen)
      winFsRef.current = v
      setWinFs(v)
    })
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      if (typeof off === 'function') off()
    }
  }, [])

  const isFs = domFs || winFs

  // Fullscreen com preview embutido: o catálogo continua montado atrás do
  // vídeo e o HWND do mpv tem input desligado — o clique atravessa o vídeo e
  // cai no catálogo/pesquisa. Igual Smarters (só vídeo + controles no
  // fullscreen): esconde o shell enquanto durar o fullscreen com playback.
  useEffect(() => {
    if (!embedded || !isFs || !playing) return
    document.body.classList.add('player-active')
    return () => {
      document.body.classList.remove('player-active')
    }
  }, [embedded, isFs, playing])

  const enterWindowFullscreen = async () => {
    try {
      const res = (await window.sturplay?.window?.setFullscreen?.(true)) as { ok?: boolean } | undefined
      // Main respondeu que nao pode: nao ha mais nada a tentar, e fingir que
      // entrou deixa o botao sem resposta de novo.
      if (res && res.ok === false) noteFullscreenFailure('janela recusou')
      return
    } catch {
      noteFullscreenFailure('janela lancou')
    }
  }

  const toggleFullscreen = () => {
    const root = playerWrapRef.current

    // NADA aqui pode depender de `isFs`/`domFs` capturados no render.
    //
    // `toggleFullscreen` e chamado de um `keydown` registrado num efeito cujo
    // array de deps NAO inclui `isFs`, `domFs` nem a propria `toggleFullscreen`.
    // O closure portanto fica congelado no valor do render em que o efeito rodou
    // por ultimo, e `isFs` muda sem re-rodar o efeito.
    //
    // A ordem das fontes tambem importa, e foi medida no log:
    //
    //   overlay action { type: 'select', overlayAchaFullscreen: true,
    //                    janelaRealFullscreen: false }
    //
    // O overlay SABIA que estava em tela cheia, e `win.isFullScreen()` disse
    // `false`. NESTE APP o fullscreen de elemento DOM nao aparece em
    // `BrowserWindow.isFullScreen()`. Então consultar o processo principal para
    // decidir se estamos em tela cheia da errado justamente no caminho de SAIR:
    // ele responde `false`, o codigo acha que nao esta em tela cheia, e chama
    // `setFullscreen(true)` — que e no-op. O sintoma era o log mostrar 14 pedidos
    // de saida seguidos com a janela presa.
    //
    // Por isso a fonte de verdade e `document.fullscreenElement`, que e leitura
    // ao vivo do DOM e nao envelhece. E a verificacao e "TEM elemento em
    // tela cheia", e nao "o elemento e o wrapper do player": quando o playback
    // para, o wrapper desmonta, o elemento some da comparacao, e a saida ficava
    // sem caminho — que era o segundo furo do mesmo bug.
    //
    // A DECISAO virou funcao pura em `lib/player/fullscreen-decision.ts`, com
    // teste. O que faltava aqui e a camada da JANELA: `requestFullscreen` e
    // recusado neste app (o log registra "fullscreen recusado pelo container"), a
    // entrada cai na tela cheia da JANELA, e `document.fullscreenElement`
    // CONTINUA vazio — tela cheia de janela nao passa pelo DOM. O proximo clique
    // nao achava nada para sair e entrava de novo. Era o bug que o usuario
    // reportou: o botao entra e nao sai.
    const acao = decideFullscreenAction({
      documentFullscreenElement: document.fullscreenElement,
      // A camada da JANELA, e nao `isFs`: `isFs` e o rotulo do botao e vem do
      // render. Aqui o comando decide, o rotulo so informa.
      windowFullscreen: winFsRef.current,
      playerMounted: Boolean(root),
      canRequestElementFullscreen: typeof root?.requestFullscreen === 'function',
    })

    if (acao.kind === 'exit-dom') {
      void document.exitFullscreen().catch(() => {})
      return
    }
    if (acao.kind === 'exit-window') {
      void window.sturplay?.window?.setFullscreen?.(false)
      return
    }

    void (async () => {
      /*
        Direto para a JANELA, sem tentar o DOM.

        `root.requestFullscreen()` TRAVA neste app: a promise nem resolve nem
        rejeita (medido — o renderer congelou 150 s num `requestFullscreen`
        pendurado, e o botao de tela cheia da barra parou de responder). O DOM
        nunca foi o caminho aqui: a entrada sempre caia na tela cheia da janela
        depois da recusa, e agora nem a recusa chega.

        `root` continua lido para `decideFullscreenAction` acima (saber se o
        player esta montado). So a ENTRADA pula o DOM.
      */
      await enterWindowFullscreen()
    })()
  }

  const exitPlayerFullscreen = () => {
    // Mesmo criterio do F11: "TEM elemento em tela cheia", e nao "o elemento e o
    // wrapper". Se o playback parou e o wrapper desmontou, comparar identidade
    // deixava o ESC sem caminho.
    //
    // `winFsRef.current` e nao `winFs`: `exitPlayerFullscreen` e chamada de um
    // `keydown` cujo array de deps NAO inclui `winFs`, entao o closure leria o
    // valor congelado. Ver o comentario do ref.
    if (escapeShouldExitFullscreen(document.fullscreenElement, winFsRef.current)) {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {})
      } else {
        void window.sturplay?.window?.setFullscreen?.(false)
      }
      return true
    }
    return false
  }

  const handlePlayerEscape = () => {
    if (exitPlayerFullscreen()) return
    if (embedded) {
      if (channel.kind !== 'live') {
        exitNativePlayback()
        onBack()
        return
      }
      onBack()
      return
    }
    if (drawerOpen) {
      setDrawerOpen(false)
      bumpOverlay()
      return
    }
    // Filme/série: Esc sai direto (como Player One), não só revela controles.
    if (channel.kind !== 'live') {
      exitNativePlayback()
      onBack()
      return
    }
    if (useBufferedNative && !nativeBootingRef.current && !overlayOn.current) {
      bumpOverlay()
      return
    }
    if (!useBufferedNative && !overlayOn.current) {
      bumpOverlay()
      return
    }
    onBack()
  }

  useEffect(() => {
    if (!useNativePlayer) return
    const offFs = window.sturplay?.player?.onUiFullscreen?.(() => {
      toggleFullscreen()
    })
    const offKey = window.sturplay?.player?.onUiKey?.((payload) => {
      const key = payload?.key
      if (!key) return
      if (key === 'Escape') {
        handlePlayerEscape()
        return
      }
      if (key === 'F11') {
        toggleFullscreen()
        return
      }
      if (key === 'Up' || key === 'Down') {
        const i = list.findIndex((item) => item.id === channel.id)
        if (channel.kind === 'live') {
          if (key === 'Up' && i > 0) onChange(list[i - 1])
          if (key === 'Down' && i < list.length - 1) onChange(list[i + 1])
        }
        return
      }
      if (useBufferedNative) {
        void window.sturplay?.player?.sendOverlayUi?.({ action: 'key', key })
      }
    })
    return () => {
      offFs?.()
      offKey?.()
    }
  }, [useNativePlayer, useBufferedNative, channel, list, embedded, drawerOpen, onBack, onChange])

  useEffect(() => {
    if (!useNativePlayer) return
    const onFs = () => {
      const root = playerWrapRef.current
      const fs = Boolean(root && document.fullscreenElement === root)
      document.body.classList.toggle('electron-fullscreen', fs)
      // `fullscreen` NAO e empurrado aqui de proposito. Quem manda esse campo e o
      // efeito da uniao mais abaixo (`domFs || winFs`).
      //
      // Empurrar o valor so do DOM fazia o overlay receber `false` no instante em
      // que a tela cheia de JANELA continuava de pe — o `fullscreenchange` do
      // documento so enxerga o caminho DOM. O overlay entao achava que nao
      // estava em tela cheia, e o ESC caia no ramo `back`, que DERRUBA O VIDEO
      // em vez de sair da tela cheia. Foi o que o usuario reportou: ESC parou o
      // video e a janela continuou em F11, sem F11 para tirar.
      const el = playerWrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      void window.sturplay?.player?.setBounds?.({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [useNativePlayer])

  // A tela cheia de JANELA nao dispara `fullscreenchange` no documento — e o
  // efeito acima so escuta esse evento. Sem isto, entrar em tela cheia pelo
  // fallback do botao deixava o overlay/mpv com os bounds antigos: a janela
  // ocupava a tela toda e o video continuava do tamanho do card. Reposicionar
  // no proximo frame, depois que o layout da janela ja assentou.
  // DONO UNICO do campo `fullscreen` do overlay.
  //
  // Sao dois mecanismos de tela cheia independentes no app: o DOM
  // (`requestFullscreen` no wrapper do player, que dispara `fullscreenchange`)
  // e o da JANELA (`win.setFullScreen`, que nao dispara `fullscreenchange` no
  // documento). O overlay decide o que o ESC faz lendo esse campo:
  //
  //   fullscreen -> ESC sai da tela cheia
  //   !fullscreen -> ESC mostra os controles, e depois para o video (`back`)
  //
  // Se o campo discordar do que esta na tela, o ESC faz a coisa errada. Era
  // exatamente o relatado: ESC DERROBOU O VIDEO e a janela continuou em F11.
  // Motivo: so o caminho DOM empurrava o valor, e empurrava `false` no momento
  // em que a tela cheia de janela continuava ativa. O caminho nativo empurrava
  // `true` na entrada e NUNCA na saida.
  //
  // Aqui vai a uniao dos dois, empurrada em qualquer mudanca — inclusive a
  // volta, que antes nao chegava ao overlay.
  useEffect(() => {
    void window.sturplay?.player?.setOverlayMeta?.({ fullscreen: isFs })
  }, [isFs])

  useEffect(() => {
    if (!useNativePlayer || !winFs) return
    let raf = 0
    let tries = 0
    const reposition = () => {
      const el = playerWrapRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          // `fullscreen` tambem nao e empurrado aqui: este efeito cuida so de
          // POSICAO. O campo `fullscreen` tem um dono so, o efeito da uniao
          // abaixo — e ele cobre os dois caminhos, inclusive a saida, que este
          // efeito nunca fazia (so empurrava `true`).
          void window.sturplay?.player?.setBounds?.({
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          })
        }
      }
      // Ajusta nas proximas frames: o Electron ainda esta animando a janela.
      if (tries < 8) {
        tries += 1
        raf = requestAnimationFrame(reposition)
      }
    }
    raf = requestAnimationFrame(reposition)
    return () => cancelAnimationFrame(raf)
  }, [useNativePlayer, winFs])

  // Volta do F11: a janela anima de volta ao modo janela e o HWND ficava com
  // os bounds do fullscreen (vídeo deslocado, faixa preta, catálogo cortado).
  // Espelha o efeito de entrada: empurra o rect do playerWrap por frames até
  // o mpv/overlay assentarem no preview de novo.
  const wasWinFsRef = useRef(false)
  useEffect(() => {
    const was = wasWinFsRef.current
    wasWinFsRef.current = winFs
    if (!useNativePlayer || winFs || !was) return
    let raf = 0
    let tries = 0
    const reposition = () => {
      const el = playerWrapRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          void window.sturplay?.player?.setBounds?.({
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          })
        }
      }
      if (tries < 10) {
        tries += 1
        raf = requestAnimationFrame(reposition)
      }
    }
    raf = requestAnimationFrame(reposition)
    return () => cancelAnimationFrame(raf)
  }, [useNativePlayer, winFs])

  useEffect(() => {
    if (!useNativePlayer) return
    return () => {
      forceShellVisible()
    }
  }, [useNativePlayer])

  const skipTime = (delta: number) => {
    if (useNativePlayer) {
      const next = Math.max(0, Math.min(duration || 999999, currentTime + delta))
      void managerRef.current?.command({ op: 'seek', seconds: next })
      setCurrentTime(next)
      bumpOverlay()
      return
    }
    const video = videoRef.current
    if (!video) return
    const next = Math.max(0, Math.min(video.duration || 999999, video.currentTime + delta))
    video.currentTime = next
    setCurrentTime(next)
    bumpOverlay()
  }

  const handleSeekStart = () => {
    seekPointerRef.current = true
    setSeeking(true)
  }

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value)
    setSeekTime(val)
    setCurrentTime(val)
  }

  const handleSeekEnd = (e: React.SyntheticEvent<HTMLInputElement>) => {
    if (!seekPointerRef.current) return
    seekPointerRef.current = false
    setSeeking(false)
    const val = Number((e.target as HTMLInputElement).value)
    if (!Number.isFinite(val)) return
    if (useNativePlayer) {
      void managerRef.current?.command({ op: 'seek', seconds: val })
      setCurrentTime(val)
    } else if (videoRef.current) {
      videoRef.current.currentTime = val
      setCurrentTime(val)
    }
    bumpOverlay()
  }

  useEffect(() => {
    if (usePlayerManager) return
    const video = videoRef.current
    if (!video) return
    let cancelled = false

    setBuffering(true)
    setBufferPercent(0)
    setPlaying(false)
    setPlaybackError(null)
    setCurrentTime(0)
    setDuration(0)
    setAudioTracks([])
    setSubtitleTracks([])
    setNativeEmbedded(false)

    const cleanup = attachPlayerEx(video, channel.url, {
      live: channel.kind === 'live',
      heavy: channel.kind === 'live' && isHeavyLiveChannel(channel),
      onError: (err) => {
        if (!cancelled) {
          setPlaybackError(err)
          setBuffering(false)
          setPlaying(false)
        }
      },
      onAudioTracks: (tracks) => {
        if (!cancelled) setAudioTracks(tracks)
      },
      onSubtitleTracks: (tracks) => {
        if (!cancelled) setSubtitleTracks(tracks)
      },
      controls: playerControls.current,
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [channel.url, channel.kind, mediaRetry, usePlayerManager])

  /**
 * Liga a proxima tentativa. E o mesmo caminho do botao "Tentar novamente",
 * extraido para que a repeticao automatica e o clique usem EXATAMENTE o mesmo
 * codigo - dois lugares que divergem sao a origem de "o botao funciona mas o
 * automatico nao".
 */
const iniciarRetry = useCallback(() => {
  const ui = playbackUiAfterRetry()
  // Sem isto, no painel dividido o retry escondia o app inteiro:
  // `player-active` zera a visibilidade do shell e, como a superficie
  // do mpv esta preta durante a tentativa, sobrava uma tela mutilada
  // com so os botoes de acao.
  if (ui.restorePlayerChrome && shouldRestorePlayerChrome({ embedded })) {
    document.body.classList.add('player-active')
  }
  setBuffering(ui.buffering)
  setPlaybackError(ui.playbackError)
  setNativeBooting(ui.nativeBooting)
  setNativeEmbedded(ui.nativeEmbedded)
  setPlaying(ui.playing)
  setRetryingNative(ui.retrying)
  setMediaRetry((n) => n + 1)
}, [embedded])

useEffect(() => {
    if (!usePlayerManager) {
      void managerRef.current?.stop()
      managerRef.current = null
      setManagedEngine(null)
      setNativeEmbedded(false)
      setNativeBooting(false)
      return
    }

const manager = new PlayerManager({
      getVideo: () => videoRef.current,
      getBoundsElement: () => playerWrapRef.current,
      onEngineChange: (engine) => {
        setManagedEngine(engine === 'stur' ? 'stur' : engine === 'mpeg' ? 'mpeg' : engine === 'internal' ? 'internal' : null)
      },
      onEvent: (event) => {
        if (event.type === 'ready' || event.type === 'playing' || event.type === 'buffering') {
          // Guarda no ref: evento de buffering repete e setState repetido
          // realimentava o render (Maximum update depth). Só seta uma vez.
          if (!nativeSeenRef.current) {
            nativeSeenRef.current = true
            setNativeSeen(true)
          }
        }
        const bufferedNative =
          playbackEngine === 'stur' ||
          playbackEngine === 'mpeg' ||
          managedEngineRef.current === 'stur' ||
          managedEngineRef.current === 'mpeg'
        if (event.type === 'ready') {
          setNativeEmbedded(true)
          // VOD STUR: mantém booting até playing (mostra % de buffer)
          if (!bufferedNative) {
            setNativeBooting(false)
            setBuffering(false)
            setPlaying(true)
          }
          setPlaybackError(null)
        }
        if (event.type === 'preview' && bufferedNative) {
          setNativeEmbedded(true)
        }
        if (event.type === 'playing') {
          if (bufferedNative) {
            nativePlayedRef.current = true
            setNativeBooting(false)
            setNativeEmbedded(true)
            setBuffering(false)
            setBufferPercent(100)
          } else {
            setNativeEmbedded(true)
            setBuffering(false)
          }
          setPlaying(true)
          setPlaybackError(null)
          setRetryingNative(false)
          // Quadro chegou: cancela o indicador de espera do zape. Se o canal
          // abriu em 300ms, o timer nem chegou a disparar e nada piscou.
          clearLiveZapWait()
        }
        if (event.type === 'paused') {
          setPlaying(false)
          if (channel.kind !== 'live' && useNativePlayer) {
            const { current, duration: dur } = playbackClockRef.current
            const effectiveDur = dur > 0 ? dur : parseVodDurationSec(channel, progress)
            if (effectiveDur > 0 && current > 0) progressHandler.current(current, effectiveDur)
          }
        }
        if (event.type === 'failed') {
          // Live morreu e o motor ja esgotou as tentativas: antes de mostrar
          // o erro, pergunta ao painel se aquele canal ainda existe em outro
          // stream_id.
          //
          // O painel rotaciona o id com frequencia — medido nesta conta,
          // 709056 virou 404 e o mesmo canal respondeu em 709057. O
          // catalogo guarda a URL do load, entao sem isto o app tratava como
          // morto um canal que estava no ar. matchLiveStream nunca devolve
          // o proprio id, entao isto nao vira laco: se nao mudou, o erro aparece.
          /**
           * Aplica a falha na UI: caixa de erro, spinner desligado, chrome de
           * volta.
           *
           * Fica numa funcao porque o `failed` tem DOIS caminhos legitimos que
           * precisam dela — e antes o segundo chamava `return` e MORRIA antes de
           * chegar aqui:
           *
           *   1. `podeRotacionarLive` devolveu false (as trocas acabaram), ou nao
           *      e live, ou nao ha playlist: segue direto para a falha.
           *   2. `podeRotacionarLive` devolveu true, o app foi procurar um
           *      `stream_id` alternativo e `resolveFreshLiveChannel` devolveu
           *      `null` — o painel NAO tem outro id para este canal. MEDIDO no log
           *      do renderer: `failed` sem nenhuma linha `stream_id rotacionado`
           *      depois, e a tela preta sem mensagem nenhuma, para sempre, porque
           *      todo `failed` caia no mesmo beco sem saida.
           *
           * Com os dois chamando aqui, o canal sem alternativa mostra o erro
           * como qualquer outro.
           */
          const aplicarFalha = () => {
            /**
           * Repetir sozinho ANTES de mostrar a caixa de erro.
           *
           * MEDIDO, e e o que a pessoa reportou ("o canal nao caiu, e muito
           * dificil os canais abertos cair"):
           *
           *   01:26:35.389  start
           *   01:26:44.754  loadfile ok        <- 9,37s: o aquecimento bateu no teto
           *   01:26:44.766  end-file error     <- 12ms
           *                 publicados:0 janela:0 motivo:null tentativas:0
           *   01:26:48.295  start              <- retry
           *   01:26:53.948  file-loaded
           *   01:26:53.958  first frame        <- FUNCIONOU
           *
           * `motivo:null` e `tentativas:0`: o normalizador nao respondeu e nao
           * falhou — a requisicao ficou pendurada. A origem, no mesmo instante,
           * mede peak de -17,3 dBFS. A unica coisa que falhou foi a primeira
           * tentativa.
           *
           * Entao uma falha de live vira uma nova tentativa, nao um veredito.
           * A caixa so aparece se as tentativas automaticas tambem falharem.
           */
          if (
            deveRepetirSozinho(tentativaAutomaticaRef.current, { kind: channel.kind })
          ) {
            tentativaAutomaticaRef.current = gastarTentativa(
              tentativaAutomaticaRef.current,
            )
            playerLog('info', 'live', 'falhou; tentando de novo sozinho antes de mostrar erro', {
              tentativa: tentativaAutomaticaRef.current.gastas,
              de: TENTATIVAS_AUTOMATICAS_MAX,
              reason: event.reason,
            })
            clearTimeout(tentativaAutomaticaTimerRef.current)
            tentativaAutomaticaTimerRef.current = window.setTimeout(() => {
              iniciarRetry()
            }, ESPERO_ENTRE_TENTATIVAS_MS)
            return
          }

          const ui = playbackUiAfterFailed(event.reason)
            forceShellVisible()
            // `forceShellVisible()` remove `player-active`, e no player cheio a
            // classe e o que esconde o browse. Sem esta volta, o browse inteiro
            // reaparece por baixo do video e sobra uma faixa de canais e categorias
            // na lateral — o sintoma de "parece tela cheia, mas so pegou o lado dos
            // canais, sendo que esta em modo janela".
            //
            // O botao "Tentar novamente" ja faz isto, com o mesmo helper; o caminho
            // de falha simplesmente nunca recolocou a classe.
            if (ui.restorePlayerChrome && shouldRestorePlayerChrome({ embedded })) {
              document.body.classList.add('player-active')
            }
            if (ui.killNativeProcess) void window.sturplay?.player?.stop?.()
            // O zape falhou: cancela o indicador de espera, senao o spinner
            // ficaria preso por cima da caixa de erro.
            clearLiveZapWait()
            nativePlayedRef.current = false
            setPlaybackError(ui.playbackError)
            setBuffering(ui.buffering)
            setPlaying(ui.playing)
            setNativeEmbedded(ui.nativeEmbedded)
            setNativeBooting(ui.nativeBooting)
            setRetryingNative(ui.retrying)
            setCurrentTime(0)
          }

          if (
            podeRotacionarLive(liveReresolveRef.current, {
              kind: channel.kind,
              temPlaylist: Boolean(playlist),
            })
          ) {
            liveReresolveRef.current = { ...liveReresolveRef.current, busy: true }
            void resolveFreshLiveChannel(playlist!, channelRef.current)
              .then((next) => {
                if (!next) {
                  // Sem id alternativo no painel. Este ramo e o que produzia o
                  // preto sem mensagem: o `return` de fora engolia a falha.
                  playerLog('warn', 'live', 'painel nao devolveu outro stream_id', {
                    de: channelRef.current.streamId,
                  })
                  liveReresolveRef.current = { ...liveReresolveRef.current, busy: false }
                  aplicarFalha()
                  return
                }
                playerLog('info', 'live', 'stream_id rotacionado, reabrindo', {
                  de: channelRef.current.streamId,
                  para: next.streamId,
                })
                liveReresolveRef.current = registrarRotacao(
                  { ...liveReresolveRef.current, busy: false },
                  next.id,
                )
                onChange(next)
              })
              .catch((error) => {
                // O proprio `get_live_streams` pode cair. Antes isto virava uma
                // promessa rejeitada sem ninguem ouvindo, e a tela ficava preta do
                // mesmo jeito — so que agora sem nem o log.
                liveReresolveRef.current = { ...liveReresolveRef.current, busy: false }
                playerLog('warn', 'live', 'falha ao procurar stream_id alternativo', {
                  erro: error instanceof Error ? error.message : String(error),
                })
                aplicarFalha()
              })
            // So volta por aqui quando a rotacao realmente vai acontecer. O `null`
            // e a rejeicao voltam por `aplicarFalha`, dentro do `.then`/`.catch`.
            return
          }
          aplicarFalha()
        }
        if (event.type === 'buffering') {
          if (typeof event.percent === 'number') {
            setBufferPercent((prev) => Math.max(prev, event.percent ?? 0))
          }
          if (bufferedNative) {
            const pct = typeof event.percent === 'number' ? event.percent : 0
            const stillBooting = pct < 100
            // Ao vivo: overlay cuida do loading — não reabrir booting no App
            // VOD: nunca reabrir spinner depois do 1º play (buffer mid-stream)
            if (channel.kind !== 'live' && !nativePlayedRef.current) {
              setBuffering(stillBooting)
              if (stillBooting) setNativeBooting(true)
              else setNativeBooting(false)
            }
          } else {
            setBuffering(Boolean(event.value))
          }
        }
        if (event.type === 'duration') setDuration(event.value)
        if (event.type === 'timeupdate') setCurrentTime(event.current)
        if (event.type === 'ended') setPlaying(false)
      },
    })
    managerRef.current = manager

    return () => {
      if (embedded) {
        void manager.stop()
        void window.sturplay?.player?.hide?.()
      } else {
        void manager.stop()
      }
      // Derruba o motor nativo AO DESMONTAR o Player.
      //
      // Antes, o teardown dependia por acidente do `setBounds` com playback
      // inativo rodar `hideSurfaces()` quando o container sumia. Eu removi
      // aquele caminho de proposito (ele bumpara o epoch e cancelava um start
      // em voo), e com ele foi embora o unico teardown em navegacoes que nao
      // passam pelo Voltar: ir pelo menu lateral, clicar em Inicio, qualquer
      // setView. O mpv sobrevivia com `--keep-open=yes` e continuava tocando
      // audio com ninguem assistindo. Medido no log: `engine started` e depois
      // nenhum `stop` em 10 minutos de sessao.
      //
      // Aqui no unmount e o ponto preciso — parar em toda troca de view
      // quebraria o preview ao vivo do browse, que e intencional.
      clearLiveZapWait()
      void window.sturplay?.player?.stop?.()
      if (managerRef.current === manager) managerRef.current = null
    }
  }, [usePlayerManager, playbackEngine, embedded, clearLiveZapWait])

  useEffect(() => {
    if (!usePlayerManager || !managerRef.current) return

    const liveSturZap =
      embedded &&
      channel.kind === 'live' &&
      (playbackEngine === 'stur' ||
        playbackEngine === 'mpeg' ||
        managedEngineRef.current === 'stur' ||
        managedEngineRef.current === 'mpeg') &&
      nativePlayedRef.current
    const urlChanged = lastPlayUrlRef.current !== channel.url
    const isRetry = !urlChanged && mediaRetry > 0
    lastPlayUrlRef.current = channel.url

    if (!liveSturZap) {
      setBuffering(true)
      setBufferPercent(0)
      setPlaying(false)
      setPlaybackError(null)
      setCurrentTime(0)
      setDuration(0)
      setAudioTracks([])
      setSubtitleTracks([])
      nativePlayedRef.current = false
      setNativeBooting(channel.kind !== 'live' || isRetry)
      if (!isRetry) setRetryingNative(false)
      if (shouldResetManagedEngine({ urlChanged, isRetry })) setManagedEngine(null)
    } else {
      setPlaybackError(null)
      setPlaying(true)
      setBuffering(false)
      // Zape de live com motor nativo: o app usava declarar "tocando" e deixar
      // o spinner desligado, para nao piscar a cada troca rapida. O resultado
      // foi o oposto do desejado: quando a origem demorava 15s, o usuario via
      // 15 segundos de video congelado, com o icone de pause, sem nenhuma
      // indicacao de que algo estava acontecendo.
      //
      // Agora o indicador so aparece DEPOIS de um atraso curto: zape que abre
      // em 300ms nao pisca nada, zape que demora mostra o spinner. E o timer e
      // cancelado no primeiro quadro, entao nunca chega a piscar.
      clearLiveZapWait()
      liveZapWaitRef.current = window.setTimeout(() => {
        liveZapWaitRef.current = 0
        if (channel.kind !== 'live') return
        setBuffering(true)
        setRetryingNative(true)
      }, LIVE_ZAP_FEEDBACK_MS)
    }

    const runPlay = () => {
      void managerRef.current?.play(
        {
          url: channel.url,
          live: channel.kind === 'live',
          heavy: channel.kind === 'live' && isHeavyLiveChannel(channel),
          startTime: initialTimeRef.current,
        },
        playbackEngine,
      )
    }

    if (embedded) {
      const id = window.requestAnimationFrame(runPlay)
      return () => window.cancelAnimationFrame(id)
    }
    runPlay()
  }, [channel.url, channel.kind, mediaRetry, usePlayerManager, playbackEngine, embedded])

  const isAudioMuted = muted || volume <= 0

  useEffect(() => {
    if (!useNativePlayer || useBufferedNative) return
    void managerRef.current?.command({ op: 'volume', value: muted ? 0 : volume })
  }, [useNativePlayer, useBufferedNative, volume, muted])

  useEffect(() => {
    if (useNativePlayer) return
    const video = videoRef.current
    if (!video) return
    setPlayerKeepMuted(video, isAudioMuted)
    // Não desmuta antes do 1º frame — Chromium bloqueia autoplay com som e deixa pausado.
    // Guarda o volume, mantém mutado; o player.ts desmuta no 1º 'playing'.
    try {
      video.volume = isAudioMuted ? video.volume : volume > 0 ? volume : 1
    } catch {
      // ignore
    }
    if (isAudioMuted) {
      video.muted = true
    } else if (!video.paused && video.currentTime > 0) {
      video.muted = false
    }
    // se ainda não tocou (pausado + currentTime 0), mantém muted=true de propósito
  }, [volume, muted, isAudioMuted, useNativePlayer])

  useEffect(() => {
    if (useNativePlayer) return
    const video = videoRef.current
    if (!video) return
    let waitingTimer = 0
    const clearWaiting = () => {
      window.clearTimeout(waitingTimer)
      waitingTimer = 0
    }
    const onPlay = () => {
      clearWaiting()
      setPlayerKeepMuted(video, isAudioMuted)
      video.muted = isAudioMuted
      if (!isAudioMuted) video.volume = volume
      setPlaying(true)
      setBuffering(false)
      setPlaybackError(null)
    }
    const onPause = () => {
      if (video.readyState < 2 && video.currentTime < 0.2) return
      setPlaying(false)
    }
    const onWaiting = () => {
      clearWaiting()
      waitingTimer = window.setTimeout(() => {
        if (!video.paused && video.readyState >= 2 && video.currentTime > 0.3) return
        setBuffering(true)
      }, channel.kind === 'live' ? 900 : 600)
    }
    const onPlaying = () => {
      clearWaiting()
      setPlayerKeepMuted(video, isAudioMuted)
      video.muted = isAudioMuted
      if (!isAudioMuted) video.volume = volume
      setBuffering(false)
      setBufferPercent(100)
      setPlaying(true)
      setPlaybackError(null)
    }
    const onCanPlay = () => {
      if (!video.paused && video.readyState >= 2) {
        setBuffering(false)
        setBufferPercent(100)
      }
    }
    const onProgress = () => {
      try {
        if (!video.buffered.length) return
        const end = video.buffered.end(video.buffered.length - 1)
        const ahead = Math.max(0, end - video.currentTime)
        if (channel.kind === 'live') {
          setBufferPercent(Math.min(100, Math.round(ahead * 25)))
          return
        }
        const target = Math.max(video.currentTime + 3, 3)
        const pct = Math.max(1, Math.min(100, Math.round((end / target) * 100)))
        setBufferPercent(pct)
      } catch {
        // ignore
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('progress', onProgress)

    const timer = window.setTimeout(() => {
      overlayOn.current = false
      setOverlay(false)
    }, 3500)
    return () => {
      clearWaiting()
      window.clearTimeout(timer)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('progress', onProgress)
    }
  }, [channel.id, channel.kind, volume, muted, isAudioMuted, useNativePlayer])

  // Listeners do <video>. Deliberadamente SEM `seeking`/`duration` nas deps:
  // antes eles estavam, e o corpo chamava restore(), que fazia
  // `video.currentTime = initialTime` — ou seja, soltar a barra de progresso
  // devolvia o playhead ao ponto de resume. O player interno era impossível
  // de usar o seek.
  useEffect(() => {
    if (useNativePlayer) return
    const video = videoRef.current
    if (!video || channel.kind === 'live') return

    const save = () => {
      if (video.duration > 0) progressHandler.current(video.currentTime, video.duration)
    }
    const onTimeUpdate = () => {
      if (!seekingRef.current) {
        setCurrentTime(video.currentTime)
      }
      if (video.duration && Number.isFinite(video.duration) && durationRef.current !== video.duration) {
        setDuration(video.duration)
      }
      const now = Date.now()
      if (now - lastVideoSaveRef.current < 3000) return
      lastVideoSaveRef.current = now
      save()
    }
    // `durationchange` só atualiza a duração. O hls.js dispara isso repetidamente
    // enquanto calcula a duração de um VOD; antes este handler também chamava
    // restore(), seekando o playhead a cada disparo.
    const onDurationChange = () => {
      if (video.duration && Number.isFinite(video.duration)) {
        setDuration(video.duration)
      }
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('pause', save)
    return () => {
      save()
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('pause', save)
    }
  }, [channel.id, channel.kind, useNativePlayer])

  // Retoma do ponto salvo — uma vez por canal, e só em `loadedmetadata`.
  useEffect(() => {
    if (useNativePlayer) return
    const video = videoRef.current
    if (!video || channel.kind === 'live') return
    // Closure local em vez de ref: a ref nunca era limpa, então abrir o MESMO
    // canal uma segunda vez (A -> B -> A) casava com o id guardado e o resume
    // não rodava — o filme voltava do zero. Com `let` na closure o estado
    // pertence a esta instancia do efeito, que morre junto com ele.
    let restored = false
    const start = initialTimeRef.current

    const restore = () => {
      if (restored) return
      if (video.duration && Number.isFinite(video.duration)) {
        setDuration(video.duration)
      }
      if (start > 0 && start < (video.duration || 999999)) {
        video.currentTime = start
        setCurrentTime(start)
        if (start > 5) {
          setShowResumeToast(true)
        }
      }
      restored = true
      if (video.paused) void video.play().catch(() => undefined)
    }

    video.addEventListener('loadedmetadata', restore)
    if (video.readyState >= 1) restore()
    return () => {
      video.removeEventListener('loadedmetadata', restore)
    }
  }, [channel.id, channel.kind, useNativePlayer])

  // STUR/mpv nativo: o <video> não avança — salva progresso para "Continuar assistindo".
  useEffect(() => {
    if (!useNativePlayer || channel.kind === 'live') return

    // Fecha o canal E o relógio no momento em que este efeito nasce. Ler de
    // `channelRef`/`playbackClockRef` no cleanup é errado: os dois refs são
    // reescritos DURANTE o render, e o React roda todo cleanup antes do próximo
    // efeito. O par saía (canal novo, relógio antigo) e gravava a posição do
    // filme A em cima do filme B — abrir B depois de A voltava 50min adiante.
    const boundChannel = channel
    const boundProgress = progress

    const persist = (force = false) => {
      const { current, duration: dur } = playbackClockRef.current
      const effectiveDur = dur > 0 ? dur : parseVodDurationSec(boundChannel, boundProgress)
      if (effectiveDur <= 0 || !Number.isFinite(current) || current < 1) return
      const now = Date.now()
      if (!force && now - lastNativeProgressSave.current < 3000) return
      // Sem esta assinatura o cleanup reescreve o mesmo estado sempre que `progress`
      // muda — o que recria este efeito, que roda o cleanup de novo. Loop infinito.
      const sig = `${boundChannel.id}|${Math.round(current)}|${Math.round(effectiveDur)}`
      if (sig === lastNativeProgressSig.current) return
      lastNativeProgressSig.current = sig
      lastNativeProgressSave.current = now
      progressHandler.current(current, effectiveDur)
    }

    const id = window.setInterval(() => persist(false), 5000)
    return () => {
      window.clearInterval(id)
      persist(true)
    }
  }, [useNativePlayer, channel.kind, channel.id, channel.duration, embedded])

  useEffect(() => {
    if (!playlist || playlist.kind !== 'xtream' || !channel.streamId || channel.kind !== 'live') {
      setEpg(null)
      return
    }
    void loadShortEpg(playlist, channel.streamId)
      .then(setEpg)
      .catch(() => setEpg(null))
  }, [playlist, channel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return
      bumpOverlay()
      const i = list.findIndex((item) => item.id === channel.id)
      if (e.key === 'Escape') {
        e.preventDefault()
        handlePlayerEscape()
        return
      }
      if (e.key === 'F11') {
        e.preventDefault()
        // STUR: globalShortcut com janela em foco — evita duplo-toggle aqui.
        if (!useBufferedNative) toggleFullscreen()
        return
      }
      if (channel.kind === 'live') {
        if (e.key === 'ArrowUp' && i > 0) onChange(list[i - 1])
        if (e.key === 'ArrowDown' && i < list.length - 1) onChange(list[i + 1])
      } else {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          skipTime(-10)
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          skipTime(10)
        }
      }
      if (e.key === 'f' || e.key === 'F') onFav()
      if (e.key === ' ' || e.key === 'Space') {
        e.preventDefault()
        if (useBufferedNative) {
          void window.sturplay?.player?.sendOverlayUi?.({ action: 'key', key: e.key })
        } else {
          togglePlay()
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [channel, list, onBack, onChange, onFav, useNativePlayer, useBufferedNative, embedded, drawerOpen])

  useEffect(() => {
    if (!useBufferedNative) return
    const engineLabel = playbackEngine === 'mpeg' || managedEngine === 'mpeg' ? 'MPEG' : playbackEngine === 'stur' || managedEngine === 'stur' ? 'STUR' : 'Interno'
    const items = list.slice(0, 400).map((item) => ({
      id: item.id,
      name: item.name,
      group: item.group,
    }))
    void window.sturplay?.player?.setOverlayMeta?.({
      engine: engineLabel,
      title: channel.name,
      kind: channel.kind,
      currentId: channel.id,
      list: items,
      durationHint:
        channel.kind === 'live' ? 0 : parseVodDurationSec(channel, progress),
    })
  }, [
    useBufferedNative,
    playbackEngine,
    managedEngine,
    channel.id,
    channel.name,
    channel.kind,
    channel.duration,
    list,
    progress,
  ])

  useEffect(() => {
    if (!useBufferedNative) return
    const off = window.sturplay?.player?.onOverlayAction?.((action) => {
      const type = String(action?.type || '')
      if (type === 'back') {
        /*
          Voltar = o que o botao da barra faz.

          Antes: so `stop()`. O video parava, mas a JANELA continuava em tela
          cheia — o app inteiro virava so o video, sem catalogo, sem barra de
          canal, sem como sair sem o mouse. Era o "aperta para voltar, o video
          para e o app fica em tela cheia".

          Agora sai da tela cheia ANTES de parar, e so sai se ela realmente
          estiver ativa (`winFsRef.current`, e nao `domFs`: tela cheia de janela
          nao passa pelo DOM, entao `document.fullscreenElement` fica vazio e
          medir por ele nunca disparava).
        */
        /*
          Quem mandou a janela entrar em tela cheia? Pergunta ao main.

          `origin: 'app'` = o dono ja estava em tela cheia antes do video. O
          `back` so para o video e mantem a janela.

          `origin: 'player'` = o video trouxe a janela (botao de tela cheia da
          barra). O `back` devolve a janela ao modo em que ela estava.

          A pergunta e feita aqui, no clique, e nao no mount: no mount ainda nao
          se sabe, e qualquer valor capturado antes do video subir corre na
          ordem dos eventos — foi o que fez o caso "app ja em tela cheia" sair
          da tela cheia mesmo assim.
        */
        void (async () => {
          const res = await window.sturplay?.window?.isFullscreen?.()
          const info = res as { fullscreen?: boolean; origin?: string | null } | undefined
          const emTelaCheia = info?.fullscreen === true
          const eraDoDono = info?.origin === 'app'

          /*
            `exitNativePlayback` e nao so `stop()`.

            `player-active` / `native-vod-active` sao as classes que escondem o
            catalogo, a barra de canais e a topbar para o video ocupar o app
            inteiro. `stop()` derruba o video mas NAO remove essas classes, entao
            o app ficava com o layout de tela cheia e sem catalogo nenhum — o
            "as vezes o catalogo some e o video pega o app inteiro".
          */
          if (!embedded) {
            onBack()
          } else if (eraDoDono) {
            /*
              A tela cheia era do dono antes do video subir: o `back` para o video
              e devolve o catalogo, mas a JANELA continua em tela cheia.

              E aqui que os dois caminhos brigavam. A decisao "nao sair" era
              correta, mas o `exitNativePlayback` chamava `setFullscreen(false)`
              logo depois e tirava a janela assim mesmo — por isso o "sai da tela
              cheia sozinho" acontecia mesmo com o `origin` certo.
            */
            exitNativePlayback({ exitFullscreen: false })
          } else if (emTelaCheia) {
            if (document.fullscreenElement) {
              await document.exitFullscreen().catch(() => {})
            } else {
              await window.sturplay?.window?.setFullscreen?.(false)
            }
            exitNativePlayback()
          } else {
            exitNativePlayback()
          }
        })()
        return
      }
      if (type === 'select' && typeof action.id === 'string') {
        const next = channelListRef.current.find((item) => item.id === action.id)
        if (next) {
          setBufferPercent(0)
          setBuffering(true)
          onChangeRef.current(next)
        }
        return
      }
      if (type === 'volume' && typeof action.value === 'number') {
        setVolume(action.value)
        try {
          localStorage.setItem('stplay.volume', String(action.value))
        } catch {
          // ignore
        }
        if (action.value > 0) setMuted(false)
        return
      }
      if (type === 'mute' && typeof action.value === 'boolean') {
        setMuted(action.value)
      }
    })
    return () => off?.()
  }, [useBufferedNative, onBack, embedded])

  function bumpOverlay() {
    if (useBufferedNative) {
      void window.sturplay?.player?.sendOverlayUi?.({ action: 'show-controls' })
    }
    if (!overlayOn.current) {
      overlayOn.current = true
      setOverlay(true)
    }
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (drawerOpenRef.current) return
      overlayOn.current = false
      setOverlay(false)
    }, 3500)
  }

  function togglePlay() {
    if (useNativePlayer) {
      void managerRef.current?.command({ op: 'toggle' })
      setPlaying((value) => !value)
      bumpOverlay()
      return
    }
    const video = videoRef.current
    if (!video) return
    // Live com pause de verdade: pausa congela, play retoma na borda se o buffer envelheceu.
    if (channel.kind === 'live') {
      if (!video.paused) {
        video.pause()
        bumpOverlay()
        return
      }
      try {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const end = buffered.end(buffered.length - 1)
          if (Number.isFinite(end) && end - video.currentTime > 4) {
            video.currentTime = Math.max(0, end - 0.5)
          }
        }
      } catch {
        // ignore
      }
      void video.play().catch(() => undefined)
      setPlaying(true)
      bumpOverlay()
      return
    }
    if (video.paused) void video.play()
    else video.pause()
    bumpOverlay()
  }

  const isVod = channel.kind !== 'live'
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  // Overlay (STUR/MPEG) é o dono do loading — igual Smarters, UMA tela de
  // loading só. O spinner do App aparecia junto com o véu do overlay
  // (texto duplo empilhado). A partir do 1º evento nativo o overlay assume.
  const [nativeSeen, setNativeSeen] = useState(false)
  const nativeSeenRef = useRef(false)
  useEffect(() => {
    setNativeSeen(false)
    nativeSeenRef.current = false
  }, [channel.url])
  const showNativeBoot =
    useBufferedNative &&
    !nativeSeen &&
    shouldShowNativeRetrySpinner({
      retrying: retryingNative,
      buffering,
      playbackError,
      nativeEmbedded,
      nativeBooting,
    })
  const showNativeEmbed = nativeEmbedded

  return (
    <div
      ref={playerWrapRef}
      className={`player-wrap has-topbar aspect-${aspect}${embedded ? ' player-embedded' : ''}${showNativeBoot ? ' is-mpv-one-booting' : ''}${showNativeEmbed ? ' is-native-embedded is-embed is-embed-chrome' : ''}${useBufferedNative ? ' is-native-buffered' : ''}`}
      onMouseMove={bumpOverlay}
      onDoubleClick={toggleFullscreen}
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay={false}
        style={{ display: showNativeEmbed ? 'none' : undefined }}
      />

      {showNativeBoot && !playbackError && (
        <div className="player-spinner-wrap">
          <div className="player-spinner" />
          <p className="player-buffer-label">
            Enchendo o buffer para reprodução fluida…
            {bufferPercent > 0 ? ` ${bufferPercent}%` : ''}
          </p>
        </div>
      )}

      {!useBufferedNative && buffering && !playbackError && (
        <div className="player-spinner-wrap">
          <div className="player-spinner" />
        </div>
      )}

      {/* Playback Error Overlay */}
      {playbackError && (
        <div className="player-error-overlay">
          <div className="player-error-box">
            <div style={{ fontSize: 36, marginBottom: 8 }}>⚠️</div>
            <h3>Não foi possível reproduzir o vídeo</h3>
            <p>{playbackError}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                className="primary"
                onClick={() => {
                  iniciarRetry()
                }}
                style={{ background: '#2dd4bf', color: '#07090f', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}
              >
                Tentar novamente
              </button>
              <button
                className="ghost"
                onClick={onBack}
                style={{ background: 'transparent', color: '#94a3b8', border: '1px solid #334155', padding: '8px 16px', borderRadius: 8, cursor: 'pointer' }}
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div className={`player-controls ${overlay ? 'visible' : 'hidden'}`}>
        <div className="player-gradient player-gradient-top" />
        <div className="player-gradient player-gradient-bottom" />

        {/* Top bar */}
        <div className="player-topbar">
          <div className="player-top-left" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/*
              Voltar fica na barra de CIMA, dentro de `player-controls`, na MESMA
              familia do pause, do som e do resto — todos `player-btn-clean`.

              Foi por estar aqui que ele herdou o hover, o `onMouseMove` do
              `player-wrap` e o `z-index` certo. Uma tentativa anterior de
              extrai-lo para fora do bloco o deixou sem animacao e sem clique,
              porque `player-controls` e `inset: 0` com `z-index: 20` e cobre a
              tela toda: um dock externo fica ATRAS dele.

              A unica diferenca em relacao aos outros e que este fica sempre
              visivel mesmo com `player-controls` em `hidden`, porque e a saida
              que nao depende de teclado.
            */}
            <button
              className="player-btn-clean player-back-always"
              onClick={onBack}
              title="Voltar"
              aria-label="Voltar"
            >
              <ArrowLeft size={18} />
            </button>
            {channel.kind === 'live' && (
              <span className="player-live-badge">LIVE TV</span>
            )}
            <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9', letterSpacing: '0.3px' }}>
              {channel.name}
            </span>
          </div>
          <div className="player-top-actions">
            <button
              className={`player-btn-clean ${favorite ? 'active' : ''}`}
              onClick={onFav}
              title={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
            >
              <Heart size={18} fill={favorite ? '#fb7185' : 'none'} color={favorite ? '#fb7185' : '#fff'} />
            </button>
          </div>
        </div>

        {/* Floating Resume Toast */}
        {/* `!isVod`: ao vivo nao existe "continuar de". A barra de seek ja tinha
            essa guarda e o toast nao — entao um canal ao vivo com posicao salva
            mostrava "Continuando de 12:34" sobre o video. */}
        {showResumeToast && !isVod && initialTime > 5 && (
          <div className="player-resume-toast">
            <span>Continuando de {formatPlayerTime(initialTime)}</span>
            <button
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = 0
                  setCurrentTime(0)
                }
                setShowResumeToast(false)
              }}
            >
              <RotateCcw size={14} />
              Voltar pro início
            </button>
          </div>
        )}

        {/* Bottom container */}
        <div className="player-bottom-container">
          {/* Seekbar / Timeline scrubber (for movies & series) */}
          {isVod && (
            <div className="player-seekbar-wrap">
              <div className="player-seekbar-row">
                <span className="player-time-badge">{formatPlayerTime(currentTime)}</span>
                <div className="player-seekbar-track-wrap">
                  <input
                    type="range"
                    min="0"
                    max={duration > 1 ? duration : Math.max(currentTime, 1)}
                    step="1"
                    value={seeking ? seekTime : currentTime}
                    onMouseDown={handleSeekStart}
                    onTouchStart={handleSeekStart}
                    onChange={handleSeekChange}
                    onMouseUp={handleSeekEnd}
                    onTouchEnd={handleSeekEnd}
                    className="player-seekbar-slider"
                    style={{
                      background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${progressPercent}%, rgba(255, 255, 255, 0.2) ${progressPercent}%, rgba(255, 255, 255, 0.2) 100%)`,
                    }}
                    title={`Puxar para o minuto desejado (${formatPlayerTime(currentTime)})`}
                  />
                </div>
                <span className="player-time-badge duration">{formatPlayerTime(duration)}</span>
              </div>
            </div>
          )}

          {/* Bottom Bar Info and Actions */}
          <div className="player-bottom-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              {/* Clean White Solid Play / Pause button */}
              <button className="player-play-btn" onClick={togglePlay} title={playing ? 'Pausar' : 'Reproduzir'}>
                {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />}
              </button>

              {/* Quick Skip Controls for VOD */}
              {isVod && (
                <div className="player-quick-controls">
                  <button className="player-btn-clean" onClick={() => skipTime(-10)} title="Voltar 10s">
                    <RotateCcw size={16} />
                  </button>
                  <button className="player-btn-clean" onClick={() => skipTime(10)} title="Avançar 10s">
                    <RotateCw size={16} />
                  </button>
                </div>
              )}

              <div className="player-channel-info">
                {channel.kind === 'live' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <strong style={{ fontSize: 15, color: '#fff' }}>{channel.name}</strong>
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{epg?.title || channel.group}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <strong style={{ fontSize: 15, color: '#fff' }}>{channel.name}</strong>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>{channel.group || 'Vídeo sob demanda'}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="player-bottom-actions">
              <label className="volume-control" title="Volume">
                <button
                  type="button"
                  className="volume-control-icon"
                  onClick={(event) => {
                    event.preventDefault()
                    setMuted((value) => {
                      const next = !value
                      if (videoRef.current) {
                        setPlayerKeepMuted(videoRef.current, next || volume <= 0)
                        videoRef.current.muted = next || volume <= 0
                        if (!next && volume > 0) videoRef.current.volume = volume
                      }
                      return next
                    })
                  }}
                  aria-label={isAudioMuted ? 'Ativar som' : 'Mudo'}
                >
                  {isAudioMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isAudioMuted ? 0 : volume}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setVolume(value)
                    if (value > 0) setMuted(false)
                    if (videoRef.current) {
                      const keepMuted = value <= 0
                      setPlayerKeepMuted(videoRef.current, keepMuted)
                      videoRef.current.volume = value
                      videoRef.current.muted = keepMuted
                    }
                  }}
                />
              </label>

              {/* Legendas - só aparece quando o servidor manda faixas */}
              {subtitleTracks.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    className={`player-btn-clean${activeSubtitleTrack !== null ? ' player-btn-active' : ''}`}
                    title="Legendas"
                    onClick={() => { setShowCaptionsMenu((v) => !v); setShowAudioMenu(false) }}
                  >
                    <Captions size={18} />
                  </button>
                  {showCaptionsMenu && (
                    <div className="player-track-menu">
                      <div className="player-track-menu-title">Legendas</div>
                      <button
                        className={`player-track-item${activeSubtitleTrack === null ? ' active' : ''}`}
                        onClick={() => {
                          setActiveSubtitleTrack(null)
                          playerControls.current.setSubtitleTrack(null)
                          setShowCaptionsMenu(false)
                        }}
                      >Desativar</button>
                      {subtitleTracks.map((t) => (
                        <button
                          key={t.id}
                          className={`player-track-item${activeSubtitleTrack === t.id ? ' active' : ''}`}
                          onClick={() => {
                            setActiveSubtitleTrack(t.id)
                            playerControls.current.setSubtitleTrack(t.id)
                            setShowCaptionsMenu(false)
                          }}
                        >{t.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Áudio - só aparece quando o servidor manda múltiplas faixas */}
              {audioTracks.length > 1 && (
                <div style={{ position: 'relative' }}>
                  <button
                    className="player-btn-clean"
                    title="Áudio"
                    onClick={() => { setShowAudioMenu((v) => !v); setShowCaptionsMenu(false) }}
                  >
                    <AudioLines size={18} />
                  </button>
                  {showAudioMenu && (
                    <div className="player-track-menu">
                      <div className="player-track-menu-title">Áudio</div>
                      {audioTracks.map((t) => (
                        <button
                          key={t.id}
                          className={`player-track-item${activeAudioTrack === t.id ? ' active' : ''}`}
                          onClick={() => {
                            setActiveAudioTrack(t.id)
                            playerControls.current.setAudioTrack(t.id)
                            setShowAudioMenu(false)
                          }}
                        >{t.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Lista de canais/episódios: só em ao vivo e séries */}
              {(channel.kind === 'live' || channel.kind === 'series') && list.length > 1 && (
                <button
                  className="player-btn-clean"
                  onClick={() => {
                    setDrawerOpen((value) => !value)
                    bumpOverlay()
                  }}
                  title={channel.kind === 'series' ? 'Episódios' : 'Lista de canais'}
                >
                  <List size={18} />
                </button>
              )}
              <button
                className={`player-btn-clean${isFs ? ' is-active' : ''}`}
                onClick={toggleFullscreen}
                title={isFs ? 'Sair da tela cheia' : 'Tela Cheia'}
                aria-label={isFs ? 'Sair da tela cheia' : 'Tela Cheia'}
              >
                <Maximize size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>

        {/* Channels / Episodes floating panel — no native buffered (HWND bloqueia; lista vai no overlay) */}
        {drawerOpen && !useBufferedNative && (
          <aside className="channel-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="channel-drawer-top">
              <span className="channel-drawer-title">
                {channel.kind === 'series' ? 'Episódios' : 'Ao vivo'}
              </span>
              {channel.kind === 'series' && seriesSeasonGroups.length > 0 && (
                <SeasonSelect
                  value={drawerSeason || seriesSeasonGroups[0][0]}
                  onChange={setDrawerSeason}
                  options={seriesSeasonGroups.map(([season, episodes]) => ({
                    value: season,
                    label: formatSeasonOptionLabel(season, episodes.length),
                  }))}
                />
              )}
              <div className="channel-drawer-search">
                <Search size={14} className="channel-drawer-search-icon" strokeWidth={2.2} aria-hidden />
                <input
                  autoFocus
                  placeholder={channel.kind === 'series' ? 'Filtrar episódios…' : 'Filtrar canais…'}
                  value={drawerSearch}
                  onChange={(e) => setDrawerSearch(e.target.value)}
                />
                {drawerSearch && (
                  <button
                    type="button"
                    className="channel-drawer-search-clear"
                    onClick={() => setDrawerSearch('')}
                    aria-label="Limpar filtro"
                  >
                    <X size={13} strokeWidth={2.4} />
                  </button>
                )}
              </div>
              {channel.kind === 'live' && (
                <div className="channel-drawer-tabs" role="tablist" aria-label="Visão da lista">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={drawerTab === 'categories'}
                    className={drawerTab === 'categories' ? 'active' : ''}
                    onClick={() => setDrawerTab('categories')}
                  >
                    Categorias
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={drawerTab === 'channels'}
                    className={drawerTab === 'channels' ? 'active' : ''}
                    onClick={() => {
                      setDrawerTab('channels')
                      setDrawerCategory(null)
                    }}
                  >
                    Canais
                  </button>
                </div>
              )}
              {drawerCategory && drawerTab === 'channels' && (
                <button
                  type="button"
                  className="channel-drawer-chip"
                  onClick={() => setDrawerCategory(null)}
                >
                  {drawerCategory}
                  <X size={12} strokeWidth={2.4} />
                </button>
              )}
            </div>

            <div className="channel-drawer-list">
              {channel.kind === 'live' && drawerTab === 'categories' ? (
                drawerCategories.map(([group, count]) => (
                  <button
                    key={group}
                    type="button"
                    className={`channel-drawer-category${drawerCategory === group ? ' active' : ''}`}
                    onClick={() => {
                      setDrawerCategory(group)
                      setDrawerTab('channels')
                    }}
                  >
                    <span className="channel-drawer-name">{group}</span>
                    <span className="channel-drawer-count">{count}</span>
                  </button>
                ))
              ) : filteredZap.length === 0 ? (
                <p className="channel-drawer-empty">Nada encontrado.</p>
              ) : (
                filteredZap.map((item) => {
                  const isActive = item.id === channel.id
                  const isFav = favorites.includes(item.id)
                  return (
                    <div
                      key={item.id}
                      className={`channel-drawer-item${isActive ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        className="channel-drawer-item-main"
                        onClick={() => {
                          onChange(item)
                          setDrawerOpen(false)
                        }}
                      >
                        {channel.kind !== 'series' && (
                          <span className="channel-drawer-num">{channelIndexMap.get(item.id) ?? '—'}</span>
                        )}
                        {channel.kind !== 'series' && (
                          <span className="channel-drawer-logo">
                            <Cover src={item.logo} small live={channel.kind === 'live'} />
                          </span>
                        )}
                        <span className="channel-drawer-name">{item.name}</span>
                      </button>
                      <button
                        type="button"
                        className={`channel-drawer-fav${isFav ? ' is-fav' : ''}`}
                        title={isFav ? 'Remover dos favoritos' : 'Favoritar'}
                        aria-label={isFav ? 'Remover dos favoritos' : 'Favoritar'}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleFavorite(item.id)
                        }}
                      >
                        <Heart size={14} fill={isFav ? 'currentColor' : 'none'} strokeWidth={2.1} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            <div className="channel-drawer-footer">
              <span>
                {drawerTab === 'categories'
                  ? `${drawerCategories.length} categorias`
                  : `${filteredZap.length} ${channel.kind === 'series' ? 'episódios' : 'canais'}`}
              </span>
              <button
                type="button"
                className="channel-drawer-close-text"
                onClick={() => setDrawerOpen(false)}
              >
                Fechar
              </button>
            </div>
          </aside>
        )}
    </div>
  )
}

