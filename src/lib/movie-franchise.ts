import type { Channel } from '../types'

/*
 * AGRUPAMENTO DE FRANQUIA POR PREFIXO.
 *
 * A estrategia anterior cortava as 2 primeiras palavras do titulo e exigia
 * igualdade exata. Isso quebrava em quase todo catalogo real:
 *
 *   "Rambo"                  -> "rambo"
 *   "Rambo 2"                -> "rambo"
 *   "Rambo 4 - 2008"         -> "rambo 4"    <- nunca casa
 *   "Rambo: Ate o Fim"       -> "rambo ate"  <- nunca casa
 *   "Rambo Last Blood"       -> "rambo last" <- nunca casa
 *   "Star Wars: Episodio I"  -> "star wars"
 *   "Star Wars: O Mandaloriano e Grogu" -> "star wars o"  <- nunca casa
 *
 * Um numero fixo de palavras nao serve: "Matrix" tem 1, "Star Wars" tem 2,
 * "Harry Potter" tem 2, e um sequencial ("Matrix Reloaded") tem 2 mas nao e a
 * raiz. Nao ha N que funcione.
 *
 * A regra que funciona e RELACIONAL, nao por chave: dois titulos sao da mesma
 * franquia quando um comeca com o outro. "Rambo" e prefixo de "Rambo 2", de
 * "Rambo: Ate o Fim" e de "Rambo Last Blood". "Star Wars" e prefixo de "Star
 * Wars 2" e de "Star Wars: O Mandaloriano".
 *
 * Antes de comparar, cada titulo vira uma lista de palavras sem numero de
 * capitulo, sem ano e sem o subtulo depois dos dois-pontos. E o que permite
 * que "Rambo 4 - 2008" (que vira "rambo 4") ainda case com "Rambo": o prefixo
 * mais curto, "rambo", e o mesmo.
 */

/** Ano no titulo tipo "Blade Runner 2049" nao e lancamento. */
const MAX_PLAUSIBLE_YEAR = new Date().getFullYear() + 1

function yearIsPlausible(year: number): boolean {
  return year >= 1900 && year <= MAX_PLAUSIBLE_YEAR
}

function extractParentheticalYear(name?: string): string | undefined {
  if (!name) return undefined
  const matches = [...String(name).matchAll(/\(\s*((?:19|20)\d{2})\s*\)/g)]
  if (matches.length === 0) return undefined
  const year = parseInt(matches[matches.length - 1][1], 10)
  return yearIsPlausible(year) ? String(year) : undefined
}

/**
 * Qualquer ano solto no titulo, e nao so entre parenteses.
 *
 * O catalogo de filmes NAO vem com `releasedate`, e boa parte da ordem se perde
 * sem isso. Mas o ano esta no proprio nome, em tres formatos:
 *
 *   "One Piece Z - 2012"                       -> 2012
 *   "One Piece Filme 10 Strong World - 2009"  -> 2009
 *   "ONE PIECE HEROINES [2026]"               -> 2026
 *
 * Sem esta leitura, a saga do One Piece saia na ordem do catalogo e o filme de
 * 2026 aparecia PRIMEIRO, quando e o ultimo.
 *
 * "Blade Runner 2049" nao entra: 2049 passa de `MAX_PLAUSIBLE_YEAR`.
 */
function extractYearFromName(name?: string): string | undefined {
  if (!name) return undefined
  const matches = [...String(name).matchAll(/\b((?:19|20)\d{2})\b/g)]
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const year = parseInt(matches[i][1], 10)
    if (yearIsPlausible(year)) return matches[i][1]
  }
  return undefined
}

/**
 * Ano de lancamento do item, em ms. 0 quando nao da para saber.
 *
 * Este e so um dos criterios de ordem. O principal continua sendo o numero de
 * capitulo, porque o catalogo de filmes nao vem com `releasedate` preenchido.
 */
