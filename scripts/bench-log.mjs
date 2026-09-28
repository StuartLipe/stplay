// Mede o custo de uma linha de log no processo principal, antes x depois.
//
// ANTES (player-log.cjs antigo): existsSync + statSync + mkdirSync +
// appendFileSync — quatro syscalls SINCRONAS por linha.
//
// DEPOIS (electron/log-writer.cjs): push num array + um WriteStream
// assincrono, com flush agrupado.
//
// Nao e um micro-benchmark de fs: e a repeticao do que o app realmente faz
// durante um zape de live (5-6 linhas de log) multiplicada por varios zapes,
// que e onde o custo aparecia para o usuario como "a tela travou".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stplay-log-'))
const LINES = 300

function antes(file) {
  // Replica o caminho antigo na ORDEM REAL: rotateIfNeeded conferia existsSync
  // primeiro e so entao chamava statSync, e o write ainda fazia mkdirSync +
  // appendFileSync em seguida.
  for (let i = 0; i < LINES; i += 1) {
    // rotateIfNeeded
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file)
        if (stat.size > 2 * 1024 * 1024) { /* nada nesta medicao */ }
      }
    } catch { /* ignore */ }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), i })}\n`)
  }
}

function depois(file) {
  const w = require(path.resolve('electron/log-writer.cjs'))
  for (let i = 0; i < LINES; i += 1) {
    w.append(file, JSON.stringify({ at: new Date().toISOString(), i }))
  }
  w.closeAll()
}

function medir(nome, fn) {
  const file = path.join(dir, `${nome}.log`)
  const t0 = process.hrtime.bigint()
  fn(file)
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6

  // O bench nao pode aceitar um log que nao chegou ao disco. A primeira versao
  // media 6,5x e "depois: 0 bytes" — o stream nao tinha descarregado e o
  // resultado era uma melhoria que perderia o log. Aqui a contagem de linhas e
  // conferida, e divergir reprova o bench.
  const texto = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const linhas = texto.split('\n').filter(Boolean).length
  const bytes = Buffer.byteLength(texto)
  const ok = linhas === LINES
  console.log(
    `  ${nome.padEnd(8)} ${ms.toFixed(1).padStart(8)} ms   ${String(bytes).padStart(9)} bytes   ` +
      `${String(linhas).padStart(4)} linhas  ${ok ? 'OK' : 'PERDEU LINHAS'}`,
  )
  if (!ok) {
    console.error(`\n  FALHA: ${nome} gravou ${linhas} de ${LINES} linhas`)
    process.exitCode = 1
  }
  return { ms, ok }
}

console.log(`\n${LINES} linhas de log, processo principal\n`)
const a = medir('antes', antes).ms
const b = medir('depois', depois).ms

console.log(`\n  ganho: ${(a / b).toFixed(1)}x mais rapido`)
console.log(`  por linha: ${(a / LINES).toFixed(3)} ms -> ${(b / LINES).toFixed(4)} ms`)

// 5-6 linhas por zape, o que o log do player realmente emite
console.log(`\n  por zape de live (6 linhas):`)
console.log(`    antes : ${((a / LINES) * 6).toFixed(2)} ms de bloqueio`)
console.log(`    depois: ${((b / LINES) * 6).toFixed(3)} ms de bloqueio`)

fs.rmSync(dir, { recursive: true, force: true })
