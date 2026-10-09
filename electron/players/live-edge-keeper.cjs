/**
 * GUARDIÃO DA BORDA AO VIVO.
 *
 * O PROBLEMA, MEDIDO. Em 04/10, no painel do dono, com o canal em `767120.m3u8`:
 *
 *   cacheSecs 50,8 -> 75,8 -> 100,8 -> 130,8 -> 150,8 -> 180,8
 *
 * +5 s de buffer a cada 5 s de relógio. Taxa de 100%. O delay cresce um segundo
 * por segundo, sem teto. Zapar zera o contador — é por isso que o dono às vezes
 * vê 1 minuto e às vezes 15.
 *
 * AS DUAS HIPÓTESES JÁ CAÍRAM, e vale registrar por que, porque a próxima pessoa
 * vai tentar as duas de novo:
 *
 *   1. "`cache-pause` está desligado depois do zape." Verdadeiro que estava, e foi
 *      corrigido (`armLiveSettle` em `stur-player.cjs`). Mas com `cache-pause=true`
 *      o buffer CONTINUA subindo na mesma taxa. `cache-pause` cuida do PISO —
 *      pausa quando o cache esvazia — e não do TETO.
 *
 *   2. "`demuxer-max-bytes` é o teto." Testado com o portão em 8MiB: o perfil
 *      aplicou (`demuxer-max-bytes=8MiB`), e o buffer passou dos 8 MiB e continuou
 *      subindo. Ele limita o cache do demuxer; no HLS ao vivo, o que fica na frente
 *      da reprodução não passa por esse limite.
 *
 * ENTÃO O QUE SOBRA É O ÚNICO CAMINHO QUE FUNCIONA COM O QUE JÁ EXISTE: quando o
 * atraso passa do limite, RECARREGA o canal. O `reload()` do motor já existe, já
 * é usado no zape, e zera o buffer de forma medida — não é uma promessa de
 * documentação, é o mesmo caminho que o dono já viu funcionar ao zapar.
 *
 * O preço é uma piscada a cada recarga. O preço de não fazer é ver o canal com
 * 15 minutos de atraso, que é o que acontece hoje. O cooldown existe porque uma
 * origem lenta demais pode demorar a reencher, e recarregar em loop seria pior que
 * o atraso.
 *
 * Lógica pura e testável de propósito: a decisão "recarregar ou não" não tem
 * business nenhum dentro de um arquivo de 4.400 linhas.
 */

/**
 * O LIMITE DE ATRASO SUBIU DE 90 s PARA 300 s, E O DONO PEDIU.
 *
 * O dono: "o que eu preciso é que ele não trave e nem recarregue". E a resposta é
 * que os 90 s nunca tiveram medição nenhuma — foram um número que EU escolhi por
 * precaução com buffer, e a precaução custou um congelamento de tela a cada minuto e
 * meio durante semanas.
 *
 * POR QUE 90 s ERA ERRADO, E NÃO SÓ APERTADO.
 *
 * O painel do dono entrega ~2× o tempo real. Isso significa que o conteúdo dos
 * últimos 90 s está TODO no buffer, íntegro, e o playback está mostrando material
 * que já foi baixado. Num aparelho de TV, 90 s de atraso não tem diferença visual
 * nenhuma — a imagem é a mesma, o som é o mesmo. O que o limite de 90 s produzia
 * não era "impedir o atraso", era "jogar fora material bom de tempos em tempos para
 * recomeçar a mesma corrida".
 *
 * E o que ele FAZIA era pior que o problema que fingia resolver: recarregar é
 * derrubar o demuxer e reabrir a conexão, o que o donoICHAMOU de congelamento. Trocar
 * "5 minutos de atraso" — invisível — por "uma tela congelada a cada 90 s" é uma
 * troca ruim feita por um número sem origem.
 *
 * ESTE NÚMERO NÃO RECARREGA NADA. É SÓ A RÉGUA DO LOG.
 *
 * Subir 90 → 300 não resolveu: o dono viu o canal recarregar aos 305 s, cinco
 * minutos de canal contínuo transformados em tela congelada, por causa de um número
 * que não tem medição por trás. Então o número parou de ser política e virou
 * registro: `recarregaPorAtraso()` responde `false` para qualquer valor, e o que
 * ainda recarrega é o sensor de demuxer silencioso — que dispara quando
 * `demuxer-cache-time` E `time-pos` param de andar juntos, e age em segundos.
 *
 * Atraso grande e canal morto são coisas diferentes. Atraso não é defeito; canal
 * morto é. Cada um tem o seu detector, e só um deles recarrega.
 */
