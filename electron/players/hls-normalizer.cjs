/**
 * SERVIDOR DE PLAYLIST CANONICA COM CACHE DE SEGMENTO.
 *
 * O painel nao publica uma playlist HLS canonica: cada GET devolve uma janela de
 * segmentos recem-mintada, sem nenhuma sobreposicao com a resposta anterior, e o
 * `#EXT-X-MEDIA-SEQUENCE` nao identifica nada. Medido em `hls-window.cjs`:
 * 24 pedidos, 24 conjuntos de URL distintos, 0/23 respostas consecutivas
 * compartilhando um segmento.
 *
 * O demuxer HLS do ffmpeg — o do mpv — identifica segmento pelo NUMERO DE
 * SEQUENCIA. Com a playlist do painel ele para de buscar, o cache congela no fim
 * da janela e a imagem trava com `buffer 100%`. Medido no mpv, sem o app:
 * cache parou em 59.97s, `time-pos` em 60.05, congelou em 25s. O hls.js
 * identifica por URL e funciona — que e a diferenca observada entre os dois.
 *
 * ARQUITETURA: cache dos segmentos, e nao proxy sob demanda.
 *
 * A primeira versao proxyava o segmento quando o mpv pedia, e falhava: os tokens
 * de segmento do painel tem vida curta. Medido — 2/3 responderam 200 numa
 * rodada e 0/3 na seguinte, sem mudanca de codigo. O manifesto dizia que os
 * segmentos eram 6, 7 e 8, e no momento do fetch ja tinham expirado na origem.
 *
 * Aqui o normalizer:
 *   1. busca o manifesto do painel;
 *   2. alinha na janela canonica (`hls-window.cjs`);
 *   3. BAIXA cada segmento novo assim que ele aparece, em disco;
 *   4. serve `/s/<sid>/<seq>.ts` do disco.
 *
 * Consequencias que importam:
 *   - o fetch do mpv e local e instantaneo, entao nao depende do token nem do
 *     momento em que o mpv decidiu pedir;
 *   - o painel ve UMA requisicao por segmento, feita pelo normalizador, com
 *     conexao nova — o que tambem elimina o modo de falha do socket silencioso
 *     que foi medido no congelamento (Established, 0 bytes/s);
 *   - a pressao no painel deixa de depender do cliente.
 */
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseManifest, createWindowState, alinhar, escreverManifesto, uriDe } = require('./hls-window.cjs')

const UA = 'VLC/3.0.21 LibVLC/3.0.21'
const PROXY_TOKEN = crypto.randomBytes(24).toString('hex')
const MAX_SESSOES = 4
/** Segmentos baixados mantidos em disco por sessao. */
const CACHE_POR_SESSAO = 24
const MAX_REDIREC = 5
const PAUSA_REFRESH_MS = 400
/**
 * Teto do aquecimento por SEGMENTO EM DISCO.
 *
 * MEDIDO, e e o que motivou isto:
 *
 *   manifesto do painel ........ 240-325ms
 *   segmento de 2.859.020 bytes  3,3-4,8s para baixar
 *
 * O `AQUECIMENTO_MS` de 2,5s espera so o MANIFESTO, entao `canonicalUrl`
 * devolvia a URL em ~300ms com a janela VAZIA em disco. O mpv recebia um
 * playlist sem segmento nenhum e MORRIA:
 *
 *   00:18:59.183  loadfile ok
 *   00:18:59.196  end-file reason:error      <- 13ms
 *                 publicados:0 janela:0
 *   00:19:04.686  end-file reason:error      <- 11ms
 *                 publicados:0 janela:0  motivo:"painel respondeu 404"
 *
 * E o app traduzia essa morte de 11ms em "Canal indisponivel no momento", com
 * o canal no ar. Medido na origem no mesmo instante: peak -17,3 dBFS, sem
 * clipe. E o "Tentar novamente" da propria pessoa abria normal.
 *
 * Entao o aquecimento passou a esperar `stitched.size > 0` — um segmento de
 * verdade em disco, que e o que `inspecionar()` imprime como `emDisco` (`+`).
 *
 * O teto e 9s porque o pior caso medido e 4,8s, e `canonicalUrl` roda dentro
 * do preflight de `loadStream`, que segura um watchdog de 20s: 9s de
 * aquecimento deixa 11s de folga. So esperar manifesto nao resolvia; esperar
 * sem teto seria pior que o problema.
 */
