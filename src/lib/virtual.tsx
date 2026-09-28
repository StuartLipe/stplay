import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

function visibleRange(
  scrollTop: number,
  clientHeight: number,
  count: number,
  cols: number,
  rowHeight: number,
  overscan: number,
) {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleRows = Math.ceil(clientHeight / rowHeight) + overscan * 2
  const start = Math.min(count, startRow * cols)
  const end = Math.min(count, (startRow + Math.max(1, visibleRows)) * cols)
  return { start, end }
}

/**
 * Janela virtual do grid de catálogo.
 *
 * O container de scroll é recebido como ref callback (não como RefObject) de
 * propósito: com RefObject, se `scrollRef.current` ainda for null no primeiro
 * commit — o que acontece quando o container tem render condicional, ou quando
 * o `key` remonta a janela — o efeito retorna cedo, NENHUMA dependência muda
 * depois, e nenhum listener é registrado. O grid ficava congelado nas 8 linhas
 * iniciais com 99,9% do catálogo inalcançável, sem determinismo.
 */
export function VirtualWindow({
  count,
  rowHeight,
  columns,
  overscan = 1,
  scrollEl,
  innerClassName,
  innerStyle,
  onRowHeight,
  onColumns,
  children,
}: {
  count: number
  rowHeight: number
  columns: number
  overscan?: number
  /**
   * O container de scroll, como NÓ — não como ref.
   *
   * Antes era `RefObject<HTMLElement|null>`, e o efeito fazia
   * `if (!scrollRef.current) return`. Se o container não estivesse anexado no
   * primeiro commit — o que acontece com render condicional e com o `key` que
   * remonta a janela — o efeito retornava, NENHUMA dependência mudava depois, e
   * nenhum listener era registrado. O grid ficava congelado nas 8 linhas
   * iniciais, com 99,9% do catálogo inalcançável e sem determinismo.
   * Como nó em state, o efeito depende do nó e re-executa quando ele aparece.
   */
  scrollEl: HTMLElement | null
  innerClassName?: string
  innerStyle?: CSSProperties
  /** Recebe a altura real da linha, medida no DOM. `rowHeight` é só a estimativa. */
  onRowHeight?: (height: number) => void
  /**
   * Recebe a contagem de colunas que o CSS realmente produziu.
   *
   * Com o grid em `auto-fill` o navegador decide a geometria, e a virtualização
   * precisa saber o número para calcular `start`/`end`. Ler de volta do DOM é o
   * jeito de os dois concordarem sem palpite.
   */
  onColumns?: (columns: number) => void
  children: (index: number) => ReactNode
}) {
  const cols = Math.max(1, columns)
  const el = scrollEl
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(count, cols * 8),
  }))
  const innerRef = useRef<HTMLDivElement | null>(null)

  // `count` muda a cada tecla de busca e a cada lote do catálogo. Se fosse dep
  // deste efeito, cada uma derrubaria o listener de scroll e o ResizeObserver
  // e os recriaria. Vira ref: só geometria real recria o efeito.
  const countRef = useRef(count)
  countRef.current = count
  const rowHeightRef = useRef(rowHeight)
  rowHeightRef.current = rowHeight

  // A altura real da linha NUNCA é a constante: o poster é aspect-ratio 2/3, o
  // bloco de título tem altura variável conforme o texto (line-clamp 4), e o
  // badge "Continuar Assistindo" acrescenta ~19px quando presente. A
  // estimativa arrastava 18% de scroll fantasma no fim de listas grandes —
  // as últimas linhas ficavam fisicamente inalcançáveis. Aqui medimos de
  // verdade: altura do conteúdo / quantas linhas ele ocupa.
  const onRowHeightRef = useRef(onRowHeight)
  onRowHeightRef.current = onRowHeight
  const measuredRef = useRef(0)
  const onColumnsRef = useRef(onColumns)
  onColumnsRef.current = onColumns

  useLayoutEffect(() => {
    const node = innerRef.current
    if (!node) return
    // Contagem de colunas mudou: a medição anterior vale para outra geometria.
    measuredRef.current = 0

    // Quantas colunas o CSS realmente produziu.
    //
    // Antes o grid usava `gridTemplateColumns: repeat(${cols}, ...)` com `cols`
    // calculado em JS a partir da largura do container. O primeiro paint usava
    // um palpite (6) e, quando a medicao rodava, o numero mudava e os cartoes
    // encolhiam na frente do usuario — "carrega grande e dps fica pequeno".
    //
    // Agora o CSS decide (`repeat(auto-fill, minmax(...))`) e a contagem real e
    // lida de volta do DOM. Nao ha palpite, nao ha correcao visivel, e qualquer
    // mudanca futura no CSS se propaga sozinha.
    const countColumns = () => {
      const first = node.firstElementChild as HTMLElement | null
      if (!first) return
      const top = first.offsetTop
      let count = 0
      for (const child of Array.from(node.children) as HTMLElement[]) {
        if (child.offsetTop !== top) break
        count += 1
      }
      if (count > 0) onColumnsRef.current?.(count)
    }

    const measure = () => {
      countColumns()
      // Mede a PRIMEIRA célula, não a média. Dividir a altura do container pelo
      // número de linhas erra quando a última está parcial (13 itens em 5
      // colunas = 3 linhas, a última com 3 -> per = 0,867 da real, 13% abaixo),
      // e a faixa morta de 2px travava o valor errado para o resto do mount —
      // exatamente o scroll fantasma que este hunk veio eliminar.
      const first = node.firstElementChild as HTMLElement | null
      let per = 0
      if (first) {
        per = first.getBoundingClientRect().height
      } else {
        const h = node.getBoundingClientRect().height
        const rows = Math.max(1, Math.ceil(node.childElementCount / cols))
        per = h / rows
      }
      if (!Number.isFinite(per) || per <= 0) return
      if (Math.abs(per - measuredRef.current) < 2) return
      measuredRef.current = per
      onRowHeightRef.current?.(Math.ceil(per))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    return () => ro.disconnect()
  }, [cols, count])

  // `useLayoutEffect`, não `useEffect`: o ajuste tem que acontecer ANTES do
  // paint, senão trocar de categoria mostra um frame de grid vazio.
  useLayoutEffect(() => {
    if (!el) return

    let frame = 0
    const update = () => {
      frame = 0
      const next = visibleRange(
        el.scrollTop,
        el.clientHeight,
        countRef.current,
        cols,
        rowHeightRef.current,
        overscan,
      )
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    }

    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
    // `rowHeight` é dep de propósito. Quando a medição real substitui a
    // estimativa (310 -> 255), a janela precisa ser recalculada com a nova
    // geometria: senão `visibleRows = ceil(clientHeight/310)` renderiza menos
    // do que cabe, e sobra uma faixa vazia no rodapé da primeira tela que só
    // some depois de rolar. Sem recriar o listener — só o update() roda, e ele
    // é uma leitura pura.
  }, [el, cols, overscan, rowHeight])

  // Se o catálogo encolheu (busca, troca de grupo), reclampa a janela.
  useLayoutEffect(() => {
    setRange((prev) => {
      const start = Math.min(prev.start, Math.max(0, count))
      const end = Math.min(Math.max(prev.end, start), count)
      if (start === prev.start && end === prev.end) return prev
      return { start, end }
    })
  }, [count])

  // Garante pelo menos uma tela se houver itens.
  const clamped = useMemo(() => {
    const start = Math.min(range.start, Math.max(0, count))
    const end = Math.min(Math.max(range.end, start), count)
    if (count > 0 && end - start < cols) {
      return { start: Math.min(start, Math.max(0, count - cols * 4)), end: Math.min(count, start + cols * 8) }
    }
    return { start, end }
  }, [range.start, range.end, count, cols])

  if (count <= 0 || rowHeight <= 0) return null

  const rows = Math.ceil(count / cols)
  const padTop = Math.floor(clamped.start / cols) * rowHeight
  const visibleRows = Math.ceil(Math.max(0, clamped.end - clamped.start) / cols)
  const padBottom = Math.max(0, rows * rowHeight - padTop - visibleRows * rowHeight)
  const length = Math.max(0, clamped.end - clamped.start)

  return (
    <>
      <div className="virtual-spacer" style={{ height: padTop }} aria-hidden />
      <div className={innerClassName} style={innerStyle} ref={innerRef}>
        {Array.from({ length }, (_, offset) => children(clamped.start + offset))}
      </div>
      <div className="virtual-spacer" style={{ height: padBottom }} aria-hidden />
    </>
  )
}
