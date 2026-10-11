const assert = require('node:assert/strict')
const { test } = require('node:test')
const { shouldPreResolveRedirect, shouldTryHttpFallback, loadModeOrder, liveEdgeSeekArgs, liveStopWaitMs, liveConnReleaseMs, liveDemuxerLavfO, liveStartIndex, networkTimeoutSecs } = require('./live-load-policy.cjs')

test('live never pre-resolves redirects (One loadfile portal URL)', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/live/u/p/1.m3u8', true), false)
  assert.equal(shouldPreResolveRedirect('https://panel.example/live/u/p/1.ts', true), false)
})

test('VOD mp4 still pre-resolves (CDN 302 + token)', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/movie/u/p/1.mp4', false), true)
})

test('HLS playlist is never pre-resolved', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/movie/u/p/1.m3u8', false), false)
})

test('live skips http proxy fallback', () => {
  assert.equal(shouldTryHttpFallback(true), false)
  assert.equal(shouldTryHttpFallback(false), true)
})

test('live NORMALIZA a playlist: o painel nao e canonico', () => {
  // Medido: 24 pedidos a 1,5s do mesmo canal deram 24 conjuntos de URL distintos,
  // e 0 de 23 respostas consecutivas compartilharam um segmento. O demuxer HLS do
  // ffmpeg identifica por numero de sequencia e para de buscar: sem normalizar,
  // o mpv congelava em 25s com `buffer 100%` e `time-pos` == `demuxer-cache-time`.
  //
  // Este teste trava a ordem porque as duas alternativas ja foram medidas e
  // ambas falham: `direct` congela, e o proxy local (`http`) nunca chega em
  // `file-loaded` em 100% dos canais.
  const ordem = loadModeOrder(true)
  assert.equal(ordem[0], 'normalize', 'live sobe pelo normalizador de playlist')
  assert.ok(ordem.includes('direct'), 'direct continua como plano B para painel canonico')
  assert.ok(!ordem.includes('http'), 'proxy local fora: falhou em 100% dos canais')
  assert.equal(ordem[ordem.length - 1], 'ffmpeg', 'ffmpeg continua sendo o ultimo recurso')
  assert.equal(new Set(ordem).size, ordem.length, 'sem modos repetidos')
})

test('VOD mantem o proxy local como plano B', () => {
  const ordem = loadModeOrder(false)
  assert.equal(ordem[0], 'direct')
  assert.ok(ordem.includes('http'))
})

test('live NAO faz seek de borda: a demuxer entrega a borda', () => {
  // Regressão do dano medido: `seek 100 absolute-percent` jogava time-pos de
  // 50.9 para 1.99 (~49s atrás) e reiniciava o demuxer a cada abertura.
  assert.deepEqual(liveEdgeSeekArgs(), [])
})

test('live_start_index=-2: um segmento de runway, nao a borda colada', () => {
  // Regressão do travamento de imagem, medido: `-1` deu 66 congelamentos em 90s
  // com 0.3s de runway; `-2` deu 0 com 8.4s. -3 e -4 não melhoram.
  assert.equal(liveStartIndex(), 'live_start_index=-2')
  assert.match(liveDemuxerLavfO(true), /live_start_index=-2/)
  assert.equal(liveDemuxerLavfO(true).split(',').length, 4, 'lista unica, sem duplicar a option')
})

test('1-tela zap waits for stop then a short release', () => {
  assert.equal(liveStopWaitMs() > 0, true)
  assert.equal(liveConnReleaseMs() > 0, true)
})

test('reconnect vai no demuxer-lavf-o com a distincao do slot', () => {
  // `--stream-lavf-o` descarta option desconhecida em silencio (manual do mpv),
  // e `reconnect` e AVFormatContext. A versao antiga postava as duas la e o
  // reconnect nunca esteve ativo em nenhum momento da vida do app.
  assert.match(liveDemuxerLavfO(true), /reconnect=1/)
  assert.match(liveDemuxerLavfO(false), /reconnect=0/)
  assert.doesNotMatch(liveDemuxerLavfO(false), /reconnect_streamed=1/)
})

test('timeout de rede no live tem folga sobre o intervalo de publicacao', () => {
  // 60s era o congelamento: socket Established sem byte nao quebra, nao da
  // timeout e nao gera evento. So o timeout de leitura fecha.
  // 10s foi testado e matou o canal: TARGETDURATION=10 significa que um read
  // timeout igual ao intervalo de publicacao erra por construcao.
  const t = networkTimeoutSecs(true)
  assert.ok(t >= 25, `live precisa de folga sobre TARGETDURATION=10 (veio ${t})`)
  assert.ok(t < 60, 'ainda precisa cortar o pior caso de 60s')
  assert.ok(networkTimeoutSecs(false) > networkTimeoutSecs(true))
})
