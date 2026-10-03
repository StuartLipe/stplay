/**
 * Altura MINIMA da janela overlay durante a reproducao.
 *
 * Medido no modo janela (video de 277px de altura), com o dock atual:
 *
 *   titulo 20 + busca 22 + toolbar 92 (duas fileiras de 44) + padding 16 = 150px
 *
 * O piso era 72px, e a janela ficava em 72 com o dock pedindo 159. O que sobra
 * de uma janela menor que o conteudo e o FIM da lista: os botoes de baixo saem
 * pelo `overflow: hidden`, e sobrava so o ultimo — o de tela cheia. Era o
 * "no modo janela aparece so o icone de tela cheia".
 *
 * 168px da folga para duas fileiras de botoes mesmo com o seek, e ainda e
 * proporcional: a barra e limitada pelos 20% de `overlayBarRect`.
 */
const OVERLAY_BAR_MIN_HEIGHT = 168

/** Espaço inferior reservado aos controles React — o HWND do mpv não cobre essa faixa. */
const CONTROL_INSET_PX = 100

/**
 * @param {{ x: number, y: number, width: number, height: number }} videoRect
 */
function overlayBarRect(videoRect) {
  if (!videoRect || videoRect.width < 32 || videoRect.height < 32) return videoRect
  /*
   * PISO = ALTURA MINIMA, e nao um teto.
   *
   * A janela e limitada pelos 20% da altura do video, mas NUNCA fica abaixo de
   * `OVERLAY_BAR_MIN_HEIGHT`: o dock tem duas fileiras de botoes mais o seek, e
   * uma janela menor que o conteudo corta o que esta no fim da lista — que era
   * exatamente o sintoma de "so aparece o icone de tela cheia".
   *
   * Em um video alto o video manda (20%), e a barra continua compacta.
   */
  const byVideo = Math.round(videoRect.height * 0.2)
  const h = Math.max(OVERLAY_BAR_MIN_HEIGHT, Math.min(byVideo, videoRect.height))
  return {
    x: Math.round(videoRect.x),
    y: Math.round(videoRect.y + videoRect.height - h),
    width: Math.max(64, Math.round(videoRect.width)),
    height: h,
  }
}

/**
 * Retângulo da janela overlay.
 *
 * Durante a REPRODUÇÃO: só a barra de controle. No resto do tempo: o retângulo
 * inteiro, porque o indicador de carregamento é centralizado no vídeo e o drawer
 * de canais precisa da área toda.
 *
 * A medição que motivou isto, com o app rodando e o vídeo congelado na tela:
 *
 *   hwnd=0xC0494  Chrome_WidgetWin_1  (797,109)-(1736,946)   939x837   <- ACIMA
 *   hwnd=0x1D0B02 Chrome_WidgetWin_1  (160,70)-(1760,970)  1600x900   <- principal
 *   HWND do mpv:                   (797,109)-(1736,946)   939x837
 *
 * A janela do mpv é uma janela NATIVA reparentada dentro da janela do Electron,
 * e o overlay é uma SEGUNDA janela do Chromium, transparente, exatamente no mesmo
 * retângulo e ACIMA na z-order. DWM passa a compor duas superfícies uma sobre a
 * outra, e o elo que quebra é o swapchain D3D11 do vo=gpu — filho reparentado de
 * uma janela do Chromium.
 *
 * E o sintoma é justamente o que a medição de velocidade desmentiu. Com o mpv
 * em 1.000x, speed=1, avsync ~0, buffer de 160s e ZERO paradas de buffer em 2
 * minutos, o usuário via o quadro congelado. O vídeo continuava tocando embaixo
 * da camada: o que parou foi a apresentação.
 *
 * O retângulo inteiro continua disponível e continua sendo o certo enquanto o
 * overlay PRECISA dele — spinner centralizado, drawer aberto. O que não pode é
 * ele ficar cobrindo o vídeo durante a reprodução.
 *
 * @param {{ x: number, y: number, width: number, height: number }} videoRect
 * @param {{ full?: boolean }} [opts] `full` força o retângulo inteiro
 */
function overlayShellRect(videoRect, opts = {}) {
  if (!videoRect || videoRect.width < 32 || videoRect.height < 32) return videoRect
  if (opts.full !== true) return overlayBarRect(videoRect)
  return {
    x: Math.round(videoRect.x),
    y: Math.round(videoRect.y),
    width: Math.max(64, Math.round(videoRect.width)),
    height: Math.max(64, Math.round(videoRect.height)),
  }
}

/**
 * Retângulo do vídeo nativo sem a barra de controles do player React.
 * @param {{ x: number, y: number, width: number, height: number }} videoRect
 * @param {{ fullscreen?: boolean }} [opts]
 */
function videoContentRect(videoRect, opts = {}) {
  if (!videoRect || videoRect.width < 32 || videoRect.height < 120) return videoRect
  const fullscreen = opts.fullscreen === true
  /*
   * O recuo tem que ser >= a barra, nunca menor: e ele que tira o HWND do mpv de
   * baixo da janela do overlay. Com a barra em 168px e o recuo em 100px, os 68px
   * de cima da barra ficavam SOBRE o video — que e o que a janela do Chromium
   * nao pode fazer sem congelar a apresentacao do swapchain D3D11.
   */
  const inset = fullscreen
    ? Math.min(168, Math.max(64, Math.round(videoRect.height * 0.1)))
    : Math.min(videoRect.height - 80, Math.max(72, Math.round(videoRect.height * 0.16)))
  return {
    x: Math.round(videoRect.x),
    y: Math.round(videoRect.y),
    width: Math.max(64, Math.round(videoRect.width)),
    height: Math.max(80, Math.round(videoRect.height - inset)),
  }
}

module.exports = {
  OVERLAY_BAR_MIN_HEIGHT,
  CONTROL_INSET_PX,
  overlayBarRect,
  overlayShellRect,
  videoContentRect,
}
