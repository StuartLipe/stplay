import type { PlaybackEngine } from '../../types'
import { createInternalPlayer } from './internalPlayer'
import { createLibmpvPlayer } from './libmpvPlayer'
import { createMpvExePlayer } from './mpvExePlayer'
import { createMpvOnePlayer } from './mpvOnePlayer'
import { createSturPlayer } from './sturPlayer'
import { createVlcPlayer } from './vlcPlayer'
import { createMpcPlayer } from './mpcPlayer'
import { playerLog } from './playerLogger'
import { syncOverlayBounds, watchVideoBounds, stopWatchingVideoBounds } from './overlayBridge'
import type { PlayerBackend, PlayerEngine, PlayerEvent, PlayerStartOptions, VideoRect } from './types'
import {
  AUTO_LIVE_INTERNAL_MS,
  ENGINE_READY_TIMEOUT_MS,
  PLAYER_READY_TIMEOUT_MS,
  autoChainFor,
} from './types'
import { canHotReloadStur } from './retryPlayback'

export type PlayerManagerOptions = {
  getVideo: () => HTMLVideoElement | null
  getBoundsElement: () => HTMLElement | null
  onEngineChange?: (engine: PlayerEngine | null) => void
  onEvent?: (event: PlayerEvent) => void
  silent?: boolean
}

const factories: Record<PlayerEngine, () => PlayerBackend> = {
  internal: () => createInternalPlayer(() => null),
  libmpv: createLibmpvPlayer,
  mpv: createMpvExePlayer,
  'mpv-one': createMpvOnePlayer,
  stur: createSturPlayer,
  vlc: createVlcPlayer,
  mpc: createMpcPlayer,
}

export class PlayerManager {
  private active: PlayerBackend | null = null
  private activeEngine: PlayerEngine | null = null
  private unsub: (() => void) | undefined
  private stopBounds: (() => void) | undefined
  private readyTimer = 0
  private cancelled = false
  /** Invalida play() antigo quando o usuário troca canal rápido. */
  private playGen = 0
  /** Após failed, mpv pode já ter sido morto — retry faz restart completo. */
  private failedSinceStart = false
  private opts: PlayerManagerOptions

  constructor(opts: PlayerManagerOptions) {
    this.opts = opts
    factories.internal = () => createInternalPlayer(opts.getVideo)
  }

  private emit(event: PlayerEvent) {
    this.opts.onEvent?.(event)
  }

  private clearReadyTimer() {
    window.clearTimeout(this.readyTimer)
    this.readyTimer = 0
  }

  private async stopCurrent() {
    this.clearReadyTimer()
    this.unsub?.()
    this.unsub = undefined
    this.stopBounds?.()
    this.stopBounds = undefined
    stopWatchingVideoBounds()
    const wasNative = this.activeEngine === 'libmpv' || this.activeEngine === 'mpv' || this.activeEngine === 'mpv-one' || this.activeEngine === 'stur'
    if (this.active) {
      try {
        await this.active.stop()
      } catch {
        // ignore
      }
    }
    this.active = null
    this.activeEngine = null
    this.opts.onEngineChange?.(null)
    if (wasNative) await window.sturplay?.player?.stop?.()
  }

  /** Preview ao vivo: solta listeners sem matar mpv (evita freeze ao trocar grupo). */
  release() {
    this.playGen += 1
    this.cancelled = true
    this.clearReadyTimer()
    this.unsub?.()
    this.unsub = undefined
    this.stopBounds?.()
    this.stopBounds = undefined
    stopWatchingVideoBounds()
    this.active = null
    this.activeEngine = null
  }