export function getItemReleaseTime(channel?: Channel): number {
  if (!channel) return 0
  if (channel.releasedate) {
    const raw = String(channel.releasedate).trim()
    const parsed = Date.parse(raw)
    if (!isNaN(parsed) && parsed > 0) {
      const year = new Date(parsed).getUTCFullYear()
      if (yearIsPlausible(year)) return parsed
    }
    const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/)
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10)
      if (yearIsPlausible(year)) return Date.UTC(year, 0, 1)
    }
  }
  const fromParen = extractParentheticalYear(channel.name)
  if (fromParen) return Date.UTC(parseInt(fromParen, 10), 0, 1)
  // Ultimo recurso: o ano solto no proprio titulo ("One Piece Z - 2012").
  const fromName = extractYearFromName(channel.name)
  if (fromName) return Date.UTC(parseInt(fromName, 10), 0, 1)
  return 0
}

const ROMANOS: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
}

/** "Episodio III", "Ep. 2", "Episode IV" — saga numerada por nome. */
const EPISODIO =
  /\b(epis[oó]dio|episode|ep\.?|parte|part)\s*[:\-]?\s*(I{1,3}|IV|VI{0,3}|[1-9])\b/i

/** Numero do episodio escrito por extenso, ou null. */
export function numeroEpisodio(titulo: string): number | null {
  const m = titulo.match(EPISODIO)
  if (!m) return null
  const bruto = m[2].toUpperCase()
  if (ROMANOS[bruto] != null) return ROMANOS[bruto]
  const n = Number(bruto)
  return Number.isFinite(n) ? n : null
}

/**
 * Numero do capitulo: o PRIMEIRO numero do titulo, nao o ultimo.
 *
 * Pegar o ultimo erraria a saga do Crepusculo:
 *   "Crepusculo 4 - Amanhecer Parte 1"  -> o "1" e METADE do filme, nao o 4o
 *   "Crepusculo 5 - Amanhecer Parte 2"  -> idem
 * O numero da saga vem logo depois do nome; o do "Parte" e subtitulo.
 */
export function numeroCapitulo(titulo: string): number | null {
  const limpo = titulo.replace(/\[[^\]]*\]/g, ' ').trim()
  const tokens = limpo.split(/\s+/).filter(Boolean)

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i].replace(/^[^0-9IVX]+|[^0-9IVX]+$/g, '')
    if (!t) continue
    // "Parte 1" / "Part 1": o numero e do lado, nao do capitulo.
    const anterior = (tokens[i - 1] || '').toLowerCase()
    if (/^(parte|part)$/.test(anterior)) continue
    // Ano solto nunca e numero de capitulo.
    if (/^(19|20)\d{2}$/.test(t)) continue
    /*
     * A TAG PRECEDE O NUMERO. Em "Star Wars: O Mandaloriano e Grogu 4K" e
     * "Star Wars: A Ascensao Skywalker 4K" o "4" e de 4K, e nao o quarto
     * capitulo — o token traz o "K" colado e a limpeza de pontuacao o deixava
     * como numero solto. Sem esta guarda, os dois spin-offs entravam no
     * catalogo como capitulo 4 da serie "Star Wars N".
     */
    if (/^\d+[a-z]+$/i.test(tokens[i])) continue
    if (/^\d+[a-z]{1,2}$/i.test(t)) continue
    const bruto = t.toUpperCase()
    if (ROMANOS[bruto] != null) return ROMANOS[bruto]
    const n = Number(t)
    if (Number.isFinite(n) && n >= 1 && n <= 99) return n
  }
  return null
}

/** Marcas de qualidade que naoidentify o filme. */
const QUALIDADE =
  /\b(4k|uhd|hdr10|sdr|full\s?hd|hd|sd|1080p|720p|480p|2160p|dual|dublado|legendado|legenda|dub|extendido|diretor\s?compressor|comprimido|remasterizado|restaurado)\b/gi

/** Artigos que nunca iniciam o nome de uma franquia. */
const ARTIGOS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas',
  'the', 'an', 'le', 'la', 'les', 'el', 'los', 'las', 'il',
  'de', 'do', 'da', 'dos', 'das', 'e',
])

