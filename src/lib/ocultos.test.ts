import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CATEGORIA_TODOS,
  CATEGORIAS_DO_APP,
  alvosMarcaveis,
  alternar,
  alternarTudo,
  categoriasVisiveis,
  chaveCategoria,
  chaveTitulo,
  contarAposFiltro,
  deveMostrarRestaurar,
  ehCategoriaDoApp,
  linhasDoBotaoOcultar,
  podeOcultarCategoria,
  rotuloMarcarTudo,
  rotuloRestaurar,
  selecaoDeveVoltarParaTodos,
  subtituloDoCabecalho,
  totalOculto,
} from './ocultos.ts'

/**
 * A TRAPECA 1 — as quatro do app.
 *
 * "Ocultar Todos" deixaria a tela sem lista e sem volta. "Continuar Assistindo"
 * e "Adicionado Recentemente" sao pilhas do APP, nao do servidor: nao faz
 * sentido some-las do catalogo.
 */
test('as quatro categorias do app nunca podem ser ocultadas', () => {
  for (const nome of CATEGORIAS_DO_APP) {
    assert.equal(ehCategoriaDoApp(nome), true, `${nome} e do app`)
    assert.equal(podeOcultarCategoria(nome), false, `${nome} nao pode ser ocultada`)
  }
})

test('categoria real do servidor sempre pode ser ocultada', () => {
  for (const nome of ['LANÇAMENTOS 2026', 'DRAMABOX', 'REELSHORT', 'FILMES | 4K']) {
    assert.equal(podeOcultarCategoria(nome), true, `${nome} pode`)
  }
})

test('sem categoria nao ha botao', () => {
  assert.equal(podeOcultarCategoria(''), false)
})

test('comparacao ignora acento e caixa — o servidor manda do jeito dele', () => {
  // Os nomes vem do servidor com acentuacao e caixa proprias. Comparar string
  // fixa deixava "continuar assistindo" escapando do filtro.
  assert.equal(ehCategoriaDoApp('continuar assistindo'), true)
  assert.equal(ehCategoriaDoApp('  FAVORITOS  '), true)
  assert.equal(ehCategoriaDoApp('Adicionado Recentemente'), true)
  assert.equal(ehCategoriaDoApp('LANÇAMENTOS 2026'), false)
})

/**
 * A TRAPECA 2 — a coluna tambem e filtrada.
 *
 * Categoria oculta listada com contagem zero e pior do que nao ter clicado: e
 * o que faz a acao parecer que nao funcionou.
 */
test('a coluna perde a categoria oculta em vez de mostrar com zero', () => {
  const coluna = ['Todos', 'Continuar Assistindo', 'LANÇAMENTOS 2026', 'DRAMABOX', 'Adicionado Recentemente']
  const visivel = categoriasVisiveis(coluna, new Set(['DRAMABOX']))
  assert.equal(visivel.includes('DRAMABOX'), false, 'nao fica listada com 0')
  assert.ok(visivel.includes('LANÇAMENTOS 2026'), 'as outras continuam')
})

test('as pilhas do app aparecem sempre, nunca somem do filtro de ocultos', () => {
  const coluna = ['Todos', 'Favoritos', 'Continuar Assistindo', 'Adicionado Recidentally']
  const visivel = categoriasVisiveis(coluna, new Set(['DRAMABOX']))
  assert.ok(visivel.includes('Todos'))
  assert.ok(visivel.includes('Favoritos'))
})

/** A TRAPECA 3 — a contagem e depois do filtro. */
test('a contagem desconta o que ainda esta guardado no grupo', () => {
  assert.equal(contarAposFiltro(100, 3), 97)
  assert.equal(contarAposFiltro(100, 0), 100)
  assert.equal(contarAposFiltro(2, 5), 0, 'nunca negativo: categoria sem item e 0, nao -3')
})

test('"Ocultar categoria" so aparece com categoria real selecionada', () => {
  assert.equal(podeOcultarCategoria(CATEGORIA_TODOS), false, 'em Todos nao ha o botao')
  assert.equal(podeOcultarCategoria('DRAMABOX'), true)
})

