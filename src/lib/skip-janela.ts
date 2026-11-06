/*
 * Decide se aparece o botão de "pular abertura", e com que janela.
 *
 * Cada fonte sozinha erra de um jeito, e o erro delas não é o mesmo:
 *
 *   AniSkip  - sabe se o episódio TEM abertura e onde ela TERMINA, mas o
 *              início vem de outro corte do vídeo. E para série que ela ainda
 *              não indexou, responde "não tem" mesmo tendo.
 *   Áudio    - ouve o arquivo e acha a música de verdade, mas erra o início
 *              em cena de diálogo forte e erra o fim em música que dá uma
 *              baixada no meio.
 *
 * A regra usa as duas, e cada uma só pode errar para o lado seguro: no
 * máximo o botão não aparece. Pular para a hora errada é pior do que não
 * oferecer o atalho.
 *
 * Medido em 14 episódios do catálogo real:
 *   - Naruto Shippuden S01E01: a AniSkip diz que TEM abertura e o áudio diz
 *     que não há música nenhuma. Veto, não aparece. (Era exatamente o
 *     defeito que o usuário reclamou.)
 *   - Série de 2026, que a AniSkip ainda não indexa: ela diz "não tem", o
 *     áudio acha a música, e o áudio ganha.
 *   - Quando as duas discordam mais de 60s sobre onde a música começa, não
 *     são a mesma música. Não aparece.
 */

export interface JanelaAbertura {
  start: number
  end: number
}

/** Diferença máxima aceitável entre as duas fontes sobre o início. */
export const TOLERANCIA_INICIO_S = 60

export interface EntradaDecisao {
  /** Janela que a AniSkip devolveu, ou null se ela não tem entrada. */
  aniskip: JanelaAbertura | null
  /** Janela que a análise de áudio achou, ou null se não achou. */
  audio: JanelaAbertura | null
  /** O ffmpeg não rodou: não há segunda fonte para cruzar. */
  deteccaoIndisponivel?: boolean
}

export interface DecisaoAbertura {
  janela: JanelaAbertura | null
  motivo:
    | 'aniskip-sem-entrada-e-sem-audio'
    | 'veto-audio-sem-musica'
    | 'fontes-discordam'
    | 'aniskip-so'
    | 'audio-so'
    | 'concordam'
}

export function decidirJanelaAbertura(entrada: EntradaDecisao): DecisaoAbertura {
  const { aniskip, audio, deteccaoIndisponivel } = entrada

  // Sem análise de áudio, a AniSkip sozinha é melhor do que nada — é a
  // reserva para quando o ffmpeg não está disponível no app empacotado.
  if (deteccaoIndisponivel) {
    if (!aniskip) return { janela: null, motivo: 'aniskip-sem-entrada-e-sem-audio' }
    return { janela: aniskip, motivo: 'aniskip-so' }
  }

  // A AniSkip não conhece esta série (ou não indexa este episódio): o áudio
  // decide sozinho.
  if (!aniskip) {
    if (!audio) return { janela: null, motivo: 'aniskip-sem-entrada-e-sem-audio' }
    return { janela: audio, motivo: 'audio-so' }
  }

  // A AniSkip diz que TEM abertura. O áudio precisa concordar que há música —
  // é o veto que mata o Naruto Shippuden S01E01.
  if (!audio) return { janela: null, motivo: 'veto-audio-sem-musica' }

  // Discordam sobre ONDE a música começa: não é a mesma música.
  if (Math.abs(audio.start - aniskip.start) > TOLERANCIA_INICIO_S) {
    return { janela: null, motivo: 'fontes-discordam' }
  }

  /*
   * Concordam. O início vem do áudio, que é mais preciso: a AniSkip conta a
   * partir de outro corte do vídeo, e a diferença chega a 49s no Attack on
   * Titan. O fim vem da AniSkip, porque o áudio trunca a música pela metade
   * (a detecção fecha a região cedo demais).
   */
  return { janela: { start: audio.start, end: aniskip.end }, motivo: 'concordam' }
}

/** A janela cobre a posição atual? */
export function janelaCobrePosicao(janela: JanelaAbertura | null, posicao: number): boolean {
  if (!janela) return false
  return posicao >= janela.start && posicao <= janela.end
}