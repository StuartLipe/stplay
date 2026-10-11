/**
 * Ao vivo: loadfile na URL do painel.
 * Não pré-resolve 302 (atrasa e pinna token) e não cai no proxy HTTP.
 */
function shouldPreResolveRedirect(url, live) {
  if (live === true) return false
  if (/\.m3u8(\?|#|$)/i.test(String(url || ''))) return false
  return true
}

function shouldTryHttpFallback(live) {
  return live !== true
}

/**
 * SEMPRE vazio: em live não existe "seek para a borda".
 *
 * Isto aqui JÁ EXISTIU como `[100, 'absolute-percent']` e era um dano, nao uma
 * correcao. Medido contra o painel real, no mesmo mpv, com o mesmo perfil:
 *
 *   sem seek:  file-loaded -> time-pos = 50.9   (a borda, porque live_start_index=-1
 *                                               ja poe o demuxer no ultimo segmento)
 *   com seek:  time-pos 50.9 -> 1.99             (delta -48.93, ~49s ATRAS)
 *
 * `absolute-percent` resolve para o INICIO da janela HLS, nao para a borda: a
 * janela deste painel tem 6 segmentos de 10s, e 100% do manifesto e o segmento
 * mais VELHO ainda listado. O proprio comentario antigo admitia isso ("puxa pro
 * comeco da janela HLS"), mas tratava como consequencia aceitavel.
 *
 * O dano era duplo:
 *
 *   1. Jogava o canal 30-60s para tras, no ponto mais velho da janela — o mais
 *      longe possivel da origem. O canal tocava conteudo velho enquanto a janela
 *   deslizava por baixo.
 *   2. Seek REINICIA o demuxer. O manual do mpv, em `--cache-pause-initial`:
 *      "This option also triggers when playback is restarted after seeking."
 *      Como o perfil de live tinha cache-pause-initial=no, cada seek reentrava
 *      tocando com o buffer vazio — o pior caso documentado, pagado a cada
 *      abertura de canal e a cada soft reload.
 *
 * A borda e trabalho do demuxer (`live_start_index=-1`). Nao e do seek.
 */
function liveEdgeSeekArgs() {
  return []
}

/**
 * 1 tela: espera o end-file do stop e um respiro curto antes do proximo loadfile.
 */
const LIVE_STOP_WAIT_MS = 700
const LIVE_CONN_RELEASE_MS = 400

function liveStopWaitMs() {
  return LIVE_STOP_WAIT_MS
}

function liveConnReleaseMs() {
  return LIVE_CONN_RELEASE_MS
}

/**
 * Options de lavf do live, todas no `demuxer-lavf-o`.
 *
 * `live_start_index` é do demuxer hls. `reconnect` / `reconnect_streamed` /
 * `reconnect_delay_max` são do AVFormatContext (camada de formato/protocolo).
 * Os dois grupos vivem no mesmo lugar.
 *
 * Eles NÃO podem ir em `stream-lavf-o`, e o motivo é textual no manual do mpv:
 * "Set AVOptions on streams opened with libavformat. **Unknown or misspelled
 * options are silently ignored.**" Postas lá, eram descartadas sem um único
 * erro no log — que é exatamente como o congelamento passou meses sem
 * ninguém notar que o reconnect nunca esteve ativo.
 *
 * `reconnect` no meio do zap segura o socket velho e ocupa a única tela da
 * conta, então a liberação do slot desliga e a reabertura religa.
 *
 * @param {boolean} reconnect
 */
function liveDemuxerLavfO(reconnect) {
  const base = liveStartIndex()
  const rc = reconnect
    ? 'reconnect=1,reconnect_streamed=1,reconnect_delay_max=5'
    : 'reconnect=0,reconnect_streamed=0,reconnect_delay_max=5'
  return `${base},${rc}`
}

/**
 * Onde o live começa dentro da janela HLS.
 *
 * `-1` é o ÚLTIMO segmento do manifesto, ou seja, a borda colada. Foi o que
 * estava aqui, e é a causa da imagem travando. Medido contra o canal real,
 * contando amostras de 1s em que o playhead não avançou:
 *
 *   live_start_index   congelamentos   runway medio
 *   -1 (borda colada)         66          0.3s
 *   -2 (1 segmento atras)      0          8.4s
 *   -3 (2 segmentos atras)     0          8.5s
 *   -4 (3 segmentos atras)     0          8.4s
 *
 * A leitura: com -1 o demuxer lê a janela inteira e o playhead fica colado no
 * fim dela, com 0,3s de vídeo à frente. O canal publica um segmento a cada 10s
 * (TARGETDURATION=10), então qualquer atraso da origem — e existe sempre — vira
 * quadro congelado. O log do app mostrava isso com clareza: `cacheTime: 134.0`
 * contra `timePos: 132.03`, ou seja, 2s de runway contra 10s de intervalo.
 *
 * `-2` recua um segmento: 10s de runway, que cobre o jitter de publicação, e o
 * player continua colado na borda. -3 e -4 não melhoram nada (8.4 vs 8.5s de
 * runway, zero congelamento nos três) — mais recuo seria latência sem retorno.
 *
 * NOTA: o código antigo também fazia `seek 100 absolute-percent` a cada
 * `file-loaded`, e isso dava ~58s de runway. Ele "resolvia" o travamento com
 * 49s de latência. Era o seek mascarando um `live_start_index` errado: corrigir
 * o `-1` para `-2` dá o mesmo silêncio sem o atraso.
 */
function liveStartIndex() {
  return 'live_start_index=-2'
}

/**
 * Timeout de LEITURA da rede, em segundos, por modo.
 *
 * Medido no congelamento real: o socket do mpv ficou `Established` com a origem
 * e 0 bytes/s por minutos. `reconnect=1` nao ajuda — reconnect so dispara quando
 * a conexao QUEBRA, e um socket aberto que nao entrega nada nunca quebra nem da
 * erro. O unico mecanismo que fecha isso e o timeout de leitura do ffmpeg, e ele
 * estava em 60s: sessenta segundos de tela parada antes do mpv reagir.
 *
 * 10s foi testado e MATOU o canal: `end-file error / loading failed` em 0.2s
 * depois do loadfile. A razao e estrutural, nao sorte — o canal publica um
 * segmento a cada 10s (TARGETDURATION=10), entao um read timeout igual ao
 * intervalo de publicacao erra por construcao. 25s da 2.5x de folga sobre o
 * intervalo e ainda corta o pior caso de 60s para 25s.
 */
function networkTimeoutSecs(live) {
  return live ? 25 : 60
}

/**
 * Ordem de tentativa dos modos de carga, por modo de playback.
 *
 * Este é o ponto onde a causa do travamento de live foi procurada, e a
 * comparação entre os dois players é real e estrutural:
 *
 * O player interno (hls.js) nunca fala com o painel. Ele busca em
 * `http://127.0.0.1:PORT/stream?u=...`, e esse proxy (`stream-proxy.cjs`) usa a
 * stack de rede do Chromium (`net.fetch`). Para live, o proxy entrega três
 * coisas que o mpv/ffmpeg não tem:
 *
 *   1. Descarta `content-length`/`content-encoding` do painel. O comentário do
 *      próprio proxy diz: "Nunca repassa Content-Length/Range do painel no
 *      live: painel com length errado causava net::ERR_CONTENT_LENGTH_MISMATCH
 *      e retry de segundos."
 *   2. Responde chunked.
 *   3. Segue o 302 do painel na stack do Chromium. `resolveRedirectUrl` existe
 *      exatamente por isso: "mpv sozinho costuma travar em HTTPS → HTTP + token".
 *
 * TENTADO E DESCARTADO: dar ao mpv o mesmo caminho do player interno
 * (`stream-proxy.cjs`, que nao trava). Resultado — falha em 100% dos canais:
 *
 *   loadfile ok mode=http
 *   ... 20s ...
 *   no file-loaded before timeout, trying fallback { mode: 'http' }
 *   live fallback → direct
 *
 * O mpv aceita a URL e o demuxer HLS nunca chega a `file-loaded`. O hls.js nao
 * tem o mesmo problema porque nao precisa de EOF nem de tamanho. O mecanismo
 * exato pelo qual o demuxer do ffmpeg nao engole a resposta chunked NAO foi
 * confirmado — e hipotese, nao medicao.
 *
 * A CAUSA REAL, e ela e do LADO DA FONTE:
 *
 * O painel nao publica playlist HLS canonica. Medido em 24 pedidos a 1,5s do
 * mesmo canal: 24 conjuntos de URL distintos, e 0 de 23 respostas consecutivas
 * compartilharam um unico segmento. Cada GET devolve uma janela recem-mintada,
 * com tokens novos; duas respostas nao tem nada em comum. A sequencia avanca
 * (~1 a cada 10s, batendo com TARGETDURATION=11) mas nao identifica nada.
 *
 * O demuxer HLS do ffmpeg identifica segmento pelo NUMERO DE SEQUENCIA, e por
 * isso para de buscar: ele acredita que ja baixou os numeros que ja viu. Medido
 * no mpv, sem nenhuma interferencia do app:
 *
 *   t=0    time-pos 48.07   demuxer-cache-time 56.30
 *   t=14   time-pos 60.05   demuxer-cache-time 59.97
 *   t=16   time-pos 60.05   demuxer-cache-time 59.97   <- PARA
 *   CONGELOU em 25s, buffer 100%
 *
 * `time-pos` e `demuxer-cache-time` no mesmo numero: o playhead no fim do cache,
 * e o cache parou de crescer. O hls.js identifica por URL, entao so pergunta
 * "qual URL eu ainda nao tenho" e nunca tem lacuna para reconciliar — e por isso
 * que o player interno nao trava.
 *
 * A CORRECAO e `normalize` (`hls-normalizer.cjs`): um playlist canonico por
 * cima, com numeros proprios, monotonicos, um URL estavel por numero, e os
 * segmentos baixados assim que aparecem. Medido com ele no mpv:
 * 361s de reproducao continua, `piorParado=4s`, congelou: NAO, `buffer 100%` o
 * tempo todo, `time-pos` de 67.92 para 416.34.
 *
 * Ordem no live: `normalize` primeiro. `direct` e `ffmpeg` continuam atras, para
 * painel que serve playlist canonica de verdade (onde o normalizer e so um
 * intermediario a mais) e para o caso do proxy local nao subir.
 */
function loadModeOrder(live) {
  if (live === true) return ['normalize', 'direct', 'ffmpeg']
  return ['direct', 'http', 'ffmpeg']
}

module.exports = {
  shouldPreResolveRedirect,
  shouldTryHttpFallback,
  loadModeOrder,
  liveEdgeSeekArgs,
  liveStopWaitMs,
  liveConnReleaseMs,
  liveDemuxerLavfO,
  liveStartIndex,
  networkTimeoutSecs,
}
