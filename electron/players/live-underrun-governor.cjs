/**
 * GOVERNADOR DE UNDERRUN: QUANDO A ORIGEM NAO ALIMENTA, O APP CRUA COLCHAO.
 *
 * O sintoma que o dono reportou: "depois de 1 min assistindo dá umas travadas, tipo
 * gargalando". Nao era o painel, e o proprio `playback-profile.cjs` ja tinha o
 * registro que explica o mecanismo:
 *
 *   `cache-pause-wait` grande e o que produz PAUSA VISIVEL
 *   `cache-secs=8`  o original, de proposito: mexer aqui nao muda nada
 *
 * Como o live roda com `cache-pause=yes` + `cache-secs=8` + `demuxer-readahead-secs=8`,
 * o demuxer so pode olhar 8 s a frente. Quando a origem entrega em rajada — burst
 * de segmentos, intervalo morto, CDN que segura a resposta — o cache encosta no
 * limiar, o `cache-pause` segura o stream ate encher, e o resultado e exatamente
 * "gargalhando": cada quadro esta bom, mas entre eles a imagem para. E o playback
 * nunca para de verdade, entao o usuario ve "o canal continua rodando".
 *
 * POR QUE UM GOVERNADOR E NAO UM NUMERO NOVO NO PERFIL.
 *
 * Os numeros do perfil foram medidos num painel so. O dono usa mais de um, e a
 * qualidade da origem muda entre eles e muda com o horario. Um numero fixo
 * acertado num servidor e errado no outro — e foi exatamente o que aconteceu antes:
 * a troca de 512MiB para 96MiB no VOD aconteceu sem medicao, e o comentario do
 * `stur-player.cjs` registra o preco ("o problema ja tinha parado, a troca nao
 * resolveu nada, ninguem voltou a medir").
 *
 * A saida e fechar o loop: o app conta quantas vezes o `cache-pause` segurou o
 * stream, e quando o numero diz "esta origem nao me alimenta", ele AUMENTA o
 * readahead para poder construir um colchao. Num servidor bom o degrau fica no
 * primeiro e o canal abre rapido, como sempre. Num servidor ruim o colchao cresce
 * e o gargalho acaba. Ninguem precisa saber qual é o servidor.
 *
 * POR QUE SOBE E NAO DESCE.
 *
 * Descer seria oscilar: subir, o gargalho passa, descer, o gargalho volta. O
 * instalo fica instavel e o usuario ve o problema ir e vir. Uma sessao comeca
 * baixa (entrada rapida) e sobe se a origem provar que precisa. O rebaixamento
 * acontece no proximo `loadfile`, que ja recalcula o perfil do zero.
 *
 * POR QUE NAO MEXE EM `cache-pause-wait`.
 *
 * Porque o arquivo registra que aumentar o wait e o que produz pausa VISIVEL —
 * foi medido (`wait=10` deu 13 pausas). O gargalho nao se resolve segurando mais
 * tempo a cada underrun; resolve-se tendo bytes de sobra para nunca chegar no
 * underrun.
 */

/** Degraus do TETO do cache (demuxer-readahead-secs), em segundos. */
const DEGRAUS = [8, 16, 32, 60, 90]

/**
 * O GATILHO DA PAUSA (`cache-secs`) FICA FIXO — E ISTO E A CORRECAO.
 *
 * Medido, do jeito difícil: subir `cache-secs` junto com o teto fez o canal
 * garralhar MAIS, não menos — "agora trava a cada alguns segundos". A causa é a
 * relação entre os dois:
 *
 *   `demuxer-readahead-secs`  TETO: até onde o demuxer pode ler à frente
 *   `cache-secs`              GATILHO: abaixo disto o `cache-pause` segura o stream
 *
 * Este arquivo subia os dois para o mesmo valor. Com os dois em 8, o demuxer tenta
 * manter o cache em 8 e segura quando não alcança. Com os dois em 16, ele tenta
 * manter em **16** — e uma origem que entrega perto do tempo real com rajada nunca
 * chega lá. Resultado: o gatilho disparava duas vezes mais vezes, e o que era uma
 * travada por minuto virou uma a cada poucos segundos.
 *
 * Couplados, os dois números não têm direção: subir o "colchão" também sobe a
 * linha de alarme. Desacoplados, o colchão cresce e a linha fica onde foi medida.
 *
 * Por que 8: é o valor medido no perfil (`LIVE_CACHE_SECS`), o mesmo que rodava
 * antes de este governador existir, e o que dava menos pausas.
 */
const CACHE_SECS_FIXO = 8

