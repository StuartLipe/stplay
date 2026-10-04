/*
 * Publica uma release. Um comando, e nao nove passos.
 *
 * O que motivou: a 1.0.8 foi publicada com o nome do asset diferente do que o
 * `latest.yml` pedia, e o unico jeito de descobrir foi o usuario clicar em
 * "Atualizar" e receber um 404 na tela. Custou um ciclo inteiro de build e
 * upload. Este script existe para pegar essa classe de erro ANTES de subir
 * qualquer byte.
 *
 * As verificacoes, em ordem de importancia:
 *
 *   1. o `latest.yml` aponta para um arquivo que existe de verdade
 *   2. o `latest.yml` diz a mesma versao do `package.json`
 *   3. o `package.json` e o lockfile parseiam (o BOM do PowerShell ja matou um
 *      build inteiro uma vez)
 *   4. a versao anterior congela no manifesto e a atual fica solta
 *
 * O passo 4 evita o extremo oposto: congelar a versao corrente faz o build
 * seguinte ser barrado sem ninguem entender por que. A regra e "tudo que ja
 * foi publicado congela; a que estou lancando ainda nao".
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const semPush = args.has('--no-push')

const log = (msg = '') => console.log(msg)

function falha(msg) {
  console.error(`\n  PUBLICACAO CANCELADA\n\n  x  ${msg}\n`)
  process.exit(1)
}

function git(...argv) {
  try {
    return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function gh(...argv) {
  return execFileSync('gh', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function tamanho(file) {
  return `${statSync(file).size.toLocaleString('pt-BR')} bytes`
}

// O BOM e o erro mais chato deste projeto: `Set-Content -Encoding utf8` no
// PowerShell 5.1 grava BOM e o `JSON.parse` do Vite morre com "Unexpected
// token". O `guard-build` ja remove a mao antes do parse; aqui a falha e na
// hora de ler, que e mais barato que descobrir no meio do build.
function lerJson(file) {
  const bruto = readFileSync(join(root, file), 'utf8')
  if (bruto.charCodeAt(0) === 0xfeff) {
    falha(`${file} comeca com BOM — o Vite nao parseia. Regrave sem BOM.`)
  }
  try {
    return JSON.parse(bruto)
  } catch (error) {
    falha(`${file} nao e JSON valido: ${error.message}`)
  }
}

function dataHora(file) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${file}').LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')`],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    return ''
  }
}

const pkg = lerJson('package.json')
const lock = lerJson('package-lock.json')
const versao = pkg.version
const repo = (pkg.repository?.url || '').replace(/\.git$/, '').split('/').slice(-2).join('/')
if (!repo) falha('package.json sem campo `repository` — o script precisa dele para o gh')

/* --------------------------------------------- 1. os artefatos existem */

const setup = join(root, 'release', `ST-PLAY-Setup-${versao}.exe`)
const portatil = join(root, 'release', `ST-PLAY-${versao}.exe`)
const latestYml = join(root, 'release', 'latest.yml')

for (const [rotulo, file] of [
  ['instalador', setup],
  ['portatil', portatil],
  ['latest.yml', latestYml],
]) {
  if (!existsSync(file)) falha(`falta o artefato ${rotulo}: release/${basename(file)}`)
}

/* ------------------------ 2. o latest.yml aponta para o que existe de fato */

const manifesto = readFileSync(latestYml, 'utf8')
const pedido = (manifesto.match(/^path:\s*(.+)$/m) || [])[1]
if (!pedido) falha('latest.yml sem campo `path:`')
if (pedido.trim() !== `ST-PLAY-Setup-${versao}.exe`) {
  falha(
    `latest.yml pede "${pedido.trim()}" mas o artefato e "ST-PLAY-Setup-${versao}.exe".\n` +
      '     O electron-builder sanitiza o artifactName ao escrever o manifesto. Se\n' +
      '     divergirem, o updater leva 404 na hora de baixar.',
  )
}
const versaoManifesto = (manifesto.match(/^version:\s*(.+)$/m) || [])[1]
if (versaoManifesto && versaoManifesto.trim() !== versao) {
  falha(`latest.yml diz version ${versaoManifesto.trim()} mas o package.json diz ${versao}`)
}
if (lock.version !== versao || lock.packages?.['']?.version !== versao) {
  falha(
    `lockfile em ${lock.version} / ${lock.packages?.['']?.version} e package.json em ${versao}` +
      ' — rode: npm install --package-only',
  )
}

log(`  versao      ${versao}`)
log(`  instalador  ST-PLAY-Setup-${versao}.exe`)
log(`              ${tamanho(setup)}  ${sha256(setup)}`)
log(`  portatil    ST-PLAY-${versao}.exe`)
log(`              ${tamanho(portatil)}  ${sha256(portatil)}`)
log('')
log(`  manifesto   latest.yml -> ${pedido.trim()}  ok, o arquivo existe`)
log('              versao do manifesto confere com o package.json')

if (dryRun) {
  log('\n  --dry-run: parou aqui, nada foi publicado.\n')
  process.exit(0)
}

/* ------------------------ 3. a versao anterior congela, a atual fica solta */