const AQUECIMENTO_SEGMENTO_MS = 9000
/** De quanto em quanto se olha `stitched` durante o aquecimento. */
const PASSO_AQUECIMENTO_MS = 100

let server = null
let baseUrl = null
let cacheDir = null

/** @type {Map<string, {sid: string, alvo: string, state: object, dir: string, emVoo: Map<number, Promise<void>>, stitched: Set<number>, ultimoRefresh: number, vivo: boolean}>} */
const sessoes = new Map()

function tokenOk(incoming) {
  const t = incoming.searchParams.get('t')
  if (typeof t !== 'string' || t.length !== PROXY_TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(PROXY_TOKEN))
}

const sidDe = (alvo) => crypto.createHash('sha1').update(alvo).digest('hex').slice(0, 16)

function decodificaTarget(token) {
  try {
    const u = new URL(Buffer.from(token, 'base64url').toString('utf8'))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** GET seguindo 302, conexao nova a cada salto. */
function buscar(url, profundidade = 0) {
  return new Promise((resolve, reject) => {
    if (profundidade > MAX_REDIREC) return reject(new Error('redirect demais'))
    let u
    try {
      u = new URL(url)
    } catch {
      return reject(new Error('url invalida'))
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(
      url,
      {
        agent: false,
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: `${u.protocol}//${u.host}/` },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return buscar(new URL(res.headers.location, url).href, profundidade + 1).then(resolve, reject)
        }
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(partes), urlFinal: url }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout na origem'))
    })
    req.on('error', reject)
  })
}

/** Baixa para arquivo temporario e so entao promove. Fetch parcial nao engana o ffmpeg. */
async function baixarPara(url, destino) {
  const parcial = `${destino}.part`
  const resp = await buscar(url)
  if (resp.status !== 200) throw new Error(`origem ${resp.status}`)
  if (!resp.body || resp.body.length < 1024) throw new Error(`corpo curto (${resp.body ? resp.body.length : 0}b)`)
  await fs.promises.writeFile(parcial, resp.body)
  await fs.promises.rename(parcial, destino)
  return resp.body.length
}

function arquivoDe(s, seq) {
  return path.join(s.dir, `${seq}.ts`)
}

function garanteDir() {
  if (!cacheDir) cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stplay-hls-'))
  return cacheDir
}

