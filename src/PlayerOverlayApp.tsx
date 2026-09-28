import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { List, X } from 'lucide-react'
import {
  findSeasonForEpisode,
  formatSeasonOptionLabel,
  groupEpisodesBySeason,
  resolveEpisodeSeason,
} from './lib/episode-seasons'
import { SeasonSelect } from './lib/SeasonSelect'

type OverlayItem = { id: string; name: string; group?: string }

type OverlayMeta = {
  engine?: string
  url?: string
  title?: string
  kind?: string
  list?: OverlayItem[]
  currentId?: string
  volume?: number
  muted?: boolean
  durationHint?: number
  fullscreen?: boolean
}

const VOLUME_KEY = 'stplay.volume'

function readVolume() {
  const raw = localStorage.getItem(VOLUME_KEY)
  const value = raw === null ? 1 : Number(raw)
  if (!Number.isFinite(value)) return 1
  // Valores corrompidos/baixos demais deixavam o slider no mínimo sem som audível
  if (value < 0.2) return 1
  return Math.min(1, Math.max(0, value))
}

function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button type="button" className="po-btn" title={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** Overlay Windows — layout igual IPTV Player One (barra compacta, seek vermelho). */
export function PlayerOverlayApp() {
  const [meta, setMeta] = useState<OverlayMeta>({})
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [booting, setBooting] = useState(true)
  const [failed, setFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [volume, setVolume] = useState(readVolume)
  const [muted, setMuted] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [listFilter, setListFilter] = useState('')
  const [listSeason, setListSeason] = useState<string | null>(null)
  const [scrubPos, setScrubPos] = useState<number | null>(null)
  const hideTimer = useRef(0)
  const playingRef = useRef(false)
  const hasPlayedRef = useRef(false)
  const listOpenRef = useRef(false)
  const metaKindRef = useRef<string | undefined>(undefined)
  const lastContentIdRef = useRef<string | undefined>(undefined)
  const catalogDurationRef = useRef(0)
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)

  useEffect(() => {
    volumeRef.current = volume
  }, [volume])

  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  const applyOutputVolume = useCallback(() => {
    const out = mutedRef.current ? 0 : volumeRef.current
    void window.sturplay?.player?.command?.('volume', out)
  }, [])

  useEffect(() => {
    applyOutputVolume()
  }, [volume, muted, applyOutputVolume])

  useEffect(() => {
    // Garante volume ao abrir overlay (mpv pode reiniciar em 100 mas UI estava baixa)
    const t = window.setTimeout(() => applyOutputVolume(), 120)
    return () => window.clearTimeout(t)
  }, [applyOutputVolume])

  useEffect(() => {
    document.documentElement.classList.add('player-overlay-mode')
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    listOpenRef.current = listOpen
    void window.sturplay?.player?.setOverlayListOpen?.(listOpen)
  }, [listOpen])

  useEffect(() => {
    metaKindRef.current = meta.kind
  }, [meta.kind])

  useEffect(() => {
    const api = window.sturplay?.player
    const offMeta = api?.onOverlayMeta?.((payload) => {
      const next = payload as OverlayMeta
      if (next.kind) metaKindRef.current = next.kind
      setMeta((prev) => ({ ...prev, ...next }))
      // Volume é local ao overlay — não sobrescrever com meta do App
      if (next.kind === 'live') {
        setDuration(0)
      } else if (typeof next.durationHint === 'number' && next.durationHint > 0) {
        catalogDurationRef.current = next.durationHint
        setDuration(next.durationHint)
      }
      if (typeof next.fullscreen === 'boolean') setFullscreen(next.fullscreen)
    })
    const offEvent = api?.onEvent?.((event) => {
      if (event.type === 'playing') {
        hasPlayedRef.current = true
        setBooting(false)
        setFailed(false)
        setPlaying(true)
        applyOutputVolume()
      }
      if (event.type === 'preview') {
        setBooting(false)
      }
      if (event.type === 'ready') {
        if (!hasPlayedRef.current) {
          setBooting(true)
          setPlaying(false)
        }
        setFailed(false)
      }
      if (event.type === 'paused') setPlaying(false)
      if (event.type === 'failed') {
        setBooting(false)
        setFailed(true)
        setPlaying(false)
      }
      if (event.type === 'zap-start') {
        // Zape de live: o canal anterior ja tocou, entao `hasPlayedRef` estava
        // verdadeiro e nenhum dos caminhos antigos de spinner disparava. Agora o
        // proprio main avisa que comecou um zape, e o overlay mostra o estado de
        // carregando ate o `playing` do canal novo.
        setBooting(true)
        setFailed(false)
        setPlaying(false)
      }
      if (event.type === 'buffering') {
        if (!hasPlayedRef.current && typeof event.percent === 'number' && event.percent < 100) {
          setBooting(true)
        }
        if (
          (typeof event.percent === 'number' && event.percent >= 100) ||
          event.value === false
        ) {
          if (hasPlayedRef.current || (typeof event.percent === 'number' && event.percent >= 100)) {
            setBooting(false)
          }
        }
      }
      if (event.type === 'duration' && typeof event.value === 'number' && event.value > 0) {
        if (metaKindRef.current === 'live') return
        const durationValue = event.value
        const pinned = catalogDurationRef.current
        if (pinned > 0) {
          if (durationValue > pinned * 1.05) {
            catalogDurationRef.current = durationValue
            setDuration(durationValue)
          }
          return
        }
        setDuration((prev) => {
          if (prev > 0 && durationValue < prev * 0.92) return prev
          return Math.max(prev, durationValue)
        })
      }
      if (event.type === 'timeupdate' && typeof event.current === 'number') {
        setCurrent(event.current)
        if (event.current > 0.05) {
          hasPlayedRef.current = true
          setBooting(false)
          setPlaying(true)
        }
      }
    })
    const offUi = api?.onOverlayUi?.((payload) => {
      if (payload?.action === 'boot') {
        hasPlayedRef.current = false
        setFailed(false)
        setBooting(true)
        setPlaying(false)
      }
      if (payload?.action === 'playback-ready' || payload?.action === 'hide-loading') {
        hasPlayedRef.current = true
        setBooting(false)
        setPlaying(true)
      }
    })
    return () => {
      offMeta?.()
      offEvent?.()
      offUi?.()
    }
  }, [])

  // Troca de conteúdo: só reinicia spinner se o id mudou de verdade.
  // Meta que chega depois do 1º frame (mesmo id) não pode reabrir a bolinha.
  useEffect(() => {
    const id = meta.currentId
    if (!id) return
    if (lastContentIdRef.current === id) return
    const prev = lastContentIdRef.current
    lastContentIdRef.current = id
    catalogDurationRef.current = 0
    if (prev === undefined && (hasPlayedRef.current || playingRef.current)) {
      return
    }
    // Ao vivo: zap não reabre bolinha e limpa filtro da lista
    if (meta.kind === 'live' && prev !== undefined) {
      setListFilter('')
      setBooting(false)
      setPlaying(true)
      setControlsVisible(true)
      return
    }
    hasPlayedRef.current = false
    setBooting(true)
    setFailed(false)
    setPlaying(false)
    setCurrent(0)
    const hint =
      typeof meta.durationHint === 'number' && meta.durationHint > 0 ? meta.durationHint : 0
    if (hint > 0) catalogDurationRef.current = hint
    setDuration(meta.kind === 'live' ? 0 : hint)
  }, [meta.currentId, meta.kind, meta.durationHint])

  useEffect(() => {
    if (meta.kind === 'live') {
      setDuration(0)
      return
    }
    if (typeof meta.durationHint === 'number' && meta.durationHint > 0) {
      setDuration((prev) => Math.max(prev, meta.durationHint!))
    }
  }, [meta.durationHint, meta.kind])

  const planHide = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (listOpenRef.current || !playingRef.current) return
      setControlsVisible(false)
      setListOpen(false)
    }, 4000)
  }, [])

  const showControls = useCallback(() => {
    setControlsVisible(true)
    planHide()
  }, [planHide])

  useEffect(() => {
    if (playing) planHide()
    else setControlsVisible(true)
    return () => window.clearTimeout(hideTimer.current)
  }, [playing, planHide])

  const cmd = (op: string, value?: number | boolean) => {
    void window.sturplay?.player?.command?.(op, value)
  }

  const sendAction = (action: Record<string, unknown>) => {
    void window.sturplay?.player?.sendOverlayAction?.(action)
  }

  const togglePause = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    cmd(playing ? 'pause' : 'play')
    setPlaying((v) => !v)
    showControls()
  }

  const seekTo = (next: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const max = duration > 0 ? duration : next
    const clamped = Math.max(0, Math.min(max, next))
    cmd('seek', clamped)
    setCurrent(clamped)
    showControls()
  }

  const finishScrub = () => {
    if (scrubPos === null) return
    const next = scrubPos
    setScrubPos(null)
    cmd('seek', next)
    setCurrent(next)
    showControls()
  }

  const setVol = (value: number) => {
    const next = Math.min(1, Math.max(0, value))
    setVolume(next)
    setMuted(false)
    localStorage.setItem(VOLUME_KEY, String(next))
    cmd('volume', next)
    sendAction({ type: 'volume', value: next })
    showControls()
  }

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !muted
    setMuted(next)
    cmd('volume', next ? 0 : volume)
    sendAction({ type: 'mute', value: next })
    showControls()
  }

  const toggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation()
    void window.sturplay?.player?.uiFullscreen?.()
    showControls()
  }

  const onBackgroundClick = () => {
    if (listOpen) {
      setListOpen(false)
      showControls()
      return
    }
    // 1º clique só mostra a barra — senão o “espaço vazio” pausa e os botões parecem mortos
    if (!controlsVisible) {
      showControls()
      return
    }
    togglePause()
  }

  const label = meta.title || ''
  const isLive = meta.kind === 'live'
  const allItems = meta.list || []
  const position = scrubPos ?? current
  const active = playing && !booting && !failed
  const uiVisible = controlsVisible || !playing || listOpen || booting
  const dockVisible = uiVisible && !failed
  const hideCursor = !uiVisible && !fullscreen
  const showMutedIcon = muted

  const seriesSeasonGroups = useMemo(() => {
    if (meta.kind !== 'series') return []
    return groupEpisodesBySeason(allItems)
  }, [meta.kind, allItems])

  useEffect(() => {
    if (meta.kind !== 'series' || seriesSeasonGroups.length === 0) return
    const currentSeason =
      (meta.currentId ? findSeasonForEpisode(allItems, meta.currentId) : null) ||
      seriesSeasonGroups[0]?.[0] ||
      null
    setListSeason((prev) => {
      if (prev && seriesSeasonGroups.some(([season]) => season === prev)) return prev
      return currentSeason
    })
  }, [meta.kind, meta.currentId, allItems, seriesSeasonGroups])

  const items = allItems.filter((item) => {
    const q = listFilter.trim().toLowerCase()
    if (meta.kind === 'series' && !q && listSeason && resolveEpisodeSeason(item) !== listSeason) {
      return false
    }
    if (!q) return true
    return (
      item.name?.toLowerCase().includes(q) || resolveEpisodeSeason(item).toLowerCase().includes(q)
    )
  })
  const showListBtn = (meta.kind === 'series' || meta.kind === 'live') && (meta.list?.length || 0) > 1

  useEffect(() => {
    setListOpen(false)
    setListFilter('')
    if (fullscreen) {
      setControlsVisible(false)
    } else {
      setControlsVisible(true)
      planHide()
    }
  }, [fullscreen, planHide])

  const handleEscape = useCallback(() => {
    if (booting || failed) {
      sendAction({ type: 'back' })
      return
    }
    if (fullscreen) {
      void window.sturplay?.player?.uiFullscreen?.()
      return
    }
    if (listOpen) {
      setListOpen(false)
      showControls()
      return
    }
    if (!controlsVisible) {
      showControls()
      return
    }
    sendAction({ type: 'back' })
  }, [booting, failed, fullscreen, listOpen, controlsVisible, showControls])

  const handleRemoteKey = useCallback(
    (key: string) => {
      if (key === ' ' || key === 'Space') {
        togglePause()
        return
      }
      if (key === 'ArrowLeft' || key === 'Left') {
        seekTo(position - 10)
        return
      }
      if (key === 'ArrowRight' || key === 'Right') {
        seekTo(position + 10)
        return
      }
      if (key === 'F11') {
        void window.sturplay?.player?.uiFullscreen?.()
        return
      }
      if (key === 'f' || key === 'F') {
        void window.sturplay?.player?.uiFullscreen?.()
      }
    },
    [position, togglePause, seekTo],
  )

  useEffect(() => {
    const off = window.sturplay?.player?.onOverlayUi?.((payload) => {
      if (payload?.action === 'escape') handleEscape()
      if (payload?.action === 'show-controls') showControls()
      if (payload?.action === 'key' && typeof payload.key === 'string') {
        handleRemoteKey(payload.key)
      }
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Space') {
        event.preventDefault()
        togglePause()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekTo(position - 10)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekTo(position + 10)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        handleEscape()
        return
      }
      if (event.key === 'f' || event.key === 'F' || event.key === 'F11') {
        event.preventDefault()
        void window.sturplay?.player?.uiFullscreen?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [handleEscape, handleRemoteKey, position, togglePause, seekTo, showControls])

  return (
    <div
      className={`po-root${hideCursor ? ' is-cursor-none' : ''}`}
      onMouseMove={showControls}
      onClick={onBackgroundClick}
    >
      {booting && !failed && (
        <div className="po-loading">
          <div className="po-loading-spinner" />
          {typeof label === 'string' && label ? (
            <p className="po-loading-label">{label} carregando...</p>
          ) : null}
        </div>
      )}

      {!isLive && active && (
        <div className={`po-center${uiVisible ? ' is-visible' : ''}`}>
          <IconBtn title="Voltar 10s" onClick={(e) => seekTo(position - 10, e)}>
            <span className="po-skip-label">-10</span>
          </IconBtn>
          <IconBtn title={playing ? 'Pausar' : 'Reproduzir'} onClick={togglePause}>
            {playing ? (
              <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 2h3v12H4zM9 2h3v12H9z" />
              </svg>
            ) : (
              <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 2.5v11l9-5.5-9-5.5z" />
              </svg>
            )}
          </IconBtn>
          <IconBtn title="Avançar 10s" onClick={(e) => seekTo(position + 10, e)}>
            <span className="po-skip-label">+10</span>
          </IconBtn>
        </div>
      )}

      <div
        className={`po-dock${dockVisible ? ' is-visible' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {label ? <p className="po-title">{label}</p> : null}

        {!isLive && duration > 0 && active && (
          <div className="po-seek-row">
            <span className="po-time">{formatTime(position)}</span>
            <div className="po-seek-wrap">
              {scrubPos !== null && (
                <span
                  className="po-scrub-tip"
                  style={{ left: `${Math.min(100, Math.max(0, (scrubPos / duration) * 100))}%` }}
                >
                  {formatTime(scrubPos)}
                </span>
              )}
              <input
                type="range"
                className="po-seek"
                min={0}
                max={duration}
                step={1}
                value={Math.min(position, duration)}
                onChange={(e) => setScrubPos(Number(e.target.value))}
                onPointerUp={finishScrub}
                onLostPointerCapture={finishScrub}
                onKeyUp={finishScrub}
                onBlur={finishScrub}
              />
            </div>
            <span className="po-time">{formatTime(duration)}</span>
          </div>
        )}

        {isLive && <div className="po-live-row">AO VIVO</div>}

        <div className="po-toolbar">
          <IconBtn title={playing ? 'Pausar' : 'Reproduzir'} onClick={togglePause}>
            {playing ? (
              <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 2h3v12H4zM9 2h3v12H9z" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 2.5v11l9-5.5-9-5.5z" />
              </svg>
            )}
          </IconBtn>

          {!isLive && (
            <IconBtn title="Voltar ao início" onClick={(e) => seekTo(0, e)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m10.4 9.8 4.2 2.2-4.2 2.2z" fill="currentColor" stroke="none" />
              </svg>
            </IconBtn>
          )}

          <IconBtn title={showMutedIcon ? 'Ativar som' : 'Mudo'} onClick={toggleMute}>
            <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M2 6v4h3l4 3.5v-11L5 6H2z" />
              {showMutedIcon ? (
                <path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.3" fill="none" />
              ) : (
                <path d="M11 5.5a3.5 3.5 0 010 5" stroke="currentColor" strokeWidth="1.3" fill="none" />
              )}
            </svg>
          </IconBtn>

          <input
            type="range"
            className="po-volume"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            style={{ ['--vol-pct' as string]: `${Math.round(volume * 100)}%` }}
            onChange={(e) => setVol(Number(e.target.value))}
            title="Volume"
          />

          <div className="po-toolbar-spacer" />

          {showListBtn && (
            <IconBtn
              title={meta.kind === 'series' ? 'Episódios' : 'Lista'}
              onClick={(e) => {
                e.stopPropagation()
                setListOpen((v) => !v)
                showControls()
              }}
            >
              <List size={18} />
            </IconBtn>
          )}

          <IconBtn title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggleFullscreen}>
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              {fullscreen ? (
                <path d="M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4" />
              ) : (
                <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
              )}
            </svg>
          </IconBtn>
        </div>
      </div>

      {listOpen && (
        <aside className="po-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="po-drawer-top">
            <strong>{meta.kind === 'series' ? 'Episódios' : 'Lista'}</strong>
            <button type="button" className="po-btn ghost" onClick={() => setListOpen(false)} aria-label="Fechar">
              <X size={14} />
            </button>
          </div>
          {meta.kind === 'series' && seriesSeasonGroups.length > 0 && (
            <SeasonSelect
              value={listSeason || seriesSeasonGroups[0][0]}
              onChange={setListSeason}
              options={seriesSeasonGroups.map(([season, episodes]) => ({
                value: season,
                label: formatSeasonOptionLabel(season, episodes.length),
              }))}
            />
          )}
          <input
            className="po-drawer-search"
            placeholder="Filtrar…"
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
          />
          <div className="po-drawer-list">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`po-drawer-item${item.id === meta.currentId ? ' active' : ''}`}
                onClick={() => {
                  sendAction({ type: 'select', id: item.id })
                  setListOpen(false)
                  showControls()
                }}
              >
                <span>{item.name}</span>
              </button>
            ))}
          </div>
        </aside>
      )}
    </div>
  )
}