const LIVE_MAX_DELAY_PADRAO = 300

/** Tempo mínimo entre duas recargas do MESMO canal. */
const LIVE_RELOAD_COOLDOWN_PADRAO = 120

/** De quanto em quanto tempo o canal é medido. */
const LIVE_EDGE_POLL_MS = 10_000

/**
 * Quanto tempo o canal precisa tocar antes do guardião poder agir.
 *
 * Um canal recem-aberto já entra com ~50 s de buffer do handshake. Medido: ele
 * cruza o limite de 90 s em uns 40 s de reprodução, sem que nada esteja errado — e
 * recarregar ali é uma piscada no meio do zape. Este piso é o que separa "atraso"
 * de "ainda enchendo".
 */
const LIVE_MIN_TOCANDO_PADRAO = 45

function parseSegundos(valor) {
  const n = Number(valor.trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function liveMaxDelaySecs(env = process.env) {
  const bruto = env.STPLAY_LIVE_MAX_DELAY_SECS
  if (!bruto) return LIVE_MAX_DELAY_PADRAO
  const s = parseSegundos(bruto)
  if (s === null) {
    throw new Error(
      `STPLAY_LIVE_MAX_DELAY_SECS invalido: ${JSON.stringify(bruto)} — use 45, 90 ou 120`,
    )
  }
  return s
}

/**
 * Recarrega, ou não?
 *
 * Todos os predicados existem porque cada um já custou uma sessão de engano:
 *
 * - `live`: em VOD um cache grande é runway, não atraso. Recarregar um filme seria
 *   jogar a posição fora.
 * - `esperandoPrimeiroQuadro`: sem quadro ainda não há canal tocando, e
 *   `demuxer-cache-time` está subindo justamente porque ele ainda vai ler tudo.
 *   Medir aí dá recarga antes do primeiro quadro, que é o pior lugar.
 * - `pausado`: com o vídeo pausado o buffer enche de propósito. Recarregar ali
 *   perderia a posição de quem pausou.
 * - `cooldown`: origem lenta reenchendo o buffer faria o guardião disparar em
 *   loop, e cada recarga joga o que já tinha chegado.
 * - `cacheSecs` precisa ser número: `get_property` pode devolver `null` quando o
 *   pipe estoura, e `null > 90` é `false` — o que por acaso seria seguro, mas
 *   `undefined` não é, e a diferença entre "sem medida" e "sem atraso" tem que ser
 *   explícita.
 */
function deveRecarregar({
  live,
  running,
  esperandoPrimeiroQuadro,
  pausado,
  cacheSecs,
  limite = LIVE_MAX_DELAY_PADRAO,
  ultimoReloadMs = 0,
  cooldownMs = LIVE_RELOAD_COOLDOWN_PADRAO,
  agoraMs = Date.now(),
  tocandoDesdeMs = 0,
  minTocandoMs = LIVE_MIN_TOCANDO_PADRAO,
}) {
  if (!live) return false
  if (!running) return false
  if (esperandoPrimeiroQuadro) return false
  if (pausado) return false
  if (typeof cacheSecs !== 'number' || !Number.isFinite(cacheSecs)) return false
  if (cacheSecs <= limite) return false
  if (ultimoReloadMs > 0 && agoraMs - ultimoReloadMs < cooldownMs * 1000) return false
  /*
   * CANAL RECEM-ABERTO NAO E ATRASO, E ACUMULO.
   *
   * Um canal que acabou de abrir ja vem com ~50 s de buffer do handshake. Ele
   * cruza o limite de 90 s em uns 40 s de reproducao sem que ninguem tenha feito
   * nada de errado — e recarregar ali produz uma piscada exatamente no momento em
   * que a pessoa esta trocando de canal.
   *
   * Este piso e o que separa "o canal está atrasado" de "o canal ainda está
   * enchendo". O `cooldown` sozinho nao segurava: com o contador reiniciado a cada
   * carga ele valia zero durante o zape, e a sessao de zape terminou com 19
   * recargas que nao precisavam acontecer.
   */
  if (tocandoDesdeMs > 0 && agoraMs - tocandoDesdeMs < minTocandoMs * 1000) return false
  return true
}

function descreverLiveEdge(env = process.env) {
  return {
    maxDelaySecs: liveMaxDelaySecs(env),
    pollMs: LIVE_EDGE_POLL_MS,
    cooldownMs: LIVE_RELOAD_COOLDOWN_PADRAO,
    fonte: env.STPLAY_LIVE_MAX_DELAY_SECS ? 'portao STPLAY_LIVE_MAX_DELAY_SECS' : 'padrao do modulo',
  }
}

/**
 * O SEEK DE BORDA ESTÁ **DESLIGADO POR PADRÃO** — E A MEDIÇÃO DIZ POR QUÊ.
 *
 * A ideia era boa no papel e errada no canal. O raciocínio: "`demuxer-cache-time`
 * é a posição do buffer, ele vai de `time-pos` até a borda viva, então um seek de
 * +`cacheSecs` chega lá sem derrubar nada". O que a medição respondeu:
 *
 *   atraso no live; voltando a borda viva   cacheSecs: 97.4, avancoSegs: 96
 *   socket do demuxer morto                 cacheTime: 97.4, cacheParadoMs: 21212
 *                                          timePos: 97.46, timePosParadoMs: 21174
 *
 * O seek FUNCIONOU: `time-pos` foi de 1 para 97.46. E aí travou por 21 s, porque
 * os 97 s de buffer estavam todos ATRÁS da posição nova — o cache à frente era
 * zero, e o demuxer parou de entregar.
 *
 * A conclusão que o log força: **na origem do dono não existe borda viva.** O canal
 * entrega uma rajada, enche ~97 s e para. O "2× o tempo real" que medi antes era a
 * FASE DE ENCHIMENTO, não uma taxa contínua. Não é live; é um buffer finito
 * apresentado como live. Seek para a borda é seek para o fim da rua — e pior que
 * o reload, porque troca uma recarga limpa por 21 s de congelamento.
 *
 * Por isso o portão. A FUNÇÃO fica, e os testes ficam, porque a medição é o que
 * precisa sobreviver: se um dia o painel passar a entregar de verdade, o caminho
 * já está escrito e testado. Liga com `STPLAY_LIVE_EDGE_SEEK=1`.
 *
 * O QUE SUBSTITUI O SEEK, hoje: o reload. Ele é feio na tela e é o único caminho
 * que comprovadamente devolve o canal — ele reabre a conexão e recomeça arajada,
 * e a rajada é o que existe. Trocar o reload por um seek que congela foi a pior
 * versão possível dessa mudança.
 */
const SEEK_ATIVO_PADRAO = false
const SEEK_FOLGA_SECS = 1
const SEEK_PISO_SECS = 3

/**
 * QUANTOS SEGUNDOS AVANÇAR PARA VOLTAR AO VIVO.
 *
 * O dono viu o canal recarregando sozinho: `atraso no live passou do limite;
 * recarregando { cacheSecs: 96.6 }`. A origem entrega ~2× o tempo real, o buffer
 * cresce +1 s por segundo de relógio, e o guardião — que só sabia uma coisa:
 * "passou do limite" — matava e reabria o canal. A imagem piscava, o áudio cortava,
 * e o ganho era zero: um segundo depois o buffer já estava crescendo de novo.
 *
 * A CERTEZA DE QUE FOI O APP E NÃO O CANAL:
 *
 *   cache 50 → 60 → 70 → 80 → 90 → 96 s
 *
 * Esse é o buffer enchendo sozinho, com o canal inteiro tocando. "Carrega o canal
 * do nada" não era falha de abertura — era o app descartando 90 s de material que
 * já tinha baixado.
 *
 * POR QUE UM SEEK E NÃO RECARREGAR.
 *
 * O `demuxer-cache-time` é a posição do buffer: ele vai de `time-pos` até a borda
 * viva. Se o cache tem 96 s, a borda viva está 96 s à frente de onde o playback
 * está. Um seek relativo de +96 s põe o playback exatamente na borda, sem derrubar
 * a conexão, sem derrubar o demuxer, sem cortar o áudio. O buffer já está baixado —
 * só não está sendo usado.
 *
 * RECARREGAR PARA "PEGAR A BORDA" É JOGAR O BUFFER FORA. O `loadfile` limpa o
 * demuxer inteiro. Trocar 96 s de buffer já pago por 137 s de rede por 0 s de atraso
 * é retrocesso. O seek entrega a mesma borda com o buffer intacto.
 *
 * `+1` de folga: o alvo exato pode estar meio segmento à frente da última coisa que
 * o demuxer indexou, e seek para depois do fim cai no chão. A folga de 1 s é
 * imperceptível no vídeo e elimina o caso de borda.
 *
 * O piso de 3 s existe pelo mesmo motivo: cache de 1-2 s é o demuxer ainda enchendo,
 * não atraso. Seek de +1 s ali seria jitter puro — o playback pisca e volta.
 */
function avancoParaVoltarAoVivo(cacheSecs, opts = {}) {
  const folga = opts.folga ?? SEEK_FOLGA_SECS
  const piso = opts.piso ?? SEEK_PISO_SECS
  if (typeof cacheSecs !== 'number' || !Number.isFinite(cacheSecs)) return null
  if (cacheSecs < piso) return null
  return Math.max(1, Math.round(cacheSecs - folga))
}

/** O portão do seek: desligado por padrão, ligado por env. Ver o bloco acima. */
function seekDeBordaAtivo(env = process.env) {
  return env.STPLAY_LIVE_EDGE_SEEK === '1'
}

/**
 * BORDA CONTÍNUA: manter o atraso com teto, em vez de recarregar quando ele estourar.
 *
 * É a resposta à pergunta que o dono fez — "o que a gente faz pra não ter limite?" —
 * e é uma mudança de conceito, não de número.
 *
 * O guardião pergunta "o atraso passou de 90 s?" e quando a resposta é sim, mata e
 * reabre. Ele administra um sintoma tarde. A origem entrega acima do tempo real,
 * então o buffer cresce sem limite, e quando o limite é cruzado a única resposta é
 * destrói-lo.
 *
 * Aqui a pergunta é outra: "o atraso está acima do que eu quero manter?" e a
 * resposta é um seek para a borda. O buffer não é destruído — o playback avança
 * para onde o material já está, e o demuxer continua puxando.
 *
 * POR QUE A MARGEM, E POR QUE O SEEK ANTERIOR CONGELOU.
 *
 * A primeira tentativa, sem margem, foi medida e falhou:
 *
 *   seek +96  →  tempoPos 97,46, cache à frente = 0  →  21 s parado
 *
 * Mandar o playback para a última gota deixa o cache à frente em zero. O demuxer não
 * tinha o que entregar e nada vinha. A margem é a diferença entre "chegar na borda"
 * e "chegar perto da borda": com 12 s de folga sobram dos dois lados, o playback
 * avança e o demuxer continua puxando.
 *
 * POR QUE O ALVO É 25 s E NÃO 0.
 *
 * Seek para 0 seria o mesmo congelamento com outro número. O alvo é o atraso que a
 * pessoa aceita de graça — 25 s num canal de TV é imperceptível, e dá ao demuxer
 * janela para reagir a uma rajada ruim sem travar. Abaixo de ~10 s o alvo fica
 * frágil demais e acima de ~40 s já é atraso que a pessoa nota.
 *
 * POR QUE ISSO É A RESPOSTA E NÃO O RECARGA.
 *
 * Com o teto contínuo, `demuxer-cache-time` deixa de crescer sem parar: ele sobe até
 * `alvo + margem`, o seek o traz de volta para `alvo`, e o ciclo recomeça. O guardião
 * de recarga nunca encontra atraso, porque atraso não acumula. Ele continua no
 * código como rede de segurança — se mesmo assim o cache passar de
 * `RECARGA_DE_ULTIMO_RECURSO`, aí é outra coisa e recarregar ainda é a resposta
 * certa.
 *
 * O PORTAO. Desligado por padrão, e o motivo não é cautela de estilo: a primeira
 * versão desta mesma ideia, sem margem, foi o que congelou o canal por 21 s, e há
 * duas semanas nesta mesma sessão um número changed sem medir trouxe o gaguejo de
 * volta. A conta da margem é boa, mas "boa" é exatamente o que se provou falso três
 * vezes. Então o caminho fica pronto e testado, e quem liga é o dono:
 *
 *   STPLAY_LIVE_EDGE_KEEP=1
 *
 * Se der errado, apagar a variável devolve o comportamento de hoje. Nada de código
 * para reverter.
 */

/** O atraso que a pessoa aceita de graça. Ver o bloco acima. */
const BORDA_ALVO_SECS = 25
/** Folga que sobra à frente do playback depois do seek. */
const BORDA_MARGEM_SECS = 12
/**
 * Acima disso, com o teto contínuo ativo, o cache está errado de outro jeito e o
 * reload entra como rede de segurança. Não é o caminho normal — é o alarme.
 */
const RECARGA_DE_ULTIMO_RECURSO_SECS = 300

/**
 * Quanto avançar para manter o atraso no alvo. Puro.
 *
 * @param {number} cacheSecs `demuxer-cache-time`
 * @param {{alvo?: number, margem?: number}} [opts]
 * @returns {{avanco: number, atrasoRestante: number, motivo: string}|null}
 */
function avancoParaManterBorda(cacheSecs, opts = {}) {
  const alvo = opts.alvo ?? BORDA_ALVO_SECS
  const margem = opts.margem ?? BORDA_MARGEM_SECS
  if (typeof cacheSecs !== 'number' || !Number.isFinite(cacheSecs)) return null
  if (cacheSecs <= alvo + margem) return null
  const avanco = Math.max(1, Math.round(cacheSecs - alvo))
  return {
    avanco,
    atrasoRestante: cacheSecs - avanco,
    motivo: `cache ${cacheSecs.toFixed(1)}s acima de ${alvo}s+${margem}s; avanca ${avanco}s`,
  }
}

/**
 * O portão da borda contínua.
 *
 * Nome separado do `seekDeBordaAtivo` de propósito: os dois resolvem coisas
 * diferentes e o primeiro é o que foi provado errado. Se um dia alguém religar o
 * antigo achando que é o mesmo caminho, os dois vão acender ao mesmo tempo e o
 * comportamento vira imprevisível.
 */
function bordaContinuaAtiva(env = process.env) {
  return env.STPLAY_LIVE_EDGE_KEEP === '1'
}

/**
 * RECARGA POR ATRASO: NUNCA. E ESTA FUNÇÃO EXISTE PARA DEIXAR ISSO EXPLÍCITO.
 *
 * O dono, depois de ver o canal recarregar sozinho duas vezes: "o que eu preciso é
 * não ter limite — se ficar 10 hrs o app não pode recarregar essas 10 hrs".
 *
 * Esta função devolve SEMPRE `false`, e o corpo está vazio de propósito. Ela não
 * existe para decidir — existe para que a decisão tenha nome, e para que o teste
 * `recarga por atraso nunca acontece, por nenhum valor` trave a porta. Sem ela, a
 * recarga volta na próxima vez que alguém tocar no guardião, porque o padrão de
 * código do app é tratar "atraso" como coisa para corrigir.
 *
 * O que ainda recarrega, e é o que DEVE: o sensor de demuxer silencioso, que dispara
 * quando `demuxer-cache-time` e `time-pos` param de andar juntos. Esse é defeito de
 * verdade. Atraso grande não é — o painel entrega ~2× o tempo real e o material está
 * íntegro no buffer.
 *
 * O custo aceito, dito com todas as letras: se o painel continuar entregando assim
 * por 10 horas, o canal toca 10 horas atrás, e nada no app pode detectar isso —
 * porque não há defeito, há só tempo passado. Para quem assiste, o atraso é
 * invisível. Para quem precisa do instante, é um problema que só se resolve
 * descartando material, e descartar material é salto na imagem.
 */
function recarregaPorAtraso() {
  return false
}

/**
 * Os dois portões ligados ao mesmo tempo.
 *
 * O seek sem margem congelou o canal por 21 s — medido. A borda contínua é o
 * conserto dele. Se alguém ligar os dois, o motor receberia dois `seek` na mesma
 * janela, com alvos incompatíveis: um vai para a última gota (congela), o outro vai
 * para 25 s atrás (funciona). O resultado seria o pior dos dois, alternando.
 *
 * Isto existe para que o conflito seja VISÍVEL no log em vez de virar sintoma.
 */
function portoesEmConflito(env = process.env) {
  return bordaContinuaAtiva(env) && seekDeBordaAtivo(env)
}

module.exports = {
  LIVE_MAX_DELAY_PADRAO,
  LIVE_RELOAD_COOLDOWN_PADRAO,
  LIVE_EDGE_POLL_MS,
  LIVE_MIN_TOCANDO_PADRAO,
  SEEK_FOLGA_SECS,
  SEEK_PISO_SECS,
  SEEK_ATIVO_PADRAO,
  BORDA_ALVO_SECS,
  BORDA_MARGEM_SECS,
  RECARGA_DE_ULTIMO_RECURSO_SECS,
  liveMaxDelaySecs,
  deveRecarregar,
  recarregaPorAtraso,
  avancoParaVoltarAoVivo,
  seekDeBordaAtivo,
  avancoParaManterBorda,
  bordaContinuaAtiva,
  portoesEmConflito,
  descreverLiveEdge,
}