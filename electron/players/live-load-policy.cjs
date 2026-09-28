/**
 * Ao vivo: igual IPTV Player One — loadfile na URL do painel.
 * Não pré-resolve 302 (atrasa e pinna token) e não cai no proxy HTTP.
 */
function shouldPreResolveRedirect(url, live) {
  if (live === true) return false
  if (/\.m3u8(\?|#|$)/i.test(String(url || ''))) return false
  return true
}

function shouldTryHttpFallback(live) {
  return live !== true
}

/** Borda ao vivo. seek 1 absolute puxa pro começo da janela HLS (~30–60s atrás). */
function liveEdgeSeekArgs() {
  return [100, 'absolute-percent']
}

/**
 * Conta 1 tela (XUI): o painel ainda conta o canal antigo se o TCP não fechou.
 * Espera o end-file do stop e um respiro curto antes do próximo loadfile.
 */
const LIVE_STOP_WAIT_MS = 700
const LIVE_CONN_RELEASE_MS = 400

function liveStopWaitMs() {
  return LIVE_STOP_WAIT_MS
}

function liveConnReleaseMs() {
  return LIVE_CONN_RELEASE_MS
}

/** reconnect no meio do zap segura o socket antigo e ocupa a única tela. */
function liveStreamLavfO(reconnect) {
  if (reconnect) {
    return 'reconnect=1,reconnect_streamed=1,reconnect_delay_max=5,live_start_index=-1'
  }
  return 'reconnect=0,reconnect_streamed=0,live_start_index=-1'
}

module.exports = {
  shouldPreResolveRedirect,
  shouldTryHttpFallback,
  liveEdgeSeekArgs,
  liveStopWaitMs,
  liveConnReleaseMs,
  liveStreamLavfO,
}
