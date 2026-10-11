import { createWriteStream, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor')
const cacheDir = path.join(vendor, 'cache')
const mpvDir = path.join(vendor, 'players', 'mpv')
const mpcDir = path.join(vendor, 'players', 'mpc-hc')
const toolsDir = path.join(vendor, 'tools')
const headers = {
  'User-Agent': 'stplay-player-bundler',
  Accept: 'application/vnd.github+json',
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

async function download(url, dest, extraHeaders = {}) {
  console.log(`baixando ${url}`)
  const response = await fetch(url, { headers: { ...headers, ...extraHeaders }, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`falha ao baixar ${url} (${response.status})`)
  }
  ensureDir(path.dirname(dest))
  await pipeline(response.body, createWriteStream(dest))
}

function findFile(dir, match) {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, match)
      if (nested) return nested
    } else if (match(entry.name)) {
      return full
    }
  }
  return null
}

function copyFolder(from, to) {
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  ensureDir(path.dirname(to))
  cpSync(from, to, { recursive: true })
}

async function latestAsset(repo, predicate) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
  if (!response.ok) throw new Error(`GitHub ${repo} (${response.status})`)
  const release = await response.json()
  const asset = (release.assets || []).find((item) => predicate(item.name))
  if (!asset?.browser_download_url) {
    throw new Error(`nenhum arquivo encontrado em ${repo}`)
  }
  return { url: asset.browser_download_url, name: asset.name, tag: release.tag_name }
}

async function ensureSevenZip() {
  const seven = path.join(toolsDir, '7zr.exe')
  if (!existsSync(seven)) {
    await download('https://www.7-zip.org/a/7zr.exe', seven, { Accept: '*/*' })
  }
  return seven
}

async function extract7z(archive, dest) {
  const seven = await ensureSevenZip()
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  ensureDir(dest)
  execFileSync(seven, ['x', archive, `-o${dest}`, '-y'], { stdio: 'inherit' })
}

function extractZip(archive, dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  ensureDir(dest)
  execFileSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' })
}

async function installMpv() {
  if (existsSync(path.join(mpvDir, 'mpv.exe'))) {
    console.log('MPV já está em vendor/players/mpv')
    return
  }
  const asset = await latestAsset(
    'shinchiro/mpv-winbuild-cmake',
    (name) => /^mpv-x86_64-\d{8}-git-.*\.7z$/i.test(name) && !name.includes('-v3-') && !name.includes('dev'),
  )
  const archive = path.join(cacheDir, asset.name)
  if (!existsSync(archive)) await download(asset.url, archive, { Accept: '*/*' })
  const unpacked = path.join(cacheDir, 'mpv-unpacked')
  await extract7z(archive, unpacked)
  const exe = findFile(unpacked, (name) => name.toLowerCase() === 'mpv.exe')
  if (!exe) throw new Error('mpv.exe não encontrado no pacote')
  copyFolder(path.dirname(exe), mpvDir)
  console.log(`MPV ${asset.tag} pronto`)
}

/*
 * `resources/mpv` e o que o empacotador usa, e nao `vendor/players/mpv`.
 *
 * O `package.json` tem `extraResources: { from: 'resources/mpv', to: 'mpv' }`.
 * O `vendor/` alimenta o `find-player.cjs` em DESVENVOLVIMENTO. Sao dois
 * destinos, e o `installMpv` acima so escrevia no segundo — entao uma maquina
 * nova, depois de `npm run download-players`, ficava com o player em `vendor/`
 * e sem ele em `resources/`, e o `npm run pack` produzia um instalador de 144 MB
 * que nao tocava nada.
 *
 * Nao ha outro caminho: o `resources/mpv` e gitignored, entao nao vem no clone,
 * e o empacotador nao baixaria nada. Era o que faltava para reconstruir o
 * projeto do zero depois de formatar o PC.
 */
const resourcesMpv = path.join(root, 'resources', 'mpv')

