import { attachPlayerEx, type PlayerControls } from '../player'
import type { AudioTrack, SubtitleTrack } from '../player'
import type { PlayerBackend, PlayerCommand, PlayerEvent } from './types'
import { isHeavyLiveUrl } from '../video-engine'
import { playerLog } from './playerLogger'

export function createInternalPlayer(
  getVideo: () => HTMLVideoElement | null,
  controls?: PlayerControls,
): PlayerBackend {
  let cleanup: (() => void) | undefined
  const listeners = new Set<(e: PlayerEvent) => void>()
  let readyTimer = 0
  let blankTimer = 0

  const emit = (event: PlayerEvent) => {
    for (const cb of listeners) cb(event)
  }

  const clearTimers = () => {
    window.clearTimeout(readyTimer)
    window.clearTimeout(blankTimer)
  }

  return {
    id: 'internal',
    embedded: true,
    async isAvailable() {
      return true
    },
    async start(opts) {
      clearTimers()
      const video = getVideo()
      if (!video) {
        emit({ type: 'failed', reason: 'Elemento de vídeo indisponível' })
        return
      }

      let gotReady = false
      const onReady = () => {
        if (gotReady) return
        const hasFrame = video.videoWidth > 0 && video.videoHeight > 0
        const isPlaying = video.readyState >= 2 && !video.paused
        const liveProgress = opts.live && video.readyState >= 2 && (video.currentTime > 0 || !video.paused)
        if (hasFrame || isPlaying || liveProgress) {
          gotReady = true
          clearTimers()
          emit({ type: 'ready' })
          emit({ type: 'playing' })
        }
      }

      const onVideoError = () => {
        if (gotReady) return
        emit({ type: 'failed', reason: 'Codec/formato não suportado no player interno' })
      }

      video.addEventListener('loadeddata', onReady)
      video.addEventListener('playing', onReady)
      video.addEventListener('canplay', onReady)
      video.addEventListener('error', onVideoError)
      if (opts.live) {
        video.addEventListener('timeupdate', () => {
          if (!gotReady && video.currentTime > 0) onReady()
        })
      }

      readyTimer = window.setTimeout(() => {
        if (!gotReady) emit({ type: 'failed', reason: 'Timeout no player interno' })
      }, opts.live ? 28_000 : 14_000)

      blankTimer = window.setTimeout(() => {
        if (!gotReady && video.readyState < 2) {
          emit({ type: 'failed', reason: 'Vídeo não renderizou no player interno' })
        }
      }, opts.live ? 30_000 : 16_000)

      cleanup = attachPlayerEx(video, opts.url, {
        live: opts.live,
        heavy: opts.heavy ?? (opts.live ? isHeavyLiveUrl(opts.url) : false),
        onError: (err) => {
          if (!gotReady) emit({ type: 'failed', reason: err })
        },
        onAudioTracks: (tracks: AudioTrack[]) => emit({ type: 'tracks', audio: tracks }),
        onSubtitleTracks: (tracks: SubtitleTrack[]) => emit({ type: 'tracks', subs: tracks }),
        controls,
      })

      const onTime = () => emit({ type: 'timeupdate', current: video.currentTime })
      const onDuration = () => {
        if (video.duration && Number.isFinite(video.duration)) {
          emit({ type: 'duration', value: video.duration })
        }
      }
      const onWaiting = () => emit({ type: 'buffering', value: true })
      const onPlaying = () => {
        emit({ type: 'buffering', value: false })
        onReady()
      }
      const onEnded = () => emit({ type: 'ended' })

      video.addEventListener('timeupdate', onTime)
      video.addEventListener('durationchange', onDuration)
      video.addEventListener('waiting', onWaiting)
      video.addEventListener('playing', onPlaying)
      video.addEventListener('ended', onEnded)

      const prevCleanup = cleanup
      cleanup = () => {
        clearTimers()
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('playing', onReady)
        video.removeEventListener('canplay', onReady)
        video.removeEventListener('error', onVideoError)
        video.removeEventListener('timeupdate', onTime)
        video.removeEventListener('durationchange', onDuration)
        video.removeEventListener('waiting', onWaiting)
        video.removeEventListener('playing', onPlaying)
        video.removeEventListener('ended', onEnded)
        prevCleanup?.()
      }

      playerLog('info', 'internal', 'start', { url: opts.url.slice(0, 80) })
    },
    async stop() {
      cleanup?.()
      cleanup = undefined
      clearTimers()
    },
    async command(cmd: PlayerCommand) {
      const video = getVideo()
      if (!video) return
      if (cmd.op === 'pause') video.pause()
      if (cmd.op === 'play') void video.play().catch(() => undefined)
      if (cmd.op === 'toggle') {
        if (video.paused) void video.play().catch(() => undefined)
        else video.pause()
      }
      if (cmd.op === 'seek') video.currentTime = cmd.seconds
      if (cmd.op === 'volume') video.volume = cmd.value
      if (cmd.op === 'mute') video.muted = cmd.value
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