/**
 * Palavras que NAO identificam a franquia, mesmo no MEIO do titulo.
 *
 * O catalogo escreve o nome de formas diferentes para a MESMA saga:
 *   "Crepusculo 1 (2008)"              -> "crepusculo"
 *   "A Saga Crepusculo: Lua Nova"      -> ["saga","crepusculo"]
 * Sem tirar "saga", a raiz de uma fica com duas palavras e a da outra com uma,
 * e nenhuma das duas e prefixo da outra: a saga saia com um filme so.
 */
const PALAVRAS_GERAIS = new Set([
  'saga', 'serie', 'filme', 'film', 'movie', 'trilogia', 'tetralogia',
  'colecao', 'franchise', 'the', 'vol', 'parte', 'part',
])

/** Tira acento: "Crepusculo" e "Crepusculo" sao o mesmo nome. */
function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Palavras que identificam a franquia, em minusculo.
 *
 * Descarta: o subtudo depois dos dois-pontos, marcas de qualidade, o numero de
 * capitulo, anos e artigos iniciais.
 *
 *   "Rambo 4 - 2008"                       -> ["rambo", "4"]
 *   "Rambo: Ate o Fim"                     -> ["rambo"]
 *   "Star Wars: O Mandaloriano e Grogu"    -> ["star", "wars"]
 *   "Matrix Resurrections 4K [HDR]"        -> ["matrix", "resurrections"]
 *   "Star Wars: Episodio I - A Ameaca"     -> ["star", "wars"]
 */
export function palavrasFranquia(titulo: string): string[] {
  let base = String(titulo || '')

  // 1. O subtítulo depois dos dois-pontos não é a franquia.
  base = base.split(':')[0]

  // 2. Marcadores entre colchetes: [L], [DUB], [HDR].
  base = base.replace(/\[[^\]]*\]/g, ' ')
  base = base.replace(/[()]/g, ' ')

  // 3. Marcas de qualidade.
  base = base.replace(QUALIDADE, ' ')

  // 4. Tudo depois de um hífen que introduce ano ou remake.
  base = base.replace(/\s[-–—]\s*\d{4}\s*$/, ' ')

  base = base.replace(/[|.;!?¡¿]/g, ' ')
  /*
   * Hifen solto. "Naruto 1 - O Filme" deixava "-" como token, e ele virava
   * palavra da lista: quebrava o casamento por causa de pontuacao.
   */
  base = base.replace(/(^|\s)[-–—_/\\]+(?=\s|$)/g, ' ')
  base = base.replace(/\s+/g, ' ').trim()

  const palavras = base.split(/\s+/).filter(Boolean)

  const saida: string[] = []
  for (const p of palavras) {
    /*
     * SEM ACENTO. O painel escreve a mesma saga de formas diferentes:
     * "Crepusculo 1 (2008)" sem acento e "A Saga Crepusculo: Lua Nova" com.
     * Sem normalizar, as duas raizes nunca casavam e a saga ficava com um
     * filme so.
     */
    const baixo = semAcento(p.toLowerCase())
    // Ano solto ("2049", "2008") não é marca de filme.
    if (/^(19|20)\d{2}$/.test(baixo) && yearIsPlausible(Number(baixo))) continue
    if (ARTIGOS.has(baixo)) continue
    // "Saga", "Filme", "Trilogia": qualifica a obra, nao a identifica.
    if (PALAVRAS_GERAIS.has(baixo)) continue
    saida.push(baixo)
  }

  /*
 * Numero de capitulo sai da lista de casamento, em QUALQUER posicao.
 *
 * No fim: "Rambo 2" virava ["rambo","2"] e so casava com outro "Rambo 2".
 * No meio: "Naruto 1 - O Filme" virava ["naruto","1","filme"] e nao casava
 * com "Naruto Shippuden 2" (["naruto","shippuden"]), porque so coincidiam em
 * "naruto". Era esse o motivo de os filmes do Naruto sumirem da gaveta.
 *
 * A distincao de capitulo continua existindo: ela e feita sobre o titulo CRU,
 * em `numeroCapitulo`/`numeroEpisodio`, e e o que separa saga principal de
 * saga lateral. Aqui so decide quem pertence a mesma familia.
 */
