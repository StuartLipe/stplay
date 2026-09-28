/*
 * Atualizacao automatica do app.
 *
 * Por que isto so funciona com o repo PUBLICO: o `electron-updater` le o
 * `latest.yml` da release pela API do GitHub sem token. Com o repo privado a
 * API responde 404 (verificado: a pagina da release, o download do asset e a
 * API /releases/latest devolvem 404 ou exigem login para quem nao esta
 * autenticado), e o app concluiria "voce esta atualizado" para sempre.
 *
 * O que o dono escolheu: manter o `sturplay` publico. Sem isso, esta pagina
 * inteira seria codigo morto.
 *
 * O padrao de fluxo e o do Discord/VS Code, nao o de "instalar sozinho":
 *
 *   1. o app checa (uma vez por dia) o `latest.yml`
 *   2. se houver versao nova, BAIXA em silencio, sem barra de progresso
 *   3. so depois de pronto aparece o aviso, offering "Reiniciar"
 *   4. quem ignorar recebe a atualizacao no proximo boot
 *
 * E por isso que o aviso chega TARDIO e nao no boot: uma checagem a cada
 * abertura transformaria um evento de uma vez por versao em um cartaz
 * permanente. O `app-update.yml` que o electron-builder gera traz o
 * `releasedAt`; e ele que separa "ha versao nova" de "me lembra de novo".
 */
const { app, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const plog = require('./players/player-log.cjs')

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const STATE_FILE = 'updater-state.json'

/*
 * `autoUpdater` fica num require tardio de proposito. O `electron-updater`
 * le `app-update.yml` de dentro do asar no momento do require, e em dev esse
 * arquivo nao existe — o require estouraria no boot do `npm run desktop` e
 * derrubaria o app inteiro por causa de um recurso que so importa no
 * empacotado.
 */
let updater = null
let updaterErro = null

function carregarAutoUpdater() {
  if (updater || updaterErro) return updater
  if (!app.isPackaged) {
    updaterErro = 'dev'
    return null
  }
  try {
    // eslint-disable-next-line global-require
    const mod = require('electron-updater')
    updater = mod.autoUpdater
    updater.autoDownload = true
    /*
     * `autoInstallOnAppQuit` DESLIGADO, e nao por padrao.
     *
     * Ligado, o `electron-updater` instala em silencio quando o app fecha
     * normalmente: em `BaseUpdater.js` o handler de quit chama
     * `this.install(true, false)` — o primeiro `true` e `isSilent`, fixo no
     * fonte da biblioteca, sem meio de mudar pela API. A pessoa dispensaria o
     * cartaz para NAO instalar e receberia a instalacao assim mesmo, so porque
     * fechou o app. O dono pediu confirmacao, e um caminho que instala sem
     * perguntar nao serve.
     *
     * O preco: dispensar o cartaz deixa de instalar sozinho no proximo boot. O
     * instalador continua em `pending` e so sai de la quando a pessoa clicar em
     * "Reiniciar" — que e o comportamento correto de quem nao quer agora.
     */
    updater.autoInstallOnAppQuit = false
    // Sem isto o Windows pergunta "de onde veio este aplicativo" a cada
    // instalacao, e o dono nao tem certificado de assinatura.
    updater.logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }
    /*
     * Sem esta chamada o `autoUpdater` funciona e ninguem escuta: o
     * `update-available` e o `update-downloaded` acontecem no processo principal
     * e morrem ali. O renderer receberia `status` e o botao "Verificar agora"
     * pareceria funcionar, mas o cartaz nunca apareceria — que e o defeito
     * exato que o aviso de `firstTime` existe para evitar.
     */
    ligarEventos(updater)
  } catch (error) {
    updaterErro = String(error && error.message ? error.message : error)
    plog.warn('updater', 'autoUpdater indisponivel', { error: updaterErro })
  }
  return updater
}

/* ---------------------------------------------------------------- estado */

/*
 * O estado mora em `userData`, ao lado dos demais arquivos do app, e NAO no
 * `localStorage` do renderer: o `quitAndInstall` mata o processo antes de o
 * renderer ter chance de salvar qualquer coisa.
 */
function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE)
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function gravarEstado(patch) {
  try {
    const proximo = { ...lerEstado(), ...patch }
    fs.writeFileSync(statePath(), JSON.stringify(proximo), 'utf8')
    return proximo
  } catch (error) {
    plog.warn('updater', 'nao gravou estado', { error: String(error && error.message) })
    return lerEstado()
  }
}

