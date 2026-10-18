/**
 * Curva de volume perceptual, compartilhada por TODOS os motores.
 *
 * O slider entrega 0..1 e cada motor fazia `value * 100` direto na propriedade
 * `volume` do mpv — que e AMPLITUDE LINEAR. Percepcao de loudness nao e linear
 * em amplitude: pela lei de Stevens a sensacao acompanha a^0.6..0.67, entao
 * metade do slider entrega sensacao de ~63%, e na faixa baixa (0.2, 0.3) a
 * diferenca e o que a pessoa descreve como "quase mudo".
 *
 * `a = s ^ 0.7` corrige essa faixa e NAO mexe nas pontas:
 *
 *   s=0.0 -> 0.000   silencio de verdade
 *   s=0.2 -> 0.324   (+4.2 dB) — antes praticamente inaudivel
 *   s=0.3 -> 0.432   (+3.2 dB)
 *   s=0.5 -> 0.616   (+1.8 dB) — "metade" agora e metade de sensacao
 *   s=0.8 -> 0.855   (+0.6 dB)
 *   s=1.0 -> 1.000   inalterado
 *
 * O expoente 0.7 fica abaixo de 1 e por isso ELEVAR a faixa media-baixa em vez de
 * achatar o topo. Com `softvol` ligado (padrao do mpv) o ganho cai um pouco,
 * mas a ordem de grandeza e a mesma.
 *
 * POR QUE ESTE E O PONTO UNICO: os cinco motores repetiam a mesma expressao
 * `Math.round(Math.max(0, Math.min(100, value * 100)))`. Corrigir aqui conserta
 * o overlay E o player nativo de uma vez — nao ha segunda versao para divergir,
 * que e a mesma razao que matou a classe de bug do `adulto.ts`.
 */

/**
 * @param {number} s valor do slider, 0..1
 * @returns {number} valor 0..1 ja com a curva aplicada
 */
function volumePerceptual(s) {
  const s01 = Math.max(0, Math.min(1, Number(s) || 0))
  // `Math.pow` com base 0 e expoente fracionario devolve 0, mas o explicito
  // evita `NaN` se `s` chegar sujo do IPC.
  return s01 === 0 ? 0 : Math.pow(s01, 0.7)
}

/** Versao ja em 0..100, que e o que a propriedade `volume` do mpv espera. */
function volumePerceptual100(s) {
  return Math.round(volumePerceptual(s) * 100)
}

module.exports = { volumePerceptual, volumePerceptual100 }