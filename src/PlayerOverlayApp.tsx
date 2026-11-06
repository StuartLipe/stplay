import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Heart, List, X } from 'lucide-react'
import { coverSrc } from './lib/proxy'
import { ehCategoriaAdulta } from './lib/adulto'
import { getSkipTimes, extractEpisodeNumber, extractSeasonNumber, type SkipTimes } from './lib/aniskip'
import { FILMES } from './lib/oped-filmes'
import { janelaCobrePosicao } from './lib/skip-janela'
import {
  findSeasonForEpisode,
  formatSeasonOptionLabel,
  groupEpisodesBySeason,
  resolveEpisodeSeason,
} from './lib/episode-seasons'
/*
 * `SeasonSelect` saiu daqui. Era um `<select>` solto acima do filtro da gavota,
 * e a informacao de temporada virou uma ABA com contagem, no mesmo visual das
 * outras. O componente continua existindo para outros usos — o lugar dele aqui
 * era redundante com a aba.
 */
import type { VideoFit } from './lib/players/types'
import { playerLog } from './lib/players/playerLogger'
import { aspectHint, nextAspect, normalizeAspect } from './lib/players/video-aspect'

type OverlayItem = {
  id: string
  name: string
  group?: string
  logo?: string
  /*
   * seriesId do episodio, quando disponivel. Usado para indexar o metadado
   * de opening (intro_start/intro_end) por serie. Vem de `series-${series_id}`
   * no id do canal, ou pode ser preenchido diretamente pelo App.
   */
  seriesId?: string
}

type OverlayMeta = {
  engine?: string
  url?: string
  title?: string
  kind?: string
  list?: OverlayItem[]
  currentId?: string
  seriesId?: string
  /*
   * Favoritos do perfil, por id. O overlay nao tinha NENHUM estado de favorito:
   * a lista nativa mostra o coracao em cada canal e a do motor nao mostrava
   * nada. Sem este campo o coracao aqui seria decoracao, entao o App manda o
   * conjunto e o clique devolve uma acao de volta.
   */
  favorites?: string[]
  volume?: number
  muted?: boolean
  durationHint?: number
  fullscreen?: boolean
  /*
   * Filmes da mesma franquia que o que esta tocando (ex: Matrix, Rambo),
   * calculado pelo App a partir do catalogo completo de filmes. So para
   * `kind === 'movie'`. O overlay exibe na aba "Continuacao", com o filme em
   * reproducao no topo como "Assistindo agora".
   */
  franquia?: OverlayItem[]
  /*
   * Os mesmos filmes, mas partidos em SAGAS. Uma franquia pode ter mais de
   * uma serie: em Star Wars, a trilogia "Episodio I..III" e a serie
   * "Star Wars 2..8" nao sao a mesma sequencia. Sem esta separacao o drawer
   * misturava as duas e o proximo capitulo offeredo estava errado.
   *
   * `principal: false` marca a saga lateral, que o drawer mostra APOS a
   * principal, com um aviso — nao some da lista nem volta pro topo.
   */
  sagas?: Array<{ principal: boolean; filmes: OverlayItem[] }>
}

const VOLUME_KEY = 'stplay.volume'

/**
 * Quanto antes do fim a oferta de proximo capitulo aparece, em segundos.
 * 30s da para ler o titulo e clicar em "Comecar" sem perder o final.
 */
const SEGUNDOS_FIM = 30

/**
 * Margem de seguranca, como FRACAO da duracao.
 *
 * A duracao do container nao e a duracao do conteudo. Medido no Episodio I:
 * a barra vai ate 2:16:10, mas o filme ACABA em 2:09:54 — 6m16s de cauda
 * (creditos/pre-roll do arquivo). Um gatilho so em segundos nunca dispararia
 * nesse filme: faltavam 376s, muito acima dos 30s.
 *
 * A fracao cobre essa cauda sem depender de o container estar certo. 5% de
 * 2:16 sao ~7 min — a oferta aparece antes do final de verdade, que e o que a
 * pessoa precisa: tempo de decidir e de carregar o proximo.
 */
const FRACAO_FIM = 0.05

/**
 * Oferta do próximo episódio em SÉRIE: não existe mais fração de duração.
 *
 * O valor antigo (12% da duração, ~2:54 antes do fim) foi REMOVIDO. Ele não
 * tem relação com o encerramento real: no SPY E01 disparava em 21:24 com o
 * ED em 21:52. Série agora usa o ED medido do episódio (mapa `oped-data`),
 * e episódio sem ED medido simplesmente não oferece o próximo antes da hora.
 */

/**
 * Janela final da oferta em FILME.
 *
 * Só filme: a duração do container mente (a cauda de 6 min do Episódio I),
 * então a fração cobre essa diferença. Em série a duração é fiel e o que
 * manda é o ED medido.
 */
