/*
 * MINIATURAS DA BARRA DE PROGRESSO (estilo YouTube).
 *
 * Um mpv "quente" separado do player: carrega o arquivo UMA vez e, para cada
 * tempo pedido, faz seek + screenshot. Medido no arquivo real do provedor:
 *
 *   load .................. 1,8-2,4 s (uma vez por episódio)
 *   cada frame novo ....... 1,1-1,6 s
 *   frame repetido ........ 0,4 s (mpv já tem a região)
 *
 * O ffmpeg direto NÃO serve aqui: `-ss` num MP4 sem faststart obriga a ler do
 * começo (medido: 34-46 s por frame).
 *
 * As imagens ficam em cache no disco por URL + faixa de 5 s, então arrastar de
 * novo sobre o mesmo trecho é instantâneo.
 */
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { app } = require('electron')
const { findSturMpv } = require('../find-player.cjs')
const scan = require('./thumb-scan.cjs')
const log = require('./player-log.cjs')

// Miniatura de v?deo na barra: DESLIGADA (o n?mero basta e ? leve).
const MINIATURAS_ATIVAS = false
const BUCKET = 10         // igual ao scanner: as chaves do cache batem
const PIPE = '\\\\.\\pipe\\stplay-thumbs'
const IDLE_MS = 5 * 60_000

let proc = null
let sock = null
let carregada = ''
let seq = 0
let fila = Promise.resolve()
let ultimoUso = 0
let idleTimer = null
const eventos = []
const memoria = new Map()
// "?ltimo pedido vence": durante o arraste a pessoa gera dezenas de pedidos;
// processar todos deixa a pr?via 5 s atrasada. S? o mais novo importa.
let pedidoSeq = 0

function dirBase() {
  return path.join(app.getPath('userData'), 'thumb-cache')
}

function destino(url, tempo) {
  const b = Math.floor(tempo / BUCKET) * BUCKET
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  const dir = path.join(dirBase(), h)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${b}.jpg`)
}

function lerDataUrl(arquivo) {
  try {
    const st = fs.statSync(arquivo)
    if (st.size < 1000) return null
    return 'data:image/jpeg;base64,' + fs.readFileSync(arquivo).toString('base64')
  } catch {
    return null
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function conectar() {
  return new Promise((resolve, reject) => {
    let tentativas = 50
    const tentar = () => {
      const s = net.connect(PIPE)
      s.once('connect', () => resolve(s))
      s.once('error', () => {
        if (--tentativas <= 0) reject(new Error('mpv thumb: sem ipc'))
        else setTimeout(tentar, 200)
      })
    }
    tentar()
  })
}

function enviar(command) {
  if (!sock || sock.destroyed) throw new Error('mpv thumb: sem conexao')
  sock.write(JSON.stringify({ command, request_id: ++seq }) + '\n')
}

async function garantirProc() {
  if (proc && !proc.killed && sock && !sock.destroyed) return
  const mpv = findSturMpv()
  if (!mpv || !fs.existsSync(mpv)) throw new Error('mpv indisponivel')
  const outDir = path.join(app.getPath('temp'), 'stplay-thumbs')
  fs.mkdirSync(outDir, { recursive: true })
  proc = spawn(mpv, [
    '--no-config', '--no-terminal', '--idle=yes', '--pause=no', '--hr-seek=no',
    '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=70',
    `--vo-image-outdir=${outDir}`,
    `--input-ipc-server=${PIPE}`,
    '--msg-level=all=error',
  ], { stdio: 'ignore', windowsHide: true })
  proc.on('exit', () => { proc = null; sock = null; carregada = '' })

  sock = await conectar()
  let buf = ''
  sock.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i); buf = buf.slice(i + 1)
      try {
        eventos.push(JSON.parse(linha))
        if (eventos.length > 200) eventos.splice(0, 100)
      } catch { /* ignore */ }
    }
  })
  sock.on('error', () => { sock = null })
}

async function garantirArquivo(url) {
  await garantirProc()
  if (carregada === url) return
  const antes = eventos.length
  enviar(['loadfile', url])
  for (let i = 0; i < 160; i++) {
    if (eventos.slice(antes).some((e) => e.event === 'file-loaded')) break
    await dormir(150)
  }
  carregada = url
}

async function capturar(url, tempo) {
  const alvo = destino(url, tempo)
  const cache = lerDataUrl(alvo)
  if (cache) return cache

  await garantirArquivo(url)
  const antes = eventos.length
  enviar(['seek', Math.max(0, tempo), 'absolute'])
  for (let i = 0; i < 60; i++) {
    if (eventos.slice(antes).some((e) => e.event === 'playback-restart')) break
    await dormir(50)
  }
  try { fs.unlinkSync(alvo) } catch { /* ignore */ }
  enviar(['screenshot-to-file', alvo, 'video'])

  let anterior = -1
  for (let i = 0; i < 80; i++) {
    try {
      const st = fs.statSync(alvo)
      if (st.size > 1000 && st.size === anterior) return lerDataUrl(alvo)
      anterior = st.size
    } catch {
      anterior = -1
    }
    await dormir(80)
  }
  return null
}

function agendarIdle() {
  ultimoUso = Date.now()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (Date.now() - ultimoUso < IDLE_MS) return agendarIdle()
    parar()
  }, IDLE_MS + 1000)
}

/** Prepara o mpv quente antes do primeiro hover (chamado no play). */
function preparar(url) {
  if (!MINIATURAS_ATIVAS || !url) return
  agendarIdle()
  void garantirArquivo(url).catch(() => undefined)
  // Pr?-gera o epis?dio inteiro em segundo plano: hover fica 0 s.
  try { scan.iniciar(url) } catch { /* ignore */ }
}

/** Pede a miniatura de `tempo` (s) para a URL atual. O ?ltimo pedido vence. */
function miniatura(url, tempo) {
  if (!MINIATURAS_ATIVAS) return Promise.resolve(null)
  if (!url || !Number.isFinite(tempo)) return Promise.resolve(null)
  const chave = `${url}:${Math.floor(tempo / BUCKET)}`
  if (memoria.has(chave)) return Promise.resolve(memoria.get(chave))

  agendarIdle()
  const meu = ++pedidoSeq
  const tarefa = fila
    .then(async () => {
      // Chegou pedido mais novo enquanto este esperava: nem gasta o seek.
      if (meu !== pedidoSeq) return null
      return capturar(url, tempo)
    })
    .then((dataUrl) => {
      if (dataUrl) {
        if (memoria.size > 300) memoria.clear()
        memoria.set(chave, dataUrl)
      }
      return dataUrl
    })
    .catch((e) => {
      log.warn('thumb', 'falhou', { erro: String(e && e.message) })
      return null
    })
  fila = tarefa.then(() => undefined)
  return tarefa
}

function parar() {
  try { scan.parar() } catch { /* ignore */ }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try { if (sock) enviar(['quit']) } catch { /* ignore */ }
  try { if (sock) sock.end() } catch { /* ignore */ }
  try { if (proc && !proc.killed) proc.kill() } catch { /* ignore */ }
  proc = null
  sock = null
  carregada = ''
  memoria.clear()
}

module.exports = { miniatura, preparar, parar }
