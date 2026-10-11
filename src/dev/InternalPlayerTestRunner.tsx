import { useEffect, useRef, useState } from 'react'
import { PlayerManager } from '../lib/players/playerManager'
import { playSrc } from '../lib/proxy'

type CaseResult = {
  name: string
  ok: boolean
  ms: number
  error?: string
}

const MOVIE = 'file:///C:/Users/Administrator/Downloads/video.mp4'
const LIVE_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'

async function runCase(
  manager: PlayerManager,
  name: string,
  url: string,
  live: boolean,
): Promise<CaseResult> {
  const started = performance.now()
  try {
    const ok = await manager.play({ url, live }, 'internal')
    await manager.stop()
    return {
      name,
      ok,
      ms: Math.round(performance.now() - started),
      error: ok ? undefined : 'play() retornou false',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await manager.stop()
    return { name, ok: false, ms: Math.round(performance.now() - started), error: msg }
  }
}

export function InternalPlayerTestRunner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<CaseResult[] | null>(null)
  const [running, setRunning] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const video = videoRef.current
      if (!video) return
      const manager = new PlayerManager({
        getVideo: () => videoRef.current,
        getBoundsElement: () => wrapRef.current,
        silent: true,
      })
      const cases: Array<{ name: string; url: string; live: boolean }> = [
        { name: 'movie-mp4', url: MOVIE, live: false },
        { name: 'live-hls-demo', url: LIVE_HLS, live: true },
      ]
      const out: CaseResult[] = []
      for (const c of cases) {
        if (cancelled) break
        const playUrl = c.live ? c.url : playSrc(c.url)
        const r = await runCase(manager, c.name, playUrl, c.live)
        out.push(r)
        if (!cancelled) setResults([...out])
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!cancelled) {
        setResults(out)
        setRunning(false)
        const payload = { at: new Date().toISOString(), results: out, allOk: out.every((r) => r.ok) }
        console.log('[dev-internal-test]', JSON.stringify(payload))
        await window.sturplay?.dev?.reportInternalTest?.(payload)
      }
    }
    const t = window.setTimeout(() => void run(), 400)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [])

  return (
    <div style={{ padding: 16, background: '#111', color: '#eee', minHeight: '100vh' }}>
      <h1>Internal player test</h1>
      <div ref={wrapRef} style={{ width: 640, height: 360, background: '#000', position: 'relative' }}>
        <video ref={videoRef} style={{ width: '100%', height: '100%' }} playsInline />
      </div>
      <p>{running ? 'Rodando…' : 'Concluído'}</p>
      <pre style={{ fontSize: 12 }}>{results ? JSON.stringify(results, null, 2) : '…'}</pre>
    </div>
  )
}