function fecharSessao(s) {
  s.vivo = false
  sessoes.delete(s.sid)
  try {
    fs.rmSync(s.dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function sessao(alvo) {
  const sid = sidDe(alvo)
  const existente = sessoes.get(sid)
  if (existente) {
    existente.vivo = true
    return existente
  }
  if (sessoes.size >= MAX_SESSOES) {
    let velha = null
    for (const [k, v] of sessoes) {
      if (Date.now() - v.ultimoRefresh > 5000) velha = k
    }
    if (velha) fecharSessao(sessoes.get(velha))
  }
  const s = {
    sid,
    alvo,
    state: createWindowState({ windowSize: 8 }),
    dir: fs.mkdtempSync(path.join(garanteDir(), `${sid}-`)),
    emVoo: new Map(),
    stitched: new Set(),
    ultimoRefresh: 0,
    vistoEm: 0,
    // Por que o painel ainda nao serviu manifesto utilizavel.
    // Medido em 709056 (encoder parado): sem manifesto com MEDIA-SEQUENCE=0 e
    // 1 segmento, e pagina nao-HLS numa resposta de 913 bytes que era uma
    // pagina de erro em HTML.
    ultimaFalha: null,
    falhas: 0,
    vivo: true,
  }
  sessoes.set(sid, s)
  return s
}

/**
 * Baixa, em background, os segmentos que ainda nao estao em disco.
 *
 * `stitched` e o conjunto de numeros cujo arquivo ja foi baixado. O reaper apaga
 * do disco o que saiu da janela, e tira de `stitched` junto, senao o numero
 * ficaria marcado como pronto para sempre e o ffmpeg levaria 404.
 */
function baixarPendentes(s) {
  for (const seg of s.state.segmentos) {
    if (s.stitched.has(seg.seq)) continue
    if (s.emVoo.has(seg.seq)) continue
    if (fs.existsSync(arquivoDe(s, seg.seq))) {
      s.stitched.add(seg.seq)
      continue
    }
    const p = baixarPara(seg.uri, arquivoDe(s, seg.seq))
      .then(() => {
        s.stitched.add(seg.seq)
      })
      .catch(() => {
        // Falhou agora: deixa para a proxima passada tentar de novo. O
        // manifesto ainda vai trazer esse numero por algumas rodadas.
        s.stitched.delete(seg.seq)
      })
      .finally(() => {
        s.emVoo.delete(seg.seq)
      })
    s.emVoo.set(seg.seq, p)
  }

  // Reaper: o que saiu da janela (janela + LRU antigos) sai do disco.
  const vivos = new Set(s.state.segmentos.map((x) => x.seq))
  for (const seq of [...s.stitched]) {
    if (vivos.has(seq)) continue
    s.stitched.delete(seq)
    try {
      fs.rmSync(arquivoDe(s, seq), { force: true })
    } catch {
      // ignore
    }
  }
  const noDisco = fs.existsSync(s.dir) ? fs.readdirSync(s.dir) : []
  for (const f of noDisco) {
    const m = /^(\d+)\.ts$/.exec(f)
    if (m && vivos.has(Number(m[1]))) continue
    try {
      fs.rmSync(path.join(s.dir, f), { force: true })
    } catch {
      // ignore
    }
  }
  while (s.stitched.size > CACHE_POR_SESSAO) {
    const maisAntigo = s.stitched.values().next().value
    s.stitched.delete(maisAntigo)
    try {
      fs.rmSync(arquivoDe(s, maisAntigo), { force: true })
    } catch {
      // ignore
    }
  }
}

async function refrescar(s) {
  if (!s.vivo) return
  s.ultimoRefresh = Date.now()
  try {
    const r = await buscar(s.alvo)
    if (r.status !== 200) {
      s.ultimaFalha = `painel respondeu ${r.status}`
      s.falhas += 1
      return
    }
    const texto = r.body.toString('utf8')
    const painel = parseManifest(texto)
    if (!painel) {
      // Medido em 709056, encoder parado: uma leitura devolvia
      //   bytes=913  MEDIA-SEQUENCE=?  segmentos=14  ultimo=ror page -->
      // ou seja, uma PAGINA DE ERRO EM HTML de 913 bytes, nao um manifesto. O
      // `parseManifest` recusa (nao tem #EXTM3U), o que e certo — mas sem
      // registro nenhum o app so via "normalizador falhou", que nao diz nada.
      const html = /<html|<!doctype/i.test(texto)
      s.ultimaFalha = html
        ? `painel devolveu pagina de erro em HTML (${texto.length} bytes)`
        : `resposta sem #EXTM3U (${texto.length} bytes)`
      s.falhas += 1
      return
    }
    s.ultimaFalha = null
    // Segmentos vem como caminho RELATIVO (`/hls/...`). Resolver contra a URL
    // final do manifesto e obrigatorio: sem isso `new URL()` do segmento lanca
    // e tudo responde 504. Medido.
    let base
    try {
      base = new URL(r.urlFinal)
    } catch {
      base = new URL(s.alvo)
    }
    for (const seg of painel.segments) {
      try {
        seg.uri = new URL(seg.uri, base).href
      } catch {
        // deixa como veio; o fetch falha e o manifesto segue
      }
    }
    s.state.targetDuration = painel.targetDuration
    alinhar(s.state, painel)
    baixarPendentes(s)
  } catch (error) {
    s.ultimaFalha = `erro de rede: ${error instanceof Error ? error.message : String(error)}`
    s.falhas += 1
    // painel instavel: nao mexe na janela, o manifesto sera re-servido como esta
  }
}

function urlDeSegmento(s, seq) {
  return `${baseUrl}/s/${s.sid}/${seq}.ts?t=${PROXY_TOKEN}`
}

function responderManifesto(res, s) {
  // Content-Length EXATO e nosso: o manifesto e nosso. Foi a ausencia dele que
  // fez o manifesto pelo proxy generico nunca chegar em `file-loaded`
  // (medido: `no file-loaded before timeout` em 100% dos canais).
  const corpo = Buffer.from(escreverManifesto(s.state, (seq) => urlDeSegmento(s, seq)), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/vnd.apple.mpegurl',
    'content-length': String(corpo.length),
    'cache-control': 'no-store',
  })
  res.end(corpo)
}

function responderSegmento(res, s, seq) {
  const destino = arquivoDe(s, seq)
  if (fs.existsSync(destino)) {
    const stat = fs.statSync(destino)
    res.writeHead(200, {
      'content-type': 'video/mp2t',
      'content-length': String(stat.size),
      'cache-control': 'no-store',
    })
    return fs.createReadStream(destino).pipe(res)
  }
  // Ainda baixando: espera o download corrente em vez de responder 404 na cara
  // do ffmpeg. O manifesto acabou de mudar, entao ele pediu recem.
  const emVoo = s.emVoo.get(seq)
  if (emVoo) {
    const t = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504)
        res.end('download lento')
      }
    }, 8000)
    return emVoo.then(() => {
      clearTimeout(t)
      if (res.writableEnded || res.headersSent) return
      if (fs.existsSync(destino)) {
        const stat = fs.statSync(destino)
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(stat.size) })
        return fs.createReadStream(destino).pipe(res)
      }
      res.writeHead(404)
      res.end('ainda nao')
    })
  }
  res.writeHead(404)
  res.end('fora da janela')
}