const semNumeros = saida.filter((p) => !ehNumeroDeCapitulo(p))
  return semNumeros.length > 0 ? semNumeros : saida
}

/** TRUE quando o titulo marca capitulo por numero, seja extenso ou solto. */
function temNumeroDeCapitulo(titulo: string): boolean {
  return numeroEpisodio(titulo) != null || numeroCapitulo(titulo) != null
}

/** O token e um numero de capitulo solto: "2", "3", "IV", "VIII". */
function ehNumeroDeCapitulo(token: string): boolean {
  const t = semAcento(token.toLowerCase())
  if (/^[1-9]$/.test(t)) return true
  return ROMANOS[t.toUpperCase()] != null
}

/**
 * Tokens do SUBTITULO (depois dos dois-pontos), ja limpos.
 *
 * `[]` quando o titulo nao tem subtitulo.
 */
function tokensDoSubtitulo(titulo: string): string[] {
  const partes = String(titulo || '').split(':')
  if (partes.length < 2) return []
  return palavrasFranquia(partes.slice(1).join(':'))
}

/**
 * A palavra que identifica a franquia: a primeira da raiz, quando tem 5+ letras.
 *
 * "star" tem 4 e nao identifica — "Star Wars" e "Star Trek" so compartilham
 * essa palavra. "naruto", "matrix", "rambo" identificam.
 */
function marcaDistintiva(raiz: string[]): string | null {
  /*
   * A marca e o token mais LONGO da raiz, nao o primeiro.
   *
   * Em "A Saga Crepusculo: Lua Nova" a raiz ja vem limpa de "saga", mas em
   * "Senhor dos Anais" o primeiro token e "senhor" e o que identifica a
   * franquia e "anais". Pegar o primeiro faria o casamento depender da ordem
   * das palavras.
   */
  const candidatos = raiz.filter((t) => t.length >= 5).sort((x, y) => y.length - x.length)
  return candidatos[0] ?? null
}

/**
 * TRUE quando o NOME da franquia abre o subtitulo de outro titulo.
 *
 * "Boruto: Naruto O Filme" e "The Last: Naruto O Filme" sao filmes do Naruto,
 * mas a raiz deles e "boruto" e "last". O prefixo nao pega; o nome no subtitulo
 * pega.
 *
 * Exige que a marca seja a PRIMEIRA palavra do subtitulo, e nao qualquer
 * palavra dele. E o que segura o contrario:
 *   - "A Glitch in the Matrix" traz "matrix" no MEIO, sem subtitulo -> fora
 *   - "Animatrix" traz "matrix" dentro da palavra, e nao e token -> fora
 *
 * Com ano dos dois lados, exige proximidade: um "Naruto" de 2004 e um de 2019
 * sao a mesma saga, mas um clone de outra franquia com o mesmo nome nao entra
 * so por causa da palavra.
 */
function marcaNoSubtitulo(
  marca: string | null,
  tituloCandidato: string,
  anoRef: number,
  anoCand: number,
): boolean {
  if (!marca) return false
  const sub = tokensDoSubtitulo(tituloCandidato)
  if (sub.length === 0 || sub[0] !== marca) return false
  if (anoRef && anoCand && Math.abs(anoRef - anoCand) > JANELA_SAGA_ANOS) return false
  return true
}

/**
 * TRUE quando os dois titulos sao da mesma franquia.
 *
 * Tres formas, da mais forte para a mais fraca:
 *
 *  1. Um e igual ao outro — `["matrix"]` com `["matrix"]`.
 *  2. Um e prefixo do outro — `["rambo"]` casa com `["rambo","last","blood"]`.
 *  3. Compartilham um prefixo de DUAS palavras — "Harry Potter e a Pedra
 *     filosofal" e "Harry Potter e a Câmara Secreta" não são prefixo um do
 *     outro, mas divergem so depois de "harry potter".
 *
 * O piso de DUAS palavras no caso 3 é o que impede "Star Wars" e "Star Trek"
 * de entrarem juntos: eles só compartilham "star", uma palavra.
 */
