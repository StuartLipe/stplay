/**
 * Electron/undici exige ByteString (code points 0–255) em headers.
 * Painéis IPTV mandam Content-Disposition/filenames com … – — etc. e o main process crasha.
 */

function sanitizeHeaderValue(value) {
  if (value == null) return undefined
  let s = String(value)
  s = s
    .replace(/\u2026/g, '...')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00A0/g, ' ')
  if (/[^\u0000-\u00FF]/.test(s)) {
    s = [...s].map((ch) => (ch.charCodeAt(0) > 255 ? '?' : ch)).join('')
  }
  return s
}

function sanitizeHeadersObject(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      const cleaned = value.map(sanitizeHeaderValue).filter((v) => v != null && v !== '')
      if (cleaned.length === 1) out[key] = cleaned[0]
      else if (cleaned.length > 1) out[key] = cleaned
    } else {
      const cleaned = sanitizeHeaderValue(value)
      if (cleaned != null && cleaned !== '') out[key] = cleaned
    }
  }
  return out
}

const SKIP_RESPONSE = new Set([
  'content-disposition',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

/** Copia headers de um Response do net.fetch sem valores que quebram ByteString. */
function safeResponseHeaders(response, extra = {}) {
  const out = { ...extra }
  if (response && response.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value, key) => {
      if (SKIP_RESPONSE.has(String(key).toLowerCase())) return
      const safe = sanitizeHeaderValue(value)
      if (safe != null && safe !== '') out[key] = safe
    })
  }
  return sanitizeHeadersObject(out)
}

function isByteStringError(error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  return /ByteString/i.test(msg) || /greater than 255/i.test(msg)
}

module.exports = {
  sanitizeHeaderValue,
  sanitizeHeadersObject,
  safeResponseHeaders,
  isByteStringError,
}
