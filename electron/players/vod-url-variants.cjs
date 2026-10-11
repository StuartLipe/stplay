/** Painel manda .mp4 e o arquivo real é .mkv/.ts — tenta as extensões comuns. */
function vodUrlVariants(url) {
  const value = String(url || '').trim()
  if (!value) return []
  const match = value.match(/^(https?:\/\/.+\.)([a-z0-9]+)(\?.*)?$/i)
  if (!match) return [value]
  const prefix = match[1]
  const current = match[2].toLowerCase()
  const query = match[3] || ''
  const seen = new Set()
  const out = []
  for (const ext of [current, 'mp4', 'mkv', 'avi', 'ts']) {
    const next = `${prefix}${ext}${query}`
    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }
  return out
}

module.exports = { vodUrlVariants }
