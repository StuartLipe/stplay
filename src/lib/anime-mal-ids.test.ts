import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  malIdParaSerie,
  normalizarNomeSerie,
  totalSeriesComMalId,
  MAL_ID_POR_NOME,
} from './anime-mal-ids.ts'

test('o mapa gerado cobre a maior parte do catálogo de anime', () => {
  /*
   * O catálogo do servidor tem 279 séries e o mapa resolve 241. As 38 restantes
   * são as que a AniList não devolveu com segurança; sem dado, o botão apenas
   * não aparece, que é o comportamento pedido.
   *
   * Se o mapa for gerado de novo contra outro servidor, este número muda — o
   * teste só trava contra um mapa vazio, que é o estado de erro real.
   */
  assert.ok(totalSeriesComMalId() > 200, `mapa com só ${totalSeriesComMalId()} séries`)
})

test('normalizarNomeSerie tira ano, etiquetas e marcador de episódio', () => {
  assert.equal(normalizarNomeSerie('Naruto Shippuden [L] (2007)'), 'naruto shippuden')
  assert.equal(normalizarNomeSerie('One Piece [L] (1999)'), 'one piece')
  assert.equal(
    normalizarNomeSerie('Rezero Starting Life in Another World (2016)'),
    'rezero starting life in another world'
  )
  assert.equal(normalizarNomeSerie('Brave 10 [L] (2012)'), 'brave 10')
  assert.equal(
    normalizarNomeSerie('One Piece Log Fish Man Island Saga [L]'),
    'one piece log fish man island saga'
  )
  assert.equal(normalizarNomeSerie(''), '')
  assert.equal(normalizarNomeSerie(null as unknown as string), '')
})

test('o título do episódio volta a ser o nome da série', () => {
  /*
   * Regressão do bug que escondeu o botão inteiro: a chave do mapa é o nome da
   * série, e o que chega do servidor num episódio é o nome do episódio.
   */
  assert.equal(normalizarNomeSerie('Naruto Shippuden S01E01'), 'naruto shippuden')
  assert.equal(normalizarNomeSerie('Ataque dos Titas S01E01'), 'ataque dos titas')
  assert.equal(normalizarNomeSerie('Chainsaw Man S01E12'), 'chainsaw man')
  assert.equal(normalizarNomeSerie('Fullmetal Alchemist: Brotherhood S01E01'), 'fullmetal alchemist brotherhood')
  assert.equal(normalizarNomeSerie('Naruto Shippuden [L] (2007) S01E220'), 'naruto shippuden')
  assert.equal(normalizarNomeSerie('Solo Leveling E03'), 'solo leveling')
  assert.equal(normalizarNomeSerie('Bleach Episódio 5'), 'bleach')
})

test('normalizarNomeSerie não mutila título que começa com E seguido de dígito', () => {
  // "86 EIGHTY-SIX" precisa virar "86 eighty six", não "86".
  assert.equal(normalizarNomeSerie('86 EIGHTY-SIX (2021)'), '86 eighty six')
  assert.equal(normalizarNomeSerie('E-Ring'), 'e ring')
})

test('normalizarNomeSerie usa o mesmo Cleaning do gerador do mapa', () => {
  // Se as duas rotinas divergirem, o lookup nunca acha nada em silêncio.
  for (const chave of Object.keys(MAL_ID_POR_NOME)) {
    assert.equal(normalizarNomeSerie(chave), chave, `chave fora do normalizador: ${chave}`)
  }
})

test('malIdParaSerie acha a série pelo nome exato do servidor', () => {
  /*
   * Nomes e IDs tirados do catálogo real do servidor e conferidos um a um.
   * Naruto Shippuden é 1735 — o 20 é o Naruto original, o que mostra por que o
   * nome não pode ser resolvido "no olho".
   */
  const esperado: Record<string, string> = {
    'Naruto Shippuden [L] (2007)': '1735',
    'One Piece [L] (1999)': '21',
    'Ataque dos Titas': '16498',
    'Fullmetal Alchemist: Brotherhood (2009)': '5114',
    'Dragon Ball Z (1989)': '813',
    'Jujutsu Kaisen (2020)': '40748',
    'Chainsaw Man (2022)': '44511',
  }
  for (const [nome, malId] of Object.entries(esperado)) {
    assert.equal(malIdParaSerie(nome), malId, nome)
  }
})

test('malIdParaSerie devolve null em vez de adivinhar', () => {
  assert.equal(malIdParaSerie('Filme Que Nao Existe 9999 [L] (1999)'), null)
  assert.equal(malIdParaSerie(''), null)
  assert.equal(malIdParaSerie(null), null)
  assert.equal(malIdParaSerie(undefined), null)
  assert.equal(
    malIdParaSerie('2273444'),
    null,
    'stream_id do Xtream nunca pode virar MyAnimeList ID'
  )
})

test('todo malId do mapa é um inteiro positivo', () => {
  for (const [nome, id] of Object.entries(MAL_ID_POR_NOME)) {
    assert.match(id, /^\d+$/, `malId inválido para "${nome}": ${id}`)
    assert.ok(Number(id) > 0)
  }
})