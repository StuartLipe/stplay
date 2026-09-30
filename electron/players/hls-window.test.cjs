const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  parseManifest,
  createWindowState,
  alinhar,
  escreverManifesto,
  uriDe,
} = require('./hls-window.cjs')

/**
 * Reproduz o comportamento MEDIDO do painel: cada GET devolve uma janela
 * recem-mintada, com tokens novos, e duas respostas consecutivas nao tem
 * segmento em comum. So a sequencia avanca, e ela nao identifica nada.
 */
function painelFalso(seq, semente) {
  const segs = []
  for (let i = 0; i < 6; i++) {
    segs.push({ dur: 10.07, uri: `/hls/tok-${semente}-${seq}-${i}` })
  }
  return { mediaSequence: seq, targetDuration: 11, segments: segs }
}

test('parseManifest le sequencia, duracao e segmentos na ordem', () => {
  const m3u = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:207',
    '#EXT-X-TARGETDURATION:11',
    '#EXTINF:10.067333,',
    '/hls/aaa',
    '#EXTINF:10.100000,',
    '/hls/bbb',
  ].join('\n')
  const p = parseManifest(m3u)
  assert.equal(p.mediaSequence, 207)
  assert.equal(p.targetDuration, 11)
  assert.equal(p.segments.length, 2)
  assert.equal(p.segments[0].uri, '/hls/aaa')
  assert.ok(Math.abs(p.segments[0].dur - 10.067333) < 0.001)
})

test('primeira leitura publica a cauda da janela do painel', () => {
  const st = createWindowState({ windowSize: 6 })
  const r = alinhar(st, painelFalso(207, 'a'))
  assert.equal(r.novos, 6)
  assert.equal(st.segmentos.length, 6)
  assert.equal(st.segmentos[0].seq, 1)
  assert.equal(st.segmentos[5].seq, 6)
})

test('painel deslizando a sequencia traz os ultimos d como conteudo novo', () => {
  const st = createWindowState({ windowSize: 6 })
  alinhar(st, painelFalso(207, 'a')) // 6 publicados, seq 1..6
  const r = alinhar(st, painelFalso(208, 'b')) // deslizou 1
  assert.equal(r.novos, 1)
  assert.equal(st.segmentos.length, 6, 'janela nao cresce')
  assert.equal(st.segmentos[5].seq, 7, 'numero de sequencia proprio continua monotonicamente')
  // O segmento novo tem que ser o ULTIMO do painel novo.
  assert.equal(st.segmentos[5].uri, `/hls/tok-b-208-5`)
})

test('sequencias do painel mudam a cada poll, mas a nossa fica estavel e contigua', () => {
  // Este e o cenario real medido: 24 polls, 24 janelas distintas, 0 sobreposicao.
  const st = createWindowState({ windowSize: 6 })
  for (let i = 0; i < 24; i++) alinhar(st, painelFalso(226 + Math.floor(i / 4), `p${i}`))

  const seqs = st.segmentos.map((s) => s.seq)
  // contiguos, sem buraco, crescentes
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i], seqs[i - 1] + 1, `sequencia quebrou em ${i}: ${seqs.join(',')}`)
  }
  // E o que o ffmpeg ve: um URL ESTAVEL por numero, e numeros que so avancam.
  const manifesto = escreverManifesto(st, (seq) => `http://127.0.0.1:1/s/${seq}.ts`)
  const urls = manifesto.split('\n').filter((l) => l.startsWith('http'))
  assert.equal(urls.length, 6)
  assert.equal(new Set(urls).size, 6, 'nenhum URL se repete na janela')

  // A mesma chamada duas vezes devolve EXATAMENTE o mesmo manifesto. E o que o
  // painel nao faz, e o que o demuxer do ffmpeg exige.
  assert.equal(escreverManifesto(st, (seq) => `http://127.0.0.1:1/s/${seq}.ts`), manifesto)
})

test('painel que nao avanca a sequencia mas muda a cauda ainda traz o novo', () => {
  // Alguns painéis mintem MEDIA-SEQUENCE. O teste que vale é a cauda.
  const st = createWindowState({ windowSize: 6 })
  alinhar(st, painelFalso(300, 'x'))
  const r = alinhar(st, painelFalso(300, 'y')) // MESMA sequencia, janela nova
  assert.equal(r.novos, 1, 'cauda diferente conta como conteudo novo')
  assert.equal(st.segmentos[5].uri, '/hls/tok-y-300-5')
})

test('painel estagnado nao inventa segmento', () => {
  const st = createWindowState({ windowSize: 6 })
  alinhar(st, painelFalso(300, 'x'))
  const r = alinhar(st, painelFalso(300, 'x')) // identico
  assert.equal(r.novos, 0, 'nao pode publicar nada se o painel nao trouxe nada')
  assert.equal(st.segmentos.length, 6)
})

test('URIs publicados ficam acessiveis depois de sair da janela (LRU)', () => {
  const st = createWindowState({ windowSize: 4, lruSize: 50 })
  alinhar(st, painelFalso(100, 'a'))
  const maisAntigo = st.segmentos[0].seq
  const uriAntigo = uriDe(st, maisAntigo)
  for (let i = 1; i <= 6; i++) alinhar(st, painelFalso(100 + i, `b${i}`))
  assert.equal(uriDe(st, maisAntigo), uriAntigo, 'fetch atrasado ainda resolve')
  assert.equal(uriDe(st, 999999), null, 'numero que nunca existiu nao resolve')
})

test('manifesto emitido tem cabecalho de midia valido e EXTINF por segmento', () => {
  const st = createWindowState({ windowSize: 3 })
  alinhar(st, painelFalso(50, 'a'))
  const m = escreverManifesto(st, (seq) => `http://127.0.0.1:1/s/${seq}.ts`)
  assert.ok(m.startsWith('#EXTM3U'))
  assert.match(m, /#EXT-X-TARGETDURATION:\d+/)
  assert.match(m, /#EXT-X-MEDIA-SEQUENCE:\d+/)
  assert.equal((m.match(/#EXTINF:/g) || []).length, 3)
})

test('manifesto de janela vazia ainda e um manifesto valido', () => {
  const st = createWindowState()
  const m = escreverManifesto(st, (seq) => `http://127.0.0.1:1/s/${seq}.ts`)
  assert.ok(m.startsWith('#EXTM3U'))
  assert.equal((m.match(/#EXTINF:/g) || []).length, 0)
})

test('painel quebrado devolve null em vez de estado corrompido', () => {
  assert.equal(parseManifest(''), null)
  assert.equal(parseManifest('lixo'), null)
  assert.equal(parseManifest('<html>404</html>'), null)
  assert.equal(parseManifest('#EXTM3U\n#EXT-X-TARGETDURATION:11\n'), null, 'sem segmentos')
})
