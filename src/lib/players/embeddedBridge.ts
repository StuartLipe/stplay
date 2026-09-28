import type { PlayerBackend, PlayerCommand, PlayerEvent, PlayerEngine, PlayerStartOptions } from './types'
import { playerLog } from './playerLogger'

function bridge(engine: PlayerEngine): PlayerBackend {
  const listeners = new Set<(e: PlayerEvent) => void>()
  let unsub: (() => void) | undefined

  const api = () => window.sturplay?.player

  const emit = (event: PlayerEvent) => {
    for (const cb of listeners) cb(event)
  }

  return {
    id: engine,
    embedded: engine === 'libmpv' || engine === 'mpv' || engine === 'mpv-one' || engine === 'stur',
    async isAvailable() {
      if (!api()) return false
      const detect = await api()?.detect?.()
      if (!detect) return false
      if (engine === 'libmpv') return Boolean(detect.libmpv)
      if (engine === 'mpv') return Boolean(detect.mpv)
      if (engine === 'mpv-one') return Boolean(detect.mpvOne)
      if (engine === 'stur') return Boolean(detect.stur)
      if (engine === 'vlc') return Boolean(detect.vlc)
      if (engine === 'mpc') return Boolean(detect.mpc)
      return false
    },
    async start(opts: PlayerStartOptions) {
      unsub?.()
      unsub = api()?.onEvent?.((payload) => {
        const p = payload as PlayerEvent
        if (p?.type) emit(p)
      })
      const result = await api()?.start?.({
        engine,
        url: opts.url,
        startTime: opts.startTime,
        bounds: opts.bounds,
        live: opts.live === true,
      })
      if (!result?.ok) {
        emit({ type: 'failed', reason: result?.error || `${engine} falhou ao iniciar` })
        return false
      }
      playerLog('info', engine, 'ipc start ok')
      return true
    },
    async stop() {
      unsub?.()
      unsub = undefined
      await api()?.stop?.()
    },
    async command(cmd: PlayerCommand) {
      const op =
        cmd.op === 'seek'
          ? 'seek'
          : cmd.op === 'volume'
            ? 'volume'
            : cmd.op === 'mute'
              ? 'mute'
              : cmd.op === 'toggle'
                ? 'toggle'
                : cmd.op
      const value = cmd.op === 'seek' ? cmd.seconds : cmd.op === 'volume' ? cmd.value : cmd.op === 'mute' ? cmd.value : undefined
      await api()?.command?.(op, value)
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export const createLibmpvPlayer = () => bridge('libmpv')
export const createMpvExePlayer = () => bridge('mpv')
export const createMpvOnePlayer = () => bridge('mpv-one')
export const createSturPlayer = () => bridge('stur')
export const createVlcPlayer = () => bridge('vlc')
export const createMpcPlayer = () => bridge('mpc')
