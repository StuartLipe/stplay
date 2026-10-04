/** Transições de UI/retry do player nativo — evita tela preta no "Tentar novamente". */

export type PlaybackRetryUi = {
  playbackError: string | null
  buffering: boolean
  playing: boolean
  nativeEmbedded: boolean
  nativeBooting: boolean
  retrying: boolean
  killNativeProcess: boolean
  restorePlayerChrome: boolean
}

export function playbackUiAfterFailed(reason: string): PlaybackRetryUi {
  return {
    playbackError: reason || 'Não foi possível reproduzir o vídeo',
    buffering: false,
    playing: false,
    nativeEmbedded: false,
    nativeBooting: false,
    retrying: false,
    // Overlay some para o diálogo React receber clique. Não mata o mpv —
    // stop() no failed + hide() no retry abortava o restart (tela preta).
    killNativeProcess: false,
    restorePlayerChrome: false,
  }
}

export function playbackUiAfterRetry(): PlaybackRetryUi {
  return {
    playbackError: null,
    buffering: true,
    playing: false,
    nativeEmbedded: false,
    nativeBooting: true,
    retrying: true,
    killNativeProcess: false,
    restorePlayerChrome: true,
  }
}

/**
 * O retry pode recolocar a "chrome" do player em tela cheia?
 *
 * `body.player-active` aplica `visibility: hidden` em `.app-shell` E em
 * `.topbar`. E `visibility: hidden` esconde os filhos MENOS os que tem
 * `visibility: visible` explicito — que no caso do browse sao os botoes de
 * favorito e o menu. Resultado observado: ao clicar em "Tentar novamente" no
 * painel dividido, os textos, os logos e os nomes de categoria sumiam e
 * sobravam so os icones, ate o retry falhar de novo e `forceShellVisible()` rodar.
 *
 * `player-active` existe para o player em TELA CHEIA, onde o video tem que
 * ocupar a janela inteira. No painel dividido o shell precisa continuar
 * visivel: o video so ocupa a coluna da direita.
 *
 * POR QUE A GUARDA INVERTEU (medido no live, 01:33):
 *
 *   retorno era `input.embedded !== true`
 *
 * Isso e `true` no live, que e `<Player embedded .../>` dentro do
 * `.live-preview-panel` do painel dividido. E o `iniciarRetry` roda sozinho no
 * zape de canal — nao precisa de clique. Uma vez so:
 *
 *   zape -> retry automatico -> player-active -> app-shell hidden
 *         -> o grid de live perde a coluna da lista
 *         -> o painel do video ESTICA para a janela toda
 *         -> "o video foi por cima da categoria e dos canais"
 *
 * E o sintoma e enganoso: o video nao foi para tela cheia. O shell escondido
 * fez o layout colapsar e o unico elemento que sobrava — o painel do video —
 * virou a janela inteira. Quem assiste ve tela cheia; o log mostra um
 * `requestFullscreen` que nunca aconteceu.
 *
 * A condicao correta e as DUAS: nao-embedded E em tela cheia. O `isFs` e o
 * mesmo `domFs || winFs` que o efeito acima do retry ja usa.
 */
export function shouldRestorePlayerChrome(input: { embedded?: boolean; isFs?: boolean }) {
  return input.embedded !== true && input.isFs === true
}

export function shouldResetManagedEngine(input: { urlChanged: boolean; isRetry: boolean }) {
  return input.urlChanged && !input.isRetry
}

export function shouldShowNativeRetrySpinner(input: {
  retrying: boolean
  buffering: boolean
  playbackError: string | null
  nativeEmbedded: boolean
  nativeBooting?: boolean
}) {
  if (!input.retrying || input.playbackError) return false
  // ready chega antes do 1º quadro — manter spinner até playing
  if (input.nativeBooting) return true
  return input.buffering && !input.nativeEmbedded
}

export function canHotReloadStur(input: {
  targetEngine: string
  activeEngine: string | null
  hasBackend: boolean
  hasStartApi: boolean
  failedSinceStart: boolean
}) {
  return (
    input.targetEngine === 'stur' &&
    input.activeEngine === 'stur' &&
    input.hasBackend &&
    input.hasStartApi &&
    !input.failedSinceStart
  )
}
