const { execSync, spawn } = require('child_process')

/**
 * Mata a árvore de processos no Windows e RESOLVE quando o taskkill termina.
 *
 * Existe por causa de um congelamento que eu mesmo introduzi: usar
 * `execSync('taskkill ...', { timeout: 3000 })` no caminho de abrir um canal
 * bloqueia o processo principal do Electron inteiro — a janela inteira fica
 * congelada e o clique no proximo canal so responde depois. `sync: true` e
 * aceitavel no `before-quit` (o app esta saindo), nunca na hot path.
 *
 * Aqui o `await` nao bloqueia o main: o `spawn` do taskkill roda em background e
 * a promise so resolve no callback de saida. O processo alvo morre de verdade
 * antes de o chamador continuar, entao nao ha processo duplicado.
 */
function forceKillPidAsync(pid) {
  return new Promise((resolve) => {
    if (!pid || pid <= 0) {
      resolve()
      return
    }
    let settled = false
    let guard = null
    const settle = () => {
      if (settled) return
      settled = true
      if (guard) clearTimeout(guard)
      resolve()
    }

    // A rede de seguranca e armada AQUI, antes do spawn — e nao dentro do
    // callback de saida. Na primeira versao eu tinha posto o timer dentro do
    // `done`, que so roda quando o taskkill JA morreu: o timer nunca disparava
    // e o `resolve()` seguinte resolvia na hora. Se o taskkill pendurasse (e ele
    // pendura quando o processo alvo esta travado em I/O), a promise nunca
    // resolvia e o `await` em `spawnMpvCore` segurava `runHostOp` para sempre.
    // Isso era pior que o congelamento original.
    guard = setTimeout(settle, 1500)
    if (guard.unref) guard.unref()

    let child
    try {
      child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      })
    } catch {
      settle()
      return
    }
    child.once('exit', settle)
    child.once('error', settle)
  })
}

/**
 * Mata árvore de processo no Windows.
 * @param {number} pid
 * @param {{ sync?: boolean }} [opts] sync=true só no fechamento do app (before-quit).
 */
function forceKillPid(pid, opts = {}) {
  if (!pid || pid <= 0) return
  const sync = opts.sync === true
  if (sync) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
      })
    } catch {
      // ignore — processo já morreu
    }
    return
  }
  try {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
  } catch {
    // ignore
  }
}

function forceKillProc(proc, opts = {}) {
  if (!proc) return null
  const pid = proc.pid
  try {
    proc.removeAllListeners('exit')
  } catch {
    // ignore
  }
  try {
    proc.kill()
  } catch {
    // ignore
  }
  if (!pid) return null
  if (opts.sync === true) {
    forceKillPid(pid, opts)
    return null
  }
  return forceKillPidAsync(pid)
}

module.exports = { forceKillPid, forceKillPidAsync, forceKillProc }
