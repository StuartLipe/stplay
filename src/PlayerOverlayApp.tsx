import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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

/**
 * Ícone de ±10s.
 *
 * Antes cada lado eram 4 `<path>`s — um colchete, uma barra, um chevron e outra
 * barra — desenhados entre y=8 e y=16 dentro de um viewBox 24. Ocupavam um terço
 * da altura do ícone, e a 22px na tela viravam dois tralços: o colchete lia como
 * "0" cortado e a barra como "1", mas fora de esmoço, com o "10" impossível de
 * confirmar. O usuário pointed pro ícone e perguntou o que aquilo era.
 *
 * O desenho é um anel quase fechado com a seta na
 * ponta e o "10" dentro. Três informações separadas — o anel diz "tempo", a seta
 * diz o sentido, o número diz a distância. Cada uma legível isolada.
 *
 * A geometria do arco: centro (12,12), raio 8.5, varrendo 300° com a abertura
 * de 60° no topo. Os dois `path` de cada botão são o mesmo arco espelhado em x=12,
 * então o par fica simétrico por construção, não porAccordar dois números.
 */
function Seek10Icon({ dir }: { dir: 'back' | 'fwd' }) {
  const back = dir === 'back'
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Arco: 300° de volta. A seta fica na ponta, tangente à direção do giro. */}
      <path d={back ? 'M12 3.5a8.5 8.5 0 1 1-6.01 2.49' : 'M12 3.5a8.5 8.5 0 1 0 6.01 2.49'} />
      {/*
        Ponta da seta. `back` fecha o arco pela esquerda com a cabeça apontando
        para baixo-esquerda (anti-horário); `fwd` espelha. Os dois triângulos são
        filled de propósito — um traço de 1.7px a esse tamanho não tem área
        suficiente para ler como seta.
      */}
      <path
        d={back ? 'M3.6 3.1l3.9 3.05-4.55 2.2z' : 'M20.4 3.1l-3.9 3.05 4.55 2.2z'}
        fill="currentColor"
        stroke="none"
      />
      {/* O "10". dy=0.35 Recentra o glifo na caixa da linha — sem ele o texto
          assenta na baseline e o número fica 1px alto dentro do anel. */}
      <text
        x="12"
        y="12"
        dy="0.35"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="8.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        letterSpacing="-0.2"
      >
        10
      </text>
    </svg>
  )
}

