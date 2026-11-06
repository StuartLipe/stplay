/*
 * Detecta a musicA DE ABERTURA no proprio arquivo, pelo audio.
 *
 * POR QUE ISSO EXISTE
 *
 * A AniSkip respondia com tempos que nao batem com o arquivo: para Attack on
 * Titan S01E01 ela diz que a abertura comeca em 0:47, e no arquivo comeca perto
 * de 1:20. Para Naruto Shippuden S01E01 ela diz que ha abertura em 0:03, e o
 * episodio nao tem abertura nenhuma.
 *
 * A causa e que a base e preenchida por gente, contra cortes diferentes: a
 * propria API devolve duracoes conflitantes para o MESMO episodio (25,67 min
 * no registro de "op", 24,12 min no de "ed"). Nenhuma API de terceiros acerta
 * isso. O audio do arquivo e a unica fonte que nao mente.
 *
 * COMO DECIDE
 *
 * Abrecao de anime tem energia alta E sustentada E grave presente. Dialogo tem
 * pausas, picos isolados e pouca energia grave. Medindo 10s a 10s os dois
 * casos ficam nitidamente separados:
 *
 *   Attack on Titan S01E01 (TEM abertura)
 *     1:20  rms 0.53  grave 0.69   <- abertura
 *     2:10  rms 0.69  grave 0.85   <- abertura
 *     2:20  rms 0.01  grave 0.01   <- terminou
 *     3:10  rms 0.34  grave 0.32   <- dialogo
 *
 *   Naruto Shippuden S01E01 (NAO tem)
 *     0:50  rms 0.42  grave 0.33   <- cena forte, mas nao sustenta
 *     5:40  rms 0.57  grave 0.54   <- pico isolado de ~10s
 *     resto rms 0.10-0.40
 *
 * Daí as duas condicoes: o trecho tem que passar de 40s E manter grave alto.
 * O pico de 10s do Naruto cai na primeira; o pedaco de 55s do Attack on Titan
 * passa nas duas.
 */

const { spawn } = require('child_process')
const { resolveFfmpegPath } = require('../ffmpeg-path.cjs')

const TAXA = 8000 // Hz, mono
const HOP = 0.02 // s por quadro
const AMOSTRAS_POR_QUADRO = Math.round(TAXA * HOP)

/*
 * Limiares. Todos medidos nos perfis reais de cima — mudar numero aqui exige
 * medir de novo contra episodio conhecido, senao o popup volta a errar.
 *
 * `GRAVE_MIN` e o que separa musica de dialogo, e e uma RAZAO, nao um nivel: a
 * energia de grave dividida pela energia total. Musica de abertura tem baixo
 * marcado; dialogo e agudo e disperso.
 *
 * Comparar o grave com o maximo dele nao funciona: normalizar os dois
 * separadamente joga fora justamente a proporcao, e ai qualquer som continuo
 * passa por musica.
 */
const SUAVIZACAO_S = 3 // janela da media movel, em segundos
const RMS_ENTRADA = 0.42 // energia que marca o comeco
const GRAVE_MIN = 0.45 // grave/total minimo para considerar musica
const RMS_SAIDA = 0.3 // energia que marca o fim
const DURACAO_MIN_S = 40 // aberturas de TV sao mais longas que isso
const DURACAO_MAX_S = 150 // e nao passam disso
/*
 * Uma musica nao e uma linha reta. A abertura tem refrões quietos, e a energia
 * cai por dois ou tres segundos varias vezes. Fechar a regiao no primeiro dip
 * cortava a abertura pela metade: era o que acontecia em 3 de 5 casos
 * medidos, e o resultado saia sempre com 40s — exatamente o minimo, porque
 * parava no primeiro degrau.
 *
 * Entao a regiao so fecha depois de `TOLERANCIA_S` seguidos ABAIXO do
 * limiar.
 *
 * O limiar NAO pode baixar muito: medindo 14 episodios do catalogo, com
 * limiar frouxo o detector passou a chamar o COMECO do arquivo de abertura em
 * 9 de 14 — o titulo de abertura, nao a musica. Preferir perder a abertura do
 * que oferecer pular para o titulo.
 */