function mesmaFranquia(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const [menor, maior] = a.length <= b.length ? [a, b] : [b, a]
  if (menor.join(' ') === maior.join(' ')) return true
  if (maior.slice(0, menor.length).join(' ') === menor.join(' ')) return true

  let comum = 0
  while (comum < menor.length && menor[comum] === maior[comum]) comum += 1
  if (comum >= 2) return true

  /*
   * Uma palavra so em comum, e so quando ela e longa o bastante para
   * identificar a franquia.
   *
   * "Naruto 1 - O Filme" e "Naruto Shippuden 2" so compartilham "naruto" — sem
   * esta regra os filmes do Naruto nao entravam na mesma saga. O piso de 5
   * letras e o que segura o contrario: "Star Wars" e "Star Trek" tambem so
   * compartilham "star", e saofranchias diferentes.
   */
  return comum === 1 && maior[0].length >= 5
}

/**
 * Nome curto da franquia, para rotulo. Nao e a chave de agrupamento — a
 * agrupacao e relacional (ver `mesmaFranquia`).
 */
export function nomeFranquia(titulo: string): string {
  const palavras = palavrasFranquia(titulo)
  return palavras.slice(0, 2).join(' ') || String(titulo || '').toLowerCase()
}

/** Janela em anos que ainda considera "mesma saga". */
const JANELA_SAGA_ANOS = 6

/**
 * Compara dois valores de ordem, tratando "sem valor" como desconhecido.
 *
 * `0` quando nao da para decidir (os dois iguais, ou os dois ausentes) — o
 * comparador segue para o criterio seguinte.
 *
 * Quando so um lado tem valor, ele NAO e placeholder automatico: empurrar o
 * com-valor para frente punha "Homem-Aranha: Um Novo Dia (2026)" acima de
 * "Homem-Aranha 2", e o "Homem-Aranha 2" ficava na posicao do catalogo, que
 * invertida. Sem par para comparar, mantem a posicao do catalogo e o proximo
 * criterio decide.
 */
function comparaNumero(a?: number | null, b?: number | null): number {
  if (a == null || b == null) return 0
  return a === b ? 0 : a - b
}

/** Um bloco de filmes da mesma saga, ja ordenado. */
export interface Saga {
  principal: boolean
  filmes: Channel[]
}

/**
 * TRUE quando o subtitulo REPETE uma palavra da propria raiz.
 *
 * E o sinal de que o subtitulo e um titulo novo, e nao um complemento:
 *
 *   "A Era do Gelo: A Era do Radio"  -> subtitulo "a era do radio" repete "era"
 *                                      -> obra separada (um especial de radio)
 *   "Rambo: Ate o Fim"               -> subtitulo "ate o fim" nao repete nada
 *                                      -> e o proprio filme
 *
 * Nao usa so o criterio do subtitulo: em Star Wars, "O Mandaloriano" nao repete
 * "star" nem "wars" e ainda assim e outra obra. Esse caso e coberto pela regra
 * de "Episodio" abaixo.
 */
function subtituloRepeteRaiz(titulo: string): boolean {
  const partes = String(titulo || '').split(':')
  if (partes.length < 2) return false
  const raiz = new Set(palavrasFranquia(partes[0]))
  if (raiz.size === 0) return false
  const sub = palavrasFranquia(partes.slice(1).join(':'))
  return sub.some((p) => raiz.has(p))
}

