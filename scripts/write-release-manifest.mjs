// Re-grava `release-exe-manifest.txt` com os artefatos que existem em release/
// AGORA.
//
// O manifesto existe para provar que um .exe ja publicado nao foi sobrescrito
// por bytes diferentes com o mesmo numero de versao — o `guard-build.mjs`
// confere SHA256 e tamanho antes de escrever qualquer byte.
//
// Ele precisa ser atualizado em dois momentos, e so nesses:
//   1. depois de um build, quando os artefatos NOVOS substituem os antigos
//      (o `latest.yml` aponta para um nome com a versao, e o electron-updater
//      so descobre a versao pelo `latest.yml` da Release — que e o que o app
//      instalado le)
//   2. depois de publicar a Release, para casar com o que esta no GitHub
//
// Nao deve ser mexido a mao para "fazer passar": o comentario do proprio guard
// diz isso. Este script so le o que esta em disco e escreve o que viu.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const release = join(root, 'release')
const manifestPath = join(root, 'release-exe-manifest.txt')

const arquivos = readdirSync(release)
  .filter((n) => n.toLowerCase().endsWith('.exe'))
  .sort()

if (!arquivos.length) {
  console.log('  nenhum .exe em release/ — nada a registrar (o manifesto anterior foi preservado)')
  process.exit(0)
}

const carimbo = new Date().toISOString().slice(0, 19).replace('T', ' ')
const linhas = arquivos.map((nome) => {
  const bytes = readFileSync(join(release, nome))
  const hash = createHash('sha256').update(bytes).digest('hex')
  return `${nome}|${hash}|${bytes.length}|${carimbo}`
})

const anterior = readFileSync(manifestPath, 'utf8')
writeFileSync(manifestPath, linhas.join('\n') + '\n', 'utf8')

console.log(`  manifesto atualizado: ${linhas.length} artefato(s)`)
for (const linha of linhas) {
  const [nome, hash, tamanho] = linha.split('|')
  console.log(`    ${nome}  ${tamanho} bytes  sha256=${hash.slice(0, 16)}...`)
}
console.log(`  antes tinha ${anterior.split('\n').filter(Boolean).length} linha(s)`)