  private waitReady(backend: PlayerBackend, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        this.clearReadyTimer()
        resolve(ok)
      }
      const off = backend.onEvent((event) => {
        if (event.type === 'ready' || event.type === 'playing') finish(true)
        if (event.type === 'failed') finish(false)
        if (event.type === 'ended' && (backend.id === 'vlc' || backend.id === 'mpc')) finish(true)
      })
      this.readyTimer = window.setTimeout(() => {
        off()
        finish(false)
      }, timeoutMs)
    })
  }

  private bindBounds(embedded: boolean) {
    if (!embedded) return
    const el = this.opts.getBoundsElement()
    if (!el) return
    this.stopBounds = watchVideoBounds(el, (rect) => {
      void syncOverlayBounds(rect)
    })
    const rect = el.getBoundingClientRect()
    if (rect.width >= 32) {
      void syncOverlayBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
  }

  /** Corre backend.start contra o orçamento de timeout; 'timeout' se estourar. */
  private raceStart(backend: PlayerBackend, opts: PlayerStartOptions, budgetMs: number): Promise<boolean | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budgetMs)
    })
    const start = Promise.resolve(backend.start(opts)).then((value) => value !== false)
    return Promise.race([start, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  private readyTimeoutMs(engine: PlayerEngine, startOpts: PlayerStartOptions, auto: boolean): number {
    if (auto && startOpts.live && engine === 'internal') return AUTO_LIVE_INTERNAL_MS
    if (startOpts.live) return 30_000
    return ENGINE_READY_TIMEOUT_MS[engine] ?? PLAYER_READY_TIMEOUT_MS
  }

  private async tryEngine(
    engine: PlayerEngine,
    startOpts: PlayerStartOptions,
    auto: boolean,
    playGen: number,
  ): Promise<boolean> {
    const backend = factories[engine]()
    const available = await backend.isAvailable()
    if (!available) {
      playerLog('info', 'manager', 'skip unavailable', { engine })
      if (!auto && !this.opts.silent) {
        const needsDesktop = engine === 'stur' || engine === 'mpv-one' || engine === 'mpv' || engine === 'libmpv'
        const reason = needsDesktop
          ? `${engine === 'stur' ? 'STUR' : engine} só funciona no app ST PLAY (.exe), não no navegador`
          : `Player ${engine} não disponível neste ambiente`
        this.emit({ type: 'failed', reason })
      }
      return false
    }

    this.active = backend
    this.activeEngine = engine
    this.opts.onEngineChange?.(engine)

    let resolved = false
    let failedReason: string | null = null
    this.unsub = backend.onEvent((event) => {
      if (playGen !== this.playGen) return
      this.emit(event)
      if (event.type === 'ready' || event.type === 'playing') {
        resolved = true
        this.failedSinceStart = false
      }
      if (event.type === 'failed' && event.reason) {
        failedReason = event.reason
        this.failedSinceStart = true
      }
    })

    const boundsEl = this.opts.getBoundsElement()
    const rect = boundsEl?.getBoundingClientRect()
    const bounds: VideoRect | undefined =
      rect && rect.width >= 32
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : startOpts.bounds

    playerLog('info', 'manager', 'trying', { engine, live: startOpts.live })
    // Race: start() travado (ex.: resolveRedirectUrl sem timeout) não pode pendurar o manager.
    const startBudget = this.readyTimeoutMs(engine, startOpts, auto)
    try {
      const started = await this.raceStart(backend, { ...startOpts, bounds }, startBudget)
      if (playGen !== this.playGen) return false
      if (started === 'timeout') {
        playerLog('warn', 'manager', 'start timed out', { engine, startBudget })
        if (!failedReason && !auto && !this.opts.silent) {
          this.emit({ type: 'failed', reason: `Tempo esgotado ao iniciar o player ${engine}` })
        }
        if (playGen === this.playGen) await this.stopCurrent()
        return false
      }
      if (started === false) {
        playerLog('warn', 'manager', 'start rejected', { engine })
        if (!failedReason && !auto && !this.opts.silent) {
          this.emit({ type: 'failed', reason: `Falha ao iniciar o player ${engine}` })
        }
        if (playGen === this.playGen) await this.stopCurrent()
        return false
      }
    } catch (error) {
      playerLog('warn', 'manager', 'start threw', { engine, error })
      if (!auto && !this.opts.silent) {
        this.emit({
          type: 'failed',
          reason: error instanceof Error ? error.message : `Falha ao iniciar o player ${engine}`,
        })
      }
      if (playGen === this.playGen) await this.stopCurrent()
      return false
    }

    if (backend.embedded && (engine === 'libmpv' || engine === 'mpv' || engine === 'mpv-one' || engine === 'stur')) this.bindBounds(true)

    if (resolved) {
      playerLog('info', 'manager', 'success (early)', { engine })
      return true
    }

    const ok = await this.waitReady(backend, this.readyTimeoutMs(engine, startOpts, auto))
    if (playGen !== this.playGen) return false
    if (!ok) {
      playerLog('warn', 'manager', 'timeout/failed', { engine })
      if (!failedReason && !auto && !this.opts.silent) {
        this.emit({ type: 'failed', reason: `O player ${engine} demorou para iniciar — tente novamente` })
      }
      if (playGen === this.playGen) await this.stopCurrent()
      return false
    }

    playerLog('info', 'manager', 'success', { engine })
    return true
  }

  async play(startOpts: PlayerStartOptions, preference: PlaybackEngine) {
    const playGen = ++this.playGen
    this.cancelled = false

    const auto = preference === 'auto'
    const chain: PlayerEngine[] =
      preference === 'auto'
        ? autoChainFor(startOpts.live)
        : preference === 'internal'
          ? ['internal']
          : preference === 'libmpv'
            ? ['libmpv']
            : preference === 'mpv'
              ? ['mpv']
              : preference === 'mpv-one'
                ? ['mpv-one']
                : preference === 'stur'
                  ? ['stur']
                  : preference === 'vlc'
                    ? ['vlc']
                    : ['mpc']

    const targetEngine = chain[0]
    const canSturReload = canHotReloadStur({
      targetEngine,
      activeEngine: this.activeEngine,
      hasBackend: Boolean(this.active),
      hasStartApi: Boolean(window.sturplay?.player?.start),
      failedSinceStart: this.failedSinceStart,
    })

    if (canSturReload) {
      const boundsEl = this.opts.getBoundsElement()
      const rect = boundsEl?.getBoundingClientRect()
      const bounds: VideoRect | undefined =
        rect && rect.width >= 32
          ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
          : startOpts.bounds
      playerLog('info', 'manager', 'stur hot reload', { url: startOpts.url.slice(0, 80) })
      const result = await window.sturplay?.player?.start?.({
        engine: 'stur',
        url: startOpts.url,
        startTime: startOpts.startTime,
        bounds,
        live: startOpts.live === true,
      })
      if (playGen !== this.playGen) return false
      if (result?.ok) return true
      playerLog('warn', 'manager', 'stur hot reload failed, full restart')
    }

    if (playGen !== this.playGen) return false

    await this.stopCurrent()

    if (playGen !== this.playGen) return false

    for (const engine of chain) {
      if (this.cancelled || playGen !== this.playGen) return false
      const ok = await this.tryEngine(engine, startOpts, auto, playGen)
      if (playGen !== this.playGen) return false
      if (ok) return true
      if (!auto) return false
      playerLog('info', 'manager', 'auto switch', { from: engine })
    }

    if (playGen !== this.playGen) return false
    this.emit({ type: 'failed', reason: 'Nenhum player disponível' })
    return false
  }

  async stop() {
    this.playGen += 1
    this.cancelled = true
    await this.stopCurrent()
  }

  async command(cmd: Parameters<PlayerBackend['command']>[0]) {
    await this.active?.command(cmd)
  }

  getActiveEngine() {
    return this.activeEngine
  }
}
