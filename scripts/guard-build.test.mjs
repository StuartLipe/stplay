// Testes negativos do guard-build. Cada caso deve sair com exit != 0.
// Roda contra copias temporarias; restaura tudo ao final.
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const guard = join(root, 'scripts', 'guard-build.mjs')
const manifest = join(root, 'release-exe-manifest.txt')
const lock = join(root, 'package-lock.json')
const pkg = join(root, 'package.json')

const backups = new Map()
const save = (f) => { if (!backups.has(f)) backups.set(f, readFileSync(f)); }
const restore = () => {
  for (const [f, buf] of backups) writeFileSync(f, buf)
  backups.clear()
}

const run = () => {
  try {
    execFileSync(process.execPath, [guard], { cwd: root, stdio: 'pipe' })
    return { blocked: false, out: '' }
  } catch (e) {
    return { blocked: true, out: (e.stdout || '') + (e.stderr || '') }
  }
}

const cases = []

/*
 * A versao vem do package.json, nunca do literal.
 *
 * As tres primeiras mutacoes abaixo faziam replace de "1.0.6" hardcoded. Na
 * virada para a 1.0.0 elas viraram no-op silencioso: o replace nao encontrava
 * nada, o guard passava legitimately, e o teste reprovava sem que ninguem
 * tivesse mexido no guard. Pior: um guard de build com tres mutacoes mortas
 * parece cobertura e nao e — e o primeiro sinal de que o build nao esta mais
 * protegido.
 */
const versaoAtual = JSON.parse(readFileSync(pkg, 'utf8')).version
const outraVersao = versaoAtual.endsWith('.1')
  ? `${versaoAtual.slice(0, -2)}.0`
  : `${versaoAtual}.99`

// 1. lockfile com versao divergente do package.json
save(lock)
writeFileSync(lock, readFileSync(lock, 'utf8').replace(`"version": "${versaoAtual}"`, `"version": "${outraVersao}"`))
cases.push(['lockfile divergente do package.json', run()])
restore()

// 2. output com pasta por versao -> risco de sobrescrever release/
//
// A mutacao tambem estava obsoleta: ela trocava "release/1.0.6" por "release",
// mas o `output` ja era "release" desde a virada da politica. O replace nao
// encontrava nada e o guard passava. Aqui parte-se do valor REAL e injeta o
// caminho por versao que a regra proibe.
save(pkg)
writeFileSync(
  pkg,
  readFileSync(pkg, 'utf8').replace('"output": "release"', `"output": "release/${versaoAtual}"`),
)
cases.push(['output nao versionado', run()])
restore()

// 3. nome de instalador sem versao
save(pkg)
writeFileSync(pkg, readFileSync(pkg, 'utf8').replace(`ST PLAY ${versaoAtual}`, 'ST PLAY'))
cases.push(['atalho/sem versao', run()])
restore()

// 4. artefato publicado com hash adulterado no manifesto
save(manifest)
writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/\b[0-9a-f]{64}\b/, '0'.repeat(64)))
cases.push(['SHA256 de .exe publicado divergente', run()])
restore()

// 5. manifesto ausente
if (existsSync(manifest)) {
  save(manifest)
  unlinkSync(manifest)
  cases.push(['manifesto ausente', run()])
  restore()
}

// 5b. artefato do manifesto ausente no disco — o caso de um clone novo.
//
// Este NAO pode reprovar. O manifesto e versionado e o `release/` e
// gitignored, entao qualquer maquina nova recebe um manifesto que aponta para
// .exe que nao existem. Reprovar aqui bloqueava o primeiro `npm run pack`
// depois de formatar o PC, e a saida seria apagar o manifesto na mao —
// justamente o arquivo que existe para nao mexer.
//
// Ausente nao e adulterado: nao ha byte para comparar, e o build gera o que
// falta. O que reprova e PRESENTE com conteudo diferente (caso 4).
{
  const linhas = readFileSync(manifest, 'utf8').split('\n').filter((l) => l.trim())
  const primeira = linhas[0].split('|')[0]
  const alvo = join(root, 'release', primeira)
  const tinha = existsSync(alvo)
  if (tinha) {
    const conteudo = readFileSync(alvo)
    unlinkSync(alvo)
    cases.push(['artefato do manifesto ausente, como num clone novo (deve passar)', run()])
    writeFileSync(alvo, conteudo)
  }
}

// 6. caminho feliz
cases.push(['estado coerente (deve passar)', run()])

restore()

let failed = 0
console.log('')
for (const [name, r] of cases) {
  const shouldPass = name.includes('deve passar')
  const ok = shouldPass ? !r.blocked : r.blocked
  if (!ok) failed++
  const detail = r.blocked ? (r.out.match(/x {2}(.+)/) || [null, ''])[1] : 'liberado'
  console.log(`  ${ok ? 'ok  ' : 'FALHOU'}  ${name.padEnd(40)} ${detail}`)
}
console.log('')
process.exit(failed ? 1 : 0)
