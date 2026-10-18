import type { Channel } from '../types'

/*
 * Identifica filmes de uma mesma franquia (ex: Matrix, Matrix Reloaded,
 * Matrix Resurrections) para exibir na tela de detalhes do filme e permitir
 * maratona em continuidade.
 *
 * Estrategia: sempre usa o NOME BASE do titulo como critério principal.
 * O campo `group` do servidor costuma ser generico (Acao, Ficcao Cientifica)
 * e nao serve para agrupar franquia. Entao ignoramos o group e extraimos o
 * "nome raiz" do titulo, removendo sufixos conhecidos.
 *
 * A ordem eh por ano de lancamento (releasedate) e, empatado, pela posicao
 * no catalogo. O proprio filme de referencia eh excluido do resultado.
 */

/* Sufixos/marcadores que nao fazem parte do nome da franquia. */
const SUFIXOS = [
  /\[L\]/i,
  /\(L\)/i,
  /\[DUB\]/i,
  /\(DUB\)/i,
  /\[LEG\]/i,
  /\(LEG\)/i,
  /\[DUBLADO\]/i,
  /\(DUBLADO\)/i,
  /\[LEGENDADO\]/i,
  /\(LEGENDADO\)/i,
  /\b4K\b/i,
  /\bHDR\b/i,
  /\b1080p\b/i,
  /\b720p\b/i,
  /\bDUAL\b/i,
  /\bLEGENDADO\b/i,
  /\bDUBLADO\b/i,
  /\bDUBLAGEM\b/i,
  /\bSUB\w*\b/i,
  /\bPART\b/i,
  /\bPARTE\b/i,
  /\bCOLLECTION\b/i,
  /\bCOLECAO\b/i,
  /\bTRILOGY\b/i,
  /\bTRILOGIA\b/i,
  /\bTHE\b/i,
  /\bRELOADED\b/i,
  /\bRESURRECTIONS\b/i,
  /\bRESURRECTION\b/i,
  /\bREVOLUTIONS\b/i,
  /\bREVOLUTION\b/i,
  /\bSOLUTIONS\b/i,
  /\bSOLUTION\b/i,
]

/* Numero de parte final (II, III, IV, 2, 3, etc.) */
const PARTE_FINAL = /\b(I{1,3}|IV|V|VI{0,3}|[2-9])\b\s*$/

/* Artigos no inicio do titulo que nao identificam franquia. */
const ARTIGOS = new Set([
  'a', 'o', 'os', 'as', 'e', 'em', 'de', 'do', 'da', 'dos', 'das',
  'um', 'uma', 'uns', 'umas', 'the', 'an',
])

/**
 * Extrai o "nome raiz" da franquia a partir do titulo.
 *
 * Estrategia: depois de limpar sufixos, ignora artigos no inicio e pega as
 * primeiras 2 palavras significativas como chave de franquia. Assim titulos
 * com grafia diferente ainda caem na mesma franquia:
 *
 *   "Star Wars 2 (2008)"              -> "star wars"
 *   "Star Wars: Episodio I"           -> "star wars"
 *   "Star Wars: A Ameaca Fantasma"    -> "star wars"
 *   "Matrix"                          -> "matrix"
 *   "Rambo [L]"                       -> "rambo"
 *   "A Ascensao Skywalker"            -> "ascensao skywalker"
 */
export function nomeFranquia(titulo: string): string {
  let base = titulo.trim()

  for (const suf of SUFIXOS) {
    base = base.replace(suf, ' ')
  }

  base = base.replace(PARTE_FINAL, ' ')
  base = base.replace(/[:\-–—|.,;!¿?]+/g, ' ')
  base = base.replace(/\s+/g, ' ').trim()

  const palavras = base.split(/\s+/)
  // ignora artigos no inicio para nao quebrar a chave
  let i = 0
  while (i < palavras.length && ARTIGOS.has(palavras[i].toLowerCase())) {
    i += 1
  }
  const significativas = palavras.slice(i)
  const chave = significativas.slice(0, 2).join(' ').toLowerCase()
  return chave || base.toLowerCase()
}

/**
 * Retorna os filmes da mesma franquia que o filme de referencia, ordenados por
 * lancamento (releasedate) e, empates, pela posicao no catalogo.
 */
export function filmesDaMesmaFranquia(
  referencia: Channel,
  catalogo: Channel[],
): Channel[] {
  const raizRef = nomeFranquia(referencia.name)

  const relacionados = catalogo.filter((c) => {
    if (c.id === referencia.id) return false
    return nomeFranquia(c.name) === raizRef
  })

  // Indice por id para desempate estavel em O(1). catalogo.indexOf(a) e O(n)
  // dentro do comparador de sort: com catalogo de dezenas de milhares e a
  // maioria dos filmes sem releasedate (empate em ''), virava O(n^2 log n)
  // e travava o renderer (render-process-gone / Network service crashed).
  const ordem = new Map<string, number>()
  catalogo.forEach((c, i) => ordem.set(c.id, i))

  return relacionados.sort((a, b) => {
    const aa = a.releasedate || ''
    const bb = b.releasedate || ''
    if (aa !== bb) return aa.localeCompare(bb)
    return (ordem.get(a.id) ?? 0) - (ordem.get(b.id) ?? 0)
  })
}

/**
 * Indica se o catalogo tem pelo menos um outro filme da mesma franquia.
 */
export function temOutroFilmeDaFranquia(
  referencia: Channel,
  catalogo: Channel[],
): boolean {
  return filmesDaMesmaFranquia(referencia, catalogo).length > 0
}