/** Overlay Windows — layout compacto, com seek vermelho. */
export function PlayerOverlayApp() {
  const [meta, setMeta] = useState<OverlayMeta>({})
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [booting, setBooting] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retryInfo, setRetryInfo] = useState<{ n: number; of: number } | null>(null)
  const [bootPct, setBootPct] = useState<number | null>(null)
  /**
   * Veredito da sondagem de VOD, quando ela condemna o titulo.
   *
   * `null` = carregando de verdade, e o `bootPct` manda.
   * `'indisponivel'` = o painel respondeu que nao tem o arquivo. A partir dai o
   * percentual sobe por relogio, nao por progresso, e mostrar "Buffering 82%"
   * seria anunciar um progresso inexistente.
   */
  const [bootMotivo, setBootMotivo] = useState<string | null>(null)
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
        setRetryInfo(null)
        setBootPct(null)
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
        if (typeof event.retry === 'number' && typeof event.of === 'number') {
          setRetryInfo({ n: event.retry, of: event.of })
          setBooting(true)
        }
        /*
         * `motivo: 'indisponivel'` = a sondagem de 256 bytes ja respondeu que o
         * painel nao tem o arquivo.
         *
         * Nesse caso o percentual e mentira: ele e uma curva de tempo, nao uma
         * medicao, entao continua subindo depois da recusa. Medido no Dalmatas
         * (1575711): recusa em +1,2 s, "Buffering 82%" na tela, falha em +11,8 s.
         * A pessoa ficava 10 s esperando um progresso que nao existia.
         *
         * Aqui o texto passa a ser o veredito e o `%` some. A falha definitiva
         * chega logo depois, com o botao de tentar de novo.
         */
        setBootMotivo(typeof event.motivo === 'string' ? event.motivo : null)
        // Percentual 0-100: sobe no véu enquanto carrega.
        if (typeof event.percent === 'number') {
          setBootPct((prev) => {
            const next = Math.max(0, Math.min(100, Math.round(event.percent as number)))
            if (prev !== null && next < prev) return prev
            return next
          })
        }
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
        setRetryInfo(null)
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
    setRetryInfo(null)
    setBootPct(null)
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
  /*
   * `active` saiu daqui: era `playing && !booting && !failed`, usado so como
   * gate da barra de seek, e por isso a barra sumia quando a pessoa pausava.
   * Quem decide se os controles aparecem e `uiVisible`/`dockVisible`, logo abaixo.
   */
  const uiVisible = controlsVisible || !playing || listOpen || booting
  // Carregando mostra só o véu + spinner. A barra embaixo
  // do véu era ruído — controle só depois do 1º frame (ou lista aberta).
  const dockVisible = uiVisible && !failed && (!booting || listOpen)
  /*
   * CURSOR: JUNTO COM OS CONTROLES, E SEMPRE QUE O VIDEO ESTE RODANDO.
   *
   * Duas viradas, nesta ordem:
   *
   * 1. Estava invertido: `!uiVisible && !fullscreen` escondia no modo JANELA e
   *    nunca na tela cheia — o oposto do pedido.
   *
   * 2. Depois veio `fullscreen && !uiVisible && playing`. Funcionava como
   *    condicao, mas nao como mecanismo: assim que os controles escondem, o
   *    overlay liga `setOverlayIgnoreMouse(true)`, sai do hit-test, e quem decide
   *    o cursor passa a ser a janela do mpv embaixo. O CSS daqui vira enfeite.
   *    Quem esconde o cursor agora e o mpv (`--cursor-autohide` em buildMpvArgs).
   *
   * Esta variavel ficou como o espelho do estado, porque e ela que acende a
   * classe no `<html>` nos intervals em que a janela ainda e alvo do ponteiro —
   * o listOpen, e os primeiros ms depois de os controles sumirem.
   *
   * O `&& playing` mantem o cursor visivel com o video parado: pausado, a pessoa
   * vai clicar em botao, e sumir o cursor debaixo da mao dela impede isso.
   */
  /*
   * O overlay segura o hit-test quando o dock esta aceso OU em tela cheia.
   * Ver o bloco do efeito de `setOverlayIgnoreMouse` para por que a tela cheia
   * precisa disso apesar de os controles estarem escondidos.
   */
  const overlayHitTest = dockVisible || fullscreen
  const hideCursor = fullscreen && !uiVisible && playing
  const showMutedIcon = muted

  /*
  O botao de voltar mora DENTRO da barra.

  Houve uma tentativa de coloca-lo numa janela SEPARADA no canto superior
  esquerdo do video (janela de 56x56, criada pelo main). Nao funciona: janela
  Chromium transparente sobre a HWND reparentada do mpv quebra o swapchain
  D3D11 do vo=gpu. O sintoma medido e o audioCutting e o quadro parando, e no
  ao vivo entra em loop. A medicao original que motivou o overlay ser so a barra
  esta em overlay-bounds.cjs, e ela se aplica aqui tambem.

  Entao o botao fica na barra. Some junto com ela, que e o comportamento
  pedido: nada fixo na tela.
*/

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

  /*
   * `cursor: none` no `.po-root` NAO FUNCIONA, e a razao e o `pointer-events`.
   *
   * O root tem `pointer-events: none` — sem isso a janela do overlay engole o
   * mouse e o clique nunca chega no catalogo. Sem ser o alvo do hit-test, o
   * `cursor` do root nunca e consultado: o Windows pede o cursor a janela que o
   * ponteiro esta sobre, e essa e a janela de baixo.
   *
   * Entao a classe vai no `<html>`, que e a raiz do documento inteiro e cobre as
   * duas janelas (overlay e principal). E o no BrowserWindow tem `setIgnoreMouse
   * Events`, que nao afeta o cursor — entao nao ha caminho melhor por la.
   */
  useEffect(() => {
    const raiz = document.documentElement
    if (hideCursor) raiz.classList.add('is-cursor-none')
    else raiz.classList.remove('is-cursor-none')
    return () => raiz.classList.remove('is-cursor-none')
  }, [hideCursor])

  /*
   * MOUSE: A JANELA ESCUTA, O DOM NAO.
   *
   * O overlay e uma BrowserWindow TRANSPARENTE por cima do video, e `main` decide
   * se ela engole o mouse com `setIgnoreMouseEvents`. Esse sinal tem dois
   * consumidores, e eles estao em camadas diferentes:
   *
   *   - os CLIQUES dependem do `setIgnoreMouseEvents` da JANELA. Com `false`, a
   *     janela engole tudo e o clique nunca chega no catalogo de baixo. Com
   *     `true`, o clique passa direto para a janela principal.
   *   - o MOVIMENTO depende do DOM. `setIgnoreMouseEvents(true, { forward: true })`
   *     repassa a mensagem de `mousemove` para o renderer, mas o `pointer-events`
   *     do alvo ainda manda: com `.po-root { pointer-events: none }` o hit test cai
   *     no `<body>` e o `onMouseMove` de um div NAO dispara. Foi o que quebrou ao
   *     passar o root para `none` — os controles sumiam e o clique morria no
   *     nada, porque os dois handlers estavam no `.po-root`.
   *
   * Entao os dois ficam em `window`, que e o unico lugar que ve o evento
   * encaminhado. O `stopPropagation` dos widgets impede o clique de chegar aqui
   * e virar toggle de controle junto.
   */
  useEffect(() => {
    const onMove = () => showControls()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('click', onBackgroundClick)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('click', onBackgroundClick)
    }
  }, [showControls, onBackgroundClick])

  /*
   * QUANDO A JANELA ENGOLE O MOUSE.
   *
   * Antes: `false` desde que o overlay aparecia, e `true` so quando ele escondia
   * (as duas unicas chamadas de `setIgnoreMouse` no `overlay-window.cjs`). No meio
   * do playback a janela ficava engolindo o mouse, entao o clique no video nunca
   * chegava no catalogo — que era a intencao declarada do recurso, e nunca
   * aconteceu.
   *
   * Agora segue o estado dos controles, que e a mesma coisa que o usuario espera:
   *
   *   controles escondidos -> a janela ignora o clique e so encaminha o movimento.
   *     O video e so video, e mexer o mouse traz os controles de volta.
   *   controles visiveis   -> a janela engole, porque a pessoa esta interagindo com
   *     o pause e o volume. O clique fora dos botoes e o que fecha.
   *
   * TELA CHEIA E A EXCECAO QUE ABRE O HIT-TEST DE PROPOSITO.
   *
   * A regra acima era "esconder = clicar atraves", e isso e o que matava o cursor:
   * com a janela em ignore-mouse, o Windows para de perguntar o cursor a ela e
   * pergunta a janela de baixo, que e a HWND do mpv. O `cursor: none` no `<html>`
   * do overlay ficava correto e sem efeito — so manda enquanto a janela e alvo do
   * ponteiro.
   *
   * Em tela cheia nao existe nada para o clique atravessar: atras do video so tem
   * video. O video esta em tela cheia, os controles do catalogo estao fora, e
   * projeto nenhum tem handler de wheel (grep em `onWheel`/`deltaY`: zero
   * resultado), entao nada do que se perde aqui estava sendo usado.
   *
   * Entando o hit-test, o SO volta a perguntar o cursor a janela do overlay, e o
   * CSS manda. O movimento continua chegando no catalogo porque os botoes do dock
   * tem `pointer-events: auto` e o clique fora deles e o que fecha os controles —
   * igual antes, so que agora a janela tambem responde pelo cursor.
   *
   * O drawer de canais e a excecao: ele precisa de clique e mouse normalmente,
   * entao abre a janela de vez, independente dos controles.
   */
  useEffect(() => {
    void window.sturplay?.player?.setOverlayIgnoreMouse?.(!overlayHitTest)
  }, [overlayHitTest])

  return (
    <div className={`po-root${hideCursor ? ' is-cursor-none' : ''}`}>
      {booting && !failed && (
        <div className="po-loading">
          <div className="po-loading-spinner" />
          {retryInfo ? (
            <p className="po-loading-label">Reconectando em 5s ({retryInfo.n}/{retryInfo.of})</p>
          ) : bootMotivo === 'indisponivel' ? (
            /*
              O titulo foi CONDENADO pela sondagem, nao esta carregando devagar.
              Mostrar o `%` aqui e o que produzia "Buffering 82%" num arquivo que
              o painel ja tinha dito, 10 s antes, que nao existe.
            */
            <p className="po-loading-label">Indisponível no servidor</p>
          ) : (
            <p className="po-loading-label">Buffering {bootPct ?? 0}%</p>
          )}
        </div>
      )}

      {/*
        O trio central `-10 / pause / +10` saiu daqui.

        Ele vivia em `.po-center`, que e `position: absolute` dentro da JANELA do
        overlay — e essa janela tem SO 104px de altura durante a reproducao. Logo
        o trio nao ficava no meio do video: ficava grudado no rodape, colado na
        barra, parecendo botao quebrado.

        Tambem era duplicata: o pause do `po-dock` e o que realmente pausa, e o
        `seekTo` dele ja cobre o salto. Os ±10 agora ficam no `po-toolbar`, na
        MESMA familia do pause e do som — que e a unica familia que funciona.
      */}

      {/*
        SAIR, NO TOPO ESQUERDO DO VIDEO.

        Morava no `po-toolbar`, embaixo, junto do pause e do som. Subiu por dois
        motivos que nao sao de gosto:

        1. O dock tem uma unica fileira e o botao de sair e um gesto diferente de
           pausa: e sair do video, e precisa de ar em volta.
        2. Em tela cheia o dock inteiro sai da tela com o video, e o botao de sair
           ficava embaixo de tudo, no canto onde o olho ja foi.

        Precisa morar no OVERLAY, e nao em `.player-controls` da janela principal,
        porque durante a reproducao mpv a janela principal fica
        `is-native-embedded is-native-buffered` e a regra
        `.player-wrap.is-native-buffered .player-controls { display: none !important }`
        apaga a barra inteira. Pior: o HWND do mpv e uma janela NATIVA sobre o
        DOM da janela principal, entao um botao la dentro ficaria ATRAS do video.
        O overlay e a unica janela acima dele.

        `is-hidden` acompanha o `dockVisible`: os dois somem juntos, e o video
        volta a ser so video. Botao de saida fixo em cima de video rodando e a
        unica coisa parada na tela.

        `type: 'back'` ja e tratado no App (App.tsx, `onOverlayAction`):
        embedded -> sai do video, senao -> `onBack()`.
      */}
      <button
        type="button"
        className={`po-btn po-back${dockVisible ? '' : ' is-hidden'}`}
        title="Voltar"
        aria-label="Voltar"
        onClick={(e) => {
          e.stopPropagation()
          void window.sturplay?.player?.sendOverlayAction?.({ type: 'back' })
          showControls()
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
      </button>

      <div
        className={`po-dock${dockVisible ? ' is-visible' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {label ? <p className="po-title">{label}</p> : null}

        {/*
          A barra de seek NAO pode depender de `active`.

          `active` e `playing && !booting && !failed`, entao ela sumia no pause —
          e era o comportamento errado: pausado e justamente quando a pessoa
          quer ver onde esta e quanto falta. O screenshot mostrava a faixa de
          tempo inteira ausente com o pause ligado, e presente com ele desligado.

          O gate correto e o mesmo dos outros controles: video carregado e com
          duracao conhecida. `booting` e `failed` ja sao barrados por `dockVisible`
          (`uiVisible && !failed`), entao aqui basta nao exigir `playing`.
        */}
        {!isLive && duration > 0 && !failed && (
          <div className="po-seek-row">
            <span className="po-time">{formatTime(position)}</span>
            <div
              className="po-seek-wrap"
              /*
                `--seek-pct` alimenta o gradiente do trilho desenhado em CSS.
                Durante o arrasto vale o valor de `scrubPos`, e nao o de
                `position`: enquanto o dedo/cursor esta no slider, o valor
                real ainda nao mudou, e usar `position` fazia o trilho
                "voltar" atras do polegar.
              */
              style={
                {
                  '--seek-pct': `${Math.min(
                    100,
                    Math.max(0, (((scrubPos ?? position) / duration) || 0) * 100),
                  )}%`,
                } as CSSProperties
              }
            >
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
          {/*
            O "Voltar" saiu daqui e virou o `.po-back`, no topo esquerdo da janela
            do overlay - sempre visivel, fora do `dockVisible`. Ver o bloco do
            `.po-back` acima, logo antes do `.po-dock`.

            Aqui agora ficam so os controles do video: pausa, saltos e som.
          */}
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

          {/*
            -10 / +10, na MESMA familia do pause e do som.

            Vieram do `.po-center`, que era `position: absolute` dentro da janela
            do overlay — e essa janela tem SO 104px de altura durante a
            reproducao. O trio ficava grudado no rodape, colado na barra, e nao
            no meio do video como parecia.

            Aqui eles usam o mesmo `IconBtn` e o mesmo `seekTo` do dock, entao
            passam a funcionar de verdade: o `-10` reapareceu no `po-toolbar`
            como qualquer outro botao da barra.
          */}
          {!isLive && (
            <>
              <IconBtn title="Voltar 10s" onClick={(e) => seekTo(position - 10, e)}>
                <Seek10Icon dir="back" />
              </IconBtn>
              <IconBtn title="Avançar 10s" onClick={(e) => seekTo(position + 10, e)}>
                <Seek10Icon dir="fwd" />
              </IconBtn>
            </>
          )}

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
