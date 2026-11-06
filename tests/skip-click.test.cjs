/*
 * Prova, no motor real (Electron/Chromium), o que um clique no popup faz.
 *
 * O overlay tem um handler GLOBAL de clique (`onBackgroundClick`) que chama
 * `togglePause()`. Um widget que não para a propagação do clique acaba
 * pausando o vídeo junto com a própria ação — foi o que aconteceu no botão
 * "Pular abertura".
 *
 * Este teste monta a mesma estrutura duas vezes:
 *   1. SEM stopPropagation  -> o handler global TEM que disparar (o defeito)
 *   2. COM stopPropagation  -> o handler global NÃO pode disparar (a correção)
 *
 * Uso:  npx electron tests/skip-click.test.cjs
 * Sai com código 0 se os dois casos baterem.
 */
const { app, BrowserWindow } = require('electron')

// sem janela o Electron encerra sozinho e o 2o caso nunca roda
app.on('window-all-closed', () => {})

const HTML = (comStop) => `<!doctype html><html><body style="margin:0">
<div id="video" style="position:fixed;inset:0;background:#000"></div>
<div id="slot" style="position:fixed;left:40px;top:40px;width:220px;height:70px">
  <button id="btn" style="width:100%;height:100%">Pular abertura</button>
</div>
<script>
  window.__fundo = 0            // handler global (togglePause)
  window.__botao = 0            // ação do widget (seek)
  // No app real o handler e de WINDOW (onBackgroundClick -> togglePause).
  window.addEventListener('click', () => {
    window.__fundo += 1
  })
  const slot = document.getElementById('slot')
  ${comStop ? "slot.addEventListener('click', (e) => e.stopPropagation())" : ''}
  document.getElementById('btn').addEventListener('click', () => {
    window.__botao += 1
  })
</script></body></html>`

async function rodar(comStop) {
  const fs = require('fs')
  const path = require('path')
  const { pathToFileURL } = require('url')
  const file = path.join(__dirname, `tmp-skip-${comStop ? 'com' : 'sem'}.html`)
  fs.writeFileSync(file, HTML(comStop), 'utf8')
  const win = new BrowserWindow({ show: false, width: 400, height: 300 })
  await win.loadURL(pathToFileURL(file).href)
  await new Promise((r) => setTimeout(r, 250))

  const p = await win.webContents.executeJavaScript(
    "(() => { const r = document.getElementById('btn').getBoundingClientRect();" +
    " return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()",
  )
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 250))

  const res = await win.webContents.executeJavaScript(
    '({ fundo: window.__fundo, botao: window.__botao })',
  )
  return res
}

app.whenReady().then(async () => {
  const sem = await rodar(false)
  const com = await rodar(true)

  console.log('sem stopPropagation:', JSON.stringify(sem))
  console.log('com stopPropagation:', JSON.stringify(com))

  const okSem = sem.botao === 1 && sem.fundo === 1
  const okCom = com.botao === 1 && com.fundo === 0

  console.log(okSem ? 'OK  sem: botao agiu E o fundo pausou (defeito reproduzido)'
                    : 'FALHOU sem: estrutura nao reproduziu o defeito')
  console.log(okCom ? 'OK  com: botao agiu e o fundo NAO pausou (correcao funciona)'
                    : 'FALHOU com: o clique ainda chegou no fundo')

  app.exit(okSem && okCom ? 0 : 1)
})
