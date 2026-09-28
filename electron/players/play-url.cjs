const path = require('path')
const { pathToFileURL } = require('url')

/** Aceita http(s), file:// ou caminho Windows (C:\...\file.mp4). */
function normalizePlayUrl(input) {
  if (!input || typeof input !== 'string') return null
  let value = input.trim().replace(/^['"]|['"]$/g, '')
  if (!value) return null
  // npm/cross-env no Windows pode duplicar % em file://
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value.replace(/%%/g, '%'))
    } catch {
      // ignore
    }
  }
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('file://')) return value
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return pathToFileURL(path.normalize(value)).href
  }
  return null
}

function isPlayableUrl(url) {
  return Boolean(url && (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)))
}

module.exports = { normalizePlayUrl, isPlayableUrl }
