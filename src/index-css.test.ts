import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const aqui = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(aqui, 'index.css'), 'utf8')
const linhas = css.split('\n')

/**
 * Reconstrói a profundidade de chaves linha a linha, ignorando comentario e
 * string, e devolve o índice de toda linha que está em profundidade 0.
 */
function profundidades(): number[] {
  let prof = 0
  return linhas.map((bruta) => {
    const limpa = bruta
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .trim()
    for (const ch of limpa) {
      if (ch === '{') prof += 1
      if (ch === '}') prof -= 1
    }
    return prof
  })
}

test('o CSS fecha toda chave que abre', () => {
  // A contagem bruta de chaves e o teste mais burro que existe: casa um `{`
  // dentro de um comentario com uma chave de verdade. A profundidade por linha
  // separa os dois.
  const prof = profundidades()
  assert.equal(prof[prof.length - 1], 0, 'o arquivo terminou com chave aberta ou a mais')
  assert.ok(!prof.includes(-1), 'alguma fecha chave antes de abrir')
})

test('nenhuma declaracao ficou fora de um bloco', () => {
  // O defeito mais silencioso que existe em CSS: a declaracao solta entre duas
  // regras. O build passa, o verificador passa, e o navegador simplesmente
  // descarta a linha — a transicao que se pensou ter escrito nunca pega.
  // Ja aconteceu duas vezes nesta folha.
  const prof = profundidades()
  const orfas: string[] = []
  linhas.forEach((bruta, i) => {
    if (prof[i] !== 0) return
    const limpa = bruta.trim()
    if (!limpa) return
    // seletor e at-rule abrem com chave; declaracao nao. Uma linha em
    // profundidade 0 sem chave e que comeca por propriedade e uma orfa.
    if (bruta.includes('{')) return
    if (/^[a-zA-Z-]+(\s*,\s*[a-zA-Z-]+)*\s*:/.test(limpa)) orfas.push(`linha ${i + 1}: ${limpa}`)
  })
  assert.deepEqual(orfas, [], 'declaracao fora de bloco e descartada pelo navegador em silencio')
})

test('nenhum seletor caiu dentro de outro bloco', () => {
  // O bug mais caro desta folha, e o unico que NENHUMA contagem de chave pega:
  // as chaves abrem e fecham do mesmo jeito, o build passa, o validador de
  // estrutura passa, e o navegador descarta as regras porem ser declaracoes
  // invalidas dentro de um bloco.
  //
  // Aconteceu com a familia `.panel-tone*`, que foi inserida logo abaixo da
  // linha do seletor vizinho: caiu dentro de `.shell-bg-options {` e dentro de
  // um `@media`. O sintoma e so visual — os botoes sem grade, sem amostra, com
  // o rotulo colado no texto ao lado.
  //
  // A regra: um seletor so pode estar dentro de um bloco se TODOS os blocos
  // abertos forem at-rule. Dentro de `@media` faz sentido; dentro de outro
  // seletor, nao.
  //
  // O scanner passa caractere a caractere em vez de empilhar por linha. Empilhar
  // por linha erra no seletor de multiplas linhas — `.a,` numa linha e `.b {` na
  // seguinte abrem UM bloco, e quem empilha por linha empilha dois e desempilha
  // um, deixando lixo na pilha e acusando metade da folha.
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pilha: { linha: number; texto: string; atRule: boolean }[] = []
  const offenses: string[] = []
  let seletor = ''
  let linhaDoSeletor = 1

  semComentario.split('\n').forEach((bruta, i) => {
    const n = i + 1
    for (const ch of bruta) {
      if (ch === '{') {
        const nome = seletor.trim()
        seletor = ''
        const atRule = nome.startsWith('@')
        if (!atRule) {
          const dentroDeSeletor = pilha.filter((b) => !b.atRule)
          if (dentroDeSeletor.length > 0) {
            const dentro = dentroDeSeletor[dentroDeSeletor.length - 1]
            offenses.push(
              `linha ${n}: "${nome}" esta dentro de "${dentro.texto}" (linha ${dentro.linha})`,
            )
          }
        }
        pilha.push({ linha: linhaDoSeletor, texto: nome, atRule })
        linhaDoSeletor = n
      } else if (ch === '}') {
        pilha.pop()
        seletor = ''
      } else if (ch === ';') {
        seletor = ''
      } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
        if (!seletor) linhaDoSeletor = n
        seletor += ch
      }
    }
  })

  assert.deepEqual(pilha, [], 'sobrou bloco aberto no fim do arquivo')
  assert.deepEqual(
    offenses,
    [],
    'seletor dentro de outro seletor vira declaracao invalida e e descartado pelo navegador',
  )
})

