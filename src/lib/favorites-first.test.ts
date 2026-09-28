// Regressao para a particao "favoritos primeiro" (src/lib/favorites-first.ts).
//
// O que este codigo nao pode fazer: embaralhar. A lista "Todos" de live tem
// 2.064 canais e o usuario navega por ela o tempo todo. Um sort por "favorito"
// como criterio tiraria a posicao dele a cada re-render e a cada clique em
// qualquer botao da tela. A particao precisa ser ESTAVEL.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { favoritesFirst, favoritesFirstById } from './favorites-first.ts'

type Row = { id: string }

const rows = (...ids: string[]) => ids.map((id) => ({ id }))

describe('favoritos primeiro', () => {
  test('sobe os favoritos preservando a ordem relativa dos dois blocos', () => {
    const list = rows('a', 'b', 'c', 'd', 'e', 'f')
    const out = favoritesFirstById(list, ['d', 'b'])
    assert.deepEqual(out.map((r) => r.id), ['b', 'd', 'a', 'c', 'e', 'f'])
  })

  test('a ordem RELATIVA dos favoritos e preservada', () => {
    // Favoritar o quinto e o primeiro tem que continuar nessa ordem, mesmo com
    // um nao-favoritado entre eles na lista original.
    const list = rows('a', 'x', 'b', 'x', 'c', 'x')
    const out = favoritesFirstById(list, ['c', 'a'])
    // favoritos: a, c (na ordem em que aparecem na lista, nao na ordem do Set)
    // resto: x, b, x, x (intactos, na posicao original)
    assert.deepEqual(out.map((r) => r.id), ['a', 'c', 'x', 'b', 'x', 'x'])
  })

  test('favoritos saem na ordem da LISTA, nao na ordem em que foram marcados', () => {
    // Marcar "c" antes de "a" nao pode inverter os dois no topo.
    const list = rows('a', 'b', 'c')
    assert.deepEqual(favoritesFirstById(list, ['c', 'a']).map((r) => r.id), ['a', 'c', 'b'])
  })

  test('sem favoritos devolve a lista na ordem original', () => {
    const list = rows('a', 'b', 'c')
    assert.deepEqual(favoritesFirstById(list, []).map((r) => r.id), ['a', 'b', 'c'])
  })

  test('nao muta a lista original', () => {
    const list = rows('a', 'b', 'c')
    favoritesFirstById(list, ['c'])
    assert.deepEqual(list.map((r) => r.id), ['a', 'b', 'c'], 'a entrada foi reordenada no lugar')
  })

  test('devolve uma copia mesmo sem favoritos', () => {
    // Sem isto, o memo devolveria a mesma referencia e o chamador que fizesse
    // `.sort()` nela reordenaria a lista em memoria.
    const list = rows('a', 'b')
    const out = favoritesFirstById(list, [])
    assert.notEqual(out, list)
    out.sort()
    assert.deepEqual(list.map((r) => r.id), ['a', 'b'])
  })

  test('todos os itens podem ser favoritos', () => {
    const list = rows('a', 'b', 'c')
    const out = favoritesFirstById(list, ['a', 'b', 'c'])
    assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c'])
  })

  test('lista vazia e lista so de favoritos', () => {
    assert.deepEqual(favoritesFirstById([] as Row[], ['a']), [])
    assert.deepEqual(favoritesFirstById(rows('a'), ['a']).map((r) => r.id), ['a'])
  })

  test('favorito que nao esta na lista nao quebra nada', () => {
    const out = favoritesFirstById(rows('a', 'b'), ['z'])
    assert.deepEqual(out.map((r) => r.id), ['a', 'b'])
  })

  test('ids repetidos nao duplicam o item', () => {
    const out = favoritesFirstById(rows('a', 'b'), ['a', 'a', 'a'])
    assert.deepEqual(out.map((r) => r.id), ['a', 'b'])
  })

  test('favoritesFirst aceita qualquer tipo via predicado', () => {
    const out = favoritesFirst([1, 2, 3, 4], (n) => n % 2 === 0)
    assert.deepEqual(out, [2, 4, 1, 3])
  })
})
