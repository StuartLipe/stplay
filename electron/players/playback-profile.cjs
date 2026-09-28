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
const { liveStreamLavfO } = require('./live-load-policy.cjs')

/** Perfil completo por modo. Ordem importa: vira a ordem dos comandos no wire. */
function profileFor(live, softZap) {
  if (live && softZap) {
    return [
      ['cache-pause', false],
      ['cache-pause-initial', false],
      ['pause', false],
      ['demuxer-lavf-o', 'live_start_index=-1'],
      ['stream-lavf-o', liveStreamLavfO(true)],
    ]
  }
  if (live) {
    // Ao vivo: start imediato na borda. Buffer grande + seek 1s puxava ~1 min
    // atras, no comeco da janela HLS.
    return [
      ['cache-pause-initial', false],
      ['cache-pause', false],
      ['cache-pause-wait', 1],
      ['demuxer-readahead-secs', 8],
      ['demuxer-max-bytes', '96MiB'],
      ['cache-secs', 8],
      ['network-timeout', 30],
      ['demuxer-lavf-o', 'live_start_index=-1'],
      ['stream-lavf-o', liveStreamLavfO(true)],
    ]
  }
  // VOD: sem cache-pause no inicio — comeca assim que houver quadro.
  return [
    ['cache-pause-initial', false],
    ['cache-pause', false],
    ['cache-pause-wait', 1],
    ['demuxer-readahead-secs', 8],
    ['demuxer-max-bytes', '96MiB'],
    ['cache-secs', 12],
    ['network-timeout', 15],
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

module.exports = { profileFor, diffProfile, commitApplied }
