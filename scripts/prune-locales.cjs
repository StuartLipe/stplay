// electron-builder chama depois de empacotar, com o app já montado no contexto.
// Chromium embarca ~54 locales; este app é pt-BR e en-US serve de fallback.
const KEEP_LOCALES = new Set(['pt-BR.pak', 'en-US.pak', 'es-419.pak'])

exports.default = async function pruneLocales(context) {
  const dir = context.appOutDir ? `${context.appOutDir}/locales` : null
  if (!dir) return
  const { readdirSync, statSync, unlinkSync } = require('node:fs')
  const { join } = require('node:path')

  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  let removed = 0
  let bytes = 0
  for (const name of entries) {
    if (!name.endsWith('.pak')) continue
    if (KEEP_LOCALES.has(name)) continue
    const file = join(dir, name)
    try {
      bytes += statSync(file).size
      unlinkSync(file)
      removed += 1
    } catch {
      // best effort
    }
  }
  if (removed > 0) {
    console.log(`  locales: removidos ${removed} arquivos, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  }
}
