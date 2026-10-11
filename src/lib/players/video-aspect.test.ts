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
 * coisas que teriamLEVADO a tarja de volta.
 */

test('o padrao preenche: nao pode ser o modo com tarja', () => {
  assert.equal(ASPECT_DEFAULT, 'fill')
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

test('o ciclo comeca em `fill` a partir de qualquer valor invalido', () => {
  // Estado corrompido (ou versao futura) nao pode devolver `fit`, porque `fit`
  // e a tarja. `indexOf` -1 somando 1 daria 0 e cairia em `fit`.
  const invalido = 'zoom' as VideoFit
  assert.equal(nextAspect(invalido), 'wide')
  assert.notEqual(nextAspect(invalido), 'fit')
})

test('toda a ordem so tem modos que o mpv sabe aplicar', () => {
  // `keepaspect` e `panscan` sao as duas propriedades que os motores mandam.
  // Um quarto modo aqui seria silenciosamente ignorado pelo motor.
  assert.deepEqual([...ASPECT_ORDER], ['fit', 'fill', 'wide'])
})

test('leitura corrompida do storage volta para `fill`, nunca para a tarja', () => {
  assert.equal(normalizeAspect(null), 'fill')
  assert.equal(normalizeAspect(undefined), 'fill')
  assert.equal(normalizeAspect(''), 'fill')
  assert.equal(normalizeAspect('garbage'), 'fill')
  assert.equal(normalizeAspect('FIT'), 'fill')
  assert.equal(normalizeAspect('fill'), 'fill')
})

test('leitura valida preserva a escolha do usuario', () => {
  assert.equal(normalizeAspect('fit'), 'fit')
  assert.equal(normalizeAspect('wide'), 'wide')
})

test('a dica do botao diz o que o proximo clique faz', () => {
  for (const modo of ASPECT_ORDER) {
    const dica = aspectHint(modo)
    assert.ok(dica.length > 0, `${modo} sem dica`)
    assert.ok(
      dica.includes('preencher') || dica.includes('caber inteira'),
      `${modo} nao explica o destino: ${dica}`,
    )
  }
})