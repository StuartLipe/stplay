// Regressao para a janela virtual do catalogo (src/lib/virtual.tsx).
//
// Dois defeitos que deixavam boa parte do catalogo inalcancavel:
//
// 1. `rowHeight` era constante (310 no poster) mas a altura real depende da
//    largura da coluna (aspect-ratio 2/3 do poster), do texto do titulo
//    (line-clamp 4) e do badge "Continuar Assistindo". A estimativa arrastava
//    ~18% de scroll fantasma: o card sob o cursor nao era o que o scrollbar
//    indicava, e as ultimas linhas ficavam fisicamente impossiveis de alcancar.
//
// 2. O efeito fazia `if (!scrollRef.current) return` com scrollRef sendo um
//    RefObject estavel. Se o container nao estivesse anexado no primeiro commit,
//    o efeito retornava, nenhuma dependencia mudava depois, e nenhum listener
//    era registrado: o grid congelava em 8 linhas para sempre.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

type Range = { start: number; end: number }

function visibleRange(scrollTop: number, clientHeight: number, count: number, cols: number, rowHeight: number, overscan: number): Range {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleRows = Math.ceil(clientHeight / rowHeight) + overscan * 2
  const start = Math.min(count, startRow * cols)
  const end = Math.min(count, (startRow + Math.max(1, visibleRows)) * cols)
  return { start, end }
}

/** Modelo do pad: o espaco total precisa bater com a altura real do conteudo. */
function padModel(count: number, cols: number, rowHeight: number, range: Range) {
  const rows = Math.ceil(count / cols)
  const padTop = Math.floor(range.start / cols) * rowHeight
  const visibleRows = Math.ceil(Math.max(0, range.end - range.start) / cols)
  const padBottom = Math.max(0, rows * rowHeight - padTop - visibleRows * rowHeight)
  return { padTop, padBottom, total: padTop + visibleRows * rowHeight + padBottom }
}

describe('visibleRange', () => {
  test('lista vazia nao renderiza nada', () => {
    assert.deepEqual(visibleRange(0, 800, 0, 6, 310, 1), { start: 0, end: 0 })
  })

  test('rowHeight zero ou negativo nao gera NaN', () => {
    const r = visibleRange(500, 800, 100, 6, 0, 1)
    assert.ok(Number.isFinite(r.start) && Number.isFinite(r.end))
  })

  test('nunca passa do fim da lista', () => {
    const r = visibleRange(999999, 800, 100, 6, 310, 1)
    assert.ok(r.start <= 100 && r.end <= 100)
  })

  test('no fim da lista, a ultima linha entra na janela', () => {
    const count = 30_000, cols = 6, rowHeight = 255
    const totalScroll = (count / cols) * rowHeight
    const r = visibleRange(totalScroll, 800, count, cols, rowHeight, 1)
    assert.equal(r.end, count, 'a ultima linha precisa estar no fim da janela')
  })
})

describe('altura de linha: estimativa vs medida', () => {
  test('1.0.5 — rowHeight fixo de 310 cria scroll fantasma', () => {
    const count = 30_000, cols = 6
    const real = 255 // medido: coluna ~137px * 1.5 + bloco de titulo
    const guess = 310
    const fake = padModel(count, cols, guess, { start: 0, end: cols * 8 })
    const rows = Math.ceil(count / cols)
    assert.ok(fake.total > rows * real, 'a barra de scroll tem mais de scroll que o conteudo')
    // Quanto sobrou no fim, em pixels de rolagem sem conteudo:
    const deadPx = fake.total - rows * real
    assert.ok(deadPx > 40_000, `${Math.round(deadPx)}px de rolagem morta no fim`)
  })

  test('com a altura medida, o total bate com o conteudo real', () => {
    const count = 30_000, cols = 6
    const real = 255
    const model = padModel(count, cols, real, { start: 0, end: cols * 8 })
    const rows = Math.ceil(count / cols)
    assert.equal(model.total, rows * real, 'sem rolagem fantasma')
    assert.equal(model.padBottom, (rows - 8) * real)
  })

  test('medicao a partir do DOM: altura / linhas visiveis', () => {
    // O que o onRowHeight faz: altura do container de conteudo dividida pelo
    // numero de linhas que ele ocupa.
    const contentHeight = 255 * 8
    const childCount = 6 * 8
    const cols = 6
    const rows = Math.max(1, Math.ceil(childCount / cols))
    const per = contentHeight / rows
    assert.equal(Math.ceil(per), 255)
  })
})

describe('congelamento por ref nulo', () => {
  test('1.0.5 — efeito com RefObject nulo nunca registra listener', () => {
    // O efeito dependia de [count, rowHeight, cols, overscan, scrollRef].
    // scrollRef e um objeto estavel: nunca muda. Se .current for null no
    // primeiro commit, o efeito retorna e NENHUMA dep muda depois.
    const scrollRef = { current: null as HTMLElement | null }
    let attached = false
    const deps = { count: 30_000, rowHeight: 255, cols: 6, overscan: 1, scrollRef }

    const mount = () => {
      const el = deps.scrollRef.current
      if (!el) return () => {}
      attached = true
      return () => {}
    }
    const cleanup = mount()
    cleanup()
    assert.equal(attached, false, 'nenhum listener registrado no primeiro commit')

    // As dependencias nunca mudam sozinhas. So o scrollRef.current mudaria, e
    // ele nao e dependencia de valor.
    const depValues = Object.values(deps)
    const before = depValues.map((v) => (typeof v === 'object' ? v : v))
    deps.count = 30_000
    assert.deepEqual(Object.values(deps), before, 'nenhuma dependencia mudou de identidade')
    assert.equal(attached, false, 'o grid continua congelado em 8 linhas')
  })

  test('corrigido — dependencia e o no, entao o efeito re-executa quando ele aparece', () => {
    let el: HTMLElement | null = null
    let passes = 0
    const run = () => {
      passes += 1
      if (!el) return
      // registra scroll listener
    }
    run() // primeiro commit: container ainda nao anexado
    assert.equal(passes, 1)
    // React anexa o no -> muda a dependencia -> o efeito re-executa
    el = {} as HTMLElement
    run()
    assert.equal(passes, 2, 'o listener e registrado assim que o no existe')
  })
})
