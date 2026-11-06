import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupEpisodesBySeason,
  resolveEpisodeSeason,
  findSeasonForEpisode,
} from './episode-seasons.ts'

/*
 * O tipo do item e o que o painel devolve: mais rico que `EpisodeListItem`,
 * porque traz `logo` — a capa que o popup de proximo episodio mostra.
 */
type ComCapa = { id: string; name: string; group?: string; logo?: string }

test('o agrupamento nao descarta os campos que ele nao usa', () => {
  const eps: ComCapa[] = [
    { id: '1', name: 'S01E01', group: 'Temporada 1', logo: 'a.jpg' },
    { id: '2', name: 'S01E02', group: 'Temporada 1', logo: 'b.jpg' },
  ]
  const grupos = groupEpisodesBySeason(eps)
  assert.equal(grupos.length, 1)
  // O `logo` e o que o popup de proximo usa; se o agrupamento o perdesse, a
  // oferta aparecia sem imagem e o typecheck nem reclamava antes do `<img>`.
  assert.equal(grupos[0][1][0]?.logo, 'a.jpg')
  assert.equal(grupos[0][1][1]?.logo, 'b.jpg')
})

test('temporadas saem em ordem numerica, nao alfabetica', () => {
  const eps: ComCapa[] = [
    { id: '10', name: 'S10E01', group: 'Temporada 10' },
    { id: '2', name: 'S02E01', group: 'Temporada 2' },
    { id: '1', name: 'S01E01', group: 'Temporada 1' },
  ]
  assert.deepEqual(
    groupEpisodesBySeason(eps).map(([temporada]) => temporada),
    ['Temporada 1', 'Temporada 2', 'Temporada 10'],
  )
})

test('temporada vem do grupo, e nao do nome, quando o grupo existe', () => {
  assert.equal(resolveEpisodeSeason({ id: '1', name: 'Episodio 7', group: 'Temporada 3' }), 'Temporada 3')
})

test('sem grupo, a temporada vem do SxxE do nome', () => {
  assert.equal(resolveEpisodeSeason({ id: '1', name: 'Brave 10 - S02E05' }), 'Temporada 2')
})

test('sem grupo e sem SxxE, cai em Outros', () => {
  assert.equal(resolveEpisodeSeason({ id: '1', name: 'Filmagem Making' }), 'Outros')
})

test('achar a temporada do episodio atual acha o proximo certo', () => {
  const eps: ComCapa[] = [
    { id: '1', name: 'S01E01', group: 'Temporada 1' },
    { id: '2', name: 'S01E02', group: 'Temporada 1' },
  ]
  assert.equal(findSeasonForEpisode(eps, '2'), 'Temporada 1')
  // Episodeo de fora da lista nao pode inventar temporada: devolve null para o
  // caller cair no primeiro grupo em vez de oferecer um proximo errado.
  assert.equal(findSeasonForEpisode(eps, '999'), null)
})