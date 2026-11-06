/**
 * Consulta a API da AniSkip para obter os tempos de abertura (op) e
 * encerramento (ed) de um episódio.
 *
 * Endpoint: GET https://api.aniskip.com/v1/skip-times/{malId}/{episodio}?types[]=op&types[]=ed
 *
 * Atenção ao formato: a API **não** devolve `{ intro, outro }`. Ela devolve
 * uma lista de resultados, cada um com o `skip_type` e o intervalo:
 *
 * {
 *   "found": true,
 *   "results": [
 *     { "interval": { "start_time": 47.365, "end_time": 137.365 },
 *       "skip_type": "op", "skip_id": "...", "episode_length": 1540.061 },
 *     { "interval": { "start_time": 1342.795, "end_time": 1430.616 },
 *       "skip_type": "ed", "skip_id": "...", "episode_length": 1446.997 }
 *   ]
 * }
 *
 * `start_time`/`end_time` são segundos contados do início do vídeo, então
 * servem direto para comparar com a posição de playback.
 *
 * A v2 (`/v2/skip-times`) exige `episodeLength` e responde 404 mesmo para
 * episódios que existem na v1 — por isso o código usa a v1.
 */
import { OPED_POR_MAL } from './oped-data.ts'

export interface SkipInterval {
  start: number
  end: number
}

export interface SkipTimes {
  intro: SkipInterval | null
  outro: SkipInterval | null
  /**
   * De onde veio. 'local' = mapa embutido conferido (início exato, não deve
   * ser misturado com a detecção de áudio do player).
   */
  source?: 'local' | 'aniskip'
  /** Segundos do fim do arquivo até o começo do ED (âncora estável). */
  edTail?: number
  /** Duração do arquivo em que a marcação foi medida. */
  len?: number
}

const ANISKIP_BASE = 'https://api.aniskip.com/v1'

interface AniSkipResult {
  interval?: { start_time?: number; end_time?: number }
  skip_type?: string
  /** Duração do episódio, em segundos, segundo a própria AniSkip. */
  episode_length?: number
}

interface AniSkipResponse {
  found?: boolean
  results?: AniSkipResult[]
}

/*
 * Guardas de sanidade, em fração da duração do episódio.
 *
 * A AniSkip é alimentada pela comunidade e tem dado ruim publicado. O exemplo
 * real que motivou isto: Naruto Shippuden S01E01 devolve encerramento começando
 * em 8:29 de um episódio de 23 minutos (36%), e Solo Leveling S01E01 devolve
 * 3:31 (14%). Pular para lá joga a pessoa no meio da história.
 *
 * Os dois limites são propositalmente diferentes:
 *
 *   - Encerramento tem de começar nos últimos 30%. Um ED começa antes disso
 *     quase sempre é entrada errada. O caso bom mais apertado que apareceu no
 *     catálogo foi 86% — sobra folga.
 *   - Abertura pode chegar a 25%: existe abertura longa de verdade, e Chainsaw
 *     Man S01E03 abre em 4:36 de um episódio de 25 minutos (18%).
 *
 * O `episode_length` vem na própria resposta, então nada aqui depende de saber
 * a duração do vídeo no player.
 */
const INTRO_MAXIMO = 0.25
const OUTRO_MINIMO = 0.7
const MARGEM = 5 // segundos de folga antes de cortar fora

function toInterval(
  interval: { start_time?: number; end_time?: number } | undefined,
  tipo: 'op' | 'ed',
  duracaoEpisodio: number | undefined
): SkipInterval | null {
  const start = interval?.start_time
  const end = interval?.end_time
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end <= start) return null

  // Duração desconhecida: não dá para descartar nada.
  if (typeof duracaoEpisodio !== 'number' || !(duracaoEpisodio > 0)) {
    return { start, end }
  }

  if (tipo === 'op') {
    if (start > INTRO_MAXIMO * duracaoEpisodio + MARGEM) return null
  } else {
    if (start < OUTRO_MINIMO * duracaoEpisodio - MARGEM) return null
  }
  // O intervalo inteiro tem de caber no episódio.
  if (end > duracaoEpisodio + MARGEM) return null

  return { start, end }
}

/**
 * Converte a resposta crua da AniSkip no formato usado pelo player.
 * Retorna null quando não há nenhuma janela utilizável.
 */
export function parseSkipResponse(data: unknown): SkipTimes | null {
  const results = (data as AniSkipResponse | null)?.results
  if (!Array.isArray(results) || results.length === 0) return null

  let intro: SkipInterval | null = null
  let outro: SkipInterval | null = null

  for (const item of results) {
    const tipo =
      item?.skip_type === 'op' || item?.skip_type === 'mixed-op'
        ? 'op'
        : item?.skip_type === 'ed' || item?.skip_type === 'mixed-ed'
          ? 'ed'
          : null
    if (!tipo) continue

    const interval = toInterval(item?.interval, tipo, item?.episode_length)
    if (!interval) continue
    if (tipo === 'op' && !intro) intro = interval
    if (tipo === 'ed' && !outro) outro = interval
  }

  if (!intro && !outro) return null
  return { intro, outro }
}

