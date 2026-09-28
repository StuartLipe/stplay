/** Altura da janela overlay (barra inferior — dock completo com seek + toolbar). */
const OVERLAY_BAR_HEIGHT = 148

/** Espaço inferior reservado aos controles React — o HWND do mpv não cobre essa faixa. */
const CONTROL_INSET_PX = 100

/**
 * @param {{ x: number, y: number, width: number, height: number }} videoRect
 */
function overlayBarRect(videoRect) {
  if (!videoRect || videoRect.width < 32 || videoRect.height < 32) return videoRect
  const h = Math.min(OVERLAY_BAR_HEIGHT, Math.max(112, Math.round(videoRect.height * 0.2)))
  return {
    x: Math.round(videoRect.x),
    y: Math.round(videoRect.y + videoRect.height - h),
    width: Math.max(64, Math.round(videoRect.width)),
    height: h,
  }
}

/** IPTV Player One: overlay cobre o retângulo inteiro do vídeo (controles no rodapé via CSS). */
function overlayShellRect(videoRect, opts = {}) {
  if (!videoRect || videoRect.width < 32 || videoRect.height < 32) return videoRect
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
  const inset = fullscreen
    ? Math.min(88, Math.max(64, Math.round(videoRect.height * 0.1)))
    : Math.min(CONTROL_INSET_PX, Math.max(72, Math.round(videoRect.height * 0.16)))
  return {
    x: Math.round(videoRect.x),
    y: Math.round(videoRect.y),
    width: Math.max(64, Math.round(videoRect.width)),
    height: Math.max(80, Math.round(videoRect.height - inset)),
  }
}

module.exports = { OVERLAY_BAR_HEIGHT, CONTROL_INSET_PX, overlayBarRect, overlayShellRect, videoContentRect }
