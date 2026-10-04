/**
 * DECISAO DE TELA CHEIA — extraida do componente para poder ser testada.
 *
 * POR QUE ISTO VIROU UM MODULO:
 *
 * O bug era um closure velho. `toggleFullscreen` era chamada de um `keydown`
 * registrado num efeito cujo array de deps NAO incluía `isFs`, `domFs` nem a
 * propria `toggleFullscreen` — entao o closure ficava congelado no valor do
 * render em que o efeito rodou por ultimo. Como `isFs` muda sem re-rodar o
 * efeito, o closure decidia com informacao velha.
 *
 * E eu tentei verificar com `webContents.sendInputEvent`, que e o jeito obvio:
 * NAO FUNCIONA. Medido, `autotest F11 janelaFullscreen` deu `false -> false
 * -> false` em duas tentativas. A razao e que o `sendInputEvent` so entrega a
 * tecla quando a JANELA TEM FOCO, e no dev ela nao tem — o overlay e uma
 * BrowserWindow separada, e o `concurrently` sobe vite e electron sem focar
 * nada. Entao o handler nunca via a tecla, e o teste media o pipeline de input,
 * nao a logica.
 *
 * Extrair a decisao para uma funcao pura tira a dependencia de janela focada
 * sem depender do DOM: os ramos passam a ser testaveis direto, incluindo o
 * caso exato que quebrava.
 */

/** O que a decisao precisa saber. Tudo o mais e consecuencia. */
export type FullscreenProbe = {
  /**
   * `document.fullscreenElement` no momento do clique.
   *
   * Esta e a FONTE DE VERDADE, e o motivo esta medido no log:
   *
   *   overlay action { type: 'select', overlayAchaFullscreen: true,
   *                    janelaRealFullscreen: false }
   *
   * O overlay sabia que a janela estava em tela cheia, e
   * `BrowserWindow.isFullScreen()` respondeu `false`. NESTE APP o fullscreen de
   * ELEMENTO DOM nao aparece em `isFullScreen()`. Consultar o processo
   * principal para decidir se estamos em tela cheia da errado justamente no
   * caminho de SAIR: ele responde `false`, o codigo acha que nao esta em tela
   * cheia, chama `setFullscreen(true)`, que e no-op. O sintoma era 14 pedidos
   * de saida seguidos com a janela presa.
   */
  documentFullscreenElement: Element | null
  /**
   * A JANELA do Electron esta em tela cheia?
   *
   * Este parametro faltava, e a falta dele e o bug que o usuario relatar:
   * clicar no botao entrava e nao saia.
   *
   * A sequencia, que e o que o log mostra neste app:
   *
   *   1. clique, `document.fullscreenElement` e null, wrapper montado
   *      -> `enter-dom`
   *   2. `requestFullscreen` e RECUSADO — e sempre recusado aqui, o log
   *      registra "fullscreen recusado pelo container, indo para a janela" —
   *      e o app cai na tela cheia da JANELA
   *   3. `document.fullscreenElement` CONTINUA null: tela cheia de janela nao
   *      passa pelo DOM
   *   4. clique de novo, a decisao ve `documentFullscreenElement: null` e o
   *      wrapper montado, e devolve `enter-dom` DE NOVO
   *
   * Entra, nunca sai. E o botao continuava marcado como ativo, porque o
   * `is-active` vem de `domFs || winFs` — a camada da janela estava no rotulo e
   * ausente da decisao. Status e comando divergindo, que e a pior forma disso.
   *
   * E o mesmo defeito pelo outro lado: o ESC saia do DOM, mas nao da janela,
   * porque `escapeShouldExitFullscreen` tambem so olhava o DOM. O usuario
   * relatou exatamente isso — "o aplicativo fica em tela cheia e nao sai".
   */
  windowFullscreen: boolean
  /**
   * O wrapper do player esta montado?
   *
   * Nao para decidir SAIR — para decidir ENTRAR. Deliberadamente NAO e
   * comparado com `documentFullscreenElement`: quando o playback para o wrapper
   * desmonta, o elemento some da comparacao, e a saida ficava sem caminho.
   * Era o segundo furo do mesmo bug.
   */
  playerMounted: boolean
  /** O wrapper tem `requestFullscreen`? navegadores sem suporte caem na janela. */
  canRequestElementFullscreen: boolean
}

export type FullscreenAction =
  /** Ha elemento em tela cheia: sair por `document.exitFullscreen()`. */
  | { kind: 'exit-dom' }
  /**
   * Nenhum elemento em tela cheia, mas a JANELA esta. Sair pela janela.
   *
   * Este e o ramo que faltava. Sem ele o botao e o F11 entravam de novo em vez
   * de sair.
   */
  | { kind: 'exit-window' }
  /** Wrapper montado e com suporte: entrar por `requestFullscreen()`. */
  | { kind: 'enter-dom' }
  /**
   * Sem elemento e sem wrapper (ou sem suporte): entrar pela tela cheia da
   * JANELA. E o caminho que sobrou depois de playback parar — antes ele era um
   * `if (!root) return`, que era beco sem saida e matava o F11 inteiro.
   *
   * Este `kind` tambem e o destino quando `requestFullscreen` e RECUSADO, mas
   * isso NAO e decidido aqui: a recusa so aparece no `catch` da promise, e o
   * app ainda registra o motivo que o navegador devolveu. Por isso a funcao tem
   * tres ramos e nao quatro — a recusa e um segundo passo, nao uma entrada.
   */
  | { kind: 'enter-window' }

/**
 * Decide o que fazer com F11 / botao / duplo clique.
 *
 * A ordem importa e e o que estava errado antes:
 *
 * 1. PRIMEIRO `documentFullscreenElement`. Se tem elemento em tela cheia, o que
 *    o usuario quer e SAIR — e `exitFullscreen` e sincrono e nao depende de
 *    nenhum estado guardado.
 * 2. DEPOIS `windowFullscreen`. A tela cheia da janela nao passa pelo DOM, entao
 *    sem este passo o comando nunca a desliga. E o que fazia o botao entrar sem
 *    sair, e o ESC deixar a janela presa.
 * 3. SO DEPOIS `playerMounted`. Sem wrapper, a unica coisa que existe e a tela
 *    cheia da janela.
 *
 * O inverso (consultar se `documentFullscreenElement === wrapper`) e o que
 * prendia o usuario: o wrapper desmonta quando o video para, e a saida perdia o
 * caminho justo no momento em que o usuario mais precisava dele.
 */
export function decideFullscreenAction(probe: FullscreenProbe): FullscreenAction {
  if (probe.documentFullscreenElement) return { kind: 'exit-dom' }
  if (probe.windowFullscreen) return { kind: 'exit-window' }
  if (probe.playerMounted && probe.canRequestElementFullscreen) return { kind: 'enter-dom' }
  return { kind: 'enter-window' }
}

/**
 * O ESC deve sair da tela cheia antes de qualquer outra coisa?
 *
 * O overlay decide o ramo do ESC por um campo `fullscreen` que e empurrado do
 * renderer. Esse campo pode divergir do estado real, e quando diverge o ESC
 * para o VIDEO em vez de sair da tela cheia — que foi o sintoma reportado.
 *
 * Por isso a resposta vem do DOM ao vivo, e nao do campo. E tambem da camada da
 * JANELA: sem ela, sair da tela cheia da janela pelo ESC nao existia, e o
 * usuario ficava preso nela tendo que sair pela lista do player.
 */
export function escapeShouldExitFullscreen(
  documentFullscreenElement: Element | null,
  windowFullscreen = false,
): boolean {
  return Boolean(documentFullscreenElement) || windowFullscreen
}