function ensureStarted() {
  if (baseUrl) return Promise.resolve(baseUrl)
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      let incoming
      try {
        incoming = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        res.writeHead(400)
        res.end('bad url')
        return
      }
      if (!tokenOk(incoming)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      const m = /^\/s\/([a-f0-9]{16})\/(\d+)\.ts$/.exec(incoming.pathname)
      if (m) {
        const s = sessoes.get(m[1])
        if (!s) {
          res.writeHead(404)
          res.end('sessao desconhecida')
          return
        }
        s.ultimoRefresh = Date.now()
        return responderSegmento(res, s, Number(m[2]))
      }

      const mm = /^\/m\/([A-Za-z0-9_-]+)\.m3u8$/.exec(incoming.pathname)
      if (mm) {
        const alvo = decodificaTarget(mm[1])
        if (!alvo) {
          res.writeHead(400)
          res.end('bad url')
          return
        }
        const s = sessao(alvo)
        s.vistoEm = Date.now()
        responderManifesto(res, s)
        // A busca do painel acontece DEPOIS de responder: o ffmpeg nao pode
        // esperar o painel para ler o manifesto. Como a janela ja foi
        // preenchida na leitura anterior, a resposta ja vai com conteudo.
        //
        // BUG QUE ISTO CORRIGE: o teste de cadence usava `ultimoRefresh`, que
        // era atualizado ANTES do teste — entao a diferenca dava sempre 0, o
        // throttle nunca deixava passar, e a janela ficava congelada em 6
        // segmentos para sempre. Medido: `MEDIA-SEQUENCE: 1` em 8 leituras
        // seguidas, `publicados` parado em 6, e o mpv congelando em 20s com
        // `buffer 0` (nenhum segmento novo para consumir).
        if (Date.now() - s.ultimoRefresh >= PAUSA_REFRESH_MS || !s.state.inicializado) {
          void refrescar(s)
        }
        return
      }

      res.writeHead(404)
      res.end('not found')
    })
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('normalizador nao iniciou'))
        return
      }
      server = httpServer
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve(baseUrl)
    })
  })
}