const TOLERANCIA_S = 8

function caminhoFfmpeg() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN
  return resolveFfmpegPath()
}

/** Media movel simples, janela em quadros. */
function mediaMovel(valores, janela) {
  const saida = new Float32Array(valores.length)
  let soma = 0
  for (let i = 0; i < valores.length; i++) {
    soma += valores[i]
    if (i >= janela) soma -= valores[i - janela]
    saida[i] = soma / Math.min(i + 1, janela)
  }
  return saida
}

/**
 * Energia grave por quadro: passa-baixa de 1 polo em 250 Hz.
 *
 * Musica tem baixo marcado; dialogo e agudo e disperso. Um filtro simples
 * separa os dois sem precisar de FFT, que aqui seria exagero.
 */
function gravesPorQuadro(pcm) {
  const ALFA = 1 - Math.exp((-2 * Math.PI * 250) / TAXA)
  const quadros = Math.floor(pcm.length / AMOSTRAS_POR_QUADRO)
  const saida = new Float32Array(quadros)
  let z = 0
  let k = 0
  let acumulado = 0
  for (let i = 0; i < pcm.length; i++) {
    z += ALFA * (pcm[i] - z)
    acumulado += z * z
    if ((i + 1) % AMOSTRAS_POR_QUADRO === 0) {
      saida[k] = Math.sqrt(acumulado / AMOSTRAS_POR_QUADRO)
      acumulado = 0
      k++
    }
  }
  return saida
}

function rmsPorQuadro(pcm) {
  const quadros = Math.floor(pcm.length / AMOSTRAS_POR_QUADRO)
  const saida = new Float32Array(quadros)
  for (let q = 0; q < quadros; q++) {
    let soma = 0
    const base = q * AMOSTRAS_POR_QUADRO
    for (let i = 0; i < AMOSTRAS_POR_QUADRO; i++) soma += pcm[base + i] * pcm[base + i]
    saida[q] = Math.sqrt(soma / AMOSTRAS_POR_QUADRO)
  }
  return saida
}

/**
 * Procura a abertura no PCM ja decodificado.
 *
 * Devolve `{ inicio, fim }` em segundos, ou `null`. `null` e a resposta
 * correta para episodio sem abertura — e nao e erro.
 */
function detectarAberturaNoPcm(pcm) {
  const rms = mediaMovel(rmsPorQuadro(pcm), Math.max(1, Math.round(SUAVIZACAO_S / HOP)))
  const graves = mediaMovel(gravesPorQuadro(pcm), Math.max(1, Math.round(SUAVIZACAO_S / HOP)))

  let maxRms = 0
  for (let i = 0; i < rms.length; i++) if (rms[i] > maxRms) maxRms = rms[i]
  if (maxRms <= 0) return null

  const nRms = new Float32Array(rms.length)
  const razaoGrave = new Float32Array(rms.length)
  for (let i = 0; i < rms.length; i++) {
    nRms[i] = rms[i] / maxRms
    // Grave sobre total: música tem a energia concentrada embaixo.
    razaoGrave[i] = rms[i] > 1e-6 ? graves[i] / rms[i] : 0
  }

  const MIN = Math.round(DURACAO_MIN_S / HOP)
  const MAX = Math.round(DURACAO_MAX_S / HOP)
  const TOLERANCIA = Math.round(TOLERANCIA_S / HOP)

  let inicio = -1
  let abaixo = 0
  let melhor = null

  for (let i = 0; i < nRms.length; i++) {
    const alto = nRms[i] >= RMS_ENTRADA && razaoGrave[i] >= GRAVE_MIN

    if (alto) {
      if (inicio < 0) inicio = i
      abaixo = 0
    } else if (inicio >= 0) {
      abaixo++
      if (abaixo >= TOLERANCIA) {
        const fimReal = i - abaixo
        if (fimReal - inicio >= MIN) {
          melhor = { inicio, fim: fimReal }
          break
        }
        // Trecho curto demais: nao era abertura, procura de novo.
        inicio = -1
        abaixo = 0
      }
    }

    if (inicio >= 0 && i - inicio > MAX) {
      melhor = { inicio, fim: inicio + MAX }
      break
    }
  }

  if (!melhor && inicio >= 0 && nRms.length - inicio >= MIN) {
    // O trecho chega no fim da analise sem cair: aceita o que tem.
    melhor = { inicio, fim: nRms.length - 1 }
  }
  if (!melhor) return null

  /*
   * NAO recua o inicio.
   *
   * Experimentei recuar ate 60s para pegar a intr instrumental fraca, e o
   * resultado ficou pior: o detector passou a chamar o COMECO do arquivo (o
   * titulo de abertura, que tem energia alta) de abertura, em 9 de 14
   * episodios. Preferir perder a abertura do que oferecer pular para o
   * titulo.
   */
  const comeco = melhor.inicio

  // Estende o fim enquanto a energia segurar: a musica costuma ir alem do
  // trecho que passou no limiar.
  let fim = melhor.fim
  const teto = Math.min(nRms.length - 1, melhor.inicio + Math.round(200 / HOP))
  while (fim + 1 <= teto && nRms[fim + 1] >= RMS_SAIDA) fim++

  return { inicio: comeco * HOP, fim: fim * HOP }
}

