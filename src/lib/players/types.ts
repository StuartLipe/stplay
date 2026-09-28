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

/** Auto: interno primeiro; STUR se falhar (app desktop). */
export const AUTO_CHAIN_LIVE: PlayerEngine[] = ['stur', 'internal']
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
