import type { PlaybackEngine } from '../types'

/**
 * Motor de video padrao e a cadeia de migracao — fora do `storage.ts`.
 *
 * Extraido pelo mesmo motivo do `fullscreen-decision.ts`: o `storage.ts` importa
 * `./accent` e `./appearance` SEM extensao (o Vite resolve, o runner de teste
 * nao), entao nenhum teste conseguia alcancar `normalizeSettings`. A decisao
 * morava num arquivo que era impossivel verificar.
 *
 * Aqui nao ha import de nada do projeto. A funcao e pura: recebe o que foi
 * gravado e quais migracoes ja rodaram, devolve o motor.
 */

/** Os quatro que a tela de configuracao oferece. */
export const PLAYER_ENGINES = ['auto', 'internal', 'mpeg', 'stur'] as const

/**
 * O padrao e `stur`, e nao `auto`.
 *
 * `auto` comeca no player interno (hls.js) e so cai no STUR quando o interno
 * falha. Quem abre um filme pesado espera o interno falhar antes de ver o mpv
 * nativo. O STUR e mpv nativo dentro do app, e o unico dos quatro que a tela
 * descreve como "filmes, series e codecs pesados" — que e o que o app e.
 */
export const PLAYER_DEFAULT: PlaybackEngine = 'stur'

/** Nomes que a versao antiga gravava e que hoje nao existem mais. */
const LEGADOS_V8 = ['shaka', 'mpv', 'mdk', 'playerone']
/** Motores que existiram entre v8 e v13 e hoje viram STUR. */
const LEGADOS_V13 = ['mpv', 'mpv-one', 'libmpv', 'vlc', 'mpc']

export interface PlayerMigrationState {
  /** Motor como esta gravado, ou `''` quando nao ha registro. */
  rawPlayer: string
  /** `true` quando a migracao desta versao JA rodou nesta maquina. */
  jaRodou: (versao: 8 | 9 | 10 | 11 | 12 | 13) => boolean
}

/**
 * Reproduz a cadeia v8..v13 na ordem em que ela esta escrita no `storage.ts`.
 *
 * Cada passo e pulado quando a sua chave de migracao ja existe — e por isso que
 * mudar o padrao aqui NAO mexe na escolha de quem ja instalou. Quem so tem
 * registro novo nunca entra nesta funcao.
 */
export function migratePlayer({ rawPlayer, jaRodou }: PlayerMigrationState): PlaybackEngine {
  const todosValidos = new Set<string>([
    ...PLAYER_ENGINES,
    'libmpv',
    'mpv',
    'mpv-one',
    'vlc',
    'mpc',
  ])
  let player: PlaybackEngine = todosValidos.has(rawPlayer)
    ? (rawPlayer as PlaybackEngine)
    : PLAYER_DEFAULT

  // v8: Shaka e MPV sairam — quem estava neles vai para o player interno.
  if (!jaRodou(8) && LEGADOS_V8.includes(rawPlayer)) player = 'internal'

  // v9: default Automatico para quem ainda usa internal.
  if (!jaRodou(9) && (!rawPlayer || rawPlayer === 'internal')) player = 'auto'

  // v10: reset — apenas player interno (mpv/libmpv refeitos depois).
  if (!jaRodou(10)) player = 'internal'

  // v11: interno + mpv embutido (sem auto/libmpv).
  if (!jaRodou(11) && player !== 'mpv') player = 'internal'

  // v12: filmes no mpv por padrao; ao vivo continua interno.
  if (!jaRodou(12)) player = 'mpv'

  // v13: so Interno + STUR + Auto; motores legados viram STUR.
  if (!jaRodou(13) && LEGADOS_V13.includes(player)) player = 'stur'

  // Fora da lista cai no PADRAO. Fixar 'auto' aqui criava um segundo padrao,
  // invisivel: registro corrompido voltava ao motor que o app deixou de escolher.
  if (!PLAYER_ENGINES.includes(player as (typeof PLAYER_ENGINES)[number])) {
    player = PLAYER_DEFAULT
  }
  return player
}