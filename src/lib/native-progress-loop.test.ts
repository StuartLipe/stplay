// Regressao para o loop infinito de render do player nativo (src/App.tsx).
//
// O efeito de progresso nativo tinha `progress` no array de dependencias e
// escrevia `progressHandler` no cleanup. Ciclo:
//
//   effect -> cleanup -> persist(true) -> onProgress -> setState (array nova)
//        -> prop `progress` muda -> effect roda de novo -> cleanup -> ...
//
// Este teste modela o ciclo e exige que ele termine.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

type Snapshot = { id: string; currentTime: number }

type World = {
  progress: Snapshot
  writes: number
  lastSig: string
}

type EffectSpec = {
  /** Deps que o efeito observa. Comparadas por identidade. */
  deps: (w: World) => unknown[]
  /** O corpo do efeito. Devolve o cleanup. */
  run: (w: World) => () => void
}

/** Simula o React: monta, e re-executa enquanto alguma dep mudar de identidade. */
function mount(spec: EffectSpec, w: World, limit = 500): number {
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

const world = (): World => ({ progress: { id: 'filme-1', currentTime: 30 }, writes: 0, lastSig: '' })

describe('player nativo: progresso nao entra em loop', () => {
  test('1.0.5 — `progress` como dep + escrita incondicional no cleanup nao converge', () => {
    const spec: EffectSpec = {
      deps: (w) => [w.progress],
      run: (w) => {
        const p = w.progress
        return () => {
          // persist(true) chamava onProgress -> setState -> objeto novo.
          // Como `progress` e dep, o efeito volta a rodar. Para sempre.
          w.writes += 1
          w.progress = { ...p, currentTime: p.currentTime + 1 }
        }
      },
    }
    assert.throws(() => mount(spec, world()), /nao convergiu/)
  })

  test('corrigido — `progress` fora das deps + guarda por assinatura converge', () => {
    const spec: EffectSpec = {
      // Deps so de primitivos. `progress` e lido por ref dentro do efeito.
      deps: (w) => [true, 'vod', w.progress.id, undefined, false],
      run: (w) => {
        const p = w.progress
        return () => {
          const sig = `${p.id}|${Math.round(p.currentTime)}`
          if (sig === w.lastSig) return
          w.lastSig = sig
          w.writes += 1
        }
      },
    }
    const w = world()
    const passes = mount(spec, w)
    assert.ok(passes < 10, `convergiu em ${passes} passadas, esperava <10`)
    assert.equal(w.writes, 1, 'cleanup redundante nao deve reescrever o mesmo estado')
  })

  test('seek real ainda persiste (posicao mudou -> escreve)', () => {
    const spec: EffectSpec = {
      deps: (w) => [true, 'vod', w.progress.id, undefined, false],
      run: (w) => {
        const p = w.progress
        return () => {
          const sig = `${p.id}|${Math.round(p.currentTime)}`
          if (sig === w.lastSig) return
          w.lastSig = sig
          w.writes += 1
        }
      },
    }
    const w = world()
    mount(spec, w)
    assert.equal(w.writes, 1)

    // O usuario arrasta a barra: a posicao muda.
    w.progress = { ...w.progress, currentTime: 95 }
    mount(spec, w)
    assert.equal(w.writes, 2, 'seek para outra posicao tem que persistir')
  })
})
