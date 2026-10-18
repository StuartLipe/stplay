/**
 * Tira a credencial da URL antes de qualquer log — versao CJS do processo main.
 *
 * POR QUE ISTO DUPLICA `src/lib/proxy.ts` (`redactUrlForLog`):
 * o renderer e TypeScript empacotado pelo Vite, e o main e CJS puro carregado
 * pelo Electron antes do bundle existir. Nao ha import crosses entre os dois sem
 * amarrar o `vite.config`. A duplicacao e de 10 linhas e fica em UM lugar so de
 * cada lado; os dois estao apontados um para o outro. Se mudar a regra, mude nos
 * dois.
 *
 * A URL do painel Xtream tem a senha em duas formas, e as duas vazavam para o
 * `internal-debug.log` (`%APPDATA%\ST PLAY\`), que sobrevive ao fechar o app:
 *
 *   http://host/player_api.php?username=639563670&password=334918348&action=X
 *   http://host/live/639563670/334918348/2396226.m3u8
 *
 * O corte em 160 caracteres nao protegia nada: a credencial cai entre a posicao
 * 28 e 90 nas duas formas, ou seja, no COMECO da string.
 *
 * A regra e por desenho, nao por allowlist. Sobram host, tipo, id e `action` —
 * que e o que o diagnostico de rede usa de fato.
 */
function redactUrlForLog(url) {
  return String(url)
    .replace(
      /([?&](?:username|password|pass|passwd|user|token|auth|api_?key|key|mac|mac_address)=)[^&#]*/gi,
      '$1***',
    )
    .replace(
      /(\/(?:live|movie|series|player_api)(?:\.php)?\/)\d+\/\d+(\/)/gi,
      '$1***/***$2',
    )
}

module.exports = { redactUrlForLog }