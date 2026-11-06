/*
 * Atualiza o manifesto com os artefatos recem-compilados.
 *
 * Mesma regra do `release.mjs`: a versao que acabou de ser compilada entra no
 * manifesto e a linha antiga dela sai. As outras versoes ficam intactas.
 *
 * Sem isso, o proximo `npm run pack` seria bloqueado: o guard compara o que
 * esta no disco com o manifesto e veria o 1.0.7 com bytes diferentes.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const versao = process.argv[2] || '1.0.7'
const alvo = join(root, 'release')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function dataHora(file) {
  const d = statSync(file).mtime
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const caminho = join(root, 'release-exe-manifest.txt')
const antes = existsSync(caminho)
  ? readFileSync(caminho, 'utf8').split('\n').filter((l) => l.trim())
  : []

const arquivos = [`ST-PLAY-Setup-${versao}.exe`, `ST-PLAY-${versao}.exe`]
const depois = antes.filter((linha) => !linhasDaVersao(linha, versao))
for (const nome of arquivos) {
  const file = join(alvo, nome)
  if (!existsSync(file)) {
    console.error(`  artefato ausente: ${nome}`)
    process.exit(1)
  }
  depois.push(`${nome}|${sha256(file)}|${statSync(file).size}|${dataHora(file)}`)
}
writeFileSync(caminho, depois.join('\n'), 'utf8')

function linhasDaVersao(linha, v) {
  const nome = linha.split('|')[0] || ''
  return nome.endsWith(`-${v}.exe`)
}

console.log(`  manifesto atualizado para ${versao}`)
for (const l of depois) {
  const [nome, , tam] = l.split('|')
  console.log(`    ${nome}  ${tam} bytes`)
}
