import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideFullscreenAction,
  escapeShouldExitFullscreen,
  type FullscreenProbe,
} from './fullscreen-decision.ts'

/**
 * Estes testes existem porque o bug NAO PAVA ser verificado pela janela.
 *
 * Medido: `webContents.sendInputEvent` deu `janelaFullscreen=false` nas duas
 * tentativas, porque so entrega tecla com a janela focada, e no dev ela nao
 * tem. O teste mediu o pipeline de input, nao a logica. Extraindo a decisao
 * para uma funcao pura, ela vira verificavel sem janela nenhuma.
 *
 * Cada caso abaixo e um modo de falha que aconteceu de verdade.
 */

/** Elemento DOM qualquer, so para o teste de identidade. */
const elemento = { tagName: 'DIV' } as unknown as Element

function probe(over: Partial<FullscreenProbe> = {}): FullscreenProbe {
  return {
    documentFullscreenElement: null,
    windowFullscreen: false,
    playerMounted: true,
    canRequestElementFullscreen: true,
    ...over,
  }
}

test('com elemento em tela cheia, o F11 SAI pelo DOM', () => {
  // O caso que prendia o usuario: 14 pedidos de saida com a janela presa.
  const r = decideFullscreenAction(
    probe({ documentFullscreenElement: elemento, playerMounted: false, canRequestElementFullscreen: false }),
  )
  assert.equal(r.kind, 'exit-dom')
})

test('sem elemento e com wrapper montado, o F11 ENTRA pelo elemento', () => {
  assert.equal(decideFullscreenAction(probe()).kind, 'enter-dom')
})

test('sem elemento e SEM wrapper, o F11 entra pela janela (nao e beco sem saida)', () => {
  // O `if (!root) return` original matava o F11 aqui. Reproduzido: o playback
  // para, o wrapper desmonta, e o F11 nao fazia NADA.
  const r = decideFullscreenAction(probe({ playerMounted: false }))
  assert.equal(r.kind, 'enter-window')
})

test('wrapper sem suporte a requestFullscreen tambem cai na janela', () => {
  const r = decideFullscreenAction(probe({ canRequestElementFullscreen: false }))
  assert.equal(r.kind, 'enter-window')
})

test('A SAIDA NAO depende do wrapper: e o segundo furo do mesmo bug', () => {
  // Quando o playback para, o wrapper desmonta e
  // `document.fullscreenElement === wrapper` ficava falso, entao a saida perdia
  // o caminho. Aqui o wrapper nao esta montado e mesmo assim a saida funciona,
  // porque a pergunta e "TEM elemento em tela cheia", nao "e o wrapper".
  for (const mounted of [true, false]) {
    const r = decideFullscreenAction(
      probe({ documentFullscreenElement: elemento, playerMounted: mounted }),
    )
    assert.equal(r.kind, 'exit-dom', `wrapper montado=${mounted} deveria sair pelo DOM`)
  }
})

test('a recusa do DOM NAO e um quarto ramo: ela cai em enter-window', () => {
  // `requestFullscreen` so roda com gesto do usuario, e o log real mostrava
  // "fullscreen recusado pelo container, indo para a janela". O destino e o mesmo
  // `enter-window`; o que muda e que o app ainda registra o motivo que o
  // navegador devolveu, coisa que uma funcao pura nao teria. Este teste trava
  // essa decisao de projeto para ninguem reintroduzir um ramo morto.
  assert.equal(decideFullscreenAction(probe()).kind, 'enter-dom', 'a DECISAO so conhece a entrada')
  assert.ok(!('enter-window-after-dom-refused' in decideFullscreenAction(probe())))
})

test('ESC sai da tela cheia a partir do DOM, e nao do campo empurrado', () => {
  // O overlay decidia o ramo do ESC por um campo `fullscreen` que divergia do
  // estado real, e o ESC acabava no ramo que DERRUBA O VIDEO.
  assert.equal(escapeShouldExitFullscreen(elemento), true)
  assert.equal(escapeShouldExitFullscreen(null), false)
})