function normalizarTituloFilme(t: string): string {
  return (t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function janelaFinal(
  duracaoSegundos: number,
  kind: 'movie' | 'series' | 'live',
  titulo?: string
): number {
  if (kind !== 'movie') return 0
  // Créditos MEDIDOS e certificados (finder): a oferta abre no começo real
  // dos créditos. Sem marca do filme, mantém a janela por duração.
  const medido = FILMES[normalizarTituloFilme(titulo || '')]
  if (medido && medido.credits > 0 && medido.credits < duracaoSegundos) {
    const janela = duracaoSegundos - medido.credits
    if (janela >= 5 && janela <= duracaoSegundos * 0.6) return janela
  }
  return Math.max(SEGUNDOS_FIM, duracaoSegundos * FRACAO_FIM)
}

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
function readAspect(): VideoFit {
  try {
    return normalizeAspect()
  } catch {
    return 'fit'
  }
}
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

  /*
   * QUANTO TEMPO JA PASSOU ESPERANDO.
   *
   * O dono mediu 76 canais abertos e 23 falhos no painel dele, e cada falha custa
   * 15 s de watchdog mais 15 s de fallback `.ts`. São 30 s de tela sem nenhuma
   * palavra, e a leitura foi "bugando e a tela preta". Ele pediu para manter o
   * tempo de espera, então a espera continua: o que muda e o app passar a DIZER
   * que está esperando.
   *
   * Contador de 1 s, e so enquanto o véu está no ar. Fora dele o timer fica
   * ligado à toa, e o componente vive na janela do overlay a sessão inteira.
   */
  const [bootSegundos, setBootSegundos] = useState(0)
  useEffect(() => {
    if (!booting) {
      setBootSegundos(0)
      return
    }
    const inicio = Date.now()
    setBootSegundos(0)
    const t = window.setInterval(() => setBootSegundos(Math.floor((Date.now() - inicio) / 1000)), 1000)
    return () => window.clearInterval(t)
  }, [booting])
  const [fullscreen, setFullscreen] = useState(false)
  const [volume, setVolume] = useState(readVolume)
  const [muted, setMuted] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [listFilter, setListFilter] = useState('')
  const [listSeason, setListSeason] = useState<string | null>(null)
  /*
   * Aba da gavota e categoria escolhida.
   *
   * "Categorias" lista os grupos com contagem; "Canais" lista os canais. São as
   * mesmas duas abas da gavota do motor nativo — sem elas, quem usava o motor
   * nativo para pular de categoria tinha que sair do player e voltar na coluna,
   * e quem usa STUR/MPEG simplesmente nao tinha o recurso.
   */
  const [listTab, setListTab] = useState<
    | 'categorias'
    | 'canais'
    | 'temporadas'
    | 'episodios'
    | 'todos'
    | 'dublado'
    | 'legendado'
    | 'franquia'
  >('canais')
  const [drawerCategoria, setDrawerCategoria] = useState<string | null>(null)
  const [scrubPos, setScrubPos] = useState<number | null>(null)
  const [hoverPos, setHoverPos] = useState<number | null>(null)
  const [previewX, setPreviewX] = useState(0)
  const [previewTop, setPreviewTop] = useState(0)

  /**
   * Janela em que o overlay se cala no zape de live.
   *
   * Mesmo numero de `LIVE_ZAP_FEEDBACK_MS` no `App.tsx`: um zape que abre em
   * 450 ms nao acende nada, e um que demora mostra o indicador. Os dois lados
   * precisam do mesmo valor — se divergirem, o spinner do App e o do overlay
   * piscam em tempos diferentes no mesmo zape.
   */
  const LIVE_ZAP_FEEDBACK_MS = 450

  /*
   * AJUSTE DE IMAGEM, no overlay. O mesmo estado que a `player-topbar` do
   * renderer principal, e pelo MESMO motivo: no modo nativo quem mostra os
   * controles e esta janela. Deixar o botao so la deixava o ajuste fora de
   * alcance de quem usa STUR.
   *
   * A chave e compartilhada (`stplay.video-aspect`), entao alternar num dos
   * dois muda no outro e o padrao sobrevive ao reinicio.
   */
  const [aspect, setAspect] = useState<VideoFit>(readAspect)
  const applyAspect = (modo: VideoFit) => {
    setAspect(modo)
    try {
      localStorage.setItem('stplay.video-aspect', modo)
    } catch {
      // sem persistencia o ajuste vale so nesta sessao
    }
    cmd('aspect', modo)
    showControls()
  }
  const hideTimer = useRef(0)
  const playingRef = useRef(false)
  const hasPlayedRef = useRef(false)
  const listOpenRef = useRef(false)
  const metaKindRef = useRef<string | undefined>(undefined)
  const lastContentIdRef = useRef<string | undefined>(undefined)
  /*
   * Espera do zape de live, o mesmo papel de `LIVE_ZAP_FEEDBACK_MS` no App.
   *
   * O App ja tem esse mecanismo desde que o dono reclamou de "15 segundos de
   * video congelado, sem nenhuma indicacao". O overlay NAO tinha: ele desligava
   * o spinner incondicionalmente a cada troca de canal ao vivo, e nada o reabria
   * ate o `failed`. No STUR quem manda no loading e o overlay, entao a correcao
   * do App nunca chegava ao caminho que ele mais usa.
   */
  const liveZapWaitRef = useRef(0)
  const clearLiveZapWait = useCallback(() => {
    if (liveZapWaitRef.current) {
      window.clearTimeout(liveZapWaitRef.current)
      liveZapWaitRef.current = 0
    }
  }, [])
  const catalogDurationRef = useRef(0)
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)

  /*
   * Refs de volume/mudo DEVEM ser atualizados no mesmo efeito que aplica o
   * volume. Em efeitos separados, o de aplicação rodava antes do que escreve o
   * ref, e mandava ao mpv o valor ANTERIOR: ao arrastar o slider o audio ia
   * atrasando um passo em relacao ao ponteiro.
   */
  useEffect(() => {
    volumeRef.current = volume
    mutedRef.current = muted
    const out = muted ? 0 : volume
    void window.sturplay?.player?.command?.('volume', out)
  }, [volume, muted])

  const applyOutputVolume = useCallback(() => {
    const out = mutedRef.current ? 0 : volumeRef.current
    void window.sturplay?.player?.command?.('volume', out)
  }, [])

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
        /*
         * ANTES DO PRIMEIRO PLAY, o booting só LIGA e nunca DESLIGA aqui.
         *
         * Este é o-defeito-do-VOD, e são duas metades do mesmo furo:
         *
         *   LIGA. A condição antiga era `percent < 100`, então o `cache-buffering-state`
         *   do mpv chegando a 100% (o cache enche) não ligava o booting — e como
         *   o primeiro quadro ainda não tinha chegado, o spinner nunca aparecia.
         *
         *   DESLIGA. O `cache-buffering-state` chega a 100% ANTES do primeiro quadro
         *   decodificar, e mandava `value: false` junto. O overlay obedecia e
         *   escondia o véu, e nada o reabria até o `playing` — buraco preto no
         *   meio do carregamento, que é o "a bola pisca e some, e a tela fica preta"
         *   que o dono viu.
         *
         * Quem fecha o booting antes do primeiro play é o evento `playing`, e só
         * ele: ele significa literalmente "o quadro está na tela". A % do mpv, não.
         * Depois do primeiro play, os dois casos voltam a ter efeito (buffer
         * recovering e o spinner some).
         */
        if (!hasPlayedRef.current) {
          setBooting(true)
        } else if (
          (typeof event.percent === 'number' && event.percent >= 100) ||
          event.value === false
        ) {
          setBooting(false)
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
          clearLiveZapWait()
          setBooting(false)
          setPlaying(true)
        }
      }
    })
    const offUi = api?.onOverlayUi?.((payload) => {
      if (payload?.action === 'boot') {
        hasPlayedRef.current = false
        clearLiveZapWait()
        setFailed(false)
        setRetryInfo(null)
        setBooting(true)
        setPlaying(false)
      }
      if (payload?.action === 'playback-ready' || payload?.action === 'hide-loading') {
        hasPlayedRef.current = true
        clearLiveZapWait()
        setBooting(false)
        setPlaying(true)
      }
    })
    return () => {
      offMeta?.()
      offEvent?.()
      offUi?.()
      clearLiveZapWait()
    }
  }, [clearLiveZapWait])

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
    /*
     * ZAPE DE LIVE: o spinner nao acende na hora, mas TAMPAO nao e apagado.
     *
     * Antesisto aqui era `setBooting(false)` + `setPlaying(true)` incondicional,
     * com a premissa de que zape e instantaneo. Nao e: neste painel o
     * `LIGA FUTSAL` respondeu 404 em 8 de 12 canais e o resto demorou ate 8
     * segundos so no primeiro byte. Durante esse tempo o mpv segura o ULTIMO
     * quadro do canal anterior — e o dono via um video congelado, com o icone
     * de pause, sem nenhuma pista de que algo estava acontecendo. O `failed`
     * so chegava 20 s depois, quando o fallback de `.ts` ja tinha falhado.
     *
     * Agora: zape que abre em 450 ms nao acende nada (a janela do App, o mesmo
     * `LIVE_ZAP_FEEDBACK_MS`), e zape que demora mostra o indicador.
     */
    if (meta.kind === 'live' && prev !== undefined) {
      setListFilter('')
      clearLiveZapWait()
      // Mostrar carregando imediatamente ao trocar de canal ao vivo.
      // O quadro antigo fica na tela enquanto o mpv abre o novo — sem isso o
      // dono via uma imagem congelada sem nenhuma pista de que algo estava
      // acontecendo.
      setPlaying(false)
      hasPlayedRef.current = false
      setBooting(true)
      setControlsVisible(true)
      // Se o playing chegar antes dos LIVE_ZAP_FEEDBACK_MS, o proprio `playing`
      // desliga o booting. Se não chegar, o spinner fica na tela até o canal
      // subir ou falhar.
      liveZapWaitRef.current = window.setTimeout(() => {
        liveZapWaitRef.current = 0
      }, LIVE_ZAP_FEEDBACK_MS)
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
  }, [meta.currentId, meta.kind, meta.durationHint, clearLiveZapWait])

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

  const cmd = (op: string, value?: number | boolean | VideoFit, mode?: string) => {
    void window.sturplay?.player?.command?.(op, value, mode)
  }

  /*
    SALTO RELATIVO. O que a pessoa quer com a seta e "anda 10s daqui", e nao
    "va para <position + 10>". A diferenca so aparece quando a tecla se
    repete: o `position` vem de `timeupdate` e nao avanca entre dois `keydown`
    seguidos, entao o segundo salto ia para onde o video JA estava. Medido no
    log: cinco seeks seguidos para o mesmo valor.
  */
  const skip = (delta: number) => {
    cmd('seek', delta, 'relative')
    // A interface acompanha pela乐观 posicao mostrada; quem manda o numero de
    // verdade e o motor, e ele corrige no proximo timeupdate.
    showControls()
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

  /*
   * Fim do arraste.
   *
   * DOIS SALPOS PARA UM ARRASTE — o bug que o log mostrou.
   *
   * `finishScrub` esta ligada em `onPointerUp`, `onLostPointerCapture`,
   * `onKeyUp` e `onBlur`. O Chromium dispara `pointerup` e depois
   * `lostpointercapture`, entao a funcao roda DUAS vezes. A guarda
   * `if (scrubPos === null) return` nao segurava, porque `scrubPos` e estado
   * do React: o `setScrubPos(null)` da primeira chamada so vale no proximo
   * render, e a segunda chamada ainda via o valor antigo.
   *
   * No log: `seek 1347 (exato)`, `seek 1323 (scrub)`, `seek 1323 (exato)`. Tres
   * saltos para um arraste, e o primeiro foi para um alvo que nem era o final.
   *
   * A guarda agora e um REF, que atualiza na hora.
   */
  const scrubConcluidoRef = useRef(false)

  /*
   * MINIATURA DA BARRA (estilo YouTube).
   *
   * Enquanto o cursor está sobre a barra (ou arrastando), pedimos ao processo
   * principal o quadro daquele instante. O main usa um mpv quente: ~1,2-1,6 s
   * por quadro novo e 0,4 s quando repete; o disco guarda por faixa de 5 s.
   * Aqui só debounçamos o pedido (160 ms) e mantemos a última imagem na tela
   * enquanto a próxima carrega.
   */
  const posPreview = scrubPos ?? hoverPos
  // Miniatura de v?deo desligada: s? o instante, que ? leve e sempre aparece.


  const finishScrub = () => {
    if (scrubConcluidoRef.current) return
    scrubConcluidoRef.current = true
    if (scrubPos === null) return
    const next = scrubPos
    setScrubPos(null)
    /*
     * O salto final é ABSOLUTO, e é o certo: o alvo é um instante escolhido
     * na barra, não um deslocamento. A posição defasada do `timeupdate` só
     * quebra os saltos RELATIVOS (as manoplas de 10s), que é por isso que
     * elas usam `relative`.
     *
     * E é o ÚNICO salto do arraste: sem busca durante o arrasto, o mpv não
     * invalida a posição de leitura oito vezes por segundo, e o vídeo
     * continua tocando enquanto a pessoa arrasta.
     *
     * MEDIDO em 20/10/2026: gmaster1.shop RESPONDE 206 Partial Content
     * (~0,6 s por faixa). O coment?rio anterior dizia que n?o; a origem
     * mudou. Mesmo assim, buscar durante o arraste continua caro no mpv
     * (cada seek invalida a leitura), ent?o o salto segue sendo um s?, no
     * fim. A pr?via da barra usa esse range no mpv quente.
     */
    const alvo = Number.isFinite(next) ? next : 0
    // A pessoa soltou o cursor no ponto onde o video ja esta: nao ha o que
    // buscar, e buscar seria reler o arquivo por causa de nada.
    if (Math.abs(alvo - current) < 1.5) {
      showControls()
      return
    }
    cmd('seek', alvo)
    setCurrent(alvo)
    showControls()
  }

  const setVol = (value: number) => {
    const next = Math.min(1, Math.max(0, value))
    setVolume(next)
    setMuted(false)
    localStorage.setItem(VOLUME_KEY, String(next))
    /*
     * NAO manda `cmd('volume')` aqui. O efeito em [volume, muted] ja chama
     * `applyOutputVolume`, que faz exatamente isso. Com os dois, cada passo do
     * slider chegava ao mpv DUAS vezes — o log mostrava 0.35, 0.35, 0.3, 0.3…
     * e o IPC repetido atrasava o audio ao arrastar.
     */
    sendAction({ type: 'volume', value: next })
    showControls()
  }

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !muted
    setMuted(next)
    // Mesmo caso do setVol: o efeito aplica o volume, inclusive o 0 do mudo.
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
  /*
   * `hideCursor` vem antes do hit-test porque e ele que decide o hit-test. A
   * ordem deixa isso a vista; na ordem antiga o `hideCursor` vivia doze linhas
   * abaixo, e o bug era invisivel justamente por causa disso.
   */
  const hideCursor = !uiVisible && playing

  /*
   * HIT-TEST: A JANELA RESPONDE PELO PONTEIRO?
   *
   *   `|| hideCursor` e o conserto. Sem ele, no modo janela, a barra escondia E o
   *   hit-test caia no MESMO instante — a janela entregava o cursor a HWND do mpv
   *   exatamente quando o `cursor: none` estava pedindo para esconder. A tela cheia
   *   nunca sentiu isso porque o `|| fullscreen` segurava o hit-test.
   *
   *   Os tres termos nao se sobrepoem, e nao precisam: `hideCursor` exige
   *   `!uiVisible`, que exclui `dockVisible`; e `fullscreen` cobre o video inteiro,
   *   onde nao ha clique atravessavel que valha perder.
   */
  const overlayHitTest = dockVisible || fullscreen || hideCursor
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

  /*
   * Favoritos do perfil chegam no `meta` (o overlay e uma janela separada e nao
   * compartilha estado com o App). Viram Set para a consulta por linha ser O(1) —
   * a lista chega com ate 400 itens e a busca linear por item em cada render
   * custava 400 comparacoes vezes o numero de linhas.
   */
  const favoritos = useMemo(() => new Set(meta.favorites || []), [meta.favorites])

  /*
   * Categorias da gavota, com a MESMA ordenacao da gavota do motor nativo.
   *
   * Alfabetico cru enterrava a categoria adulta: "ADULTOS +18 | CANAIS" comeca
   * com A e ia pro topo, enquanto a coluna lateral pegas adultas no FIM de
   * proposito. Aqui a ordem e a mesma da coluna — normais em ordem, adultas no
   * final — para os dois lugares apontarem para a mesma categoria no mesmo lugar.
   */
  const drawerCategorias = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of allItems) {
      const group = item.group?.trim() || 'Outros'
      counts.set(group, (counts.get(group) || 0) + 1)
    }
    const entradas = [...counts.entries()]
    const normais = entradas
      .filter(([group]) => !ehCategoriaAdulta(group))
      .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
    const adultas = entradas
      .filter(([group]) => ehCategoriaAdulta(group))
      .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
    return [...normais, ...adultas]
  }, [allItems])

  const items = allItems.filter((item) => {
    const q = listFilter.trim().toLowerCase()
    if (meta.kind === 'series' && !q && listSeason && resolveEpisodeSeason(item) !== listSeason) {
      return false
    }
    /*
     * Aba de categoria: escolher uma categoria estreita a lista de canais.
     *
     * O filtro de texto NAO pode zerar a categoria escolhida. Com os dois ativos,
     * digitar "a" dentro de "ADULTOS +18 | CANAIS" deixava a lista vazia sem
     * saida visivel, porque o unico jeito de limpar era limpar o texto — e o
     * texto continua cheio. A gavota do motor nativo faz o mesmo, entao aqui
     * segue a mesma regra.
     */
    if (!q && drawerCategoria && item.group?.trim() !== drawerCategoria) {
      return false
    }
    if (!q) return true
    return (
      item.name?.toLowerCase().includes(q) || resolveEpisodeSeason(item).toLowerCase().includes(q)
    )
  })

  /*
   * Abas do drawer de FILME: Todos | Dublado | Legendado | Continuacao.
   * Tudo deriva da MESMA FRANQUIA do filme que esta tocando (ex: Matrix),
   * nunca do catálogo inteiro. O servidor marca o legendado com [L].
   */
  const franquiaRelacionada = meta.franquia || [] // ja exclui o filme de referencia
  const filmeAgora = useMemo(() => {
    if (meta.kind !== 'movie') return null
    return meta.list?.find((item) => item.id === meta.currentId) ?? null
  }, [meta.kind, meta.list, meta.currentId])

  const isLegendado = (item: OverlayItem) => /\[L\]/i.test(item.name ?? '')

  /*
   * Audio escolhido nas abas Dublado/Legendado. Fica separado de `listTab`
   * porque a Continuacao e uma aba que REAPROVEITA o audio escolhido: ela
   * precisa saber dublado ou legendado sem roubar a posicao das abas. Com um
   * unico estado aparecia um segundo par de botoes embaixo (duplicado).
   */
  const [audioFiltro, setAudioFiltro] = useState<'dublado' | 'legendado'>('dublado')

  /*
   * As SAGAS da mesma franquia, ja filtradas pelo audio escolhido.
   *
   * `meta.sagas` mantem a separacao que o App fez. Sem ele (versao antiga do
   * main, ou filme sem saga) cai num bloco unico com a lista inteira, que e o
   * comportamento de antes — nunca fica vazio.
   */
  const sagaBlocos = useMemo<{ principal: boolean; filmes: OverlayItem[] }[]>(() => {
    if (meta.kind !== 'movie') return []
    const fonte =
      meta.sagas && meta.sagas.length > 0
        ? meta.sagas
        : [{ principal: true, filmes: franquiaRelacionada }]
    return fonte
      .map((s) => ({
        principal: s.principal,
        filmes: s.filmes.filter((item) => isLegendado(item) === (audioFiltro === 'legendado')),
      }))
      // Saga sem nenhum filme no audio escolhido nao tem o que mostrar.
      .filter((s) => s.filmes.length > 0)
  }, [meta.kind, meta.sagas, audioFiltro, franquiaRelacionada])

  const movieBins = useMemo<{
    todos: OverlayItem[]
    dublado: OverlayItem[]
    legendado: OverlayItem[]
    franchise: OverlayItem[]
  }>(() => {
    if (meta.kind !== 'movie') return { todos: [], dublado: [], legendado: [], franchise: [] }
    const completa = [filmeAgora, ...franquiaRelacionada].filter(
      (item): item is OverlayItem => item != null,
    )
    return {
      todos: completa,
      dublado: completa.filter((item) => !isLegendado(item)),
      legendado: completa.filter((item) => isLegendado(item)),
      franchise: sagaBlocos.flatMap((s) => s.filmes),
    }
  }, [meta.kind, meta.list, meta.currentId, sagaBlocos, filmeAgora])

  const soContinuacao = meta.kind === 'movie' && listTab === 'franquia'

  /*
   * Linhas da aba Continuacao, em BLOCOS de saga.
   *
   * O filme em reproducao fica no topo do bloco principal. A saga lateral vem
   * DEPOIS, com cabecalho: a mesma franquia pode ter duas series ("Episodio
   * I..III" e "Star Wars 2..8") e misturar as duas numa fila unica faz a
   * pessoa clicar num filme achando que e o proximo e descobrir que e de outra
   * serie. O aviso evita isso sem tirar os filmes da lista.
   */
  const sagaComAtualNoTopo = useMemo(() => {
    return sagaBlocos.map((bloco, i) => {
      const ehPrincipal = bloco.principal
      /*
       * O filme em reproducao vai no TOPO do bloco principal, marcado como
       * "Assistendo agora".
       *
       * A ordem do resto NAO muda: a saga ja vem em ordem de capitulo, e
       * puxar o filme atual para a frente descolava a sequencia. No Episodio I
       * isso colocava o Episodio III na posicao 1 e o Episodio II na 2 — a
       * lista deixava de ser a ordem da saga.
       */
      const filmes = i === 0 && ehPrincipal && filmeAgora
        ? [filmeAgora, ...bloco.filmes.filter((c) => c.id !== filmeAgora.id)]
        : bloco.filmes
      return { principal: ehPrincipal, filmes }
    })
  }, [sagaBlocos, filmeAgora])

  /*
   * A gaveta so usa os blocos com a aba Continuacao aberta; o popup de proximo
   * usa sempre. Sao o MESMO calculo — se o popup usasse uma lista diferente da
   * tela, a oferta contradiria a lista.
   */
  const continuacaoBlocos = soContinuacao ? sagaComAtualNoTopo : null

  const continuacaoItens = useMemo(
    () => continuacaoBlocos?.flatMap((b) => b.filmes) ?? null,
    [continuacaoBlocos],
  )

  /*
   * PROXIMO FILME — a oferta que a Netflix e a Crunchyroll fazem.
   *
   * Aparece sobre a barra de tempo quando falta pouco pro fim E existe um
   * proximo capitulo. So entra na reta final: mostrar antes covers o video e
   * some assim que a pessoa comeca a arrastar o tempo.
   *
   * `proximo` e o proximo da MESMA saga no MESMO audio da aba, e e o mesmo
   * criterio da aba Continuacao — as duas telas tem que oferecer o mesmo
   * proximo, senao a oferta contradiz a lista.
   */
  const proximo = useMemo(() => {
    if (meta.kind === 'series') {
      /*
       * SERIE: proximo episodio da MESMA temporada. No fim da temporada, o
       * primeiro da seguinte — e o que a pessoa espera de quem assiste em
       * sequencia. A ordem de `seriesSeasonGroups` ja vem em ordem de
       * temporada, entao "a proxima" e a seguinte na lista.
       */
      const temporadaAtual = meta.currentId ? findSeasonForEpisode(allItems, meta.currentId) : null
      if (!temporadaAtual) return null
      const naTemporada = seriesSeasonGroups.find(([s]) => s === temporadaAtual)?.[1] ?? []
      const idx = naTemporada.findIndex((item) => item.id === meta.currentId)
      if (idx >= 0) {
        const seguinte = naTemporada[idx + 1]
        if (seguinte) return seguinte
      }
      // Ultimo episodio da temporada: cai na primeira da seguinte.
      const proxTemporada = seriesSeasonGroups.find(([s]) => s !== temporadaAtual)
      return proxTemporada?.[1]?.[0] ?? null
    }

    if (meta.kind !== 'movie') return null
    /*
     * A MESMA lista que o drawer mostra (`continuacaoBlocos`), e nao
     * `sagaBlocos`: a saga exclui o filme em reproducao — ele e a referencia do
     * agrupamento — entao o `findIndex` dava sempre -1 e o popup nunca tinha o
     * que oferecer. Foi por isso que ele nao aparecia nem com 50s para o fim.
     *
     * Usar `continuacaoBlocos` tambem garante que a oferta e a lista dizem a
     * mesma coisa: o proximo do popup e a linha seguinte a que esta marcada
     * como "Assistindo agora".
     */
    const saga = sagaComAtualNoTopo[0]?.filmes ?? []
    const idx = saga.findIndex((item) => item.id === meta.currentId)
    if (idx < 0) return null
    return saga[idx + 1] ?? null
  }, [meta.kind, meta.currentId, allItems, seriesSeasonGroups, sagaComAtualNoTopo])

  const [proximoOferecido, setProximoOferecido] = useState(false)
  /*
   * A pessoa disse "agora nao". A oferta nao pode voltar sozinha: `position`
   * oscila a cada `timeupdate`, e sem esta trava a popup piscava no ar durante
   * o resto do final.
   */
  const [proximoDispensado, setProximoDispensado] = useState(false)

  // Um popup por conteudo. Trocar de filme/episodio reabre a oferta.
  useEffect(() => {
    setProximoOferecido(false)
    setProximoDispensado(false)
  }, [meta.currentId])

  /*
   * PULAR INTRO — aparece so durante o opening do episodio, por serie.
   *
   * Usa a API da AniSkip para buscar skip-times do episodio.
   * Se a API nao retornar dados, nao mostra nada.
   */
  /*
   * JANELA DE ABERTURA — decideda por DUAS fontes cruzadas.
   *
   * O problema que motivou isso: cada fonte sozinha erra de um jeito.
   *
   *   AniSkip  - sabe que o episódio TEM abertura e onde ela termina, mas o
   *              início é de outro corte do vídeo. E para série que ela ainda
   *              não indexou, responde "não tem abertura" mesmo tendo.
   *   Áudio    - ouve o arquivo e acha a música de verdade, mas erra o
   *              início em cena de diálogo forte e erra o fim em música que
   *              dá uma baixada.
   *
   * A regra usa as duas, e cada uma só pode errar para o lado seguro:
   *
   *   1. AniSkip diz que TEM abertura?
   *      - não tem: pode ser série nova no catálogo dela. Se o áudio achou
   *        música, o áudio ganha (a AniSkip só não conhece ainda).
   *      - tem: o áudio precisa concordar. Sem música no arquivo, é veto —
   *        não mostra. É o caso do Naruto Shippuden S01E01, que tem abertura
   *        anotada e não tem nenhuma.
   *   2. As duas discordam sobre ONDE a música começa (mais de 60s de
   *      diferença)? Não são a mesma música. Não mostra.
   *   3. Concordam: início vem do áudio (é mais preciso), fim vem da AniSkip
   *      (o áudio trunca a música pela metade).
   */
  const [skipTimes, setSkipTimes] = useState<SkipTimes | null>(null)
  const [aniskipConcluido, setAniskipConcluido] = useState(false)

  /*
   * Janela de skip que o usuario ja dispensou ("Agora não") ou ja pulou.
   * A chave separa intro de outro: dispensar a abertura nao pode esconder a
   * encerramento, que aparece minutos depois no mesmo episodio.
   */
  const [skipDispensado, setSkipDispensado] = useState<string | null>(null)

  useEffect(() => {
    // Episódio novo: a janela do anterior não vale mais.
    setAniskipConcluido(false)
    setSkipDispensado(null)
  }, [meta.currentId])

  useEffect(() => {
    /*
     * FILME: abertura medida pelo finder (logos/abertura). Os créditos
     * ficam na oferta de "próximo capítulo" (janelaFinal). Sem marca do
     * filme, nenhum popup — nada de chutar.
     */
    if (meta.kind === 'movie') {
      const medido = FILMES[normalizarTituloFilme(meta.title || '')]
      if (medido?.op && medido.op.end > medido.op.start + 5) {
        setSkipTimes({
          source: 'local',
          intro: { start: medido.op.start, end: medido.op.end },
          outro: null,
          len: medido.duration,
        })
      } else {
        setSkipTimes(null)
      }
      setAniskipConcluido(true)
      return
    }

    if (meta.kind !== 'series') {
      setSkipTimes(null)
      setAniskipConcluido(true)
      return
    }

    const ep = allItems.find((item) => item.id === meta.currentId)
    if (!ep) {
      setSkipTimes(null)
      setAniskipConcluido(true)
      return
    }

    const epNum = extractEpisodeNumber(ep.name)

    /*
     * `meta.seriesId` é o MyAnimeList ID resolvido pelo catálogo.
     * `ep.seriesId` é o stream_id do Xtream (ex.: 2273444) e NÃO serve para a
     * AniSkip — usar ele na frente faz toda requisição dar 404.
     */
    const malId = meta.seriesId

    if (!malId || epNum === null) {
      setSkipTimes(null)
      setAniskipConcluido(true)
      return
    }

    let cancelado = false
    void getSkipTimes(malId, epNum, extractSeasonNumber(ep.name)).then((result) => {
      if (cancelado) return
      setSkipTimes(result)
      setAniskipConcluido(true)
      setSkipDispensado(null)
    })

    return () => {
      cancelado = true
    }
  }, [meta.kind, meta.title, meta.currentId, meta.seriesId, allItems])

  /*
   * Janela de ABERTURA que cobre a posição atual.
   *
   * Regradescribed no bloco dos estados, acima. Resumindo: a AniSkip diz se
   * existe, o áudio diz ONDE começa, e o fim vem da AniSkip porque o áudio
   * trunca a música.
   *
   * Só a abertura. O encerramento foi de fora de propósito: no fim do episódio
   * a pessoa quer o próximo capítulo, e a oferta "A seguir" já ocupa aquele
   * canto da tela — ter os dois era o que empilhava dois popups.
   */
  const janelaSkip = useMemo(() => {
    if (isLive) return null
    if (!aniskipConcluido) return null

    /*
     * SÓ marcação embutida conferida (`source === 'local'`).
     *
     * A consulta remota à AniSkip foi desligada de propósito. O início dela é
     * contado a partir de outro corte do vídeo, e o cruzamento com o áudio
     * fazia o botão aparecer segundos fora do lugar. Sem dado nosso conferido
     * não aparece popup nenhum: melhor não oferecer do que pular errado.
     */
    const janela = skipTimes?.source === 'local' ? skipTimes.intro : null
    if (!janelaCobrePosicao(janela, position)) return null
    return { inicio: janela!.start, fim: janela!.end }
  }, [skipTimes, position, isLive, aniskipConcluido])

  /*
   * ENCERRAMENTO: a ação certa é IR PARA O PRÓXIMO episódio, não pular o ED.
   * Só com marcação conferida e quando a posição entra no intervalo.
   */
  const janelaEd = useMemo(() => {
    if (isLive) return null
    if (!aniskipConcluido) return null
    if (skipTimes?.source !== 'local') return null
    const ed = skipTimes.outro
    if (!ed) return null

    /*
     * Tempo ABSOLUTO do arquivo analisado.
     *
     * Cheguei a deslocar pela cauda (duração − ed_tail) para compensar
     * arquivos com outra duração, mas isso erra quando o arquivo do provedor
     * só tem um final/preview mais longo: o ED continua no mesmo instante e
     * o aviso aparecia ~75 s adiantado. O começo do arquivo é o mesmo (a OP
     * bate), então o tempo absoluto é a referência certa.
     */
    if (!janelaCobrePosicao(ed, position)) return null
    return ed
  }, [
    skipTimes,
    position,
    isLive,
    aniskipConcluido,
  ])

  /*
 * "A seguir" visível. Usado para tirar o popup de pular da frente: no fim do
 * episódio não pode haver dois convites na tela, e ir para o próximo é a ação
 * que a pessoa quer ali.
 */