/* ------------------------------------------------------------- emissao */

let janelaPrincipal = null

/*
 * Verdadeira apenas durante a checagem do portatil, com `autoDownload` desligado.
 * E o que impede o `update-available` de mandar o cartaz prometer um download que
 * este build esta deliberadamente nao fazendo.
 */
let modoPortatil = false

function setJanelaPrincipal(win) {
  janelaPrincipal = win
}

function emitir(payload) {
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return
  try {
    janelaPrincipal.webContents.send('updater:event', payload)
  } catch {
    // ignore
  }
}

/* ---------------------------------------------------------------- portatil */

/*
 * O executavel portatil NAO pode se atualizar, e o motivo e fisico: e um
 * arquivo unico auto-extraivel. Ele roda de dentro de uma pasta temporaria e
 * nao tem pasta de instalacao para o NSIS substituir — nao ha destino para os
 * 144 MB.
 *
 * Sem esta checagem, quem usasse o portatil receberia o fluxo completo: o app
 * baixava o INSTALADOR de 144 MB, e o `quitAndInstall` rodava esse instalador,
 * criando uma segunda copia do app em `%LOCALAPPDATA%\Programs\ST PLAY`
 * enquanto o portatil continuava sendo o que a pessoa abreva. Duas copias,
 * 144 MB, e nenhum pedido feito.
 *
 * A deteccao e a variavel que o electron-builder define no stub do portatil,
 * `PORTABLE_EXECUTABLE_DIR`. O caminho do executavel serve de reserva, mas e
 * chute: adivinhar por `\Temp\` no caminho acerta por acaso.
 */
function ehPortatil() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true
  try {
    return /\\Temp\\|\\Portable\\|stplay-portable/i.test(app.getPath('exe'))
  } catch {
    return false
  }
}

/* ------------------------------------------------------- checagem de 24h */

function jaChecouHoje() {
  const { ultimoCheck } = lerEstado()
  if (!ultimoCheck) return false
  return Date.now() - Number(ultimoCheck) < CHECK_INTERVAL_MS
}

function marcarChecagem() {
  gravarEstado({ ultimoCheck: Date.now() })
}

/* ----------------------------------------------------------------- eventos */

function ligarEventos(up) {
  up.on('update-available', (info) => {
    plog.info('updater', 'update-available', { version: info && info.version })
    if (modoPortatil) return
    emitir({ type: 'available', version: String(info.version) })
  })

  up.on('update-not-available', (info) => {
    plog.info('updater', 'update-not-available', { version: info && info.version })
    emitir({ type: 'not-available', version: info ? String(info.version) : null })
  })

  up.on('download-progress', (progress) => {
    emitir({
      type: 'progress',
      percent: Math.round(Number(progress.percent) || 0),
      transferred: Number(progress.transferred) || 0,
      total: Number(progress.total) || 0,
      bytesPerSecond: Number(progress.bytesPerSecond) || 0,
    })
  })

  up.on('update-downloaded', (info) => {
    plog.info('updater', 'update-downloaded', { version: info && info.version })
    /*
     * `shownVersion` e o que impede o cartaz perpetuo. Uma vez mostrado para
     * esta versao, nao mostra de novo — mesmo que a pessoa feche o app sem
     * reiniciar. Ela recebe a atualizacao no proximo boot de todo jeito, por
     * causa do `autoInstallOnAppQuit`.
     */
    const estado = lerEstado()
    const versao = String(info.version)
    emitir({
      type: 'downloaded',
      version: versao,
      firstTime: estado.shownVersion !== versao,
    })
    if (estado.shownVersion !== versao) gravarEstado({ shownVersion: versao })
  })

  up.on('error', (error) => {
    const mensagem = String(error && error.message ? error.message : error)
    plog.warn('updater', 'erro', { error: mensagem })
    emitir({ type: 'error', message: mensagem })
  })
}

/* ----------------------------------------------------------------- checar */