/* ------------------------------------------------------------------ */
/* Folha de restauracao                                                */
/* ------------------------------------------------------------------ */

test('a linha inteira alterna o item', () => {
  let sel = alternar(new Set(), 'vod-1')
  assert.equal(sel.has('vod-1'), true)
  sel = alternar(sel, 'vod-1')
  assert.equal(sel.has('vod-1'), false, 'clicar de novo desmarca')
})

test('marcar tudo marca tudo; clicar de novo desmarca tudo', () => {
  const todos = ['a', 'b', 'c']
  const marcado = alternarTudo(new Set(), todos)
  assert.equal(marcado.size, 3)
  const desmarcado = alternarTudo(marcado, todos)
  assert.equal(desmarcado.size, 0)
})

test('o rotulo do botao de marcar tudo acompanha o estado', () => {
  const todos = ['a', 'b']
  assert.equal(rotuloMarcarTudo(new Set(), todos), 'Marcar tudo')
  assert.equal(rotuloMarcarTudo(new Set(['a']), todos), 'Marcar tudo')
  assert.equal(rotuloMarcarTudo(new Set(['a', 'b']), todos), 'Desmarcar tudo')
})

test('lista vazia nao fica "tudo marcado" por acidente', () => {
  assert.equal(rotuloMarcarTudo(new Set(), []), 'Marcar tudo')
})

/** A TRAPECA 4 — nada de instrucao dentro do botao desabilitado. */
test('sem nada marcado o botao mostra so "Restaurar"', () => {
  assert.equal(rotuloRestaurar(0), 'Restaurar')
  assert.equal(rotuloRestaurar(1), 'Restaurar 1')
  assert.equal(rotuloRestaurar(7), 'Restaurar 7')
})

test('a instrucao vive no subtitulo do cabecalho', () => {
  assert.equal(subtituloDoCabecalho(0), 'Nada oculto neste tipo de conteúdo')
  assert.equal(subtituloDoCabecalho(1), '1 item · toque para marcar o que volta')
  assert.equal(subtituloDoCabecalho(12), '12 itens · toque para marcar o que volta')
})

test('"Restaurar" so aparece com algo oculto no contexto', () => {
  assert.equal(deveMostrarRestaurar({ channels: [], groups: [] }), false)
  assert.equal(deveMostrarRestaurar({ channels: ['a'], groups: [] }), true)
  assert.equal(deveMostrarRestaurar({ channels: [], groups: ['DRAMABOX'] }), true)
  assert.equal(totalOculto({ channels: ['a', 'b'], groups: ['c'] }), 3)
})

/**
 * A TRAPECA 5 — restaurar e por escolha, e a selecao volta quando precisa.
 *
 * Se a categoria selecionada era uma das restauradas, o conteudo volta para o
 * armazenamento mas nao aparece na lista, e a pessoa conclui que o botao nao
 * funcionou.
 */
test('a selecao volta para Todos quando a categoria restaurada era a selecionada', () => {
  assert.equal(selecaoDeveVoltarParaTodos('DRAMABOX', ['DRAMABOX']), true)
  assert.equal(selecaoDeveVoltarParaTodos('dramabox', ['DRAMABOX']), true, 'ignora caixa')
  assert.equal(selecaoDeveVoltarParaTodos('LANÇAMENTOS 2026', ['DRAMABOX']), false, 'outra categoria')
  assert.equal(selecaoDeveVoltarParaTodos(CATEGORIA_TODOS, ['DRAMABOX']), false, 'ja em Todos')
  assert.equal(selecaoDeveVoltarParaTodos('', ['DRAMABOX']), false, 'sem selecao')
})

/* ------------------------------------------------------------------ */
/* Botao de duas linhas                                                */
/* ------------------------------------------------------------------ */

/** "Ocultar categoria NETFLIX" num botao de meia largura encolhe a fonte ou vaza. */
test('o botao de ocultar tem rotulo e nome em linhas separadas', () => {
  const linhas = linhasDoBotaoOcultar('DRAMABOX')
  assert.equal(linhas.rotulo, 'Ocultar categoria')
  assert.equal(linhas.nome, 'DRAMABOX')
  assert.equal(linhas.completo, 'Ocultar categoria: DRAMABOX', 'o nome inteiro vai no title')
})

