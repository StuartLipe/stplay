/**
 * Teto de bytes do demuxer no AO VIVO.
 *
 * O SINTOMA. Medido em 04/10 no painel do dono, canais `767130.m3u8` e
 * `2396226.m3u8`, com o teto em 96 MiB:
 *
 *   20:35:18   52,3 s
 *   20:35:26   54,5 s
 *   20:35:31   59,5 s
 *   20:35:41   69,5 s      +5 s de buffer a cada 5 s de relogio
 *   20:36:06   94,5 s
 *   pico da sessao: 887,6 s = 14,8 minutos
 *
 * +1,0 s de atraso por segundo de relógio. O canal entrega na velocidade real, o
 * mpv consome na velocidade real, e o excedente fica guardado. Não é atraso de
 * partida — é acúmulo, e só um reload zera.
 *
 * POR QUE `cache-pause` NÃO RESOLVE. O perfil de live aplica `cache-pause=true` e
 * `cache-pause-wait=2`, e está certo. Mas esses dois cuidam do PISO: pausam quando
 * o cache está vazio. Não fazem nada com o TETO.
 *
 * POR QUE O PADRÃO MUDOU DE 96 MiB PARA 4 MiB — E A MEDIÇÃO DE QUEM.
 *
 * Em 05/10 o dono reclamou de duas coisas ao mesmo tempo, e as duas tinham a mesma
 * raiz: o colchão grande demais. Com 96 MiB, no painel `fibers.lol`:
 *
 *   cache 51 → 61 → 71 → 81 → 91 → 101 → 111 → 121 s
 *   gaguejo ("dá umas travadas, tipo gargalando")
 *   5+ recargas de canal por sessao ("recarrega do nada")
 *
 * Com o portão em 4 MiB, MESMO painel, MESMA sessão de teste:
 *
 *   maior cache observado: 138,9 s     (o teto em bytes NÃO segura em segundos)
 *   gaguejo: SUMIU                       (veredito do dono)
 *   recargas: 5+ → 1
 *
 * A leitura honesta do resultado: 4 MiB remove o gaguejo e corta a recarga em
 * quatro quintos, mas NÃO zera a recarga — 138,9 s ainda passa dos 90 s do
 * guardião. A conta fecha assim:
 *
 *   4 MiB = 138,9 s   →   bitrate real ≈ 30 KB/s ≈ 240 kbps
 *   90 s de buffer    →   90 × 30 KB/s ≈ 2,7 MB
 *
 * Ou seja: o bitrate é ~240 kbps, não os ~900 kbps que o comentário antigo
 * assumia, e 1 MiB seguraria o cache em ~35 s — abaixo do limite do guardião, o
 * que tornaria a recarga aritmeticamente impossível.
 *
 * POR QUE O PADRÃO É 4 MiB E NÃO 1 MiB. Porque 4 MiB foi TESTADO pelo dono, com
 * veredito, e 1 MiB é aritmética minha. Este projeto já trocou esse número uma vez
 * no escuro — o registro em `stur-player.cjs` diz o preço: "o problema já tinha
 * parado, a troca não resolveu nada, e ninguém voltou a medir". Guardar o 1 MiB
 * atrás do portão é o jeito de ter a conta à mão sem Trustar nela. Quando o dono
 * rodar `STPLAY_LIVE_MAX_BYTES=1MiB` e confirmar que o gaguejo continua ausente, o
 * padrão sobe para lá.
 *
 * Sem fallback silencioso: valor inválido vira erro no boot, não um número que
 * ninguém sabe de onde saiu.
 */

const { MiB, parseBytes, formatBytes } = require('./vod-buffer-limits.cjs')

/**
 * O PADRÃO É 4 MiB — TESTADO, não calculado.
 *
 * Era 96 MiB, o valor do pico de 887,6 s. A medição de 05/10 mostrou que o tamanho
 * do colchão é o que produz o gaguejo, e 4 MiB o remove.
 */
const LIVE_MAX_BYTES_PADRAO = 4 * MiB

function liveMaxBytes(env = process.env) {
  const bruto = env.STPLAY_LIVE_MAX_BYTES
  if (!bruto) return LIVE_MAX_BYTES_PADRAO
  const bytes = parseBytes(bruto)
  if (bytes === null) {
    throw new Error(
      `STPLAY_LIVE_MAX_BYTES invalido: ${JSON.stringify(bruto)} — use 1MiB, 4MiB ou 4194304`,
    )
  }
  return bytes
}

/** Log do que foi resolvido, para o log responder a configuração sem ler código. */
/*
 * IMPORTANTE: ISTO NAO E O CONSERTO DO DELAY.
 *
 * O delay que cresce sozinho tinha duas causas, e elas sao diferentes:
 *
 * 1. `cache-pause=false` permanente no canal em que a pessoa assentou depois de
 *    um zape — esse e o mecanismo, e o conserto esta em `stur-player.cjs`
 *    (`armLiveSettle`), que devolve o perfil de live depois que a troca passa.
 *
 * 2. O teto em bytes alto (96 MiB = 887 s de pico medido), que e o que o delay
 *    ALCANCA enquanto o item 1 esta de pe.
 *
 * O item 2 foi medido em 05/10 e o padrão mudou de 96 para 4 MiB — ver o cabeçalho
 * deste arquivo. O portão continua aqui porque o próximo passo é 1 MiB (que a
 * aritmética aponta e que ainda ninguém rodou), e porque mudar esse número no
 * escuro ja custou uma sessão de dúvida a este projeto uma vez.
 */
function descreverLiveBuffer(env = process.env) {
  return {
    maxBytes: liveMaxBytes(env),
    padrao: !env.STPLAY_LIVE_MAX_BYTES,
    fonte: env.STPLAY_LIVE_MAX_BYTES ? 'portao STPLAY_LIVE_MAX_BYTES' : 'padrao do modulo',
  }
}

module.exports = {
  /*
   * `MiB` e `parseBytes` sao reexportados de proposito.
   *
   * `vod-buffer-limits.test.cjs` importa `MiB` e `parseBytes` deste modulo e
   * escreve as garantias em MiB (`4MiB`), que e como o teto aparece no log. Sem
   * reexportar, o teste do live teria que repetir a aritmetica em bytes crus — ou
   * pior, fazer `8 * MiB` com `MiB` indefinido e receber `NaN` num assert que
   * "passa" pela metade. Reexportar mantem os dois irmaos com a mesma interface.
   */
  MiB,
  parseBytes,
  LIVE_MAX_BYTES_PADRAO,
  liveMaxBytes,
  descreverLiveBuffer,
  formatBytes,
}