const test = require('node:test')
const assert = require('node:assert/strict')

const { detectarAberturaNoPcm, _internos } = require('./anime-abertura.cjs')

const { HOP, TAXA } = _internos

/** Gera PCM mono com uma "abertura" marcada entre dois instantes. */
function pcmComAbertura({ totalS = 420, aberturaInicio = 80, aberturaFim = 135, semente = 7 }) {
  const n = Math.round(totalS * TAXA)
  const pcm = new Float32Array(n)
  let ruido = semente
  const proximo = () => {
    ruido = (ruido * 1103515245 + 12345) & 0x7fffffff
    return (ruido / 0x7fffffff) * 2 - 1
  }

  for (let i = 0; i < n; i++) {
    const t = i / TAXA
    const naAbertura = t >= aberturaInicio && t < aberturaFim

    if (naAbertura) {
      // Baixo (60 Hz) + medio (400 Hz) forte e continuo: musica.
      const baixo = 0.55 * Math.sin(2 * Math.PI * 60 * t)
      const medio = 0.22 * Math.sin(2 * Math.PI * 400 * t)
      pcm[i] = baixo + medio + 0.02 * proximo()
    } else {
      // Dialogo: voz dispersa, com pausas, e pouca energia grave.
      const pausa = Math.sin(2 * Math.PI * 0.35 * t) > -0.2 ? 1 : 0.06
      const voz = 0.1 * Math.sin(2 * Math.PI * 900 * t) + 0.06 * Math.sin(2 * Math.PI * 1500 * t)
      pcm[i] = pausa * (voz + 0.05 * proximo())
    }
  }
  return pcm
}

/** Gera PCM sem nenhuma abertura: dialogue o tempo todo. */
function pcmSemAbertura({ totalS = 420, semente = 11 }) {
  const n = Math.round(totalS * TAXA)
  const pcm = new Float32Array(n)
  let ruido = semente
  const proximo = () => {
    ruido = (ruido * 1103515245 + 12345) & 0x7fffffff
    return (ruido / 0x7fffffff) * 2 - 1
  }
  for (let i = 0; i < n; i++) {
    const t = i / TAXA
    const pausa = Math.sin(2 * Math.PI * 0.31 * t) > -0.15 ? 1 : 0.05
    const voz = 0.11 * Math.sin(2 * Math.PI * 850 * t) + 0.05 * Math.sin(2 * Math.PI * 1700 * t)
    pcm[i] = pausa * (voz + 0.04 * proximo())
  }
  return pcm
}

/** Gera o perfil medido do Naruto S01E01: sem abertura, mas com pico isolado. */
function pcmComPicoIsolado() {
  const pcm = pcmSemAbertura({ semente: 13 })
  const inicio = 340
  const fim = 352
  for (let i = Math.round(inicio * TAXA); i < Math.round(fim * TAXA); i++) {
    const t = i / TAXA
    pcm[i] = 0.6 * Math.sin(2 * Math.PI * 70 * t) + 0.2 * Math.sin(2 * Math.PI * 420 * t)
  }
  return pcm
}

const perto = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} nao esta perto de ${b} (tol ${tol})`)

test('acha a abertura e devolve o intervalo', () => {
  const achado = detectarAberturaNoPcm(pcmComAbertura({}))
  assert.ok(achado, 'deveria achar a abertura')
  // A detecção arredonda para a janela de suavização, então a folga é de ~3s.
  perto(achado.inicio, 80, 6)
  perto(achado.fim, 135, 6)
})

test('acha a abertura que começa mais tarde no episodio', () => {
  // Ataque dos Titans S01E01: a abertura comeca por volta de 1:20.
  const achado = detectarAberturaNoPcm(pcmComAbertura({ aberturaInicio: 82, aberturaFim: 138 }))
  assert.ok(achado)
  perto(achado.inicio, 82, 6)
  perto(achado.fim, 138, 6)
})

test('devolve null quando o episodio nao tem abertura', () => {
  // Naruto Shippuden S01E01: sem abertura. Este e o caso que a AniSkip errava,
  // mostrando "pular abertura" num episodio que nao tem.
  assert.equal(detectarAberturaNoPcm(pcmSemAbertura({})), null)
})

test('ignora pico de alta energia que dura pouco', () => {
  // Uma cena de luta de 12s nao e abertura. So vira se for longa e grave.
  assert.equal(detectarAberturaNoPcm(pcmComPicoIsolado()), null)
})

test('ignora silencio absoluto', () => {
  assert.equal(detectarAberturaNoPcm(new Float32Array(Math.round(420 * TAXA))), null)
})

test('a deteccao escala com o volume', () => {
  // O detector normaliza pela energia maxima, entao a mesma forma tem de dar
  // o mesmo intervalo em ganho baixo.
  const base = pcmComAbertura({})
  const baixo = Float32Array.from(base, (v) => v * 0.05)
  const a = detectarAberturaNoPcm(base)
  const b = detectarAberturaNoPcm(baixo)
  assert.ok(a && b)
  perto(b.inicio, a.inicio, 3)
  perto(b.fim, a.fim, 3)
})

test('devolve null em audio curto demais para ter abertura', () => {
  assert.equal(detectarAberturaNoPcm(pcmComAbertura({ totalS: 20, aberturaInicio: 2, aberturaFim: 10 })), null)
})

test('HOP e a taxa sao coerentes', () => {
  assert.equal(Math.round(TAXA * HOP), 160)
})