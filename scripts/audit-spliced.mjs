/**
 * CAÇA-LIXO nos arquivos que eu reescrevi linha a linha com PowerShell.
 *
 * O risco concreto: eu usei WriteAllLines/Replace para editar arquivos grandes,
 * e um splice errado deixa para tras duplicata de linha, bloco orfao ou
 * encoding quebrado. `node --check` pega sintaxe invalida, mas NAO pega um
 * `if (...) {` duplicado que ainda compila.
 *
 * Cada teste aqui e uma forma de lixo que ja aconteceu ou poderia acontecer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const alvos = [
  'electron/players/stur-player.cjs',
  'electron/players/player-host.cjs',
  'electron/players/hls-normalizer.cjs',
  'electron/players/hls-window.cjs',
  'electron/players/live-load-policy.cjs',
  'electron/players/overlay-window.cjs',
  'electron/players/playback-profile.cjs',
  'electron/main.cjs',
  'src/App.tsx',
  'src/index.css',
  'src/lib/xtream.ts',
  'src/lib/players/types.ts',
]

const problemas = []
const ok = []

for (const rel of alvos) {
  const caminho = join(root, rel)
  const bruto = readFileSync(caminho)
  const txt = bruto.toString('utf8')
  const linhas = txt.split(/\r?\n/)
  const achados = []

  // 1. BOM no meio do arquivo (Set-Content -Encoding utf8 no PS 5.1).
  if (txt.includes('﻿')) achados.push('BOM U+FEFF dentro do arquivo')

  // 2. Linha duplicada na sequencia (splice que repetiu a abertura).
  const vistos = new Map()
  for (let i = 0; i < linhas.length; i++) {
    const t = linhas[i].trim()
    if (t.length < 12) continue
    if (/^[\s{}()]*$/.test(t)) continue
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    if (vistos.has(t)) {
      achados.push(`linha ${i + 1} duplicada de ${vistos.get(t) + 1}: ${t.slice(0, 70)}`)
    } else {
      vistos.set(t, i)
    }
  }

  // 3. Chave de funcao/const declarada duas vezes no mesmo escopo.
  const decls = new Map()
  for (let i = 0; i < linhas.length; i++) {
    const m = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(linhas[i])
    if (m) {
      const nome = m[1]
      if (decls.has(nome) && decls.get(nome) !== i) {
        achados.push(`function ${nome}() declarada nas linhas ${decls.get(nome) + 1} e ${i + 1}`)
      } else decls.set(nome, i)
    }
  }

  // 4. Bloco de comentario que nunca fecha (splice cortou no meio).
  const abreBloco = (txt.match(/\/\*/g) || []).length
  const fechaBloco = (txt.match(/\*\//g) || []).length
  if (abreBloco !== fechaBloco) {
    achados.push(`comentario de bloco desbalanceado: ${abreBloco} "/*" e ${fechaBloco} "*/"`)
  }

  // 5. String com acento corrompido pelo caminho de encoding do PS 5.1.
  const corrompidos = txt.match(/[�]|Ã©|Ã£|Ãµ|â€/g)
  if (corrompidos) {
    achados.push(`${corrompidos.length} caractere(s) com sinal de mojibake: ${[...new Set(corrompidos)].join(' ')}`)
  }

  // 6. CRLF e LF misturados no mesmo arquivo.
  const crlf = (txt.match(/\r\n/g) || []).length
  const lf = (txt.match(/(?<!\r)\n/g) || []).length
  if (crlf && lf) achados.push(`fim de linha misturado: ${crlf} CRLF e ${lf} LF`)

  // 7. Chave de objeto ou propriedade com dois pontos a menos/mais.
  for (let i = 0; i < linhas.length; i++) {
    if (/^\s*[a-zA-Z_$][\w$]*\s+[a-zA-Z_$][\w$]*:\s*$/.test(linhas[i])) {
      achados.push(`linha ${i + 1} com propriedade sem valor: ${linhas[i].trim()}`)
    }
  }

  if (achados.length) problemas.push({ rel, achados })
  else ok.push(`${rel}  (${linhas.length} linhas, ${Math.round(statSync(caminho).size / 1024)} KB)`)
}

console.log('  ===== OK =====')
for (const o of ok) console.log(`  ${o}`)
console.log('')
if (!problemas.length) {
  console.log('  nenhum lixo encontrado')
} else {
  console.log('  ===== ACHADOS =====')
  for (const p of problemas) {
    console.log(`  ${p.rel}`)
    for (const a of p.achados) console.log(`     - ${a}`)
  }
}
