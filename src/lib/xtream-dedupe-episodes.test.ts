import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeEpisodesByNumber } from './dedupe-episodes.ts'

// Registros reais de `Brave 10 [L]` (series_id 44008), como o painel devolveu.
// O id menor e o que responde `200 text/html`; o maior tem o arquivo.
const PAINEL = [
  { id: '1607372', episode_num: '1', title: 'S01E01' },
  { id: '2187891', episode_num: '1', title: 'S01E01' },
  { id: '2187892', episode_num: '2', title: 'S01E02' },
  { id: '1607373', episode_num: '2', title: 'S01E02' },
]

test('um registro por episodio, com o id que tem arquivo', () => {
  const out = dedupeEpisodesByNumber(PAINEL)
  assert.equal(out.length, 2)
  assert.deepEqual(
    out.map((e) => e.id).sort(),
    ['2187891', '2187892'],
  )
})

test('id numerico nao vira string na comparacao', () => {
  const out = dedupeEpisodesByNumber([
    { id: 100, episode_num: '1' },
    { id: 99, episode_num: '1' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 100)
})

test('episodio sem numero nao e colapsado', () => {
  const out = dedupeEpisodesByNumber([
    { id: 'a' },
    { id: 'b' },
    { id: '5', episode_num: '1' },
  ])
  assert.equal(out.length, 3)
})

test('lista vazia e lista sem duplicata passam direto', () => {
  assert.deepEqual(dedupeEpisodesByNumber([]), [])
  const limpo = [{ id: '1', episode_num: '1' }, { id: '2', episode_num: '2' }]
  assert.equal(dedupeEpisodesByNumber(limpo).length, 2)
})

test('episode_num nao numerico cai fora da regra', () => {
  const out = dedupeEpisodesByNumber([
    { id: '1', episode_num: 'especial' },
    { id: '2', episode_num: 'especial' },
  ])
  assert.equal(out.length, 2)
})