/**
 * Em qual saga o item cai.
 *
 * `franquiaTemEpisodios`: a MESMA franquia usa "Episodio" em algum titulo.
 *
 * Duas regras tiram spin-offs, e elas se complementam porque nenhum criterio
 * sozinho serve:
 *
 *  - O subtitulo repete palavra da raiz: e outra obra, com nome proprio.
 *    "A Era do Gelo: A Era do Radio" sai daqui.
 *  - A franquia marca "Episodio" e o titulo tem subtitulo: e spin-off.
 *    "Star Wars: O Mandaloriano" sai daqui.
 *
 * "Rambo: Ate o Fim" passa nas duas: o subtitulo nao repete "rambo" e a saga do
 * Rambo nao usa "Episodio" — que e o comportamento certo, porque esse titulo e
 * um filme do Rambo.
 *
 * Na mesma situacao, titulo SEM numero e SEM subtitulo ("Star Wars Biornas")
 * tambem sai quando a franquia marca episodio: e duplicata, nao capitulo.
 */
function classificacaoSaga(
  item: Channel,
  sagaAnos: number[],
  franquiaTemEpisodios: boolean,
): 'principal' | 'lateral' | null {
  const ep = numeroEpisodio(item.name)
  const cap = numeroCapitulo(item.name)

  if (ep != null) return 'principal'

  if (cap != null) {
    /*
     * Numero solto ("Rambo 2", "A Era do Gelo 3").
     *
     * "Saga lateral" so existe quando ha CONFLITO de numeracao na mesma
     * franquia: em Star Wars, "Episodio II" e "Star Wars 2" se referem a
     * series diferentes, e so a proximidade de ano separa.
     *
     * Sem "Episodio" em nenhum titulo da franquia nao existe conflito —
     * "Rambo 1", "Rambo 2", "Rambo 3" sao a mesma saga, e antes eles ca iam
     * num bloco "outra saga" que nao queria dizer nada. Ai o numerado e
     * principal, e a ordem de capitulo faz o resto.
     */
    if (!franquiaTemEpisodios) return 'principal'
    const r = getItemReleaseTime(item)
    if (!r) return 'lateral'
    const ano = new Date(r).getUTCFullYear()
    return sagaAnos.some((a) => Math.abs(a - ano) <= JANELA_SAGA_ANOS)
      ? 'principal'
      : 'lateral'
  }

  /*
   * Sem numero de capitulo.
   *
   * Vem para o BLOCO LATERAL, e nao e descartado. Sao outras obras da mesma
   * franquia — "Star Wars: O Mandaloriano", "Star Wars: A Ascensao Skywalker",
   * "Star Wars Biornas" — e a pessoa que assiste o Episodio II tem motivo real
   * para ver que aquilo existe: e spin-off da mesma saga maior.
   *
   * Descartar escondia da gaveta um filme que existe e que a pessoa procuraria
   * por ali. O aviso do bloco lateral diz que nao e a continuacao, que e a
   * informacao que ela precisa.
   */
  if (subtituloRepeteRaiz(item.name)) return 'lateral'
  if (franquiaTemEpisodios) return 'lateral'
  return 'principal'
}

/**
 * Agrupa em SAGAS os filmes da mesma franquia do filme de referencia.
 *
 * Nao existe "numero de palavras da franquia": o agrupamento e por prefixo
 * (ver `mesmaFranquia`), o que faz a mesma regra valer para "Rambo 2",
 * "Rambo: Ate o Fim" e "Star Wars: O Mandaloriano" sem lista de casos.
 */