/**
 * Marcação embutida, gerada pelo oped-finder. Só entra aqui o que foi
 * conferido: início da OP num corte de cena real, duração plausível e sem
 * estimativa. Sem entrada aqui, o app segue para a AniSkip oficial.
 *
 * O mapa é indexado pelo MAL ID da série, que é o da 1ª temporada. Por isso
 * `season` existe: em temporada ≥ 2 os tempos são outros, e usar os da 1ª
 * daria pulo errado — nesse caso é melhor não usar o mapa.
 */
function doMapaLocal(
  malId: string | number,
  episodeNumber: number | string,
  season?: number | null
): SkipTimes | null {
  const porTemporada = OPED_POR_MAL[String(malId)]
  if (!porTemporada) return null

  /*
   * Temporada: '1'/'2' vêm do nome do episódio. '*' é a série que só tem uma
   * temporada no mapa. Temporada 2 NUNCA cai na 1: são aberturas diferentes.
   */
  const chave = typeof season === 'number' ? String(season) : '*'
  const eps = porTemporada[chave] ??
    (chave === '1' || chave === '*' ? porTemporada['*'] : undefined)
  if (!eps) return null

  const numero = Number(episodeNumber)
  if (!Number.isFinite(numero)) return null
  const ep = eps[String(numero)]
  if (!ep) return null

  const results: AniSkipResult[] = []
  if (ep.op) {
    results.push({
      interval: { start_time: ep.op.start, end_time: ep.op.end },
      skip_type: 'op',
      episode_length: ep.len,
    })
  }
  if (ep.ed) {
    results.push({
      interval: { start_time: ep.ed.start, end_time: ep.ed.end },
      skip_type: 'ed',
      episode_length: ep.len,
    })
  }
  const parsed = parseSkipResponse({ found: true, results })
  return parsed
    ? { ...parsed, source: 'local', edTail: ep.ed_tail, len: ep.len }
    : null
}

/**
 * Consulta remota à AniSkip oficial: DESLIGADA.
 *
 * O app usa só o mapa embutido (`oped-data.ts`), que foi conferido contra
 * cortes de cena reais. Sem entrada ali, nenhum popup aparece — a AniSkip da
 * comunidade já publicou início de abertura dezenas de segundos fora, e pular
 * para o lugar errado é pior do que não oferecer o atalho.
 *
 * Para voltar a usar a AniSkip, mude para true.
 */
const USAR_ANISKIP_REMOTO = false

export async function getSkipTimes(
  malId: string | number,
  episodeNumber: number | string,
  season?: number | null
): Promise<SkipTimes | null> {
  const local = doMapaLocal(malId, episodeNumber, season)
  if (local) return local
  if (!USAR_ANISKIP_REMOTO) return null

  try {
    const types = 'types[]=op&types[]=ed'
    const url = `${ANISKIP_BASE}/skip-times/${encodeURIComponent(String(malId))}/${encodeURIComponent(
      String(episodeNumber)
    )}?${types}`

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      // Timeout curto para não travar o player se a API estiver fora.
      signal: AbortSignal.timeout(5000),
    })

    // 404 = a AniSkip não tem dados para este episódio. Não é erro.
    if (!res.ok) return null

    const parsed = parseSkipResponse(await res.json())
    return parsed ? { ...parsed, source: 'aniskip' } : null
  } catch {
    // Falha de rede, timeout, JSON inválido — nunca bloqueia o player.
    return null
  }
}

export function extractSeasonNumber(name: string): number | null {
  const value = String(name ?? '')

  const sxe = value.match(/[Ss](\d{1,2})[\s._-]*[Ee]\d{1,4}/)
  if (sxe) return Number(sxe[1])

  const temporada = value.match(/[Tt]emporada[\s._-]*(\d{1,2})/)
  if (temporada) return Number(temporada[1])

  return null
}

/**
 * Extrai o número do episódio a partir do nome.
 *
 * Cobre os formatos que aparecem no servidor Xtream e em fontes mais
 * genéricas: "S01E02", "E02", "Episódio 5", "05", "Naruto Shippuden - 12".
 * Retorna null quando não há número reconhecível.
 */
export function extractEpisodeNumber(name: string): number | null {
  const value = String(name ?? '')

  const sxe = value.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4})/)
  if (sxe) return Number(sxe[2])

  const ep = value.match(/[Ee](?:p|pisode|s[óo]dio|s[óo]dio)?[\s._-]*(\d{1,4})\b/)
  if (ep) return Number(ep[1])

  const spelled = value.match(/[Ee]pis[óo]dio[\s._-]*(\d{1,4})\b/)
  if (spelled) return Number(spelled[1])

  // Só aceita número solto se a string não for só dígitos (senão "2273444"
  // vira episódio 344).
  const trailing = value.match(/[\s._-](\d{1,4})$/)
  if (trailing) return Number(trailing[1])

  return null
}