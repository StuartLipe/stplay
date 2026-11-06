/*
 * Sobe a versao do projeto.
 *
 * Escrito como script, e nao na mao, por dois motivos:
 *   - `Set-Content` do PowerShell 5.1 grava BOM e o `JSON.parse` do Vite morre
 *     com "Unexpected token". Isso ja matou um build inteiro uma vez.
 *   - package.json e package-lock.json precisam concordar, ou o `npm ci` falha
 *     em outra maquina. O guard-build checa isso, mas e melhor nao depender
 *     dele para pegar.
 *
 * Ajusta tambem os campos do NSIS que carregam a versao no texto do atalho e
 * do desinstalador — o guard exige que ambos contenham a versao.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const nova = process.argv[2]

if (!/^\d+\.\d+\.\d+$/.test(nova ?? '')) {
  console.error('  uso: node scripts/bump-version.mjs 1.0.8')
  process.exit(1)
}

function lerJson(file) {
  const bruto = readFileSync(join(root, file), 'utf8')
  if (bruto.charCodeAt(0) === 0xfeff) {
    console.error(`  ${file} tem BOM — regrave sem BOM antes.`)
    process.exit(1)
  }
  return JSON.parse(bruto)
}

const pkg = lerJson('package.json')
const lock = lerJson('package-lock.json')

const antiga = pkg.version
if (antiga === nova) {
  console.log(`  versao ja e ${nova}`)
  process.exit(0)
}

pkg.version = nova
if (pkg.build?.nsis) {
  for (const campo of ['shortcutName', 'uninstallDisplayName']) {
    const valor = pkg.build.nsis[campo]
    if (typeof valor === 'string') {
      pkg.build.nsis[campo] = valor.replace(antiga, nova)
    }
  }
}

lock.version = nova
if (lock.packages?.['']) lock.packages[''].version = nova

writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', 'utf8')

console.log(`  versao ${antiga} -> ${nova}`)
console.log(`  atalho: ${pkg.build?.nsis?.shortcutName}`)
