const fs = require('fs')
const path = require('path')

/**
 * Escritor de log em buffer.
 *
 * O problema que este modulo resolve: o log de diagnostico usava
 * `appendFileSync` e, ainda pior, refazia `existsSync` + `statSync` +
 * `mkdirSync` a CADA LINHA. Um unico `log.info` custava quatro syscalls
 * sincronas — tres de metadados, mais open/write/close — tudo no processo
 * principal do Electron, que e single-threaded. O log do player dispara 5-6
 * vezes por zape, mais os ticks de watchdog e de buffering, entao o custo nao
 * era marginal: era latencia de interface causada por um arquivo que ninguem
 * esta olhando enquanto o app roda.
 *
 * Desenho escolhido, e o que foi descartado:
 *
 *   - WriteStream com write() por linha. Parecia o certo, mas o proprio stream
 *     tem buffer: no encerramento, 200 de 300 linhas estavam la dentro e foram
 *     pro lixo quando o processo saiu. Um log que perde 2/3 do que registrou,
 *     em troca de velocidade, e um log que mente.
 *
 *   - flush com appendFile ASSINCRONO. Mesmo problema pelo mesmo motivo: a
 *     escrita fica em voo no thread pool e o `before-quit` termina em
 *     `app.exit(0)`, que nao espera. Medido: 100 de 300 linhas gravadas.
 *
 * Entao nao ha stream nem I/O assincrono. A linha vai para um array (zero I/O no
 * caminho quente) e o flushperiodico usa appendFileSync com TODAS as linhas do
 * periodo em UMA escrita. Isso troca N syscalls sincronas por UMA, espacada por
 * FLUSH_MS, e nada fica em voo: o log nunca perde linha, nem em saida limpa,
 * nem em crash.
 *
 * O preco aceito: um crash abrupto perde ate FLUSH_MS de log. Troquei
 * "log que trava o video" por "log que perde o ultimo quarto de segundo" —
 * a linha que o crash ORIGINA nem chega aqui, ela morre com o processo.
 */


const MAX_BYTES = 2 * 1024 * 1024
const FLUSH_MS = 400
const MAX_BUFFER = 200

const pending = new Map()
let timer = null

/** Cria a pasta uma vez, sob demanda. */
function ensureDir(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    // Sem permissao: o append vai falhar e a linha e descartada.
  }
}

/** Rotaciona por tamanho, uma vez, antes do primeiro write do processo. */
const rotated = new Set()
function rotateOnce(file) {
  if (rotated.has(file)) return
  rotated.add(file)
  try {
    if (!fs.existsSync(file)) return
    if (fs.statSync(file).size <= MAX_BYTES) return
    const backup = `${file}.1`
    if (fs.existsSync(backup)) fs.unlinkSync(backup)
    fs.renameSync(file, backup)
  } catch {
    // ignore
  }
}

/**
 * Enfileira uma linha. Zero I/O no caminho quente.
 *
 * @param {string} file
 * @param {string} line sem o \n
 */
function append(file, line) {
  if (typeof line !== 'string' || line.length === 0) return
  let buf = pending.get(file)
  if (!buf) {
    buf = []
    pending.set(file, buf)
  }
  buf.push(`${line}\n`)

  if (buf.length >= MAX_BUFFER) {
    flush(file)
    return
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null
      for (const key of [...pending.keys()]) flush(key)
    }, FLUSH_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

/** Envia o buffer ao disco. Uma unica escrita por flush. */
function flush(file) {
  const buf = pending.get(file)
  if (!buf || buf.length === 0) return
  const text = buf.join('')
  pending.set(file, [])
  try {
    ensureDir(file)
    rotateOnce(file)
    // SINCRONO, e de proposito — ver a nota do topo.
    fs.appendFileSync(file, text)
  } catch {
    // ignore
  }
}

/**
 * Descarrega o que sobrou e para. Chamar em `before-quit`.
 *
 * O descarte final e SINCRONO. O `before-quit` termina em `app.exit(0)`, que
 * mata o processo sem esperar o thread pool terminar — um appendFile assincrono
 * ainda em voo seria descartado. Um write sincrono aqui custa um unico I/O no
 * encerramento, que nao e o caminho quente, e garante que o log chegue inteiro.
 */
function closeAll() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  for (const [file, buf] of pending) {
    if (!buf || buf.length === 0) continue
    const text = buf.join('')
    pending.set(file, [])
    try {
      ensureDir(file)
      rotateOnce(file)
      fs.appendFileSync(file, text)
    } catch {
      // Ultimo recurso falhou: nao ha mais nada a fazer sem travar a saida.
    }
  }
}

module.exports = { append, flush, closeAll }