test('todo hover declarado tem uma transicao em algum lugar', () => {
  // Um `:hover` sem `transition` nao e uma animacao, e um salto. Cada bloco que
  // declara hover precisa ter a transicao no proprio bloco base ou num ancestral
  // — aqui conferimos o caso comum, os dois seletores na mesma regra base.
  const pares: [string, string][] = [
    ['.accent-swatch', '.accent-swatch:hover'],
    ['.shell-bg-option', '.shell-bg-option:hover'],
    ['.appearance-folder-toggle', '.appearance-folder-toggle:hover'],
    ['.theme-option', '.theme-option:hover'],
  ]
  for (const [base, hover] of pares) {
    const i = linhas.findIndex((x) => x.trim() === `${base} {`)
    assert.ok(i >= 0, `${base} nao existe`)
    let fim = i
    while (fim < linhas.length && linhas[fim].trim() !== '}') fim += 1
    assert.ok(
      linhas.slice(i, fim).some((x) => x.includes('transition')),
      `${base} declara hover mas nao tem transition — vira salto, nao animacao`,
    )
    assert.ok(linhas.some((x) => x.trim().startsWith(hover)), `${hover} nao existe`)
  }
})

test('nenhum overlay que cobre tudo tem fundo opaco', () => {
  // O defeito do cartao "Continuar assistindo": um overlay `inset: 0` com fundo
  // opaco, que so aparece no hover. Ele cobre a imagem inteira e o cartao vira
  // um retangulo cinza no exato momento em que a pessoa passa o mouse para
  // olhar a capa. Foi assim em `.home-continue-play` e em
  // `.series-ep-play-overlay`.
  //
  // A excecao e o video do player, que PRECISA ser preto, e o overlay de erro,
  // que precisa ser opaco para nao dar a entender que o video continua.
  const EXCECOES = ['player-wrap', 'player-error-overlay', 'detail-tint-scrim']

  const opaco = (valor: string) => {
    if (!valor) return false
    if (/var\(--poster-scrim/.test(valor)) return false
    if (valor.includes('transparent')) return false
    const alfa = valor.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/)
    if (alfa) return Number(alfa[1]) >= 0.95
    return true
  }

  const blocos: { sel: string; corpo: string }[] = []
  const pilha: { sel: string; ini: number }[] = []
  let seletor = ''
  linhas.forEach((bruta, i) => {
    for (const ch of bruta) {
      if (ch === '{') {
        seletor = seletor.trim()
        if (seletor) pilha.push({ sel: seletor, ini: i })
        seletor = ''
      } else if (ch === '}') {
        const b = pilha.pop()
        if (b) blocos.push({ sel: b.sel, corpo: linhas.slice(b.ini, i).join('\n') })
        seletor = ''
      } else if (ch === ';') seletor = ''
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') seletor += ch
    }
  })

  const ofensas: string[] = []
  for (const b of blocos) {
    if (!/position:\s*absolute/.test(b.corpo)) continue
    if (!/inset:\s*0/.test(b.corpo)) continue
    if (EXCECOES.some((x) => b.sel.includes(x))) continue
    const fund = b.corpo
      .split('\n')
      .map((x) => x.trim())
      .find((x) => /^(background|background-color):/.test(x))
    if (!fund) continue
    const valor = fund.split(':').slice(1).join(':').trim()
    if (opaco(valor)) ofensas.push(`${b.sel} -> ${valor}`)
  }

  assert.deepEqual(
    ofensas,
    [],
    'overlay `inset: 0` com fundo opaco cobre a imagem e some com a capa no hover',
  )
})

test('os botoes do hero continuam sendo pilula com flex e transicao', () => {
  // Regressao que eu causei: o script procurou `.home-hero-ghost {` e casou a
  // SEGUNDA LINHA do seletor agrupado
  //
  //     .home-hero-play,
  //     .home-hero-ghost {     <-- casou aqui
  //
  // que e a continuacao do bloco BASE de layout. O corpo do ghost foi escrito por
  // cima e `display`, `gap`, `border-radius: 999px`, `padding`, `cursor`,
  // `font-size`, `font-weight` e a `transition` sumiram de uma vez. Os tres
  // botoes ficaram retangulares, sem pílula.
  //
  // Nenhum teste pegou: as chaves continuaram fechando, o build passou, e o
  // sintoma e so visual. Por isso a lista e explicita.
  const i = linhas.findIndex((x) => x.trim() === '.home-hero-play,')
  assert.ok(i >= 0, 'o bloco base dos botoes do hero nao existe')
  assert.equal(
    linhas[i + 1].trim(),
    '.home-hero-ghost {',
    'o seletor do hero tem de continuar agrupado em duas linhas',
  )

  let fim = i
  while (fim < linhas.length && linhas[fim].trim() !== '}') fim += 1
  const base = linhas.slice(i, fim + 1).join('\n')

  for (const precisa of [
    'display: inline-flex',
    'align-items: center',
    'gap: 7px',
    'border-radius: 999px',
    'border: 1px solid transparent',
    'padding: 11px 16px',
    'cursor: pointer',
    'font-size: 13px',
    'font-weight: 700',
    'transition:',
  ]) {
    assert.ok(base.includes(precisa), `o bloco base do hero perdeu "${precisa}"`)
  }

  // E nenhum seletor do cluster pode estar duplicado: a duplicata foi o que
  // deixou a regra antiga de `filter: brightness()` valendo por cima da nova.
  for (const sel of [
    '.home-hero-play {',
    '.home-hero-play:hover {',
    '.home-hero-ghost {',
    '.home-hero-ghost:hover {',
  ]) {
    // A continuacao do seletor agrupado (`.home-hero-ghost {` na linha DEPOIS de
    // `.home-hero-play,`) conta como uma ocorrencia, e e proposital: e assim que
    // se declara o bloco base de layout dos dois. Sem essa ressalva o teste acusa
    // o agrupamento — que e a forma correta — em vez da duplicata, que e o defeito.
    const n = linhas.filter(
      (x, k) => x.trim() === sel && !(sel === '.home-hero-ghost {' && k === i + 1),
    ).length
    assert.equal(n, 1, `${sel} aparece ${n}x; a ultima ganha e a antiga fica por baixo`)
  }
})