const caminhoManifesto = join(root, 'release-exe-manifest.txt')
const antes = existsSync(caminhoManifesto)
  ? readFileSync(caminhoManifesto, 'utf8').split('\n').filter((l) => l.trim())
  : []

const depois = antes.filter((linha) => !linha.includes(`-${versao}.exe`))
for (const file of [setup, portatil]) {
  depois.push(
    `${basename(file)}|${sha256(file)}|${statSync(file).size}|${dataHora(file)}`,
  )
}
writeFileSync(caminhoManifesto, depois.join('\n'), 'utf8')
log('')
log('  manifesto   esta versao entra agora e congela no proximo build')
log(`              ${antes.length} linha(s) anteriores preservadas, ${depois.length} no total`)

/* ------------------------------------------------ 4. notas a partir do git */

let notas = null
const arquivoNotas = join(root, `NOTAS-${versao}.md`)
if (existsSync(arquivoNotas)) {
  notas = readFileSync(arquivoNotas, 'utf8')
  log(`  notas       NOTAS-${versao}.md`)
} else {
  const base = git('describe', '--tags', '--abbrev=0')
  const commits = git('log', '--oneline', '--no-merges', base ? `${base}..HEAD` : 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^[0-9a-f]{7,}\s+/, ''))
  notas = [
    `## ST PLAY ${versao}`,
    '',
    'Repositório em https://github.com/' + repo,
    '',
    '### Mudanças',
    '',
    ...(commits.length ? commits.map((c) => `- ${c}`) : ['- (sem commits desde a tag anterior)']),
    '',
  ].join('\n')
  log(`  notas       ${commits.length} commit(s) desde ${base || 'o inicio'}`)
  log(`              escreva NOTAS-${versao}.md para usar texto proprio`)
}

/* -------------------------------------------------------- 5. publicar */

const tag = `v${versao}`
const arquivos = [setup, portatil, latestYml]
const notasTmp = join(root, 'release', `.notas-${versao}.md`)
writeFileSync(notasTmp, notas, 'utf8')

let jaExiste = true
try {
  gh('release', 'view', tag)
} catch {
  jaExiste = false
}

log('')
log(`  publicando  ${tag} ...`)
if (jaExiste) {
  log('              a release ja existe: --clobber nos artefatos')
  gh('release', 'upload', tag, '--clobber', ...arquivos)
  gh('release', 'edit', tag, '--notes-file', notasTmp, '--title', `ST PLAY ${versao}`, '--latest')
} else {
  gh('release', 'create', tag, '--title', `ST PLAY ${versao}`, '--notes-file', notasTmp, '--latest', ...arquivos)
}
rmSync(notasTmp, { force: true })

/* ------------------------------------- 6. conferir o que o GitHub gravou */

log('')
log('  conferindo  o que o GitHub gravou')
const dados = JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`))
for (const file of arquivos) {
  const nome = basename(file)
  const asset = dados.assets.find((a) => a.name === nome)
  if (!asset) falha(`asset "${nome}" nao apareceu na release ${tag}`)
  const local = sha256(file)
  const remoto = (asset.digest || '').replace('sha256:', '')
  if (remoto && remoto !== local) {
    falha(`digest divergente em "${nome}"\n      local  ${local}\n      github ${remoto}`)
  }
  log(`              ${nome}  ok`)
}

/* ------------------------------------------------------ 7. commit e push */

/*
 * SO O MANIFESTO ENTRA NO COMMIT.
 *
 * Era `git('status', '--porcelain')` + `git add -A`, e o `-A` é o problema: ele
 * varre a arvore INTEIRA e leva junto o que estava solto. Medido nesta 1.0.2: três
 * `scripts/probe-*.cjs` de diagnóstico, que o dono tinha dito para não commitar,
 * entraram no commit "build: 1.0.2 publicada" porque estavam untracked na hora do
 * release. Quem depende disso é o próximo build de quem estiver com um arquivo
 * qualquer aberto.
 *
 * A condição também era a errada: perguntava "a árvore está suja?" e respondia
 * "então commita tudo". A pergunta certa é "o manifesto mudou?".
 */
const manifestoAlterado = git('status', '--porcelain', '--', 'release-exe-manifest.txt').trim()
if (manifestoAlterado) {
  git('add', '--', 'release-exe-manifest.txt')
  git('commit', '-m', `build: ${versao} publicada`)
  log('')
  log(`  commit      build: ${versao} publicada`)
  const foraDoCommit = git('status', '--porcelain')
  if (foraDoCommit) {
    log(`  arvore      ${foraDoCommit.split('\n').length} arquivo(s) fora do commit, por design:`)
    for (const linha of foraDoCommit.split('\n').filter(Boolean)) log(`              ${linha}`)
  }
  if (semPush) {
    log('  push        pulado (--no-push)')
  } else {
    git('push', 'origin', 'main')
    log(`  empurrei    ${versao} -> main`)
  }
} else {
  log('')
  log('  commit      nada a commitar, o manifesto ja estava igual')
}

log(`\n  pronto. https://github.com/${repo}/releases/tag/${tag}\n`)
