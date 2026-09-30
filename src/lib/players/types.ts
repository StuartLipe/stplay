export type PlayerEngine = 'internal' | 'libmpv' | 'mpv' | 'mpv-one' | 'stur' | 'vlc' | 'mpc'

export type VideoRect = {
  x: number
  y: number
  width: number
  height: number
}

export type PlayerStartOptions = {
  url: string
  live?: boolean
  heavy?: boolean
  startTime?: number
  bounds?: VideoRect
  referer?: string
}

export type PlayerCommand =
  | { op: 'pause' }
  | { op: 'play' }
  | { op: 'toggle' }
  | { op: 'seek'; seconds: number }
  | { op: 'volume'; value: number }
  | { op: 'mute'; value: boolean }

export type PlayerEvent =
  | { type: 'ready' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'timeupdate'; current: number }
  | { type: 'duration'; value: number }
  | { type: 'ended' }
  | { type: 'buffering'; value: boolean; percent?: number }
  | { type: 'preview' }
  | { type: 'failed'; reason: string }
  | { type: 'tracks'; audio?: unknown[]; subs?: unknown[] }

export interface PlayerBackend {
  readonly id: PlayerEngine
  readonly embedded: boolean
  isAvailable(): Promise<boolean>
  start(opts: PlayerStartOptions): Promise<void | boolean>
  stop(): Promise<void>
  command(cmd: PlayerCommand): Promise<void>
  onEvent(cb: (event: PlayerEvent) => void): () => void
}

/**
 * Qual motor primeiro, por conteudo.
 *
 * Este arquivo dizia "Auto: interno primeiro" e fazia o contrario: as duas
 * cadeias comecavam em stur. O comentario estava certo e o codigo errado, e o
 * efeito era que o modo auto nunca chegava no motor que funciona.
 *
 * LIVE: interno (hls.js) primeiro.
 *
 * O sintoma e a diferenca entre os dois motores, medida no mesmo canal:
 *
 *   player interno (hls.js/MSE) : toca, sem travar
 *   STUR (mpv embutido)         : congela
 *
 * A CAUSA, e ela e do lado da fonte: o painel nao publica HLS canonico. Medido
 * em 24 pedidos do mesmo canal a cada 1,5s — 24 conjuntos de URL distintos, e
 * 0 de 23 respostas consecutivas compartilhando um unico segmento. A sequencia
 * avanca (~1 a cada 10s, batendo com TARGETDURATION=11) mas nao identifica
 * nada.
 *
 * O hls.js identifica segmento por URL: so pergunta "qual URL eu ainda nao
 * tenho", entao uma janela recem-mintada a cada pedido e inofensiva. O demuxer
 * HLS do ffmpeg identifica pelo NUMERO DE SEQUENCIA, mantem contabilidade de
 * janela deslizante, e acredita que ja baixou os numeros que ja viu — entao
 * para de buscar. Medido no mpv, sem o app:
 *
 *   t=0    time-pos 48.07   demuxer-cache-time 56.30
 *   t=14   time-pos 60.05   demuxer-cache-time 59.97
 *   t=16   time-pos 60.05   demuxer-cache-time 59.97   <- PARA
 *   CONGELOU em 25s, buffer 100%
 *
 * Nao e apresentacao nem VO nem janela: o playhead para exatamente no fim de
 * um cache que deixou de crescer. A bisseccao congelou tambem na variante mais
 * crua, sem nenhum comportamento do app.
 *
 * O STUR sobe pelo normalizador de playlist (ver `hls-window.cjs` e
 * `hls-normalizer.cjs`), que entrega manifesto canonico ao mpv. Medido com ele:
 * 361s continuos, congelou: NAO.
 *
 * E e a politica do player popular de Windows (IPTVnator, Electron): tres
 * motores web (hls.js, Video.js, ArtPlayer) por padrao, e o mpv so quando o
 * navegador nao decodifica. O mpv EMBUTIDO la e experimental e opt-in.
 *
 * VOD: STUR primeiro. Progressivo em mp4, e decodificacao nativa com hwdec e
 * seek robusto valem mais que MSE, e nao ha relato de problema em VOD — a
 * playlist de VOD e um arquivo, nao a janela nao-canonica que quebrava o live.
 */
export const AUTO_CHAIN_LIVE: PlayerEngine[] = ['internal', 'stur']
export const AUTO_CHAIN_VOD: PlayerEngine[] = ['stur', 'internal']
export const AUTO_CHAIN: PlayerEngine[] = AUTO_CHAIN_LIVE

export function autoChainFor(live?: boolean): PlayerEngine[] {
  return live ? AUTO_CHAIN_LIVE : AUTO_CHAIN_VOD
}

export const PLAYER_READY_TIMEOUT_MS = 8000

export const ENGINE_READY_TIMEOUT_MS: Partial<Record<PlayerEngine, number>> = {
  internal: 14_000,
  mpv: 18_000,
  'mpv-one': 45_000,
  stur: 45_000,
  libmpv: 15_000,
}

/** No modo auto, interno falha rápido em live (não segura MPEG-TS). */
export const AUTO_LIVE_INTERNAL_MS = 5_000