/**
 * Roda a analise em segundo plano sobre a URL do episodio.
 *
 * O ffmpeg decodifica so o audio, em mono 8 kHz — o suficiente para a faixa de
 * graves. A leitura roda ~7x mais rapido que o video, entao o resultado fica
 * pronto muito antes de a pessoa chegar na abertura.
 *
 * `aoDetectar` dispara uma vez, com `{ inicio, fim }` ou `null`.
 */
function analisarAbertura(url, { aoDetectar, aoErro, limiteSegundos = 420 } = {}) {
  const ffmpeg = caminhoFfmpeg()
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-t',
    String(limiteSegundos),
    '-i',
    url,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(TAXA),
    '-f',
    's16le',
    '-',
  ]

  let proc
  try {
    proc = spawn(ffmpeg, args, { windowsHide: true })
  } catch (e) {
    aoErro?.(e)
    return { parar() {} }
  }

  let partes = []
  let totalAmostras = 0
  let decidido = false
  let morreu = false

  const analisar = () => {
    if (decidido || morreu || partes.length === 0) return
    const buf = Buffer.concat(partes)
    if (buf.length < (TAXA * 2 * DURACAO_MIN_S) / 4) return

    const pcm = new Float32Array(buf.length >> 1)
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768

    const achado = detectarAberturaNoPcm(pcm)
    // So decide quando a musica ja TerminOU: antes disso o fim ainda nao
    // aconteceu e o "pular para" seria chute.
    if (!achado) return

    decidido = true
    aoDetectar?.(achado)
    parar()
  }

  proc.stdout.on('data', (bloco) => {
    if (decidido || morreu) return
    partes.push(bloco)
    totalAmostras += bloco.length >> 1
    // Analisa a cada ~10s de audio novo, para nao refazer o trabalho sempre.
    if (totalAmostras % (TAXA * 10) < (TAXA * 2)) analisar()
  })

  proc.on('error', (e) => {
    morreu = true
    aoErro?.(e)
  })

  proc.on('close', () => {
    if (decidido) return
    // Chegou no fim do trecho analisado sem decidir: o que viu e a melhor
    // resposta disponivel. `null` significa "nenhuma abertura aqui".
    morreu = true
    if (partes.length) analisar()
    if (!decidido) {
      decidido = true
      aoDetectar?.(null)
    }
  })

  function parar() {
    if (morreu) return
    morreu = true
    try {
      proc.kill()
    } catch {
      // ja morreu
    }
  }

  return { parar }
}

module.exports = {
  analisarAbertura,
  detectarAberturaNoPcm,
  // Exportado para os testes poderem montar o proprio sinal.
  _internos: { HOP, TAXA, rmsPorQuadro, gravesPorQuadro, mediaMovel },
}