/**
 * Esta URL ja e uma saida minha?
 *
 * BUG GRAVE QUE ISTO CORRIGE, e que so apareceu por causa de uma medicao:
 *
 *   socket do demuxer morto  cacheTime=91143.696522  timePos=0
 *   start live=True url=http://127.0.0.1:58602/m/aHR0cDovLzIyMDhhaHNn...
 *
 * O `softReloadLive` recarregava a partir de `livePlayUrl`, que e a URL JA
 * RESOLVIDA. O normalizador recebia a propria saida, tratava a propria saida
 * como se fosse o painel, embrulhava de novo, e a cada recarga a cadeia crescia
 * uma camada. O mpv foi ler uma playlist que apontava para outra playlist que
 * apontava para outra — e o buffer chegou a 91.143 segundos (25 horas) com o
 * playhead em zero.
 *
 * A guarda e barato e total: se a URL tem a MINHA forma e o MEU token, ela ja
 * foi normalizada, e normalizar de novo so construiria a proxima camada.
 */
function eMinhaSaida(alvo) {
  if (typeof alvo !== 'string') return false
  const m = /^(https?):\/\/(127\.0\.0\.1|localhost):(\d+)\/m\/([A-Za-z0-9_-]+)\.m3u8\?t=([a-f0-9]+)$/.exec(
    alvo.trim(),
  )
  return Boolean(m && m[5] === PROXY_TOKEN)
}

async function canonicalUrl(alvo) {
  // Ja normalizada: devolve como esta. Ver `eMinhaSaida`.
  if (eMinhaSaida(alvo)) return alvo
  const base = await ensureStarted()
  const url = `${base}/m/${Buffer.from(alvo, 'utf8').toString('base64url')}.m3u8?t=${PROXY_TOKEN}`
  const s = sessao(alvo)
  // AQUECIMENTO COM TETO.
  //
  // Sem espera, o primeiro manifesto que o mpv le sai com a janela VAZIA, ele
  // erro em milissegundos e o app cai no `direct` — foi medido: `load mode
  // mode=normalize` seguido de `live fallback → direct` 13ms depois.
  //
  // Esperar sem teto tambem esta errado: o painel respondeu o manifesto uma vez
  // em 12.541ms (cold) e nas outras em 182-272ms. Como `canonicalUrl` roda
  // dentro de `loadStream`, que segura o preflight, uma espera longa arrisca
  // estourar o watchdog de 20s por causa de um cold start que o mpv tolera
  // sozinho.
  //
  // O comentario antigo falava so do MANIFESTO e por isso a espera parava cedo
  // demais. Ver `AQUECIMENTO_SEGMENTO_MS`: manifesto e rapido, segmento nao.
  if (!s.state.inicializado) {
    let timer = null
    let passo = null
    const limite = new Promise((r) => {
      timer = setTimeout(r, AQUECIMENTO_SEGMENTO_MS)
    })
    // Sai assim que UM segmento estiver em disco. `refrescar` roda em paralelo:
    // ele traz o manifesto e chama `baixarPendentes`, que e quem popula o
    // `stitched`. Sem o manifesto nao ha segmento para baixar, entao os dois
    // andam juntos.
    const primeiroEmDisco = new Promise((r) => {
      passo = setInterval(() => {
        if (s.stitched.size > 0) r(true)
      }, PASSO_AQUECIMENTO_MS)
    })
    await Promise.race([Promise.all([refrescar(s), primeiroEmDisco]), limite])
    if (timer) clearTimeout(timer)
    if (passo) clearInterval(passo)
  }
  return url
}

function inspecionar(alvo) {
  const s = sessoes.get(sidDe(alvo))
  if (!s) return null
  return {
    publicados: s.state.publicados,
    janela: s.state.segmentos.map((x) => ({ seq: x.seq, emDisco: s.stitched.has(x.seq) })),
    seqPainel: s.state.panelSeq,
    baixando: s.emVoo.size,
    ultimaFalha: s.ultimaFalha,
    falhas: s.falhas,
  }
}

function stop() {
  for (const s of [...sessoes.values()]) fecharSessao(s)
  sessoes.clear()
  if (server) {
    try {
      server.close()
    } catch {
      // ignore
    }
  }
  server = null
  baseUrl = null
  if (cacheDir) {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    cacheDir = null
  }
}

module.exports = { ensureStarted, canonicalUrl, inspecionar, stop, eMinhaSaida, PROXY_TOKEN }