/**
 * Underruns dentro da janela antes de subir um degrau.
 *
 * Tres e nao um: uma pausa isolada é jitter de rede, que todo mundo tem, e subir
 * o buffer por causa dela custaria entrada lenta de canal sem motivo. Tres
 * pausinhas em 30 s e um padrão, não é ruído.
 */
const PAUSAS_PARA_SUBIR = 3

/** Janela da contagem. */
const JANELA_MS = 30_000

/**
 * Intervalo mínimo entre mudanças.
 *
 * O demuxer precisa de alguns segundos para encher o readahead novo; subir degrau
 * a cada tique só geraria uma escalada que nunca chega a encher nada.
 */
const ENTRE_MUDANCAS_MS = 15_000

/**
 * Decide se o readahead sobe um degrau. Puro: recebe o historico e devolve a
 * resposta, sem tocar em mpv nem no tempo do processo.
 *
 * @param {object} estado
 * @param {number[]} estado.pausas      timestamps (ms) dos underruns
 * @param {number}   estado.degrau      indice em DEGRAUS
 * @param {number}   estado.agoraMs
 * @returns {{degrau: number, readaheadSecs: number, cacheSecs: number, subiu: boolean, motivo: string, naJanela: number}}
 */
function decidir({ pausas = [], degrau = 0, agoraMs = 0 }) {
  const teto = DEGRAUS.length - 1
  const atual = Math.min(Math.max(degrau, 0), teto)
  const naJanela = pausas.filter((t) => agoraMs - t <= JANELA_MS)

  if (atual >= teto) {
    return {
      degrau: atual,
      readaheadSecs: DEGRAUS[atual],
      cacheSecs: CACHE_SECS_FIXO,
      subiu: false,
      motivo: `ja no degrau maximo (${DEGRAUS[atual]}s)`,
      naJanela: naJanela.length,
    }
  }

  if (naJanela.length < PAUSAS_PARA_SUBIR) {
    return {
      degrau: atual,
      readaheadSecs: DEGRAUS[atual],
      cacheSecs: CACHE_SECS_FIXO,
      subiu: false,
      motivo: `underruns na janela: ${naJanela.length}/${PAUSAS_PARA_SUBIR}`,
      naJanela: naJanela.length,
    }
  }

  const proximo = atual + 1
  return {
    degrau: proximo,
    readaheadSecs: DEGRAUS[proximo],
    cacheSecs: CACHE_SECS_FIXO,
    subiu: true,
    motivo: `${naJanela.length} underruns em ${JANELA_MS / 1000}s — origem nao esta alimentando; readahead ${DEGRAUS[atual]}s -> ${DEGRAUS[proximo]}s`,
    naJanela: naJanela.length,
  }
}

/** Estado do governador. Um por motor, criado no boot e zerado no loadfile. */
function criarGovernador() {
  return { pausas: [], degrau: 0, ultimaMudancaMs: 0, subiuAlgumaVez: false }
}

/**
 * Registra um underrun. `agoraMs` entra explícito para o teste poder avançar o
 * relógio sem `Date.now()` — o histórico de pausas é a única entrada do cálculo.
 */
function registrarUnderrun(gov, agoraMs) {
  gov.pausas.push(agoraMs)
  // Janela deslizante: descartar o que ja saiu evita o array crescer a sessao toda.
  gov.pausas = gov.pausas.filter((t) => agoraMs - t <= JANELA_MS)
  return gov
}

/**
 * Consulta o governador e, se ele mandar subir, devolve o comando a mandar.
 * Devolve `null` quando nao ha mudanca — que e o caso comum, e nao deve gerar
 * trafego no pipe do mpv.
 */
function proximaAcao(gov, agoraMs) {
  if (agoraMs - gov.ultimaMudancaMs < ENTRE_MUDANCAS_MS) return null
  const d = decidir({ pausas: gov.pausas, degrau: gov.degrau, agoraMs })
  if (!d.subiu) return null
  gov.degrau = d.degrau
  gov.ultimaMudancaMs = agoraMs
  gov.subiuAlgumaVez = true
  // A janela zera: subir e a resposta para o que ja foi visto. Sem isso, o
  // proximo tique veria as mesmas 3 pausinhas e subiria de novo.
  gov.pausas = []
  return d
}

module.exports = {
  DEGRAUS,
  CACHE_SECS_FIXO,
  PAUSAS_PARA_SUBIR,
  JANELA_MS,
  ENTRE_MUDANCAS_MS,
  decidir,
  criarGovernador,
  registrarUnderrun,
  proximaAcao,
}