function copiarParaResources() {
  const origem = path.join(mpvDir, 'mpv.exe')
  if (!existsSync(origem)) return
  if (existsSync(path.join(resourcesMpv, 'mpv.exe'))) {
    console.log('resources/mpv já está populado')
    return
  }
  ensureDir(resourcesMpv)
  // Só o executável. O resto do pacote do mpv (dlls, filtros) fica em
  // `vendor/`, e o app em runtime resolve pelo PATH do player nativo.
  copyFileSync(origem, path.join(resourcesMpv, 'mpv.exe'))
  console.log('resources/mpv populado — o npm run pack já vai embutir o player')
}

const libmpvDir = path.join(vendor, 'players', 'libmpv')

async function installLibmpv() {
  if (existsSync(path.join(libmpvDir, 'libmpv-2.dll'))) {
    console.log('libmpv já está em vendor/players/libmpv')
    return
  }
  const asset = await latestAsset(
    'shinchiro/mpv-winbuild-cmake',
    (name) => /^mpv-dev-x86_64-\d{8}-git-.*\.7z$/i.test(name) && !name.includes('-v3-'),
  )
  const archive = path.join(cacheDir, asset.name)
  if (!existsSync(archive)) await download(asset.url, archive, { Accept: '*/*' })
  const unpacked = path.join(cacheDir, 'mpv-dev-unpacked')
  await extract7z(archive, unpacked)
  const dll = findFile(unpacked, (name) => name.toLowerCase() === 'libmpv-2.dll')
  if (!dll) throw new Error('libmpv-2.dll não encontrado no pacote')
  ensureDir(libmpvDir)
  const { copyFileSync, readdirSync } = await import('node:fs')
  for (const name of readdirSync(path.dirname(dll))) {
    if (name.toLowerCase().endsWith('.dll')) {
      copyFileSync(path.join(path.dirname(dll), name), path.join(libmpvDir, name))
    }
  }
  console.log(`libmpv ${asset.tag} pronto`)
}

async function installMpcHc() {
  if (existsSync(path.join(mpcDir, 'mpc-hc64.exe')) || existsSync(path.join(mpcDir, 'mpc-hc.exe'))) {
    console.log('MPC-HC já está em vendor/players/mpc-hc')
    return
  }
  const asset = await latestAsset(
    'clsid2/mpc-hc',
    (name) => /^MPC-HC\..+\.x64\.zip$/i.test(name),
  )
  const archive = path.join(cacheDir, asset.name)
  if (!existsSync(archive)) await download(asset.url, archive, { Accept: '*/*' })
  const unpacked = path.join(cacheDir, 'mpc-unpacked')
  extractZip(archive, unpacked)
  const exe = findFile(unpacked, (name) => /^mpc-hc64\.exe$/i.test(name) || /^mpc-hc\.exe$/i.test(name))
  if (!exe) throw new Error('mpc-hc64.exe não encontrado no pacote')
  copyFolder(path.dirname(exe), mpcDir)
  console.log(`MPC-HC ${asset.tag} pronto`)
}

ensureDir(cacheDir)
if (!existsSync(mpvDir) || !statSync(mpvDir).isDirectory()) ensureDir(mpvDir)
if (!existsSync(mpcDir) || !statSync(mpcDir).isDirectory()) ensureDir(mpcDir)
if (!existsSync(libmpvDir) || !statSync(libmpvDir).isDirectory()) ensureDir(libmpvDir)

await installMpv()
await installLibmpv()
await installMpcHc()
// Sem isto o `npm run pack` sai com um instalador de 144 MB que nao toca nada:
// o empacotador le `resources/mpv`, e nao `vendor/players/mpv`.
copiarParaResources()

if (!existsSync(path.join(mpvDir, 'mpv.exe'))) throw new Error('MPV não foi instalado')
if (!existsSync(path.join(libmpvDir, 'libmpv-2.dll'))) throw new Error('libmpv não foi instalado')
if (!existsSync(path.join(mpcDir, 'mpc-hc64.exe')) && !existsSync(path.join(mpcDir, 'mpc-hc.exe'))) {
  throw new Error('MPC-HC não foi instalado')
}

console.log('Players prontos para o instalador.')
