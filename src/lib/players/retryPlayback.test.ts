import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canHotReloadStur,
  playbackUiAfterFailed,
  playbackUiAfterRetry,
  shouldResetManagedEngine,
  shouldRestorePlayerChrome,
  shouldShowNativeRetrySpinner,
} from './retryPlayback.ts'

test('after STUR failed, React keeps an error dialog and drops native embed', () => {
  const ui = playbackUiAfterFailed('STUR end-file error')
  assert.equal(ui.playbackError, 'STUR end-file error')
  assert.equal(ui.buffering, false)
  assert.equal(ui.playing, false)
  assert.equal(ui.nativeEmbedded, false)
  assert.equal(ui.nativeBooting, false)
  assert.equal(ui.retrying, false)
  assert.equal(ui.killNativeProcess, false)
})

test('retry clears the error and shows a boot spinner instead of a black wrap', () => {
  const ui = playbackUiAfterRetry()
  assert.equal(ui.playbackError, null)
  assert.equal(ui.buffering, true)
  assert.equal(ui.nativeBooting, true)
  assert.equal(ui.nativeEmbedded, false)
  assert.equal(ui.playing, false)
  assert.equal(ui.retrying, true)
  assert.equal(ui.restorePlayerChrome, true)
})

test('retry does not reset managedEngine (that hide()s the overlay and aborts start)', () => {
  assert.equal(shouldResetManagedEngine({ urlChanged: false, isRetry: true }), false)
  assert.equal(shouldResetManagedEngine({ urlChanged: true, isRetry: false }), true)
  assert.equal(shouldResetManagedEngine({ urlChanged: false, isRetry: false }), false)
})

test('shows React spinner while native overlay is still hidden after retry', () => {
  assert.equal(
    shouldShowNativeRetrySpinner({
      retrying: true,
      buffering: true,
      playbackError: null,
      nativeEmbedded: false,
    }),
    true,
  )
  assert.equal(
    shouldShowNativeRetrySpinner({
      retrying: false,
      buffering: true,
      playbackError: null,
      nativeEmbedded: false,
    }),
    false,
  )
  assert.equal(
    shouldShowNativeRetrySpinner({
      retrying: true,
      buffering: true,
      playbackError: 'STUR end-file error',
      nativeEmbedded: false,
    }),
    false,
  )
  assert.equal(
    shouldShowNativeRetrySpinner({
      retrying: true,
      buffering: true,
      playbackError: null,
      nativeEmbedded: true,
    }),
    false,
  )
  assert.equal(
    shouldShowNativeRetrySpinner({
      retrying: true,
      buffering: true,
      playbackError: null,
      nativeEmbedded: true,
      nativeBooting: true,
    }),
    true,
  )
})

test('does not hot-reload STUR after a failed event — process may already be dead', () => {
  assert.equal(
    canHotReloadStur({
      targetEngine: 'stur',
      activeEngine: 'stur',
      hasBackend: true,
      hasStartApi: true,
      failedSinceStart: true,
    }),
    false,
  )
  assert.equal(
    canHotReloadStur({
      targetEngine: 'stur',
      activeEngine: 'stur',
      hasBackend: true,
      hasStartApi: true,
      failedSinceStart: false,
    }),
    true,
  )
})

// ---------------------------------------------------------------------------
// Regressao do "Tentar novamente" no painel de video dividido.
//
// O bug e visual e bem especifico: clicar em "Tentar novamente" com o player no
// painel da direita sumia com TODO o texto, TODOS os logos e TODOS os nomes de
// categoria, e ficavam so os botoes de favorito e o menu.
//
// `body.player-active` aplica `visibility: hidden` em `.app-shell`. E
// `visibility: hidden` esconde os filhos MENOS os que declaram
// `visibility: visible` — que no browse sao justamente os botoes de acao. Por
// isso o app ficava mutilado em vez de simplesmente vazio.
//
// A classe existe para o player em TELA CHEIA, onde o video tem que ocupar a
// janela inteira. No painel dividido o shell tem que continuar visivel.
//
// A guarda e `nao-embedded E em tela cheia` — as duas. Com so a primeira, o
// zape de live (que tem `embedded` e roda retry automatico) escondia o shell,
// o grid perdia a coluna da lista e o painel do video esticava ate virar a
// janela toda. Medido no canal A Fazenda as 01:33.
test('retry em tela cheia (nao embedded + isFs) recoloca a chrome', () => {
  assert.equal(shouldRestorePlayerChrome({ embedded: false, isFs: true }), true)
})

test('retry embedded NAO pode recolocar a chrome', () => {
  assert.equal(shouldRestorePlayerChrome({ embedded: true, isFs: true }), false)
})

// A regressao do live: embedded, JANELA normal, zape com retry automatico.
test('embedded fora de tela cheia NAO recoloca a chrome (o bug do live)', () => {
  assert.equal(shouldRestorePlayerChrome({ embedded: true, isFs: false }), false)
})

// Sem `isFs` a guarda nao sabe, e o padrao e NAO esconder: escondido sem
// motivo e o estado que lasted o resto da sessao.
test('isFs ausente nao recoloca a chrome (falhar fechado)', () => {
  assert.equal(shouldRestorePlayerChrome({ embedded: false }), false)
  assert.equal(shouldRestorePlayerChrome({}), false)
  assert.equal(shouldRestorePlayerChrome({ embedded: undefined }), false)
})

test('o retry sempre pede chrome; quem decide embedded e quem sabe', () => {
  // playbackUiAfterRetry nao conhece o modo de exibicao — devolve a intencao,
  // e a guarda fica no componente. Se esse retorno virar false, o caminho de
  // tela cheia perde a chrome sem nenhum aviso.
  assert.equal(playbackUiAfterRetry().restorePlayerChrome, true)
})