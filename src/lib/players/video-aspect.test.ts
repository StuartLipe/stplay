import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ASPECT_DEFAULT,
  ASPECT_ORDER,
  aspectHint,
  nextAspect,
  normalizeAspect,
} from './video-aspect.ts'
import type { VideoFit } from './types'

/**
 * O sintoma era "o filme tem borda". A causa nao era o mpv: era o codigo do
 * renderer, que fixava `fit` e nao tinha setter. Estes testes travam as tres
 * coisas que teriam levado a tarja de volta.
 */

test('o padrao mostra a imagem inteira: nunca corta a borda', () => {
  assert.equal(ASPECT_DEFAULT, 'fit')
})

test('o ciclo passa pelos tres modos e volta', () => {
  const andar = (inicio: VideoFit, passos: number): VideoFit => {
    let modo = inicio
    for (let i = 0; i < passos; i++) modo = nextAspect(modo)
    return modo
  }
  assert.equal(andar('fit', 1), 'fill')
  assert.equal(andar('fit', 2), 'wide')
  assert.equal(andar('fit', 3), 'fit')
  // Um ciclo fechado e periodico: e um botao, nao uma escada que acaba.
  assert.equal(andar('fit', 4), 'fill')
})

test('o ciclo comeca em `fit` a partir de qualquer valor invalido', () => {
  // Estado corrompido cai no padrao `fit` e o proximo e `fill`.
  const invalido = 'zoom' as VideoFit
  assert.equal(nextAspect(invalido), 'fill')
})

test('toda a ordem so tem modos que o mpv sabe aplicar', () => {
  // `keepaspect` e `panscan` sao as duas propriedades que os motores mandam.
  // Um quarto modo aqui seria silenciosamente ignorado pelo motor.
  assert.deepEqual([...ASPECT_ORDER], ['fit', 'fill', 'wide'])
})

test('leitura corrompida do storage volta para `fit`, nunca para o corte', () => {
  assert.equal(normalizeAspect(), 'fit')
})

test('leitura valida sempre retorna `fit` (o padrao mostra tudo)', () => {
  assert.equal(normalizeAspect(), 'fit')
})

test('a dica do botao diz o que o proximo clique faz', () => {
  for (const modo of ASPECT_ORDER) {
    const hint = aspectHint(modo)
    assert.ok(typeof hint === 'string' && hint.length > 0)
  }
})
