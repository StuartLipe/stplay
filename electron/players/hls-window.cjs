/**
 * JANELA HLS CANONICA — a correcao do congelamento de live.
 *
 * MEDIDO (a causa, nao teoria):
 *
 * O painel nao publica uma playlist canonica. Em 24 pedidos consecutivos a
 * 1,5s do MESMO canal:
 *
 *   respostas lidas: 24
 *   conjuntos de URL distintos: 24
 *   respostas que compartilharam >=1 segmento com a anterior: 0/23
 *   por MEDIA-SEQUENCE, quantos conjuntos distintos apareceram:
 *     seq 226 -> 4     seq 227 -> 5     seq 228 -> 6     seq 229 -> 5
 *
 * Ou seja: cada GET devolve uma janela de 6 segmentos recem-mintada, com tokens
 * novos, e duas respostas consecutivas nao tem NENHUM segmento em comum. A
 * sequencia avanca (~1 a cada 10s, batendo com TARGETDURATION=11), mas ela nao
 * identifica nada: o mesmo numero de sequencia devolve conteudo diferente.
 *
 * POR QUE ISSO QUEBRA O mpv E NAO O hls.js:
 *
 *   - hls.js identifica segmento por URL. Ele so pergunta "qual URL eu ainda
 *     nao tenho?". Uma janela 100% nova a cada pedido e inofensiva: ele apenas
 *     continua baixando URLs novas, e nunca tem lacuna para reconciliar.
 *   - O demuxer HLS do ffmpeg (o do mpv) identifica segmento pelo NUMERO DE
 *     SEQUENCIA e mantem contabilidade de janela deslizante. Ele acredita que ja
 *     baixou os numeros que ja viu, entao quando a sequencia avanca com URLs sem
 *     relacao com ela, ele pula o conteudo novo.
 *
 * O resultado medido no mpv, sem nenhuma interferencia do app:
 *
 *   t=0    time-pos 48.07   demuxer-cache-time 56.30
 *   t=11   time-pos 59.11   demuxer-cache-time 59.95
 *   t=14   time-pos 60.05   demuxer-cache-time 59.97
 *   t=16   time-pos 60.05   demuxer-cache-time 59.97   <- PARA
 *   CONGELOU em 25s, buffer 100%
 *
 * `time-pos` 60.05 e `demuxer-cache-time` 59.97 sao o mesmo numero: o playhead
 * esta no fim do cache, e o cache parou de crescer porque o demuxer parou de
 * buscar. Nao e VO, nao e apresentacao, nao e `--wid`, nao e buffer, nao e rede.
 *
 * O QUE ESTE MODULO FAZ: reconstroi uma playlist canonica por cima. Numbers de
 * sequencia proprios, monotonicos, e um URL estavel por numero. O ffmpeg recebe
 * o que ele sabe consumir.
 */

/** @typedef {{ dur: number, uri: string, key: string }} PanelSegment */

const PADRAO = {
  /** Segmentos publicados por vez. O painel usa 6; 8 da folga. */
  windowSize: 8,
  /** Quantos numeros de sequencia guardar apos sairem da janela (fetch atrasado). */
  lruSize: 160,
}

/**
 * Extrai segmentos de um manifesto de midia.
 *
 * @param {string} m3u texto do manifesto
 * @returns {{ mediaSequence: number|null, targetDuration: number, segments: PanelSegment[] }|null}
 */
function parseManifest(m3u) {
  if (typeof m3u !== 'string' || !m3u.includes('#EXTM3U')) return null
  const linhas = m3u.split(/\r?\n/)
  const seqM = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(m3u)
  const tdM = /#EXT-X-TARGETDURATION:([\d.]+)/.exec(m3u)
  const segments = []
  let durPendente = null
  for (const bruta of linhas) {
    const l = bruta.trim()
    if (!l) continue
    if (l.startsWith('#EXTINF:')) {
      durPendente = parseFloat(l.slice(8).split(',')[0])
      continue
    }
    if (l.startsWith('#')) continue
    if (durPendente === null) durPendente = 0
    segments.push({ dur: Number.isFinite(durPendente) ? durPendente : 0, uri: l, key: '' })
    durPendente = null
  }
  if (!segments.length) return null
  return {
    mediaSequence: seqM ? Number(seqM[1]) : null,
    targetDuration: tdM ? Number(tdM[1]) : 0,
    segments,
  }
}

/**
 * Estado inicial da janela.
 *
 * @param {{ windowSize?: number, lruSize?: number }} [opts]
 */
function createWindowState(opts = {}) {
  return {
    windowSize: opts.windowSize || PADRAO.windowSize,
    lruSize: opts.lruSize || PADRAO.lruSize,
    /**Ultimo #EXT-X-MEDIA-SEQUENCE visto no painel. */
    panelSeq: null,
    /** Sequencia propria do segmento mais antigo publicado. */
    baseSeq: 0,
    /** Segmentos publicados, do mais antigo para o mais novo. */
    segmentos: [],
    /** seq -> uri, para resolver fetch de um segmento que ja saiu da janela. */
    lru: new Map(),
    /** Quantas vezes o painel TRouxe conteudo novo. Util para diagnostico. */
    publicados: 0,
    inicializado: false,
  }
}