async function checar({ manual } = {}) {
  const up = carregarAutoUpdater()
  if (!up) {
    return {
      ok: false,
      reason: updaterErro === 'dev' ? 'dev' : 'unavailable',
      message: updaterErro === 'dev' ? 'O updater so roda no app empacotado.' : 'Updater indisponivel.',
    }
  }

  if (!manual && jaChecouHoje()) {
    return { ok: true, skipped: true, reason: 'checked-today' }
  }

  /*
   * O portatil descobre a versao nova mas nao baixa nada.
   *
   * `autoDownload` e `true`, entao o `checkForUpdates()` ja comeca a baixar
   * 144 MB do INSTALADOR assim que encontra a release. Desligar so depois nao
   * adianta: o download ja saiu. Por isso ele e desligado ANTES da chamada, e
   * a flag `modoPortatil` silencia o `update-available` para o cartaz nao
   * prometer um download que nao vai acontecer.
   *
   * Consultar com `autoDownload: false` ainda da a versao, que e o que permite
   * dizer "a 1.0.1 esta disponivel" em vez de um "baixe o instalador" vazio.
   */
  if (ehPortatil()) {
    modoPortatil = true
    up.autoDownload = false
    try {
      const resultado = await up.checkForUpdates()
      marcarChecagem()
      const versao = resultado && resultado.updateInfo ? String(resultado.updateInfo.version) : null
      emitir({ type: 'portable', version: versao })
      return { ok: true, portable: true, available: Boolean(versao), version: versao }
    } catch (error) {
      plog.warn('updater', 'checagem no portatil falhou', {
        error: String(error && error.message ? error.message : error),
      })
      emitir({ type: 'portable', version: null })
      return { ok: true, portable: true, available: false, version: null }
    } finally {
      up.autoDownload = true
      modoPortatil = false
    }
  }

  try {
    const resultado = await up.checkForUpdates()
    marcarChecagem()
    if (!resultado || !resultado.updateInfo) return { ok: true, available: false }
    return {
      ok: true,
      available: true,
      version: String(resultado.updateInfo.version),
    }
  } catch (error) {
    const mensagem = String(error && error.message ? error.message : error)
    plog.warn('updater', 'check falhou', { error: mensagem, manual: Boolean(manual) })
    // Nao propaga o erro: falha de rede nao pode virar erro na tela do app.
    return { ok: false, reason: 'check-failed', message: mensagem }
  }
}

/* ---------------------------------------------------------------- instalar */

/*
 * O `before-quit` do main faz `event.preventDefault()` e chama `app.exit(0)`
 * para dar tempo de derrubar o mpv e esvaziar o log. Se ele rodar durante o
 * `quitAndInstall`, mata o processo antes do instalador assumir — e a
 * atualizacao fica silenciosamente sem aplicar. Por isso o main consulta esta
 * flag antes de Preventar.
 */
let instalando = false

function isInstalando() {
  return instalando
}

function instalar() {
  const up = carregarAutoUpdater()
  if (!up) return { ok: false, message: 'Updater indisponivel neste build.' }
  if (instalando) return { ok: true, alreadyRunning: true }
  try {
    instalando = true
    plog.info('updater', 'quitAndInstall solicitado')
    /*
     * `isSilent` = false: o instalador do NSIS aparece e PERGUNTA.
     *
     * Era `true`, e o dono reclamou — a intencao original era "instalar e
     * pronto", mas o efeito e trocar uma atualizacao por 145 MB sem a pessoa
     * decidir nada. A confirmacao do proprio instalador, com a barra e o
     * botao, e o que da a sensacao de controle que o cartaz promete e nao
     * entrega.
     *
     * `isForceRunAfter` = false tambem, de proposito: com `isSilent: false` quem
     * decide o `autoRunAppAfterInstall` (default true) e o proprio NSIS. Passar
     * `true` aqui ignoraria essa preferencia.
     */
    setImmediate(() => up.quitAndInstall(false, false))
    return { ok: true }
  } catch (error) {
    instalando = false
    return { ok: false, message: String(error && error.message ? error.message : error) }
  }
}

/* -------------------------------------------------------------------- IPC */

function registerUpdaterIpc() {
  ipcMain.handle('updater:status', async () => {
    const up = carregarAutoUpdater()
    const estado = lerEstado()
    return {
      ok: true,
      packaged: app.isPackaged,
      portable: ehPortatil(),
      dev: updaterErro === 'dev',
      current: app.getVersion(),
      lastCheck: estado.ultimoCheck || null,
      shownVersion: estado.shownVersion || null,
      available: Boolean(up && up.downloadedUpdate),
      installing: instalando,
    }
  })

  ipcMain.handle('updater:check', async (_event, payload) => checar({ manual: Boolean(payload && payload.manual) }))

  ipcMain.handle('updater:install', async () => instalar())

  ipcMain.handle('updater:open-releases', async () => {
    await shell.openExternal('https://github.com/StuartLipe/stplay/releases/latest')
    return { ok: true }
  })
}

module.exports = {
  registerUpdaterIpc,
  setJanelaPrincipal,
  isInstalando,
  checar,
  instalar,
}