export function sagasDaFranquia(referencia: Channel, catalogo: Channel[]): Saga[] {
  const refPalavras = palavrasFranquia(referencia.name)
  if (refPalavras.length === 0) return []

  const anoRef = getItemReleaseTime(referencia)
  const anoRefNum = anoRef ? new Date(anoRef).getUTCFullYear() : 0
  const marca = marcaDistintiva(refPalavras)

  const mesmaRaiz = catalogo.filter((c) => {
    if (c.id === referencia.id) return false
    if (mesmaFranquia(refPalavras, palavrasFranquia(c.name))) return true
    /*
     * Segunda via: o NOME da franquia abre o subtitulo do candidato.
     * "Boruto: Naruto O Filme" pertence ao Naruto, e so isso pega ele.
     */
    const t = getItemReleaseTime(c)
    return marcaNoSubtitulo(
      marca,
      c.name,
      anoRefNum,
      t ? new Date(t).getUTCFullYear() : 0,
    )
  })
  if (mesmaRaiz.length === 0) return []

  /*
   * Anos dos filmes que marcam episodio. Delimitam o bloco principal: e por
   * eles que se sabe onde a saga lateral ("Star Wars 2..8") comeca.
   */
  const sagaAnos = mesmaRaiz
    .filter((c) => numeroEpisodio(c.name) != null)
    .map((c) => getItemReleaseTime(c))
    .filter((t) => t > 0)
    .map((t) => new Date(t).getUTCFullYear())

  const principal: Channel[] = []
  const laterais: Channel[] = []

  const franquiaTemEpisodios =
    mesmaRaiz.some((x) => numeroEpisodio(x.name) != null) ||
    numeroEpisodio(referencia.name) != null

  for (const c of mesmaRaiz) {
    const saga = classificacaoSaga(c, sagaAnos, franquiaTemEpisodios)
    if (saga === null) continue
    if (saga === 'principal') principal.push(c)
    else laterais.push(c)
  }

  const ordem = new Map<string, number>()
  catalogo.forEach((c, i) => ordem.set(c.id, i))

  const ordenar = (lista: Channel[]) =>
    /*
     * ORDEM DA SAGA.
     *
     * A regra que evita o embaralhamento: titulo COM numero de capitulo
     * forma uma ESPINHA continua e ordenada. Titulo SEM numero fica depois
     * dessa espinha, entre si.
     *
     * Sem isto, "Homem-Aranha: No Aranhaverso" (sem numero) e "Homem-Aranha 2"
     * (numero 2) davam 0 na comparacao — sem par — e caíam na posicao do
     * catalogo, que vem invertida. O resultado era "No Aranhaverso" no topo e
     * os 2 e 3 largados no meio, sem nenhuma leitura possivel.
     *
     * Cada grupo interno se ordena por episodio, depois numero de capitulo,
     * depois ano.
     */
    lista.sort((a, b) => {
      // 1. Numerados antes dos nao numerados (a espinha).
      const grupoA = temNumeroDeCapitulo(a.name) ? 0 : 1
      const grupoB = temNumeroDeCapitulo(b.name) ? 0 : 1
      if (grupoA !== grupoB) return grupoA - grupoB

      // 2. Dentro do grupo: episodio, capitulo e ano.
      const parEpisodio = comparaNumero(numeroEpisodio(a.name), numeroEpisodio(b.name))
      if (parEpisodio !== 0) return parEpisodio

      const parCapitulo = comparaNumero(numeroCapitulo(a.name), numeroCapitulo(b.name))
      if (parCapitulo !== 0) return parCapitulo

      const parAno = comparaNumero(getItemReleaseTime(a), getItemReleaseTime(b))
      if (parAno !== 0) return parAno

      // 3. Posicao no catalogo, como ultimo recurso.
      return (ordem.get(a.id) ?? 0) - (ordem.get(b.id) ?? 0)
    })

  const blocos: Saga[] = []
  if (principal.length > 0) blocos.push({ principal: true, filmes: ordenar(principal) })
  if (laterais.length > 0) blocos.push({ principal: false, filmes: ordenar(laterais) })
  return blocos
}

/**
 * Todos os filmes da mesma franquia, todas as sagas juntas.
 * Versao plana; o drawer usa `sagasDaFranquia` para manter os blocos.
 */
export function filmesDaMesmaFranquia(
  referencia: Channel,
  catalogo: Channel[],
): Channel[] {
  return sagasDaFranquia(referencia, catalogo).flatMap((s) => s.filmes)
}

/** Indica se o catalogo tem pelo menos um outro filme da mesma franquia. */
export function temOutroFilmeDaFranquia(
  referencia: Channel,
  catalogo: Channel[],
): boolean {
  return filmesDaMesmaFranquia(referencia, catalogo).length > 0
}