/**
 * Tirar da frente da janela NAO e jogar fora: o segmento continua valendo e
 * precisa ser resolvivel por um fetch que chegou atrasado.
 *
 * BUG QUE ISTO CORRIGE: o LRU era alimentado so pelo truncamento do fim, e nao
 * pelo deslizamento. Um segmento que saia da janela porque a do painel deslizou
 * sumia do estado e voltava 404 no proxy. Fetch atrasado do ffmpeg e a regra
 * normal em HLS ao vivo — a janela anda mais rapido do que o cliente pede.
 */
function descartar(state, segmentos) {
  for (const s of segmentos) state.lru.set(s.seq, s.uri)
  if (segmentos.length) state.baseSeq = segmentos[segmentos.length - 1].seq + 1
  while (state.lru.size > state.lruSize) {
    const maisAntigo = state.lru.keys().next().value
    state.lru.delete(maisAntigo)
  }
}

/**
 * Alinha o manifesto do painel na janela canonica.
 *
 * O painel desliza a janela eincrementa a sequencia. Se `d` segmentos sairam da
 * cauda, os `d` ultimos do painel sao conteudo novo. Como as URLs nao tem
 * relacao com a sequencia do painel, a identidade do segmento vem da POSICAO
 * relativa a cauda, nunca do numero.
 *
 * @param {object} state estado de `createWindowState` (mutado)
 * @param {{ mediaSequence: number|null, targetDuration: number, segments: PanelSegment[] }} painel
 * @returns {{ state: object, novos: number, motivo: string }}
 */
function alinhar(state, painel) {
  const w = state.windowSize
  let novos = 0
  let motivo = ''

  if (!state.inicializado) {
    // Primeira leitura: publica a cauda da janela do painel. Sem history para
    // alinhar, entao pega os `w` mais recentes e da sequencia 1 em diante.
    const inicial = painel.segments.slice(-w)
    state.baseSeq = 1
    state.segmentos = inicial.map((seg, i) => ({ seq: 1 + i, dur: seg.dur, uri: seg.uri }))
    novos = inicial.length
    motivo = 'primeira leitura'
    state.inicializado = true
  } else {
    const d =
      Number.isFinite(painel.mediaSequence) && Number.isFinite(state.panelSeq)
        ? painel.mediaSequence - state.panelSeq
        : NaN

    if (Number.isFinite(d) && d > 0 && d < state.segmentos.length) {
      // Deslizou `d`: os `d` ultimos do painel sao novos. Os `d` mais antigos
      // meus saem da frente — mas vao para o LRU, nao para o lixo (ver
      // `descartar`).
      const bringing = painel.segments.slice(-d)
      descartar(state, state.segmentos.slice(0, d))
      const ultimo = state.segmentos.length ? state.segmentos[state.segmentos.length - 1].seq : state.baseSeq - 1
      for (const seg of bringing) {
        state.segmentos.push({ seq: ultimo + 1, dur: seg.dur, uri: seg.uri })
        novos += 1
      }
      motivo = `painel deslizou ${d}`
    } else {
      // Sequencia nao avançou (ou pulou/regrediu de forma nao confiavel).
      // Alguns paineis mintem a sequencia, entao o teste que vale e: o segmento
      // MAIS NOVO do painel mudou? Se mudou, ele e conteudo novo.
      const ultimoPainel = painel.segments[painel.segments.length - 1]
      const meuNovo = state.segmentos[state.segmentos.length - 1]
      if (ultimoPainel && (!meuNovo || ultimoPainel.uri !== meuNovo.uri)) {
        const ultimo = meuNovo ? meuNovo.seq : state.baseSeq - 1
        state.segmentos.push({ seq: ultimo + 1, dur: ultimoPainel.dur, uri: ultimoPainel.uri })
        novos = 1
        motivo = 'cauda mudou sem a sequencia andar'
      } else {
        motivo = 'painel nao trouxe nada novo'
      }
    }
  }

  // Trunca a janela (so quando ela cresce alem do limite; o deslizamento ja
  // descartou o que tinha que sair).
  if (state.segmentos.length > w) descartar(state, state.segmentos.splice(0, state.segmentos.length - w))

  if (Number.isFinite(painel.mediaSequence)) state.panelSeq = painel.mediaSequence
  state.publicados += novos
  return { state, novos, motivo }
}

/**
 * Serializa a janela como um manifesto de midia CANONICO.
 *
 * @param {object} state
 * @param {(seq: number) => string} urlPara  monta a URL estavel de um segmento
 */
function escreverManifesto(state, urlPara) {
  if (!state.segmentos.length) {
    return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n#EXT-X-MEDIA-SEQUENCE:0\n'
  }
  const primeiro = state.segmentos[0]
  const td = Math.max(
    1,
    Math.ceil(Math.max(...state.segmentos.map((s) => s.dur || 0), state.targetDuration || 0)),
  )
  const linhas = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${td}`,
    `#EXT-X-MEDIA-SEQUENCE:${primeiro.seq}`,
  ]
  for (const s of state.segmentos) {
    linhas.push(`#EXTINF:${(s.dur || 0).toFixed(6)},`)
    linhas.push(urlPara(s.seq))
  }
  return linhas.join('\n') + '\n'
}

/** Resolve o URI de origem de um numero de sequencia, janela ou LRU. */
function uriDe(state, seq) {
  const naJanela = state.segmentos.find((s) => s.seq === seq)
  if (naJanela) return naJanela.uri
  return state.lru.get(seq) || null
}

module.exports = {
  PADRAO,
  parseManifest,
  createWindowState,
  alinhar,
  escreverManifesto,
  uriDe,
}
