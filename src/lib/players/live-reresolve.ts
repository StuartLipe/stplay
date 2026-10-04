/**
 * QUANTAS VEZES O APP PODE ROTACIONAR O `stream_id` DE UM LIVE ANTES DE PARAR
 * E MOSTRAR O ERRO.
 *
 * POR QUE ISTO EXISTE — MEDIDO, NAO ADIVINHADO:
 *
 * O log do renderer (internal-debug.log) mostra a falha real:
 *
 *   22:31:01.633  live  stream_id rotacionado, reabrindo  de 709067 para 709686
 *   22:31:05.320  live  stream_id rotacionado, reabrindo  de 709686 para 709067
 *   22:31:08.889  live  stream_id rotacionado, reabrindo  de 709067 para 709686
 *   22:31:12.376  live  stream_id rotacionado, reabrindo  de 709686 para 709067
 *
 * Tres segundos por volta, para sempre. E enquanto isso a tela fica preta SEM
 * MENSAGEM, porque o ramo de rotacao termina em `return` ANTES do
 * `setPlaybackError` do ramo de erro. Ou seja: o app nunca mostra o erro
 * porque nunca para de tentar.
 *
 * A causa tem duas partes, e as duas precisam estar aqui:
 *
 * 1. `lastAttempt` era ESCRITO e nunca LIDO. A protecao existia so no
 *    comentario.
 * 2. O reset usava `channel.id` como chave, e a propria rotacao muda
 *    `channel.id`: `resolveFreshLiveChannel` monta `id: 'live-' + stream_id`.
 *    Entao trocar 709067 -> 709686 dispara o reset e zera o contador. Ele nunca
 *    chega a 1, quanto mais a 2. (xtream.ts:558)
 *
 * A segunda e a que mantinha o laco vivo. Por isso `deveZerarReresolve` abaixo
 * nao olha `channel.id`: ele olha se o id atual e o que nos proprios rotacionamos
 * para. Se for, a tentativa continua e o contador NAO pode ser apagado.
 */

/** Quantas trocas de `stream_id` antes de desistir e mostrar o erro. */
export const ROTACOES_LIVE_MAX = 2

export type LiveReresolveState = {
  /** Uma busca de catálogo em andamento (o motor pode emitir `failed` repetido). */
  busy: boolean
  /** Trocas ja feitas nesta mesma escolha de canal. */
  trocas: number
  /**
   * `channel.id` para o qual nos rotacionamos por ultimo.
   *
   * No estado inicial e o id que a pessoa escolheu, o que faz o primeiro
   * `deveZerarReresolve` devolver `null` — trocar de canal duas vezes seguidas
   * para o MESMO id e a mesma tentativa, nao uma nova.
   */
  esperado: string
}

/**
 * Deve rotacionar o `stream_id`, ou deixar a falha cair no ramo que mostra o erro?
 *
 * `trocas` e a unica trava. Quando ela esgota, `podeRotacionarLive` devolve
 * `false` e o chamador segue para o `setPlaybackError` — que e o que a pessoa
 * precisa ver.
 */
export function podeRotacionarLive(
  state: LiveReresolveState,
  input: { kind: string; temPlaylist: boolean },
): boolean {
  if (input.kind !== 'live') return false
  if (!input.temPlaylist) return false
  // `failed` repetido com a busca ainda em andamento: nao abre outra.
  if (state.busy) return false
  return state.trocas < ROTACOES_LIVE_MAX
}

/**
 * Conta a rotacao. Devolve estado novo em vez de mutar, para o teste poder
 * comparar o antes e o depois sem depender de ordem de execucao.
 */
export function registrarRotacao(
  state: LiveReresolveState,
  idRotacionadoPara: string,
): LiveReresolveState {
  return { busy: state.busy, trocas: state.trocas + 1, esperado: idRotacionadoPara }
}

/**
 * Estado novo para a escolha de canal `idEscolhido`: sem troca nenhuma e com o
 * proprio id como `esperado`.
 */
export function estadoInicialReresolve(idEscolhido: string): LiveReresolveState {
  return { busy: false, trocas: 0, esperado: idEscolhido }
}

/**
 * O contador deve ser apagado agora que `channel.id` mudou?
 *
 * `null` quando o id atual e exatamente o que a rotacao anterior produziu: e a
 * MESMA tentativa continuando, e apagar aqui e o que criava o laco
 * 709067 <-> 709686.
 *
 * Estado novo quando a pessoa escolheu outro canal — ai o contador recomeça,
 * como deve.
 */
export function deveZerarReresolve(
  state: LiveReresolveState,
  idAtual: string,
): LiveReresolveState | null {
  if (state.esperado === idAtual) return null
  return estadoInicialReresolve(idAtual)
}
