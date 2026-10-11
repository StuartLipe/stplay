import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLAYER_DEFAULT, PLAYER_ENGINES, migratePlayer } from './player-default.ts'
import type { PlaybackEngine } from '../types'

/**
 * Motor padrao e cadeia de migracao.
 *
 * O padrao tem DUAS fontes de verdade, e elas discordavam. `DEFAULT_SETTINGS`
 * dizia `auto`, mas o caminho de instalacao nova nunca passava por ele: quem nao
 * tem registro salvo recebe o objeto direto, e quem tem registro passa pela
 * cadeia v8..v13, que termina em `stur`. Um arquivo dizia `auto` e o produto
 * entregava `stur` — o tipo de divergencia que so aparece quando alguem le o
 * arquivo e acredita nele.
 *
 * Aqui nao ha `storage.ts`: ele importa `./accent` e `./appearance` SEM extensao
 * (o Vite resolve, o runner nao), e por isso que nenhum teste conseguia alcancar
 * `normalizeSettings`. A decisao foi extraida para `player-default.ts` justamente
 * para isto.
 */

/** Todas as migracoes ja rodaram nesta maquina — o caso de quem ja instalou. */
const todasRodaram = () => true
/** Nenhuma rodou — o caso de um perfil com registro antigo. */
const nenhumaRodou = () => false

test('o padrao e STUR', () => {
  assert.equal(PLAYER_DEFAULT, 'stur')
})

test('STUR esta entre os motores oferecidos', () => {
  assert.ok(PLAYER_ENGINES.includes(PLAYER_DEFAULT as (typeof PLAYER_ENGINES)[number]))
})

test('perfil novo, sem nada gravado, termina em STUR', () => {
  assert.equal(migratePlayer({ rawPlayer: '', jaRodou: todasRodaram }), 'stur')
})

test('perfil antigo, sem migracao rodada, termina em STUR', () => {
  // Quem instalou antes da cadeia tem registro mas nao tem as chaves. Percorrer
  // v8..v13 inteiro precisa_landar no mesmo lugar do perfil novo — e um teste
  // por passo intermediario congelaria a cadeia contra o proprio codigo.
  assert.equal(migratePlayer({ rawPlayer: 'internal', jaRodou: nenhumaRodou }), 'stur')
})

test('quem ja instalou continua no motor que escolheu', () => {
  for (const escolhido of PLAYER_ENGINES) {
    assert.equal(
      migratePlayer({ rawPlayer: escolhido, jaRodou: todasRodaram }),
      escolhido,
      `perdeu a escolha: ${escolhido}`,
    )
  }
})

test('motor gravado fora da lista cai no padrao, e o padrao e STUR', () => {
  // Antes disto caia em 'auto' — o motor que o app deixou de escolher.
  for (const invalido of ['vlc', 'mpc', 'shaka', 'mpv-one', 'nao-existe']) {
    assert.equal(migratePlayer({ rawPlayer: invalido, jaRodou: todasRodaram }), PLAYER_DEFAULT, invalido)
  }
})

test('nenhum caminho da cadeia devolve um motor fora da tela de configuracao', () => {
  // v12 colocava `mpv` no meio do caminho. Se um passo voltar a fazer isso e o
  // filtro final deixar passar, o app abre num motor que ninguem pode escolher.
  const entradas = ['', 'auto', 'internal', 'mpeg', 'stur', 'mpv', 'vlc', 'mpc', 'shaka']
  for (const raw of entradas) {
    for (const todas of [true, false]) {
      const saida = migratePlayer({ rawPlayer: raw, jaRodou: todas ? todasRodaram : nenhumaRodou })
      assert.ok(
        (PLAYER_ENGINES as readonly string[]).includes(saida),
        `raw="${raw}" migrationsRan=${todas} devolveu "${saida}", que nao esta na tela`,
      )
    }
  }
})

test('so o STUR sobrevive a um registro sem nenhuma migracao rodada', () => {
  // Confirma o motivo do padrao: `auto` e `internal` nao sao resultado final de
  // perfil novo. Se isso mudar, o `PLAYER_DEFAULT` precisa ser revisto junto.
  const saidas = new Set<PlaybackEngine>()
  for (const raw of ['', 'auto', 'internal', 'mpeg', 'stur']) {
    saidas.add(migratePlayer({ rawPlayer: raw, jaRodou: nenhumaRodou }))
  }
  assert.deepEqual([...saidas], ['stur'])
})