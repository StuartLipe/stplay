import type { VideoFit } from './types'

/**
 * Ajuste da imagem — as tres decisões, fora do componente.
 *
 * Extraído por causa do mesmo motivo do `fullscreen-decision.ts`: o defeito
 * aqui não dá para ver em teste de janela. A tarja aparecia porque o estado
 * `aspect` existia com um único valor possível e sem caminho para mudar — a
 * linha era `const [aspect] = useState(<'fit'|'fill'|'wide'>('fit'))`, sem
 * setter. Nada no código podia produzir o modo que resolve.
 *
 * Estas funções são o que torna isso verificável sem abrir um player.
 */

/**
 * Ordem do botão. Vai do mais fiel ao mais chapado: primeiro a tarja some
 * (`fill`), depois a proporção vai embora (`wide`).
 *
 * `fill` primeiro porque é o que resolve a queixa sem estragar a imagem —
 * cortar a borda é invisível num canal de TV, esticar transforma gente em
 * oval.
 */
export const ASPECT_ORDER: readonly VideoFit[] = ['fit', 'fill', 'wide'] as const

export const ASPECT_DEFAULT: VideoFit = 'fill'

/** Próximo do ciclo. `fit` → `fill` → `wide` → `fit`. */
export function nextAspect(atual: VideoFit): VideoFit {
  const i = ASPECT_ORDER.indexOf(atual)
  // `indexOf` -1 (valor fora da lista, estado corrompido) cai em `fill`: o
  // comeco do ciclo. Melhor que `-1 + 1 = 0` devolver `fit` e reintroduzir a
  // tarja que o padrao existe para tirar.
  const proximo = (i < 0 ? ASPECT_ORDER.indexOf(ASPECT_DEFAULT) : i) + 1
  return ASPECT_ORDER[proximo % ASPECT_ORDER.length]
}

/**
 * Le o modo guardado.
 *
 * Qualquer coisa que nao seja `fit` ou `wide` vira `fill`. Um `localStorage`
 * corrompido nao pode reintroduzir a tarja que o padrao tira.
 */
export function normalizeAspect(raw: string | null | undefined): VideoFit {
  return raw === 'fit' || raw === 'wide' ? raw : ASPECT_DEFAULT
}

/** O que o botão diz que vai acontecer, não o que ele fez. */
export function aspectHint(atual: VideoFit): string {
  if (atual === 'fit') return 'Imagem: caber inteira, com tarja preta. Clique para preencher.'
  if (atual === 'fill') return 'Imagem: preencher cortando a borda. Clique para esticar.'
  return 'Imagem: preencher esticando, perde a proporção. Clique para caber inteira.'
}