/*
 * SCANNER DE MINIATURAS (pré-geração do episódio inteiro).
 *
 * O hover sob demanda custa ~1 s (seek no mp4 remoto). Para ser igual ao
 * YouTube, as miniaturas precisam estar prontas ANTES do hover.
 *
 * Este módulo roda um mpv separado, sem áudio, com `--untimed` (decodifica o
 * mais rápido que a rede permitir) e `--vf=fps=1/10`: ele escreve um JPEG a
 * cada 10 s do episódio. Ao terminar, os arquivos são renomeados para o cache
 * por faixa (0.jpg, 10.jpg, ...), que é o que o serviço consulta primeiro.
 *
 * Custo: ~300 MB de banda (uma conexão) e ~1 núcleo por 2-5 min, em segundo
 * plano. Se atrapalhar a reprodução, pode ser desligado em `preparar`.
 */
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { findSturMpv } = require('../find-player.cjs')
const log = require('./player-log.cjs')

const INTERVALO = 10 // segundos entre miniaturas
const PREFIXO = 'scan-'

let proc = null
let atual = ''
let pasta = ''

function dirCache(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'thumb-cache', h)
}

function parar() {
  if (proc && !proc.killed) {
    try { proc.kill() } catch { /* ignore */ }
  }
  proc = null
  atual = ''
  if (pasta) {
    try { fs.rmSync(pasta, { recursive: true, force: true }) } catch { /* ignore */ }
    pasta = ''
  }
}

function iniciar(url) {
  if (!url || url === atual || proc) return
  const mpv = findSturMpv()
  if (!mpv || !fs.existsSync(mpv)) return

  const cache = dirCache(url)
  fs.mkdirSync(cache, { recursive: true })
  pasta = path.join(app.getPath('temp'), `${PREFIXO}${Date.now()}`)
  fs.mkdirSync(pasta, { recursive: true })
  atual = url

  log.info('thumb', 'scan iniciado', { intervalo: INTERVALO })
  // O mpv escreve 00000001.jpg, 00000002.jpg... Vamos movendo para o cache
  // enquanto ele roda: assim os primeiros trechos j? ficam instant?neos.
  const mover = () => {
    try {
      for (const nome of fs.readdirSync(pasta)) {
        const m = nome.match(/(\d+)\.jpg$/)
        if (!m) continue
        const bucket = Math.max(0, (Number(m[1]) - 1) * INTERVALO)
        try {
          fs.renameSync(path.join(pasta, nome), path.join(cache, `${bucket}.jpg`))
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  const moverTimer = setInterval(mover, 1500)
  proc = spawn(mpv, [
    '--no-config', '--no-terminal', '--no-audio', '--untimed',
    '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=45',
    `--vf=fps=1/${INTERVALO}`,
    `--vo-image-outdir=${pasta}`,
    '--msg-level=all=error',
    url,
  ], { stdio: 'ignore', windowsHide: true })

  proc.on('exit', () => {
    clearInterval(moverTimer)
    mover()
    let n = 0
    try { n = fs.readdirSync(cache).filter((f) => f.endsWith('.jpg')).length } catch { /* ignore */ }
    log.info('thumb', 'scan concluido', { quadros: n })
    try { fs.rmSync(pasta, { recursive: true, force: true }) } catch { /* ignore */ }
    pasta = ''
    proc = null
    atual = ''
  })
}

module.exports = { iniciar, parar }
