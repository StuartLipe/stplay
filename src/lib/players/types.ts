export type PlayerEngine = 'internal' | 'libmpv' | 'mpv' | 'mpv-one' | 'stur' | 'mpeg' | 'vlc' | 'mpc'

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
  /**
   * Como a imagem ocupa a area do player. Vai no `start` porque o mpv resolve
   * `wide` na flag de spawn (`keepaspect`) e `fit`/`fill` na propriedade
   * `panscan` — quem decide e o motor, nao o CSS.
   */
  aspect?: VideoFit
}

/**
 * Ajuste da imagem dentro da area do player.
 *
 *   fit   - a imagem inteira cabe; sobram tarjas pretas.
 *   fill  - preenche cortando a borda da imagem; sem tarja, sem distorcao.
 *   wide  - preenche esticando; a imagem perde a proporcao.
 *
 * O historico era `fit` fixo, sem estado e sem botao: o `<video>` recebia
 * `object-fit: contain` pelo CSS e o mpv, que nao tem `<video>`, mantinha o
 * padrao dele de preservar proporcao. Nos dois motores a tarja era inevitavel.
 * `fill` e o padrao agora porque e o que a TV entrega do mesmo canal — janela
 * 16:9 com fonte 16:9 nao gera tarja, e no PC a janela nunca e exatamente o
 * aspecto da fonte.
 */
export type VideoFit = 'fit' | 'fill' | 'wide'

export type PlayerCommand =
  | { op: 'pause' }
  | { op: 'play' }
  | { op: 'toggle' }
  /**
   * `relative: true` = "anda X SEGUNDOS a partir de onde o video esta".
   *
   * Nao e detalhe. O caminho antigo mandava `absolute` com um instante calculado
   * no renderer (`currentTime + 10`), e esse `currentTime` chega por `timeupdate`
   * — uma leitura atrasada em relacao ao mpv. Atraso de meio segundo numa seta
   * para frente vira seek para TRAS, e no mpv seek para tras descarta o buffer e
   * volta a rede: e exatamente a travada de "o filme nao carregou".
   *
   * Relativo nao tem esse problema por construcao: o motor aplica a partir da
   * posicao real dele, que e a unica que importa.
   */
  | { op: 'seek'; seconds: number; relative?: boolean }
  | { op: 'volume'; value: number }
  | { op: 'mute'; value: boolean }
  | { op: 'aspect'; mode: VideoFit }

export type PlayerEvent =
  | { type: 'ready' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'timeupdate'; current: number }
  | { type: 'duration'; value: number }
  | { type: 'ended' }
  | {
      type: 'buffering'
      value: boolean
      percent?: number
      /**
       * Veredito da sondagem de VOD. `'indisponivel'` = o painel respondeu que
       * nao tem o arquivo, e o `percent` a partir dai e curva de relogio, nao
       * progresso - a UI tem que mostrar o texto em vez do numero.
       */
      motivo?: 'indisponivel'
      retry?: number
      of?: number
    }
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
 * Qual motor primeiro, por conteudo. Consumido por `playerManager.ts`.
 *
 * LIVE: interno (hls.js) primeiro. VOD: STUR (mpv) primeiro.
 *
 * O sintoma e a diferenca entre os dois motores, medida no mesmo canal:
 *
 *   player interno (hls.js/MSE) : toca, sem travar
 *   STUR (mpv embutido)         : congela
 *
 * A CAUSA e do lado da fonte: o painel nao publica HLS canonico — cada pedido
 * da uma janela nova de segmentos, e o demuxer do ffmpeg identifica segmento
 * por NUMERO DE SEQUENCIA, para de buscar depois de 25s e congela. A medicao
 * completa (24 pedidos, o time-pos parado, e os 361s do normalizador sem
 * congelar) esta no modulo que DONA da decisao: `live-load-policy.cjs`. Leia
 * aquele arquivo antes de mexer na ordem destes motores.
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
