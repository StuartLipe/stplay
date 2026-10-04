/**
 * Perfil de properties de playback do motor STUR, e o calculo do que precisa
 * realmente ser enviado.
 *
 * Isolei isto de `stur-player.cjs` por dois motivos.
 *
 * Latencia: o perfil era enviado como 5-9 `set_property` em `await`s
 * SEQUENCIAIS, cada um com seu timeout de 8s — 5-9 voltas completas do named
 * pipe entre o clique e o `loadfile`. E no zape de live, quatro dessas
 * properties JÁ estavam com exatamente o mesmo valor desde a live anterior,
 * porque mpv não esquece property entre `loadfile`. Eram comandos idênticos
 * custando ida-e-volta para não mudar nada.
 *
 * Testabilidade: `diffProfile` é puro e decide quais comandos valem a ida-e-volta.
 * Se ele errar, o canal abre com o perfil errado e o sintoma é "o canal às
 * vezes comeca com buffer estranho" — sem erro, sem log, só imagem estranha.
 */
const { networkTimeoutSecs } = require('./live-load-policy.cjs')
const {
  vodMaxBytes,
  vodReadaheadSecs,
  formatBytes,
  descreverVodBuffer,
} = require('./vod-buffer-limits.cjs')

/**
 * Quanto buffer o live precisa — medido, nao escolhido no feeling.
 *
 * Este arquivo ja propôs `cache-secs=30` + `cache-pause-wait=10` com o
 * argumento classico ("suavidade = buffer fundo"). O sweep contra o canal real
 * DERRUBOU o argumento:
 *
 *   config            1o quadro   pausas   buffer_min
 *   cache30 wait10       3.6s       13        51.0s
 *   cache20 wait5        3.0s        5        52.8s
 *   cache15 wait3        3.0s        8        53.4s
 *   cache8  wait2        3.1s        1        52.8s
 *
 *   1. `buffer_min` e ~51-53s em TODOS os perfis. A origem entrega muito mais
 *      rapido que tempo real, o buffer enche sozinho, e `cache-secs` nunca e o
 *      gargalo. Aumenta-lo nao compra margem: a margem ja existe e e de 50s.
 *   2. `cache-pause-wait` grande e o que produz PAUSA VISIVEL. wait=10 deu 13
 *      pausas, wait=2 deu 1. A origem entrega em rajadas (1 segmento a cada
 *      10s), e wait longo transforma cada micro-underrun numa pausa maior.
 *      Empurrava a roda na direcao errada: mais espera, mais congelamento.
 *
 * O que sobreviveu a medicao:
 *
 *   cache-pause-initial=yes  nao custou tempo de 1o quadro (3.0-3.6s nos dois
 *     braços) e e o que o manual indica para "playback starts smoothly".
 *   cache-pause=yes          (default do mpv) o perfil antigo desligava, e sem
 *     ele o underrun vira stall bruto em vez de pausa e reaninagem.
 *   cache-pause-wait=2       o medido com menos pausas. O original era 1.
 *   cache-secs=8             o original, de proposito: mexer aqui nao muda nada.
 */
const LIVE_CACHE_SECS = 8
const LIVE_CACHE_PAUSE_WAIT = 2
const LIVE_READAHEAD_SECS = 8
const LIVE_MAX_BYTES = '96MiB'

/** Perfil completo por modo. Ordem importa: vira a ordem dos comandos no wire. */
function profileFor(live, softZap) {
  if (live && softZap) {
    // Zape de live: o canal esta no ar, com buffer cheio, e precisa sair na
    // hora — rebuffer aqui seria 1-3s de tela parada a CADA zape, que e o
    // outro extremo. Nao ha nada de lavf aqui de proposito: `live_start_index`
    // e `reconnect` sao do demuxer, posto uma vez na linha de comando em
    // `buildMpvArgs`. Reenvia-los por IPC aqui nao mudava nada (ver
    // live-load-policy.cjs) e so ocupava o pipe.
    return [
      ['cache-pause', false],
      ['pause', false],
    ]
  }
  if (live) {
    return [
      ['cache-pause-initial', true],
      ['cache-pause', true],
      ['cache-pause-wait', LIVE_CACHE_PAUSE_WAIT],
      ['cache-secs', LIVE_CACHE_SECS],
      ['demuxer-readahead-secs', LIVE_READAHEAD_SECS],
      ['demuxer-max-bytes', LIVE_MAX_BYTES],
      ['network-timeout', networkTimeoutSecs(true)],
    ]
  }
  // VOD: sem cache-pause no inicio — comeca assim que houver quadro.
  //
  // `demuxer-max-bytes` e `demuxer-readahead-secs` vem de `vod-buffer-limits.cjs`,
  // e nao daqui. Eles efetivo 96MiB/30 por um tempo, num raciocinio sobre um
  // problema de apresentacao que ja tinha sido resolvido, e o efeito colateral
  // (buffer curto demais -> rebuffer) nao era distinguivel do sintoma antigo.
  // Agora o padrao e o valor original, e `STPLAY_VOD_MAX_BYTES` /
  // `STPLAY_VOD_READAHEAD_SECS` permitem o A/B sem recompilar.
  //
  // O perfil VOD mantem `cache-pause=false`: aqui nao ha pausing por cache, o
  // demuxer le ate o teto de bytes. O teto que dimensiona o runway e o
  // `demuxer-max-bytes`.
  const maxBytes = vodMaxBytes()
  const readaheadSecs = vodReadaheadSecs()
  return [
    ['cache-pause-initial', false],
    ['cache-pause', false],
    ['cache-pause-wait', 1],
    ['demuxer-readahead-secs', readaheadSecs],
    ['demuxer-max-bytes', formatBytes(maxBytes)],
    ['cache-secs', 12],
    ['network-timeout', networkTimeoutSecs(false)],
  ]
}

/**
 * Separa o perfil em "vale enviar" e "ja esta no valor certo".
 *
 * @param {Array<[string, unknown]>} profile
 * @param {Map<string, unknown>} applied ultimo valor CONFIRMADO por propriedade
 * @returns {{ fresh: Array<[string, unknown]>, stale: string[] }}
 */
function diffProfile(profile, applied) {
  const fresh = []
  const stale = []
  for (const pair of profile) {
    const key = pair[0]
    if (applied.has(key) && applied.get(key) === pair[1]) stale.push(key)
    else fresh.push(pair)
  }
  return { fresh, stale }
}

/** Registra no memo so o que o mpv confirmou. */
function commitApplied(applied, fresh, results) {
  for (let i = 0; i < fresh.length; i += 1) {
    if (results[i] && results[i].ok !== false) applied.set(fresh[i][0], fresh[i][1])
  }
  return applied
}

module.exports = {
  profileFor,
  diffProfile,
  commitApplied,
  LIVE_CACHE_SECS,
  LIVE_CACHE_PAUSE_WAIT,
  LIVE_READAHEAD_SECS,
  LIVE_MAX_BYTES,
  descreverVodBuffer,
}