test('quando DOM e janela divergem, o DOM manda (foi medido no log)', () => {
  //   overlayAchaFullscreen: true, janelaRealFullscreen: false
  // O campo dizia que sim, `win.isFullScreen()` dizia que nao. A decisao usa o
  // DOM, que e leitura ao viva do navegador e nao envelhece.
  const r = decideFullscreenAction(
    probe({ documentFullscreenElement: elemento, windowFullscreen: false }),
  )
  assert.equal(r.kind, 'exit-dom', 'o DOM tem elemento em tela cheia, entao ha o que sair')
})

// ---------------------------------------------------------------------------
// O BUG QUE O USUARIO RELATOU: o botao entra e nao sai.
// ---------------------------------------------------------------------------

test('BOTAO: entra e depois sai, mesmo quando a entrada caiu na tela cheia da JANELA', () => {
  // A sequencia real, passo a passo, e o que o log deste app mostra:
  //
  //   clique 1 -> document.fullscreenElement null, wrapper montado
  //            -> enter-dom
  //            -> `requestFullscreen` RECUSADO (o log registra isso sempre)
  //            -> cai na tela cheia da JANELA
  //   agora: document.fullscreenElement CONTINUA null (janela nao passa pelo DOM)
  //          e windowFullscreen = true
  //
  // Antes deste ramo, o clique 2 via `enter-dom` de novo. Entrava para sempre.
  const passo1 = decideFullscreenAction(probe())
  assert.equal(passo1.kind, 'enter-dom', 'primeiro clique tenta o elemento')

  // Estado depois da recusa: nada no DOM, janela em tela cheia.
  const passo2 = decideFullscreenAction(probe({ windowFullscreen: true }))
  assert.equal(passo2.kind, 'exit-window', 'segundo clique tem de SAIR, nao entrar de novo')
})

test('BOTAO: sair pela janela funciona mesmo com o wrapper desmontado', () => {
  // O video parou, o wrapper sumiu. A camada da janela continua de pe, e o
  // botao ainda precisa sair. Com `playerMounted: false` e sem o ramo da
  // janela, a decisao cairia em `enter-window` e entraria de novo.
  const r = decideFullscreenAction(
    probe({ windowFullscreen: true, playerMounted: false, canRequestElementFullscreen: false }),
  )
  assert.equal(r.kind, 'exit-window')
})

test('ESC tambem sai da tela cheia da JANELA, e nao so do DOM', () => {
  // O relato do usuario: sair do video pela lista deixava o APLICATIVO em tela
  // cheia. O ESC so olhava o DOM, entao a camada da janela nao tinha saida.
  assert.equal(escapeShouldExitFullscreen(null, true), true, 'so a janela em tela cheia')
  assert.equal(escapeShouldExitFullscreen(null, false), false, 'nada em tela cheia')
  assert.equal(escapeShouldExitFullscreen(elemento, false), true, 'so o DOM')
  assert.equal(escapeShouldExitFullscreen(elemento, true), true, 'as duas camadas')
})

test('a camada da JANELA e lida, e nao o rotulo do botao', () => {
  // Este teste existe porque `isFs = domFs || winFs` e o que pinta o `is-active`
  // do botao. O status dizia "ativo" enquanto a decisao nao sabia da camada, e o
  // clique nao fazia nada. Aqui as duas coisas vem do mesmo parametro, entao
  // nao podem divergir.
  const rotuloAtivo = (p: FullscreenProbe) => Boolean(p.documentFullscreenElement) || p.windowFullscreen
  for (const p of [
    probe(),
    probe({ documentFullscreenElement: elemento }),
    probe({ windowFullscreen: true }),
    probe({ windowFullscreen: true, playerMounted: false }),
    probe({ playerMounted: false, canRequestElementFullscreen: false }),
  ]) {
    const ativo = rotuloAtivo(p)
    const r = decideFullscreenAction(p)
    if (ativo) {
      assert.ok(
        r.kind === 'exit-dom' || r.kind === 'exit-window',
        `rotulo ativo (${ativo}) mas a decisao mandou ${r.kind} — clicaria para entrar de novo`,
      )
    } else {
      assert.ok(
        r.kind === 'enter-dom' || r.kind === 'enter-window',
        `rotulo inativo mas a decisao mandou ${r.kind}`,
      )
    }
  }
})
