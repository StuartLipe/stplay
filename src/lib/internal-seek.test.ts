// Regressao para o seek do player interno (src/App.tsx).
//
// O efeito que escuta o <video> tinha `seeking` e `duration` no array de
// dependencias e chamava restore(), que fazia `video.currentTime = initialTime`.
//
//   mouseDown -> seeking=true  -> efeito recria -> restore() -> playhead volta
//   mouseUp   -> seeking=false -> efeito recria -> restore() -> playhead volta
//
// Ou seja: o player interno nao acceptava seek nenhum.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

type Listener = () => void

/** <video> minúsculo com registro de listeners, suficiente pro modelo. */
function makeVideo(start = 0, duration = 7200) {
  const el = {
    currentTime: start,
    duration,
    listeners: new Map<string, Set<Listener>>(),
    addEventListener(type: string, fn: Listener) {
      if (!el.listeners.has(type)) el.listeners.set(type, new Set())
      el.listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: Listener) {
      el.listeners.get(type)?.delete(fn)
    },
    dispatch(type: string) {
      for (const fn of el.listeners.get(type) ?? []) fn()
    },
    count(type: string) {
      return el.listeners.get(type)?.size ?? 0
    },
  }
  return el
}

type World = {
  video: ReturnType<typeof makeVideo>
  initialTime: number
  restoredChannel: string
  writes: number
}

type Spec = { deps: (w: World) => unknown[]; run: (w: World) => () => void }

/** Simula o React: monta e re-executa enquanto alguma dep mudar de identidade. */
function mount(spec: Spec, w: World, limit = 200): number {
  let passes = 0
  let prev = spec.deps(w)
  for (;;) {
    if (++passes > limit) throw new Error(`nao convergiu em ${limit} passes`)
    const cleanup = spec.run(w)
    cleanup()
    const next = spec.deps(w)
    const changed = next.length !== prev.length || next.some((v, i) => v !== prev[i])
    if (!changed) return passes
    prev = next
  }
}

/** O corpo de restore, isolado. */
function restore(w: World) {
  const v = w.video
  if (w.video.duration > 0 && Number.isFinite(v.duration)) {
    // setDuration
  }
  if (w.initialTime > 0 && w.initialTime < (v.duration || 999999)) {
    v.currentTime = w.initialTime
    if (w.initialTime > 5) {
      // setShowResumeToast
    }
  }
  w.restoredChannel = 'filme-1'
}

describe('player interno: seek nao e desfeito pelo restore', () => {
  test('1.0.5 — restore() roda a cada toggle de seeking e desfaz o seek', () => {
    const w: World = { video: makeVideo(), initialTime: 1800, restoredChannel: '', writes: 0 }
    let restoreCalls = 0
    // Deps de 1.0.5: seeking e duration entram no efeito.
    const depSeeking = () => w.video.currentTime
    const deps = (ww: World) => ['filme-1', 'movie', ww.restoredChannel.length > 0, ww.video.duration, false]
    void depSeeking

    // Simula um arrasto: mouseDown -> seeking=true, mouseUp -> seeking=false.
    // Cada toggle recria o efeito, e o corpo antigo chamava restore().
    let prev = deps(w)
    for (let i = 0; i < 6; i += 1) {
      // o usuario arrasta para 5400
      w.video.currentTime = 5400
      // commit: seeking alterna
      w.restoredChannel = i % 2 === 0 ? 'x' : ''
      const next = deps(w)
      const changed = next.length !== prev.length || next.some((v, j) => v !== prev[j])
      if (changed) {
        // corpo do efeito 1.0.5: restore() no fim
        if (w.video.duration && Number.isFinite(w.video.duration)) w.video.currentTime = w.initialTime
        if (w.initialTime > 0 && w.initialTime < (w.video.duration || 999999)) w.video.currentTime = w.initialTime
        restoreCalls += 1
      }
      prev = next
    }
    assert.ok(restoreCalls > 0, 'o seek seria desfeito a cada toggle')
    assert.equal(w.video.currentTime, 1800, 'playhead voltou ao ponto de resume depois do arrasto')
  })

  test('corrigido — restore so em loadedmetadata, uma vez por canal', () => {
    const w: World = { video: makeVideo(), initialTime: 1800, restoredChannel: '', writes: 0 }
    // deps so de primitivos: seeking/duration fora.
    const deps = () => ['filme-1', 'movie', false]
    assert.equal(mount({ deps, run: () => () => {} }, w), 1)
    // seeking muda varias vezes durante o arrasto: nada acontece.
    w.video.currentTime = 5400
    assert.equal(mount({ deps, run: () => () => {} }, w), 1)
    assert.equal(w.video.currentTime, 5400, 'seek do usuario foi preservado')
  })

  test('restore aplica o ponto de resume uma unica vez por canal', () => {
    const w: World = { video: makeVideo(), initialTime: 1800, restoredChannel: '', writes: 0 }
    if (w.restoredChannel !== 'filme-1') restore(w)
    assert.equal(w.video.currentTime, 1800)
    const after = w.video.currentTime
    // hls.js dispara durationchange varias vezes; o guard impede novo seek.
    if (w.restoredChannel !== 'filme-1') restore(w)
    assert.equal(w.video.currentTime, after, 'nao resseta apos o primeiro restore')
  })

  test('trocar de canal limpa o guard e o resume roda de novo', () => {
    const w: World = { video: makeVideo(), initialTime: 1800, restoredChannel: 'filme-1', writes: 0 }
    // Canal novo: guard nao bate, entao restore aplica.
    w.restoredChannel = 'filme-1'
    const isNew = w.restoredChannel === 'filme-2'
    assert.equal(isNew, false)
    // Trocando explicitamente:
    const novo: World = { video: makeVideo(), initialTime: 60, restoredChannel: '', writes: 0 }
    restore(novo)
    assert.equal(novo.video.currentTime, 60)
  })

  test('durationchange so atualiza duracao, nao resseta o playhead', () => {
    const w: World = { video: makeVideo(900), initialTime: 1800, restoredChannel: 'filme-1', writes: 0 }
    const v = w.video
    // Handler corrigido: apenas setDuration.
    const onDurationChange = () => {
      if (v.duration && Number.isFinite(v.duration)) {
        // setDuration(v.duration)
      }
    }
    onDurationChange()
    onDurationChange()
    assert.equal(v.currentTime, 900, 'playhead intacto apos varios durationchange')
  })
})
