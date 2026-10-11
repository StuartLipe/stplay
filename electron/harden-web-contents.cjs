/**
 * Trava navegacao e abertura de janela em QUALQUER webContents.
 *
 * Precisa ser aplicado as DUAS janelas, nao so a principal: o overlay carrega o
 * mesmo preload (com `downloads:open-folder` -> `shell.openPath`) e renderiza
 * `channel.name` vindo do painel. Sem o guard nela, um `target=_blank` ou um
 * `location.href` navegava um renderer privilegiado para a internet com a ponte
 * ainda anexada — exatamente o ataque que o guard da janela principal descreve.
 *
 * `setPermissionRequestHandler` e de sessao, entao ja cobre as duas; navegacao e
 * window-open sao por webContents, e por isso precisam ser aplicadas uma a uma.
 *
 * Idempotente por `__sturHardened`, para chamar duas vezes nao duplica listeners.
 */
function hardenWebContents(wc, log) {
  if (!wc || wc.__sturHardened) return
  wc.__sturHardened = true

  // Nada no app linka para fora, entao nao ha caso legitimo para abrir janela
  // nova. `shell.openExternal` foi removido de proposito: ele disparava para
  // qualquer URL que o renderer produzisse, e o renderer renderiza strings
  // controladas pelo painel (nome de canal, plot) — ou seja, o provider
  // controlaria a abertura de programa no navegador do usuario.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  wc.on('will-navigate', (event, url) => {
    const current = wc.getURL()
    if (url === current) return
    event.preventDefault()
    if (log && log.warn) log.warn('app', 'navegacao bloqueada', { url: String(url).slice(0, 120) })
  })
}

module.exports = { hardenWebContents }