const proximoVisivel =
  !isLive && proximoOferecido && proximo !== null && proximo.id !== meta.currentId

const chaveSkip = janelaSkip ? String(janelaSkip.inicio) : null
const mostrarSkip = janelaSkip !== null && chaveSkip !== skipDispensado

const chaveEd = janelaEd ? 'ed:' + String(janelaEd.start) : null
const mostrarEd = janelaEd !== null && chaveEd !== skipDispensado

/*
 * DIAGNÓSTICO do popup: registra no log o número usado e a posição real do
 * vídeo no instante em que o aviso aparece. É o que separa "meu tempo está
 * errado" de "o app está disparando na hora errada".
 */
useEffect(() => {
  if (!janelaSkip) return
  playerLog('info', 'oped', 'popup OP', {
    inicio: janelaSkip.inicio, fim: janelaSkip.fim,
    posicao: position, duration,
  })
}, [janelaSkip])

useEffect(() => {
  if (!mostrarEd || !janelaEd) return
  playerLog('info', 'oped', 'popup ED', {
    inicio: janelaEd.start, fim: janelaEd.end,
    posicao: position, duration,
  })
}, [mostrarEd, janelaEd])

  /*
   * Dispara na reta final, para filme E serie.
   *
   * A janela e `janelaFinal(duration)`, nao `SEGUNDOS_FIM`: a duracao do
   * container costuma ser maior que o conteudo (o Episodio I acaba em
   * 2:09:54 e a barra vai ate 2:16:10). Medir so em segundos deixava a oferta
   * nunca aparecendo nesses arquivos.
   *
   * Nao dispara em live: nao ha "fim" de um canal.
   */
  useEffect(() => {
    if (meta.kind !== 'movie' && meta.kind !== 'series') return
    if (!proximo || proximoDispensado) return
    if (isLive || duration <= 0) return
    const faltam = duration - position
    /*
     * ATRIBUICAO, e nao `if (...) setProximoOferecido(true)`.
     *
     * So ligar deixava a oferta grudada. Medido em Brave 10 [L]: com "Comecar"
     * clicado no fim do S01E02, a oferta reapareceu no S01E03 — o episodio
     * carregou em 00:01 e o cartao continuou na tela oferecendo o S01E04.
     *
     * A causa e a corrida do clique: `sendAction` e IPC, entao o `position` do
     * episodio VELHO (no fim, faltam ~2s) ainda valia quando o `meta` novo
     * chegou. O efeito reabriu a oferta com aquele `faltam`, e como nada nunca
     * voltava a `false`, quando a posicao zerou a oferta ficou la para sempre.
     *
     * Atribuir nos dois sentidos fecha em: quando `faltam` cresce de novo, ela
     * apaga sozinha.
     */
    /*
     * Se temos o ENCERRAMENTO medido deste episódio, o cartão "A seguir"
     * NÃO usa mais os 12% da duração: ele espera o ED começar.
     *
     * Era esse o "popup uns segundos antes": 12% de um episódio de 24 min
     * dá ~2:54 antes do fim, e o ED podia começar bem depois disso (SPY E01:
     * cartão em 21:17, ED em 21:52). Quem oferece o próximo episódio nesse
     * caso é o aviso do ED, que usa o número medido.
     */
    const edLocal = skipTimes?.source === 'local' ? skipTimes.outro : null
    if (edLocal) {
      setProximoOferecido(false)
      return
    }

    /*
     * SÉRIE: sem ED medido não existe oferta antecipada. O valor de 12% da
     * duração foi removido do app — ele disparava sem relação com o ED real.
     * FILME mantém a janela final, porque ali a duração do container mente.
     */
    if (meta.kind !== 'movie') {
      setProximoOferecido(false)
      return
    }
    setProximoOferecido(faltam <= janelaFinal(duration, 'movie', meta.title))
  }, [meta.kind, meta.title, proximo, proximoDispensado, isLive, duration, position, skipTimes])

  useEffect(() => {
    if (meta.kind !== 'movie') return
    // No filme as abas sao so a Continuacao; o audio e filtro, nao aba.
    setListTab((prev) => (prev === 'canais' || prev === 'categorias' ? 'todos' : prev))
  }, [meta.kind])

  /*
   * Itens que ficam visiveis na lista do drawer, ja aplicando o filtro de busca
   * e a aba escolhida (todos / dublado / legendado / franquia).
   */
  const drawerItems = useMemo(() => {
    if (meta.kind !== 'movie') return items
    const q = listFilter.trim().toLowerCase()
    const base = soContinuacao
      ? movieBins.franchise
      : audioFiltro === 'legendado'
        ? movieBins.legendado
        : movieBins.dublado
    if (!q) return base
    return base.filter(
      (item) => item.name?.toLowerCase().includes(q) || resolveEpisodeSeason(item).toLowerCase().includes(q),
    )
  }, [meta.kind, soContinuacao, audioFiltro, listFilter, items, movieBins])

  const showListBtn = (meta.kind === 'series' || meta.kind === 'live' || meta.kind === 'movie') && (meta.list?.length || 0) > 1

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
        skip(-10)
        return
      }
      if (key === 'ArrowRight' || key === 'Right') {
        skip(10)
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
        skip(-10)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        skip(10)
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
    /*
     * MOUSE PARADO NAO E INTERACAO.
     *
     * O `mousemove` da janela rearmava o auto-esconder inteiro (4s) a cada
     * chegada. Com `setIgnoreMouseEvents(true, { forward: true })` o Electron
     * reenvia movimento para o renderer mesmo sem o ponteiro andar, e o timer nunca
     * vencia: os controles ficavam na tela para sempre e, com eles, o cursor.
     *
     * Medido: 5s parado, `controlsVisible: true` e nenhuma transicao no log — o
     * `setControlsVisible(true)` com o valor ja `true` nao repinta, entao o defeito
     * era invisivel.
     *
     * O `e.clientX/clientY` resolve: o evento reenviado chega com a mesma posicao
     * do ultimo, e nao ha interacao nenhuma para rearmar o timer.
     */
    let ultimoX = -1
    let ultimoY = -1
    const onMove = (e: MouseEvent) => {
      if (e.clientX === ultimoX && e.clientY === ultimoY) return
      ultimoX = e.clientX
      ultimoY = e.clientY
      showControls()
    }
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
   * O HIT-TEST ABRE SEMPRE QUE O CURSOR TEM QUE SUMIR (ver `overlayHitTest`).
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
            <>
              <p className="po-loading-label">
                {bootPct === null ? 'Abrindo canal' : `Buffering ${bootPct}%`}
              </p>
              {/*
                O TEMPO CORRENDO, E O QUE SEPARA "ESPERANDO" DE "QUEBRADO".

                Medido no painel do dono: 76 canais abertos, 23 falharam. Os 23
                custam 15 s de watchdog + 15 s de fallback `.ts` = 30 s de tela
                sem dizer NADA. O dono leu isso como "bugando e a tela preta".

                O dono decidiu manter os 15 s — canal lento lento ainda abre, e
                encurtar seria trocar um defeito por outro. O que sobra e dizer
                quanto tempo ja passou. Uma pessoa esperando 6 s sabe que espera;
                uma pessoa vendo preto ha 6 s acha que o app quebrou.

                Sem este contador, o "Buffering 0%" ficava congelado no comecinho
                da tela por 30 segundos, que e pior que preto: parece travado.
              */}
              {bootPct !== null && bootSegundos > 0 && (
                <p className="po-loading-elapsed">
                  {bootSegundos < 10
                    ? `esperando há ${bootSegundos}s`
                    : `esperando há ${Math.round(bootSegundos / 10) * 10}s`}
                </p>
              )}
            </>
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
        className={`po-btn po-back${
          /*
            O dock some por DOIS motivos: o temporizador de auto-hide E o
            `booting`. So usar o temporizador deixava o voltar sozinho na tela
            durante o buffering — o "Buffering 15%" com o dock inteiro fora e o
            voltar parado no canto.
            
            Nao volta para `dockVisible`: aquele deriva de `uiVisible`, que tem
            `|| !playing`. Canal que nunca chega a tocar deixa `!playing`
            permanentemente verdadeiro, `uiVisible` trava em true e o voltar
            nunca some — que era o defeito original.
            
            Aqui e a interseccao das duas, sem `playing`: some quando o relogio
            venceu E nao esta carregando. `listOpen` e `failed` seguram porque
            sao os estados em que a pessoa PRECISA ver o voltar — gavota aberta
            ou player quebrado sem saida e beco sem saida.
          */
          (controlsVisible && !booting) || listOpen || failed ? '' : ' is-hidden'
        }`}
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

      {/*
        PULAR ABERTURA / ENCERRAMENTO.

        Fica FORA do `.po-dock` porque o dock tem `opacity: 0` quando os
        controles somem, e o botão precisa ficar à vista durante a música de
        abertura com o vídeo limpo — como no Netflix e na Crunchyroll. Dentro
        do dock ele só aparecia com os controles visíveis, que era o defeito.

        Só aparece quando a AniSkip devolveu o intervalo DESTE episódio: sem
        dado, nada é mostrado e nada é adivinhado.
      */}
      {/*
        "A seguir" tem prioridade sobre "pular encerramento".

        Os dois aparecem na mesma região do vídeo — o encerramento fica nos
        últimos minutos e a oferta do próximo episódio nos últimos segundos — e
        antes apareciam empilhados, com dois "Agora não / Pular" no mesmo canto.
        No fim do episódio a ação certa é ir para o próximo, então a oferta
        ganha e a de pular só reaparece se a pessoa dispensar a primeira.
      */}
      {!isLive && mostrarSkip && janelaSkip && !proximoVisivel && (
        <div className="po-skip-slot" onClick={(e) => e.stopPropagation()}>
          <div
            className="po-proximo"
            role="dialog"
            aria-label="Pular abertura"
          >
            <span className="po-proximo-label">Pular abertura</span>
            <span className="po-proximo-titulo">Salta para {formatTime(janelaSkip.fim)}</span>
            <div className="po-proximo-acoes">
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-ghost"
                onClick={() => {
                  // Esconde só esta janela; a do outro tipo continua válida.
                  if (chaveSkip) setSkipDispensado(chaveSkip)
                }}
              >
                Agora não
              </button>
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-primary"
                onClick={() => {
                  const fim = janelaSkip.fim
                  if (chaveSkip) setSkipDispensado(chaveSkip)
                  showControls()
                  void window.sturplay?.player?.sendOverlayAction?.({ type: 'seek', value: fim })
                }}
              >
                Pular
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        ENCERRAMENTO -> PRÓXIMO EPISÓDIO.

        O pedido é não "pular o ED": no encerramento a pessoa quer o próximo
        capítulo. Mesma ação do cartão "A seguir", mas disparada quando o
        encerramento começa (e só quando existe intervalo conhecido).
      */}
      {!isLive && mostrarEd && janelaEd && !proximoVisivel && proximo && (
        <div className="po-skip-slot" onClick={(e) => e.stopPropagation()}>
          <div className="po-proximo" role="dialog" aria-label="Próximo episódio">
            <span className="po-proximo-label">Encerramento</span>
            <span className="po-proximo-titulo">{proximo.name}</span>
            <div className="po-proximo-acoes">
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-ghost"
                onClick={() => {
                  if (chaveEd) setSkipDispensado(chaveEd)
                  showControls()
                }}
              >
                Agora não
              </button>
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-primary"
                onClick={() => {
                  const id = proximo.id
                  if (chaveEd) setSkipDispensado(chaveEd)
                  setProximoOferecido(false)
                  setProximoDispensado(true)
                  sendAction({ type: 'select', id })
                }}
              >
                Próximo episódio
              </button>
            </div>
          </div>
        </div>
      )}

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
        {/*
          PROXIMO CAPITULO — vale para FILME (proximo da saga) e SERIE
          (proximo episodio, ou o primeiro da temporada seguinte).

          Fica ACIMA da faixa de tempo, e nao dentro dela: sobrepor o trilho
          esconderia o tempo que resta, que e justamente o dado que a pessoa
          precisa para decidir.
        */}
        {/*
          PROXIMO CAPITULO e o popup de PULAR ficam em slots diferentes.

          O de pular vai para `.po-skip-slot`, fora do dock, porque precisa
          sobreviver ao sumico dos controles. O de proximo fica aqui, dentro
          do dock, porque so interessa quando a pessoa estapilando as
          informacoes do episodio seguinte.
        */}
        {proximoVisivel && proximo && (
          <div className="po-proximo" role="dialog" aria-label="Próximo">
            {/*
              CAPA DO PROXIMO. Sem ela a oferta e so uma faixa de texto e nao se
              reconhece o episodio seguinte; a arte e o que faz a pessoa bater o
              olho e decidir. Se a capa faltar, o espaco nao e reservado e a
              oferta encolhe para o texto.
            */}
            {proximo.logo ? (
              <span className="po-proximo-capa" aria-hidden>
                <img
                  src={coverSrc(proximo.logo)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={(e) => {
                    e.currentTarget.closest('.po-proximo-capa')?.remove()
                  }}
                />
              </span>
            ) : null}
            <div className="po-proximo-info">
              <span className="po-proximo-label">A seguir</span>
              <span className="po-proximo-titulo">{proximo.name}</span>
            </div>
            <div className="po-proximo-acoes">
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-ghost"
                onClick={() => {
                  setProximoOferecido(false)
                  // Trava a oferta: sem isso ela volta no proximo timeupdate.
                  setProximoDispensado(true)
                  showControls()
                }}
              >
                Agora não
              </button>
              <button
                type="button"
                className="po-proximo-btn po-proximo-btn-primary"
                onClick={() => {
                  sendAction({ type: 'select', id: proximo.id })
                  /*
                   * `proximoDispensado` tambem, e nao so `proximoOferecido`.
                   *
                   * `sendAction` e IPC: o `meta` com o `currentId` novo chega
                   * depois. Entre o clique e a troca, `position` ainda e o do
                   * episodio velho — no fim — e o efeito de oferta lia isso como
                   * "esta acabando" e religava o cartao. A trava sobe no clique e
                   * o reset (que roda em `meta.currentId`) limpa junto: o
                   * episodio novo nasce com a oferta livre para o FIM DELE.
                   */
                  setProximoOferecido(false)
                  setProximoDispensado(true)
                  showControls()
                }}
              >
                Começar
              </button>
            </div>
          </div>
        )}

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
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                if (!r.width) return
                const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
                setHoverPos(pct * duration)
                setPreviewX(Math.min(window.innerWidth - 96, Math.max(96, e.clientX)))
                setPreviewTop(r.top - 8)
              }}
              onPointerLeave={() => setHoverPos(null)}
            >
              <input
                type="range"
                className="po-seek"
                min={0}
                max={duration}
                step={1}
                value={Math.min(position, duration)}
                onChange={(e) => {
                  /*
                   * ARRASTE: só move o mostrador. NAO busca durante o arrasto.
                   *
                   * A ideia era buscar ao vivo (o video acompanhando o cursor),
                   * e foi o que medi. Resultado: RUIM.
                   *
                   * A origem (`gmaster1.shop`) nao responde a range request —
                   * devolve 200 OK com o arquivo inteiro em vez de 206 Partial
                   * Content. Entao nao existe "pular para o byte X": o mpv
                   * relê do comeco. Cada seek do arrasto (oito por segundo)
                   * invalida a posicao de leitura, e o demuxer volta para o
                   * inicio do arquivo a cada um.
                   *
                   * Medido no app: com o arraste ao vivo, a posicao ficou 5,8 s
                   * parada e a imagem travada. Sem buscar durante o arrasto, o
                   * video continua tocando normalmente enquanto a pessoa
                   * arrasta — e so existe UM salto, no fim.
                   *
                   * Quem resolve o salto e o motor, com o seek rapido
                   * (`mode: 'scrub'`), que para no keyframe mais proximo em
                   * vez de decodificar ate o quadro exato.
                   */
                  // Novo arraste: a guarda do `finishScrub` volta a valer.
                  scrubConcluidoRef.current = false
                  setScrubPos(Number(e.target.value))
                }}
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
              <IconBtn title="Voltar 10s" onClick={(e) => { e.stopPropagation(); skip(-10) }}>
                <Seek10Icon dir="back" />
              </IconBtn>
              <IconBtn title="Avançar 10s" onClick={(e) => { e.stopPropagation(); skip(10) }}>
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

          {/*
           * O ciclo e o mesmo do renderer principal: `fit -> fill -> wide`.
           * O icone muda no terceiro clique para dizer "esticar", que e o
           * unico modo que perde a proporcao da imagem.
           *
           * Aparece no live tambem: o dono abre canal ao vivo em janela
           * often e o corte/panscan dele e por canal, nao por tipo de conteudo.
           * A chave e a mesma nos dois players, entao alternar aqui vale la.
           */}
          <IconBtn
            title={aspectHint(aspect)}
            onClick={(e) => { e.stopPropagation(); applyAspect(nextAspect(aspect)) }}
          >
            {aspect === 'wide' ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <path d="M6 2v4a2 2 0 0 1-2 2H2M18 2v4a2 2 0 0 0 2 2h2M6 22v-4a2 2 0 0 0-2-2H2M18 22v-4a2 2 0 0 1 2-2h2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </IconBtn>

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
            <strong>
              {meta.kind === 'series'
                ? 'Episódios'
                : meta.kind === 'live'
                  ? 'AO VIVO'
                  : listTab === 'franquia'
                    ? 'Continuacao'
                    : 'Lista'}
            </strong>
            <button type="button" className="po-btn ghost" onClick={() => setListOpen(false)} aria-label="Fechar">
              <X size={14} />
            </button>
          </div>
          {/*
            Abas da gavota, por tipo de conteudo.

            LIVE/FILME -> Categorias | Canais. SERIE -> Temporadas | Episodios.

            Serie tem grupo de serie, nao categoria de canal, entao "Categorias"
            ali seria sempre a mesma linha. E o que a pessoa precisa ver em serie
            sao as temporadas — que antes so existiam num `<select>` solto acima
            do filtro, sem contagem e sem a mesma leitura das abas.

            As duas listas sao IRMÃS: escolher uma temporada joga para Episodios,
            que é a aba que mostra o conteudo dela.
          */}
          {(meta.kind === 'series' ? seriesSeasonGroups.length > 0 : drawerCategorias.length > 1) && (
            <div className="po-drawer-tabs">
              {meta.kind === 'series' ? (
                <>
                  <button
                    type="button"
                    className={listTab === 'temporadas' ? 'active' : ''}
                    onClick={() => setListTab('temporadas')}
                  >
                    Temporadas
                  </button>
                  <button
                    type="button"
                    className={listTab === 'episodios' ? 'active' : ''}
                    onClick={() => setListTab('episodios')}
                  >
                    Episódios
                  </button>
                </>
              ) : meta.kind === 'movie' ? (
                <>
                  {/*
                    Dublado/Legendado aqui sao o AUDIO, nao abas: um so pode
                    estar marcado. Eles filtram a lista e valem tambem para a
                    Continuacao. Antes eram abas concorrentes com a Continuacao
                    e o drawer mostrava "Todos|Dublado|Legendado|Continuacao"
                    mais um segundo par Dublado|Legendado embaixo.
                  */}
                  <button
                    type="button"
                    className={audioFiltro === 'dublado' ? 'active' : ''}
                    onClick={() => setAudioFiltro('dublado')}
                  >
                    Dublado
                  </button>
                  <button
                    type="button"
                    className={audioFiltro === 'legendado' ? 'active' : ''}
                    onClick={() => setAudioFiltro('legendado')}
                  >
                    Legendado
                  </button>
                  {movieBins.franchise.length > 0 && (
                    <button
                      type="button"
                      className={soContinuacao ? 'active' : ''}
                      onClick={() => setListTab(soContinuacao ? 'todos' : 'franquia')}
                    >
                      Continuação
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={listTab === 'categorias' ? 'active' : ''}
                    onClick={() => setListTab('categorias')}
                  >
                    Categorias
                  </button>
                  <button
                    type="button"
                    className={listTab === 'canais' ? 'active' : ''}
                    onClick={() => setListTab('canais')}
                  >
                    Canais
                  </button>
                </>
              )}
            </div>
          )}
          {/* Aba TEMPORADAS: a lista de temporadas com contagem, no mesmo visual da lista de categorias. */}
          {meta.kind === 'series' && listTab === 'temporadas' && (
            <div className="po-drawer-list">
              {seriesSeasonGroups.map(([season, episodes]) => {
                const ativa = (listSeason || seriesSeasonGroups[0]?.[0]) === season
                return (
                  <button
                    key={season}
                    type="button"
                    className={`po-drawer-category${ativa ? ' active' : ''}`}
                    onClick={() => {
                      setListSeason(season)
                      setListTab('episodios')
                      showControls()
                    }}
                  >
                    <span className="po-drawer-category-name">{formatSeasonOptionLabel(season, episodes.length)}</span>
                    <span className="po-drawer-category-count">{episodes.length}</span>
                  </button>
                )
              })}
            </div>
          )}
          {/* Serie nao tem grupo para filtrar: o chip de categoria e so de live. */}
          {meta.kind === 'live' && drawerCategoria && listTab === 'canais' && (
            <div className="po-drawer-chiprow">
              <button
                type="button"
                className="po-drawer-chip is-on"
                onClick={() => setDrawerCategoria(null)}
                title="Limpar filtro de categoria"
              >
                {drawerCategoria}
                <X size={12} />
              </button>
            </div>
          )}
          <input
            className="po-drawer-search"
            placeholder="Filtrar canais…"
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
          />
          {meta.kind === 'live' && listTab === 'categorias' && (
            <div className="po-drawer-list">
              {drawerCategorias.map(([group, count]) => (
                <button
                  key={group}
                  type="button"
                  className={`po-drawer-category${drawerCategoria === group ? ' active' : ''}`}
                  onClick={() => {
                    setDrawerCategoria(group)
                    setListTab('canais')
                    showControls()
                  }}
                >
                  <span className="po-drawer-category-name">{group}</span>
                  <span className="po-drawer-category-count">{count}</span>
                </button>
              ))}
            </div>
          )}
          <div
            className="po-drawer-list"
            /*
             * `hidden` nao servia aqui: o atributo vem do stylesheet do agente do
             * usuario como `[hidden] { display: none }`, e a regra de autor
             * `.po-drawer-list { display: flex }` tem a MESMA especificidade e
             * vence por cascade. Resultado: aba "Categorias" marcada, categorias
             * na tela e a lista de canais COLADA embaixo, sem sumir.
             *
             * Render condicional nao sofre disso: nao existe elemento, nao ha
             * regra que possa mantê-lo.
             */
            style={
              (meta.kind !== 'series' && listTab === 'categorias') ||
              (meta.kind === 'series' && listTab === 'temporadas')
                ? { display: 'none' }
                : undefined
            }
          >
            {/*
              Em filme na aba Continuacao, mostra o filme em reproducao no topo
              ("Assistindo agora") seguido dos demais, em BLOCOS DE SAGA. Cada
              saga lateral ganha um cabecalho que avisa que e outra serie.
              Nas outras abas/outros conteudos usa drawerItems (dublado/
              legendado ou categorias/canais/temporadas/episodios).
            */}
            {(continuacaoBlocos ?? [null]).map((bloco, blocoIdx) => {
              const linhas = bloco ? bloco.filmes : drawerItems
              return (
                <div className="po-drawer-saga" key={bloco ? `saga-${blocoIdx}` : 'lista'}>
                {/*
                  AVISO DE SAGA. Aparece so na saga lateral, que e outra serie
                  da mesma franquia: sem ele a pessoa clica achando que e o
                  proximo capitulo e sobe um filme de outra serie.
                */}
                {bloco && !bloco.principal && (
                  <p className="po-drawer-saga-aviso">
                    Outra saga desta franquia — não é a continuação destes filmes
                  </p>
                )}
                {linhas.map((item, idx) => {
              const ativo = item.id === meta.currentId
              const favorito = favoritos.has(item.id)
              const ehAGora =
                meta.kind === 'movie' &&
                listTab === 'franquia' &&
                !!filmeAgora &&
                item.id === filmeAgora.id
              return (
                <div
                  key={item.id}
                  className={`po-drawer-row${ativo ? ' active' : ''}${ehAGora ? ' po-drawer-agora' : ''}`}
                >
                  <button
                    type="button"
                    className="po-drawer-item"
                    onClick={() => {
                      sendAction({ type: 'select', id: item.id })
                      setListOpen(false)
                      showControls()
                    }}
                    disabled={ehAGora}
                  >
                    <span className="po-drawer-idx">{ehAGora ? '—' : idx + 1}</span>
                    <span className="po-drawer-logo" aria-hidden>
                      {item.logo ? (
                        <img
                          src={coverSrc(item.logo)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                          /*
                           * Capa que falha nao deixa o icone de imagem
                           * quebrada do navegador na linha. Varios titulos do
                           * catalogo apontam para capa morta no painel; o
                           * quadrado de 32px fica vazio, que e o que se espera
                           * de um titulo sem arte.
                           */
                          onError={(e) => {
                            e.currentTarget.style.visibility = 'hidden'
                          }}
                        />
                      ) : null}
                    </span>
                    <span className="po-drawer-name">{item.name}</span>
                    {ehAGora && <span className="po-drawer-now">Assistindo agora</span>}
                  </button>
                  {/*
                    O coracao e um botao SEPARADO da linha, e nao dentro dela.
                    Dentro, clicar no coracao dispararia tambem o `select` — o
                    favorito piscaria e o canal trocaria junto, que e o opposite
                    do que se espera de um botao de favorito.
                  */}
                  <button
                    type="button"
                    className={`po-drawer-fav${favorito ? ' is-on' : ''}`}
                    aria-label={favorito ? 'Remover dos favoritos' : 'Favoritar'}
                    title={favorito ? 'Remover dos favoritos' : 'Favoritar'}
                    onClick={(e) => {
                      e.stopPropagation()
                      sendAction({ type: 'toggle-favorite', id: item.id })
                      showControls()
                    }}
                  >
                    <Heart
                      size={14}
                      fill={favorito ? 'currentColor' : 'none'}
                      strokeWidth={2.1}
                    />
                  </button>
                </div>
              )
            })}
                </div>
              )
            })}
          </div>
          {/*
            Rodape com a contagem e o "Fechar", como na gavota do motor nativo.
            Sem a contagem nao ha leitura de "o filtro cortou isto de 200 para 12"
            — a lista encurta em silencio e a pessoa conclui que o canal sumiu.
          */}
          <div className="po-drawer-foot">
            <span>
              {/*
                O rodape conta O QUE ESTA NA TELA, como na gavota do motor
                nativo. Fixo em "canais" ele escrevia "400 canais" com a lista
                de categorias na frente — uma contagem que nao corresponde a nada
                que a pessoa estivesse vendo.
              */}
              {meta.kind === 'movie'
                ? listTab === 'franquia'
                  ? `${Math.max(0, (continuacaoItens?.length ?? 1) - 1)} continuaçoes`
                  : `${drawerItems.length} filmes`
                : listTab === 'categorias'
                  ? `${drawerCategorias.length} categorias`
                  : listTab === 'temporadas'
                    ? `${seriesSeasonGroups.length} temporadas`
                    : `${items.length} ${meta.kind === 'series' ? 'episódios' : 'canais'}`}
            </span>
            <button type="button" className="po-drawer-close-text" onClick={() => setListOpen(false)}>
              Fechar
            </button>
          </div>
        </aside>
      )}

      {/*
        PRÉVIA DA BARRA fica FORA do `.po-dock`.

        O dock tem `overflow: hidden` (para o conteúdo não vazar quando a janela
        é menor que ele), e isso cortava a miniatura no teto. Como elemento
        `position: fixed` no root — que cobre o vídeo inteiro — ela cabe acima
        da barra sem depender do recorte do dock.
      */}
      {posPreview !== null && (
        <div className="po-scrub-preview" style={{ left: previewX, top: previewTop }}>
          <span className="po-scrub-time">{formatTime(posPreview)}</span>
        </div>
      )}
    </div>
  )
}
