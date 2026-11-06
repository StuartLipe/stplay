/*
 * Prova de conceito: mpv quente para miniaturas da barra de progresso.
 * Carrega o arquivo UMA vez e, para cada tempo pedido, faz seek + screenshot.
 *
 * Uso: node tests/thumb-poc.cjs <url>
 */
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const MPV = path.join(__dirname, '..', 'resources', 'mpv', 'mpv.exe')
const PIPE = '\\\\.\\pipe\\stplay-thumb-poc'
const URL = process.argv[2]
if (!URL) {
  console.error('uso: node tests/thumb-poc.cjs <url>')
  process.exit(1)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-poc-'))
const mpv = spawn(MPV, [
  '--no-config', '--no-terminal', '--idle=yes', '--pause=no', '--hr-seek=yes',
  '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=70',
  `--vo-image-outdir=${dir}`,
  `--input-ipc-server=${PIPE}`,
  '--msg-level=all=error',
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function conectar() {
  return new Promise((resolve, reject) => {
    const tentar = (n) => {
      const s = net.connect(PIPE)
      s.once('connect', () => resolve(s))
      s.once('error', () => {
        if (n <= 0) reject(new Error('sem ipc'))
        else setTimeout(() => tentar(n - 1), 250)
      })
    }
    tentar(40)
  })
}

let seq = 0
function comandar(sock, command) {
  sock.write(JSON.stringify({ command, request_id: ++seq }) + '\n')
}

async function esperarArquivo(arquivo) {
  let anterior = -1
  for (let i = 0; i < 60; i++) {
    try {
      const st = fs.statSync(arquivo)
      if (st.size > 1000 && st.size === anterior) return st.size
      anterior = st.size
    } catch {
      anterior = -1
    }
    await sleep(80)
  }
  return 0
}

async function main() {
  const sock = await conectar()
  let buf = ''
  const eventos = []
  sock.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i); buf = buf.slice(i + 1)
      try { eventos.push(JSON.parse(linha)) } catch { /* ignore */ }
    }
  })

  const t0 = Date.now()
  comandar(sock, ['loadfile', URL])
  for (let i = 0; i < 120; i++) {
    if (eventos.some((e) => e.event === 'file-loaded')) break
    await sleep(250)
  }
  console.log(`load: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const hashes = new Map()
  for (const t of [300, 1200, 800, 600, 1000, 300]) {
    const inicio = Date.now()
    const antes = eventos.length
    const arquivo = path.join(dir, `t${t}-${seq}.jpg`)
    comandar(sock, ['seek', t, 'absolute', 'exact'])
    for (let i = 0; i < 60; i++) {
      if (eventos.slice(antes).some((e) => e.event === 'playback-restart')) break
      await sleep(50)
    }
    comandar(sock, ['screenshot-to-file', arquivo, 'video'])
    const sz = await esperarArquivo(arquivo)
    const dt = (Date.now() - inicio) / 1000
    let hash = 'FALHOU'
    if (sz > 0) {
      hash = crypto.createHash('md5').update(fs.readFileSync(arquivo)).digest('hex').slice(0, 8)
      hashes.set(arquivo, hash)
    }
    console.log(`seek ${String(t).padStart(4)}s -> ${dt.toFixed(2)}s | ${sz} bytes | ${hash}`)
  }

  const distintos = new Set(hashes.values())
  console.log(`\nframes distintos: ${distintos.size} de ${hashes.size} capturas`)

  comandar(sock, ['quit'])
  sock.end()
  mpv.kill()
  fs.rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error('erro:', e.message)
  try { mpv.kill() } catch { /* ignore */ }
  process.exit(1)
})
