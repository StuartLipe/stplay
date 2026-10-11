/**
 * Teto de bytes do demuxer, por modo.
 *
 * POR QUE EXISTE UM ARQUIVO SO PARA ISSO. Estas duas constantes custaram uma
 * sessao de suspeita sem nenhuma medicao. Em algum momento o VOD caiu de 512MiB
 * para 96MiB e o `demuxer-readahead-secs` de 120 para 30, com um raciocinio no
 * comentario (`encher 256MB enquanto o decoder pede quadro engasga a
 * apresentacao`). O problema que o raciocinio resolvia JA TINHA PARADO — o
 * proprio registro da sessao diz isso. E o efeito colateral nao era hipotetico:
 * 96MiB sao ~30s de video, e qualquer oscilacao de rede acima disso vira
 * rebuffer visivel.
 *
 * Entao os dois numeros saoDUAS HIPOTESES opostas, e nenhuma foi medida:
 *
 *   teto pequeno  -> buffer curto -> acaba antes -> REBUFFER
 *   teto grande   -> aloca muito -> pode engasgar o decoder
 *
 * Escolher entre elas no codigo, sem numero, e o que produziu a duvida. Este
 * arquivo deixa a escolha num portao de ambiente: `STPLAY_VOD_MAX_BYTES` e
 * `STPLAY_VOD_READAHEAD_SECS`, com o valor original como padrao. Mede os dois,
 * e o que ganhar vira a constante.
 *
 * Nao ha fallback silencioso: valor invalido vira erro no boot, nao um numero
 * que ninguem sabe de onde saiu.
 */

const MiB = 1024 * 1024

/** Aceita `96MiB`, `512MiB`, `1GiB`, `268435456`. Devolve bytes, ou `null`. */
function parseBytes(valor) {
  if (typeof valor !== 'string') return null
  const m = valor.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kib|mib|gib)?$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const un = (m[2] || 'b').toLowerCase()
  const fator = un === 'gib' ? 1024 ** 3 : un === 'mib' ? MiB : un === 'kib' ? 1024 : 1
  return Math.round(n * fator)
}

/** Aceita `30`, `120`, `8.5`. Devolve segundos, ou `null`. */
function parseSegundos(valor) {
  if (typeof valor !== 'string') return null
  const n = Number(valor.trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Valor original, medido antes da mudanca: 512MiB e 120s.
 *
 * O padrao e o valor ANTIGO de proposito. Mudar de valor sem medicao e o que
 * criou a duvida; voltar ao padrao conhecido e o estado neutro, e a mudanca
 * volta a ser uma Flagship consciente.
 */
const VOD_MAX_BYTES_PADRAO = 512 * MiB
const VOD_READAHEAD_PADRAO = 120

function vodMaxBytes(env = process.env) {
  const bruto = env.STPLAY_VOD_MAX_BYTES
  if (!bruto) return VOD_MAX_BYTES_PADRAO
  const bytes = parseBytes(bruto)
  if (bytes === null) {
    throw new Error(
      `STPLAY_VOD_MAX_BYTES invalido: ${JSON.stringify(bruto)} — use 96MiB, 512MiB ou 268435456`,
    )
  }
  return bytes
}

function vodReadaheadSecs(env = process.env) {
  const bruto = env.STPLAY_VOD_READAHEAD_SECS
  if (!bruto) return VOD_READAHEAD_PADRAO
  const s = parseSegundos(bruto)
  if (s === null) {
    throw new Error(`STPLAY_VOD_READAHEAD_SECS invalido: ${JSON.stringify(bruto)} — use 30 ou 120`)
  }
  return s
}

/**
 * Inverso de `parseBytes`, e ESTAVEL.
 *
 * Estavel e o ponto: `diffProfile` compara por `===` contra o memo do que o mpv
 * confirmou. Se `formatBytes` devolvesse `536870912` num boot e `512MiB` no
 * seguinte, o memo nunca casaria, a property seria reenviada a cada carga, e o
 * `profileMemoSkipped` ficaria em zero sem ninguem saber por que.
 *
 * Entao: sempre `MiB`, sempre inteiro, nunca `GiB` para valor que cabe em MiB.
 */
function formatBytes(bytes) {
  const n = Math.round(Number(bytes))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`formatBytes: valor invalido ${bytes}`)
  if (n % MiB === 0) return `${n / MiB}MiB`
  return String(n)
}

/** Log do que foi resolvido, para o log responder a configuracao sem ler codigo. */
function descreverVodBuffer(env = process.env) {
  return {
    maxBytes: vodMaxBytes(env),
    readaheadSecs: vodReadaheadSecs(env),
    doPadrao: !env.STPLAY_VOD_MAX_BYTES && !env.STPLAY_VOD_READAHEAD_SECS,
  }
}

module.exports = {
  MiB,
  VOD_MAX_BYTES_PADRAO,
  VOD_READAHEAD_PADRAO,
  parseBytes,
  parseSegundos,
  formatBytes,
  vodMaxBytes,
  vodReadaheadSecs,
  descreverVodBuffer,
}
