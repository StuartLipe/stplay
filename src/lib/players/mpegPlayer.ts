import type { PlayerBackend, PlayerCommand, PlayerEvent, PlayerEngine, PlayerStartOptions } from './types'
import { playerLog } from './playerLogger'

/**
 * MPEG - URL crua no mpv, com retry curto.
 *
 * O que o painel precisa, sem camada no meio:
 *
 *   LIVE:   {proto}://host:port/live/user/pass/{stream_id}.ts   (selectedContainer default '.ts')
 *   VOD:    {proto}://host:port/movie/user/pass/{stream_id}.{container_extension real}
 *   SERIES: {proto}://host:port/series/user/pass/{episode_id}.{container_extension real}
 *   PLAYER: libVLC embutido, URL CRUA direta, autoplay — sem preflight de
 *           manifesto, sem normalizer, sem resolve de redirect, sem remux/proxy.
 *   ERRO:   "Playback error, reconnects in 5s (x/5)" — tenta o MESMO link
 *           até 5x. Só depois desiste.
 *
 * Aqui o motor nativo é o mpv embutido (electron/players/mpeg-player.cjs) no
 * lugar do VLC deles — mesma função: URL crua + retry 5x/5s. O ST já monta
 * live .m3u8 / VOD ext real / séries ext real; o MPEG converte o live pra
 * .ts e entrega cru ao nativo.
 * STUR, interno e os outros: intocados.
 */
function toRawLiveUrl(url: string) {
  let next = url
  next = next.replace(/([?&]output=)(m3u8|hls)\b/i, '$1ts')
  next = next.replace(/(\/live\/[^/?#]+\/[^/?#]+\/[^/?#?]+)\.m3u8(\?|#|$)/i, '$1.ts$2')
  next = next.replace(/(\/live\/[^/?#]+\/[^/?#]+\/\d+)(\?|#|$)/i, (full, path: string, end: string) => {
    if (/\.[a-z0-9]+$/i.test(path)) return full
    return `${path}.ts${end}`
  })
  return next
}

function bridge(engine: PlayerEngine): PlayerBackend {
  const listeners = new Set<(e: PlayerEvent) => void>()
  let unsub: (() => void) | undefined

  const api = () => window.sturplay?.player

  const emit = (event: PlayerEvent) => {
    for (const cb of listeners) cb(event)
  }

  return {
    id: engine,
    embedded: true,
    async isAvailable() {
      if (!api()) return false
      const detect = await api()?.detect?.()
      if (!detect) return false
      return Boolean((detect as Record<string, unknown>).mpeg)
    },
    async start(opts: PlayerStartOptions) {
      unsub?.()
      unsub = api()?.onEvent?.((payload) => {
        const p = payload as PlayerEvent
        if (p?.type) emit(p)
      })
      // selectedContainer '.ts' deles: live sempre .ts cru, VOD/séries
      // seguem com a extensão real que o catálogo já traz.
      const rawUrl = opts.live ? toRawLiveUrl(opts.url) : opts.url
      const result = await api()?.start?.({
        engine,
        url: rawUrl,
        startTime: opts.startTime,
        bounds: opts.bounds,
        live: opts.live === true,
      })
      if (!result?.ok) {
        emit({ type: 'failed', reason: result?.error || `${engine} falhou ao iniciar` })
        return false
      }
      playerLog('info', engine, 'ipc start ok', { url: rawUrl.slice(0, 80) })
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

export const createMpegPlayer = () => bridge('mpeg')
