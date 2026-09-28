const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function fileIfExists(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? filePath : null
  } catch {
    return null
  }
}

function which(command) {
  try {
    execFileSync('where.exe', [command], { stdio: 'ignore' })
    return command
  } catch {
    return null
  }
}

function searchRoots() {
  const { app } = require('electron')
  const roots = []
  const add = (value) => {
    if (!value) return
    const normalized = path.normalize(value)
    if (!roots.includes(normalized)) roots.push(normalized)
  }

  add(process.resourcesPath)
  add(path.join(process.resourcesPath || '', 'players'))
  try {
    add(path.join(app.getAppPath(), '..'))
    add(path.join(app.getAppPath(), '..', 'players'))
  } catch {
    // app ainda não pronto
  }
  add(path.join(path.dirname(process.execPath), 'resources'))
  add(path.join(path.dirname(process.execPath), 'resources', 'players'))
  add(path.dirname(process.execPath))
  add(path.join(path.dirname(process.execPath), 'players'))
  add(path.join(__dirname, '..', 'vendor', 'players'))
  add(path.join(__dirname, '..', 'vendor', 'players', 'mpv'))
  add(path.join(__dirname, '..', 'vendor', 'players', 'mpc-hc'))
  return roots
}

function walkForExe(dir, names, depth = 0) {
  if (depth > 5 || !dir) return null
  let entries
  try {
    if (!fs.existsSync(dir)) return null
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const wanted = names.map((name) => name.toLowerCase())
  for (const entry of entries) {
    if (entry.isFile() && wanted.includes(entry.name.toLowerCase())) {
      return path.join(dir, entry.name)
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = walkForExe(path.join(dir, entry.name), names, depth + 1)
    if (nested) return nested
  }
  return null
}

function findPlayerExe(fileNames) {
  const names = Array.isArray(fileNames) ? fileNames : [fileNames]
  for (const root of searchRoots()) {
    const direct = names
      .map((name) => fileIfExists(path.join(root, name)) || fileIfExists(path.join(root, 'mpv', name)) || fileIfExists(path.join(root, 'mpc-hc', name)))
      .find(Boolean)
    if (direct) return direct
  }
  for (const root of searchRoots()) {
    const base = path.basename(root).toLowerCase()
    if (base !== 'players' && base !== 'resources' && base !== 'mpv' && base !== 'mpc-hc') continue
    const walked = walkForExe(root, names)
    if (walked) return walked
  }
  return names.map((name) => which(name)).find(Boolean) || null
}

function findPlayerOneMpv() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return (
    fileIfExists(path.join(pf, 'IPTV Player One', 'resources', 'mpv', 'mpv.exe')) ||
    fileIfExists(path.join(pf86, 'IPTV Player One', 'resources', 'mpv', 'mpv.exe')) ||
    null
  )
}

function findSturMpv() {
  // Mesmo binário do IPTV Player One quando instalado — mesma velocidade de decode/abertura.
  const one = findPlayerOneMpv()
  if (one) return one
  const bundled = fileIfExists(path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'))
  if (bundled) return bundled
  const projectMpv = fileIfExists(path.join(__dirname, '..', 'resources', 'mpv', 'mpv.exe'))
  if (projectMpv) return projectMpv
  return findPlayerExe(['mpv.exe'])
}

/** @param {'playerone' | 'stur' | undefined} preferred */
function findMpv(preferred) {
  if (preferred === 'stur') return findSturMpv()
  if (preferred === 'playerone') return findPlayerOneMpv() || findPlayerExe(['mpv.exe'])
  return findPlayerExe(['mpv.exe']) || findPlayerOneMpv()
}

function findMpc() {
  return findPlayerExe(['mpc-hc64.exe', 'mpc-hc.exe'])
}

function findVlc() {
  return (
    fileIfExists(path.join(process.env.ProgramFiles || '', 'VideoLAN', 'VLC', 'vlc.exe')) ||
    which('vlc.exe')
  )
}

function logPlayerSearch(extra = {}) {
  try {
    const { app } = require('electron')
    const payload = {
      at: new Date().toISOString(),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
      roots: searchRoots(),
      mpv: findMpv(),
      playerone: findPlayerOneMpv(),
      stur: findSturMpv(),
      mpc: findMpc(),
      ...extra,
    }
    try {
      payload.appPath = app.getAppPath()
    } catch {
      payload.appPath = null
    }
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'player-search.log'), JSON.stringify(payload, null, 2))
  } catch {
    // ignore
  }
}

module.exports = {
  fileIfExists,
  which,
  findMpv,
  findSturMpv,
  findPlayerOneMpv,
  findMpc,
  findVlc,
  searchRoots,
  logPlayerSearch,
}
