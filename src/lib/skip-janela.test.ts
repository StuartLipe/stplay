import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decidirJanelaAbertura, janelaCobrePosicao } from './skip-janela.ts'

test('veto: a AniSkip diz que tem abertura, o áudio não acha música', () => {
  /*
   * Naruto Shippuden S01E01: a AniSkip anota 0:03-1:33 e o episódio não tem
   * abertura nenhuma. Era o defeito que o usuário viu — o botão aparecia
   * num episódio sem música de abertura.
   */
  const d = decidirJanelaAbertura({
    aniskip: { start: 3, end: 93 },
    audio: null,
  })
  assert.equal(d.janela, null)
  assert.equal(d.motivo, 'veto-audio-sem-musica')
})

test('concordam: o início vem do áudio e o fim da AniSkip', () => {
  /*
   * Attack on Titan S01E01: a AniSkip diz 0:47-2:17 (início de outro corte) e
   * o áudio achou a música em 1:36. O botão tem de aparecer em 1:36, não em
   * 0:47, e pular para 2:17.
   */
  const d = decidirJanelaAbertura({
    aniskip: { start: 47, end: 137 },
    audio: { start: 96, end: 139 },
  })
  assert.deepEqual(d.janela, { start: 96, end: 137 })
  assert.equal(d.motivo, 'concordam')
})

test('fontes discordam sobre onde a música começa: não mostra', () => {
  // Uma acha a música aos 4:31, a outra aos 1:22. Não é a mesma música.
  const d = decidirJanelaAbertura({
    aniskip: { start: 82, end: 172 },
    audio: { start: 271, end: 311 },
  })
  assert.equal(d.janela, null)
  assert.equal(d.motivo, 'fontes-discordam')
})

test('série que a AniSkip não indexa: o áudio decide sozinho', () => {
  /*
   * As séries de 2026 do catálogo não estão na base da AniSkip ainda — ela
   * responde "não tem abertura" mesmo tendo. Do jeito antigo, essas séries
   * nunca teriam botão.
   */
  const d = decidirJanelaAbertura({ aniskip: null, audio: { start: 35, end: 79 } })
  assert.deepEqual(d.janela, { start: 35, end: 79 })
  assert.equal(d.motivo, 'audio-so')
})

test('sem nenhuma das duas fontes: não mostra', () => {
  const d = decidirJanelaAbertura({ aniskip: null, audio: null })
  assert.equal(d.janela, null)
  assert.equal(d.motivo, 'aniskip-sem-entrada-e-sem-audio')
})

test('sem áudio disponível, a AniSkip sozinha é a reserva', () => {
  const d = decidirJanelaAbertura({
    aniskip: { start: 47, end: 137 },
    audio: null,
    deteccaoIndisponivel: true,
  })
  assert.deepEqual(d.janela, { start: 47, end: 137 })
  assert.equal(d.motivo, 'aniskip-so')
})

test('a tolerância de 60s separa "mesma música" de "outra música"', () => {
  // Exatamente 60s de diferença ainda é a mesma música.
  const dentro = decidirJanelaAbertura({
    aniskip: { start: 0, end: 100 },
    audio: { start: 60, end: 140 },
  })
  assert.deepEqual(dentro.janela, { start: 60, end: 100 })

  // 61s já é outra coisa.
  const fora = decidirJanelaAbertura({
    aniskip: { start: 0, end: 100 },
    audio: { start: 61, end: 140 },
  })
  assert.equal(fora.janela, null)
})

test('a janela só cobre a posição dentro dela', () => {
  const janela = { start: 96, end: 137 }
  assert.equal(janelaCobrePosicao(janela, 95), false)
  assert.equal(janelaCobrePosicao(janela, 96), true)
  assert.equal(janelaCobrePosicao(janela, 120), true)
  assert.equal(janelaCobrePosicao(janela, 137), true)
  assert.equal(janelaCobrePosicao(janela, 138), false)
  assert.equal(janelaCobrePosicao(null, 120), false)
})