test('sem nome de categoria o botao nao fica com dois pontos soltos', () => {
  const linhas = linhasDoBotaoOcultar('')
  assert.equal(linhas.nome, '')
  assert.equal(linhas.completo, 'Ocultar categoria')
})

/* ------------------------------------------------------------------ */
/* A chave que a linha e o "Marcar tudo" tem que compartilhar          */
/* ------------------------------------------------------------------ */

/**
 * O BUG QUE ESTE BLOCO TRAVA.
 *
 * Medido no app: com UMA linha na tela, o botao dizia "Restaurar 2" e o rotulo
 * do "Marcar tudo" nunca concordava com a selecao. A causa era a chave em dois
 * lugares — a linha usava `g:TREND FILMES` e a lista de "marcar tudo" usava
 * `TREND FILMES`. O clique marcava uma chave que nenhuma linha consulta.
 *
 * Este teste pega a divergencia na regra pura: se `alvosMarcaveis` e a chave da
 * linha saem da mesma funcao, nao ha como divergirem.
 */
test('a chave da linha e a chave de "marcar tudo" sao a mesma', () => {
  const alvos = alvosMarcaveis(['DRAMABOX'], ['vod-1'], () => 'CATEGORIA')
  const marcavel = alvos.map((a) => a.chave)

  // marcar tudo produz um estado em que TODA linha fica marcada
  const marcado = alternarTudo(new Set(), marcavel)
  assert.deepEqual(alvos.filter((a) => marcado.has(a.chave)).length, alvos.length)

  // e o rotulo do botao concorda com essa selecao
  assert.equal(rotuloMarcarTudo(marcado, marcavel), 'Desmarcar tudo')
  assert.equal(rotuloRestaurar(marcado.size), `Restaurar ${alvos.length}`)
})

test('"Marcar tudo" nunca produz contagem maior que a de linhas', () => {
  const alvos = alvosMarcaveis(['DRAMABOX'], [], () => undefined)
  const marcado = alternarTudo(new Set(), alvos.map((a) => a.chave))
  assert.equal(marcado.size, 1, 'uma categoria, uma linha')
  assert.equal(rotuloRestaurar(marcado.size), 'Restaurar 1')
})

test('a ordem e categorias primeiro, e a categoria de origem vem junto', () => {
  const alvos = alvosMarcaveis(
    ['DRAMABOX', 'NETFLIX'],
    ['vod-1', 'vod-2'],
    (id) => (id === 'vod-1' ? 'DRAMABOX' : undefined),
  )
  assert.deepEqual(
    alvos.map((a) => a.tipo),
    ['categoria', 'categoria', 'titulo', 'titulo'],
  )
  assert.equal(alvos[2].origem, 'DRAMABOX', 'a origem do titulo')
  assert.equal(alvos[3].origem, undefined, 'sem origem no catalogo, sem linha de origem')
})

test('categoria e titulo com o mesmo texto nao viram a mesma linha', () => {
  // Nomes de categoria vem do servidor sem restricao; um id de titulo pode
  // colidir com um deles. Sem prefixo, marcar um marcaria o outro e o
  // "Restaurar 2" contaria duas coisas que a pessoa marcou uma.
  const [cat] = alvosMarcaveis(['vod-1'], [], () => undefined)
  const [tit] = alvosMarcaveis([], ['vod-1'], () => undefined)
  assert.equal(cat.nome, 'vod-1')
  assert.equal(tit.nome, 'vod-1')
  assert.notEqual(cat.chave, tit.chave)

  const marcado = alternarTudo(new Set(), [cat.chave])
  assert.equal(marcado.has(tit.chave), false, 'marcar a categoria nao marca o titulo')
})

test('as chaves tem prefixo, e o prefixo e o que separa os dois tipos', () => {
  assert.equal(chaveCategoria('DRAMABOX'), 'g:DRAMABOX')
  assert.equal(chaveTitulo('vod-1'), 'i:vod-1')
})
