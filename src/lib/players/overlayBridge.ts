import type { VideoRect } from './types'

const OVERLAY_BAR_HEIGHT = 80

export function overlayBarRect(rect: VideoRect): VideoRect {
  const h = Math.min(OVERLAY_BAR_HEIGHT, Math.max(48, Math.round(rect.height * 0.12)))
  return {
    x: rect.x,
    y: rect.y + rect.height - h,
    width: rect.width,
    height: h,
  }
}

let observer: ResizeObserver | null = null
let raf = 0
let lastPublishedKey = ''
/** Desinscrever sem guardar closure — `stop` pode rodar depois do `watch`. */
let limpar: (() => void) | null = null

export function measureVideoRect(element: HTMLElement | null): VideoRect | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 32 || rect.height < 32) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function watchVideoBounds(element: HTMLElement | null, onBounds: (rect: VideoRect) => void) {
  stopWatchingVideoBounds()
  if (!element) return

  const publish = (forcar: boolean) => {
    const rect = measureVideoRect(element)
    if (!rect) return
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    /*
     * `forcar` existe porque a chave sozinha mente quando a JANELA muda e o
     * elemento nao.
     *
     * `getBoundingClientRect` e relativo ao viewport da janela, entao mover a
     * janela entre monitores ou sair da tela cheia NAO muda x/y/w/h — o elemento
     * continua com o mesmo tamanho na mesma posicao DENTRO da janela. O
     * `ResizeObserver` tambem nao dispara: ele observa o ELEMENTO, e o elemento
     * nao mudou.
     *
     * Resultado: a chave ficava identica, o update era descartado aqui, e o
     * main continuava com o retangulo antigo — valido na tela anterior. O
     * video nascia offset no outro monitor e, ao voltar, cobria a janela
     * inteira. Medido: `showVideo posicionou { x: 597, y: 8, w: 972, h: 837 }`
     * num painel que a sonda mediu em 668x709.
     *
     * Nao ha como deduzir "a janela mudou" pela chave: ela e a mesma antes e
     * depois. Quem sabe do evento externo e o chamador, e ele passa `forcar`.
     */
    if (!forcar && key === lastPublishedKey) return
    lastPublishedKey = key
    onBounds(rect)
  }

  const schedule = () => {
    window.cancelAnimationFrame(raf)
    raf = window.requestAnimationFrame(() => publish(false))
  }

  /**
   * Republica ignorando o cache. Usado por resize de JANELA e por sair/entrar de
   * tela cheia — os dois casos em que o retangulo do main envelhece sem que o
   * elemento mude.
   */
  const republish = () => {
    window.cancelAnimationFrame(raf)
    raf = window.requestAnimationFrame(() => publish(true))
  }

  observer = new ResizeObserver(schedule)
  observer.observe(element)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', republish)
  /*
   * `fullscreenchange` cobre o `:fullscreen` do DOM.
   *
   * Sair da tela cheia e o caso mais perigoso, e o `ResizeObserver` NAO cobre:
   * enquanto o elemento esta em `:fullscreen` o `getBoundingClientRect` reporta
   * o retangulo de tela cheia, mas para o observer o elemento continuou no
   * tamanho do painel o tempo todo (`:fullscreen` e CSS, nao layout). Ao sair,
   * nenhum evento dispara e o main fica com o retangulo de tela cheia.
   *
   * Medido: `bounds { w: 972, h: 837 }` num painel que a sonda mediu em
   * `668 x 709`, persistindo por todos os tiques do `raiseTimer`.
   *
   * O fullscreen NATIVO (`win.setFullScreen`, que e o que o app usa) nao dispara
   * `fullscreenchange` — quem escuta esse caminho e o `playerManager`, via
   * `onFullscreenChanged` + `reconciliar`.
   */
  document.addEventListener('fullscreenchange', republish)
  schedule()

  // O teardown fica em `limpar` (module-level) para que `stopWatchingVideoBounds`
  // possa desinscrever sem precisar desta closure. O retorno e o mesmo teardown,
  // por compatibilidade com quem chamava e usava o valor.
  limpar = () => {
    window.removeEventListener('resize', republish)
    document.removeEventListener('fullscreenchange', republish)
  }
  return limpar
}

export function stopWatchingVideoBounds() {
  window.cancelAnimationFrame(raf)
  lastPublishedKey = ''
  observer?.disconnect()
  observer = null
  limpar?.()
  limpar = null
}

export async function syncOverlayBounds(rect: VideoRect) {
  await window.sturplay?.player?.setBounds?.(rect)
}