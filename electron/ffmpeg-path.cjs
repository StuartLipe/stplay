/*
 * Onde está o ffmpeg.
 *
 * Extraído de `stur-ffmpeg-proxy.cjs` porque dois modulos precisam agora: o
 * proxy de streaming e a detecção de abertura. A ordem das candidatas importa —
 * em dev o binário está em `node_modules`, e no pacote o `asarUnpack` o coloca em
 * `app.asar.unpacked`, que é um caminho DIFERENTE do que `require` devolve.
 *
 * Sem isto, o app empacotado não acha o ffmpeg e a detecção de abertura
 * silenciosamente deixa de existir.
 */

const fs = require('node:fs')
const path = require('node:path')

let cache = null

function resolveFfmpegPath() {
  if (cache !== null) return cache
  const candidatos = []

  try {
    const doPacote = require('ffmpeg-static')
    if (doPacote && typeof doPacote === 'string') {
      // `require` devolve o caminho dentro do asar; o executavel esta fora dele.
      candidatos.push(doPacote.replace(/app\.asar([/\\])/g, 'app.asar.unpacked$1'))
    }
  } catch {
    // ffmpeg-static ausente: tenta os caminhos abaixo.
  }

  try {
    const { app } = require('electron')
    candidatos.push(path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
    const recursos = app.isPackaged ? process.resourcesPath : null
    if (recursos) {
      candidatos.push(path.join(recursos, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
    }
  } catch {
    // fora do electron (testes): segue com os caminhos relativos.
  }

  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  candidatos.push(
    path.join(pf, 'IPTV Player One', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  )
  candidatos.push(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))

  for (const candidato of candidatos) {
    try {
      if (candidato && fs.existsSync(candidato)) {
        cache = candidato
        return cache
      }
    } catch {
      // sem permissão para .existsSync: tenta o proximo
    }
  }

  // Ultimo recurso: o ffmpeg do sistema, pelo PATH.
  cache = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return cache
}

module.exports = { resolveFfmpegPath }