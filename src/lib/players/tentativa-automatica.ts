/**
 * QUANDO O APP DEVE REPETIR SOZINHO, ANTES DE MOSTRAR "CANAL INDISPONIVEL".
 *
 * POR QUE — MEDIDO, E O QUE A PESSOA RELATOU ("o canal nao caiu, e muito
 * dificil os canais abertos cair"):
 *
 *   01:26:35.389  start
 *   01:26:37.243  superficie de video perdida - reancorando
 *   01:26:44.754  loadfile ok            <- 9,37s: o aquecimento bateu no teto
 *   01:26:44.766  end-file reason:error  <- 12ms
 *                 publicados:0 janela:0  motivo:null  tentativas:0
 *   01:26:48.295  start                  <- retry
 *   01:26:52.460  loadfile ok
 *   01:26:53.948  file-loaded
 *   01:26:53.958  first frame            <- FUNCIONOU
 *
 * `motivo: null` e `tentativas: 0` sao a prova de que o normalizador nao
 * respondeu e nao falhou: a requisicao ficou pendurada. Nao foi 404, nao foi
 * timeout, nao foi canal fora do ar.
 *
 * E a origem, no mesmo instante, mede peak de -17,3 dBFS, sem clipe, com o
 * canal no ar. A unica coisa que falhou foi a primeira tentativa.
 *
 * ENTAO: uma falha de live nao vira caixa de erro na cara. Vira uma nova
 * tentativa. A caixa so aparece se as tentativas automaticas tambem falharem.
 *
 * POR QUE 2 E NAO MAIS: no log medido a segunda tentativa ja passou. Tres
 * tentativas cobrem o vaivem de painel 404medido antes (709056/709109), e quatro
 * comecam a custar tempo de quem so queria assistir.
 *
 * POR QUE ESPACADAS: um retry instantaneo repete a mesma requisicao pendurada.
 * O espaco deixa a conexao velha morrer e a nova abrir — foi o que medido: a
 * tentativa que voltaria rapido pegava o mesmo cache do painel.
 */

/** Quantas vezes repetir sozinho antes de mostrar o erro. */
export const TENTATIVAS_AUTOMATICAS_MAX = 2

/** Espera entre uma tentativa e a seguinte. */
export const ESPERO_ENTRE_TENTATIVAS_MS = 2500

export type TentativaAutomaticaState = {
  /** Tentativas automaticas ja gastas NESTA escolha de canal. */
  gastas: number
}

export function estadoTentativaAutomatica(): TentativaAutomaticaState {
  return { gastas: 0 }
}

/**
 * Repetir sozinho, ou mostrar o erro?
 *
 * `false` para filme e serie: a falha deles nao e de janela deslizante, e
 * repetir so esconde um erro que a pessoa precisa ver.
 */
export function deveRepetirSozinho(
  state: TentativaAutomaticaState,
  input: { kind: string },
): boolean {
  if (input.kind !== 'live') return false
  return state.gastas < TENTATIVAS_AUTOMATICAS_MAX
}

/** Conta a tentativa. Estado novo, para o teste nao depender de ordem. */
export function gastarTentativa(state: TentativaAutomaticaState): TentativaAutomaticaState {
  return { gastas: state.gastas + 1 }
}

/**
 * O canal voltou a funcionar no meio da espera? Entao a tentativa automatica nao
 * conta e o erro nao aparece.
 *
 * Medido no log: `file-loaded` chega antes do timeout quando o painel responde
 * na segunda rodada. Sem esta guarda o app mostraria a caixa de erro POR CIMA de
 * um video que ja voltou — que e pior que o bug original.
 */
export function tentarNovamenteCanceladoPorSucesso(input: {
  tocando: boolean
  jaTinhaErro: boolean
}): boolean {
  return input.tocando && input.jaTinhaErro
}