test('nenhum hover aponta para o mesmo fundo do seu descanso', () => {
  // A armadilha mais chata: a regra de hover existe, pega o mouse, e nao
  // desenha nada porque repete o valor de descanso. Foi assim no
  // `.appearance-folder-toggle` e no `.shell-bg-option`.
  const casos: [string, string][] = [
    ['.appearance-folder', '.appearance-folder-toggle:hover'],
    ['.shell-bg-option', '.shell-bg-option:hover'],
  ]
  for (const [base, hover] of casos) {
    const i = linhas.findIndex((x) => x.trim() === `${base} {`)
    let fim = i
    while (fim < linhas.length && linhas[fim].trim() !== '}') fim += 1
    const descanso = linhas
      .slice(i, fim)
      .map((x) => x.trim())
      .find((x) => x.startsWith('background:'))

    const j = linhas.findIndex((x) => x.trim() === `${hover} {`)
    assert.ok(j >= 0, `${hover} nao existe`)
    let fim2 = j
    while (fim2 < linhas.length && linhas[fim2].trim() !== '}') fim2 += 1
    const sobre = linhas
      .slice(j, fim2)
      .map((x) => x.trim())
      .find((x) => x.startsWith('background:'))

    assert.ok(sobre, `${hover} nao declara background`)
    assert.notEqual(
      sobre,
      descanso,
      `${hover} repete o fundo de descanso de ${base} — o hover nao desenha diferenca`,
    )
  }
})

test('o cartao de recomendacao tem hover e foco, e nada mais', () => {
  // A fileira "Porque voce assistiu" era a unica da home sem hover nenhum: nem
  // transicao, nem levante, nem botao de favoritar. A regra existe para travar
  // as tres coisas, porque as tres ja faltaram.
  const bloco = (sel: string) => {
    const i = linhas.findIndex((x) => x.trim() === sel)
    assert.ok(i >= 0, `${sel} nao existe`)
    let fim = i
    while (fim < linhas.length && linhas[fim].trim() !== '}') fim += 1
    return linhas.slice(i, fim + 1).join('\n')
  }

  const card = bloco('.home-rec-card {')
  assert.ok(card.includes('transition:'), '.home-rec-card nao tem transicao — o hover vira salto')
  assert.ok(
    bloco('.home-rec-card:hover {').includes('translateY'),
    '.home-rec-card:hover nao levanta',
  )
  assert.ok(
    bloco('.home-rec-card:focus-visible {').includes('outline'),
    'card sem foco visivel: e um `div` com borda 0, entao o anel do navegador some',
  )

  // O play tem de ser scrim. Um fundo opaco aqui apagaria a capa no hover — foi
  // exatamente o defeito do "Continuar assistindo".
  const play = bloco('.home-rec-play {')
  assert.ok(
    play.includes('--poster-scrim'),
    'o overlay de play precisa de scrim translucido, senao cobre a capa',
  )

  // O coracao NAO pode voltar nesta fileira. O dono pediu para tirar, e a
  // medicao no app confirmou por que ele via "sombra": o botao era o UNICO
  // descendente dos cartoes que desenhava borda —
  //
  //   <button.poster-fav-btn.poster-heart-btn> 20x20@70,7
  //     border=1.11px solid rgba(255, 255, 255, 0.16)
  //
  // Um fio de 16% de branco num cartao escuro, que e o unico anel claro que
  // existia ali. Os cartoes em si mediram `border=0px`, `outline=none`,
  // `shadow=none`, com a imagem ocupando o container exato em `0,0`.
  const coracao = linhas.filter((x) =>
    /home-rec-(poster|card)[^{]*\.(poster-fav-btn|poster-heart-btn)/.test(x),
  )
  assert.deepEqual(
    coracao,
    [],
    'o coracao de favoritar saiu da fileira de recomendacao a pedido do dono — nao volta',
  )
})
