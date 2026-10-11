import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  blendOver,
  contrastRatio,
  deriveCustomTokens,
  hexToRgb,
  mixHex,
  normalizeHex,
  PANEL_TONES,
  panelToneColor,
  readability,
  relativeLuminance,
  surfaceRampFor,
  textDefaultFor,
  textRampFor,
  toneLiftFor,
} from './theme-tokens.ts'

// Os defaults dos seis temas, para provar que o derivador reproduz o que esta
// gravado no CSS. Se algum dia a conta do runtime divergir do que foi colado no
// stylesheet, estes testes acusam.
const AMOLED = { bg: '#000000', text: '#eef3ff' }
const MIDNIGHT = { bg: '#020617', text: '#eef3ff' }
const OCEAN = { bg: '#041018', text: '#eef3ff' }

describe('normalizeHex', () => {
  it('expande 3 digitos', () => {
    assert.equal(normalizeHex('#abc'), '#aabbcc')
  })
  it('aceita 6 digitos e caixa alta', () => {
    assert.equal(normalizeHex('#AABBCC'), '#aabbcc')
  })
  it('cai no fallback com lixo', () => {
    assert.equal(normalizeHex('nao e cor', '#123456'), '#123456')
    assert.equal(normalizeHex(''), '#000000')
  })
})

describe('mixHex', () => {
  it('p=1 devolve a primeira cor', () => {
    assert.equal(mixHex('#ff0000', '#0000ff', 1), '#ff0000')
  })
  it('p=0 devolve a segunda', () => {
    assert.equal(mixHex('#ff0000', '#0000ff', 0), '#0000ff')
  })
  it('p=.5 fica no meio', () => {
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080')
  })
})

describe('blendOver', () => {
  it('pesa o SEGUNDO argumento, que e o que entra', () => {
    // Tranca o significado. `mixHex` pesa o primeiro, e essa inversao ja
    // transformou uma superficie de 5% em 95%.
    assert.equal(blendOver('#000000', '#ffffff', 0.05), '#0d0d0d')
    assert.equal(blendOver('#000000', '#ffffff', 0.5), '#808080')
    assert.equal(blendOver('#000000', '#ffffff', 1), '#ffffff')
  })

  it('0 devolve a base intacta', () => {
    assert.equal(blendOver('#123456', '#ffffff', 0), '#123456')
  })

  it('e o que a busca binaria da rampa usa: 0 e o topo, 1 e o fundo', () => {
    // A inversao de peso da busca foi o bug mais caro da sessao: com `mixHex`
    // a busca rodava com os pesos trocados, `meio = 0` devolvia o FUNDO em vez
    // do topo, e a rampa colapsava. Este teste e a rede que impede a volta.
    const topo = '#eef3ff'
    const fundo = '#000000'
    assert.equal(blendOver(topo, fundo, 0), topo, 'meio 0 tem de ser o topo')
    assert.equal(blendOver(topo, fundo, 1), fundo, 'meio 1 tem de ser o fundo')
    // E o meio tem de ficar no meio, com contraste entre os extremos.
    const c = blendOver(topo, fundo, 0.5)
    assert.ok(contrastRatio(c, fundo) < contrastRatio(topo, fundo))
    assert.ok(contrastRatio(c, fundo) > contrastRatio(fundo, fundo))
  })
})

describe('contraste', () => {
  it('preto contra branco e 21:1', () => {
    assert.equal(Number(contrastRatio('#000000', '#ffffff').toFixed(2)), 21)
  })
  it('uma cor contra si mesma e 1:1', () => {
    assert.equal(Number(contrastRatio('#123456', '#123456').toFixed(2)), 1)
  })
  it('e simetrico', () => {
    assert.equal(contrastRatio('#101010', '#f0f0f0'), contrastRatio('#f0f0f0', '#101010'))
  })
})

describe('textRampFor', () => {
  it('o topo e a cor escolhida, sem mexer', () => {
    // Quem escolheu a letra escolheu a letra. Um degrau de contraste "para
    // melhorar" seria contrariar a escolha.
    const r = textRampFor(AMOLED.text, AMOLED.bg)
    assert.equal(r.textPrimary, AMOLED.text)
  })

  it('o topo nao e corrigido nem quando o contraste e ruim', () => {
    // O bug que a verificacao do cenario reportado pegou: `alvo: 99` deixava o
    // topo passar por `comPiso`, que o empurrava para cima. Escolhendo
    // `#c82d2d` (3.87:1 no preto) o app devolvia `#fefdfd` — a escolha da
    // pessoa era descartada em silencio.
    const r = textRampFor('#c82d2d', '#000000')
    assert.equal(r.textPrimary, '#c82d2d', 'a letra escolhida foi sobrescrita')
    assert.ok(contrastRatio(r.textPrimary, '#000000') < 4.5, 'o teste precisa de uma letra ruim mesmo')
  })

  it('o topo sobrevive a qualquer letra escolhida', () => {
    for (const letra of ['#ffffff', '#5a2a2a', '#00ff00', '#c82d2d', '#123456']) {
      assert.equal(textRampFor(letra, '#000000').textPrimary, letra, `topo alterado com ${letra}`)
    }
  })

  it('a rampa e monotonamente mais apagada', () => {
    for (const tema of [AMOLED, MIDNIGHT, OCEAN]) {
      const r = textRampFor(tema.text, tema.bg)
      const degraus = [r.textPrimary, r.textBody, r.textMuted, r.textFaint, r.textGhost]
      for (let i = 1; i < degraus.length; i += 1) {
        assert.ok(
          contrastRatio(degraus[i], tema.bg) < contrastRatio(degraus[i - 1], tema.bg),
          `${tema.bg}: degrau ${i} nao ficou mais apagado`,
        )
      }
    }
  })

  it('todo degrau passa do seu piso de contraste', () => {
    for (const tema of [AMOLED, MIDNIGHT, OCEAN]) {
      const r = textRampFor(tema.text, tema.bg)
      assert.ok(contrastRatio(r.textBody, tema.bg) >= 4.5, 'body abaixo de AA')
      assert.ok(contrastRatio(r.textMuted, tema.bg) >= 4.5, 'muted abaixo de AA')
      assert.ok(contrastRatio(r.textFaint, tema.bg) >= 3.5, 'faint abaixo do piso')
      assert.ok(contrastRatio(r.textGhost, tema.bg) >= 3.0, 'ghost abaixo do piso')
    }
  })

  // Estes valores sao os que estao LITERALMENTE no index.css, gerados pela
  // mesma funcao por scripts/dump-text-ramp.mjs. Eles antes divergiam em
  // 1/255 do runtime, de uma busca binaria com resolucao levemente diferente
  // entre o gerador e a versao que roda no app — invisivel a olho, mas fazia
  // "escolhi a letra" e "nao escolhi nada" produzirem cores diferentes.
  it('bate com a rampa que esta no CSS do amoled', () => {
    const r = textRampFor(AMOLED.text, AMOLED.bg)
    assert.equal(r.textPrimary, '#eef3ff')
    assert.equal(r.textBody, '#bfc4cd')
    assert.equal(r.textMuted, '#9ca0a7')
    assert.equal(r.textFaint, '#76787e')
    assert.equal(r.textGhost, '#616368')
  })

  it('bate com a rampa que esta no CSS do ocean', () => {
    const r = textRampFor(OCEAN.text, OCEAN.bg)
    assert.equal(r.textBody, '#c6ccd8')
    assert.equal(r.textMuted, '#a0a8b2')
    assert.equal(r.textFaint, '#77808a')
    assert.equal(r.textGhost, '#616a74')
  })

  it('acompanha um fundo claro em vez de quebrar', () => {
    // Fundo claro e letra clara: nao ha rampa possivel para o TOPO, que e
    // literal por decisao. O que importa e que os quatro degraus derivados
    // continuem DISTINTOS e ordenados.
    //
    // Nao se exige piso de contraste aqui, e nao por esquecimento: o par que a
    // pessoa escolheu ja e ilegivel e nenhum degrau conserta isso — a leitura de
    // contraste na UI e que avisa. Resolver por contraste dava os quatro
    // degraus no mesmo `#020202`, que e rampa nenhuma; razoes fixas dao
    // presenca.
    const r = textRampFor('#f0f0f0', '#ffffff')
    assert.equal(r.textPrimary, '#f0f0f0', 'o topo e literal')
    const derivados = [r.textBody, r.textMuted, r.textFaint, r.textGhost]
    assert.equal(new Set(derivados).size, 4, `degraus repetidos: ${derivados.join(' ')}`)
    // "ghost" e o mais fraco, e fraco e PROXIMIDADE ao fundo. Numa rampa invertida
    // o ghost acabaria com mais contraste que o primary num fundo claro.
    for (let i = 1; i < derivados.length; i += 1) {
      const a = relativeLuminance(derivados[i])
      const b = relativeLuminance(derivados[i - 1])
      // Fundo claro: mais fraco = mais proximo do fundo = MAIS CLARO.
      const fundoClaro = relativeLuminance('#ffffff') > relativeLuminance(derivados[0])
      assert.ok(
        fundoClaro ? a > b : a < b,
        `degrau ${i} nao segue a ordem de fraqueza: ${derivados.join(' ')}`,
      )
    }
  })

  it('o caso degenerado nao empilha os degraus', () => {
    // Regressao do binario saturado: os quatro saiam em `#020202`.
    const r = textRampFor('#f0f0f0', '#ffffff')
    assert.equal(new Set([r.textBody, r.textMuted, r.textFaint, r.textGhost]).size, 4)
  })

  it('acompanha uma letra escolhida fora da familia azul', () => {
    const r = textRampFor('#ffd166', '#000000')
    assert.equal(r.textPrimary, '#ffd166')
    for (const v of [r.textBody, r.textMuted, r.textFaint, r.textGhost]) {
      assert.ok(contrastRatio(v, '#000000') >= 3)
    }
  })
})

describe('surfaceRampFor', () => {
  it('as tres superficies ficam ACIMA da pagina', () => {
    const s = surfaceRampFor(AMOLED.bg)
    for (const v of [s.bgSurface, s.bgRail, s.borderSubtle]) {
      assert.ok(contrastRatio(v, s.bgBase) > 1, `${v} nao se destaca da pagina`)
    }
  })

  it('bgRail fica abaixo de bgSurface, e border acima dos dois', () => {
    const s = surfaceRampFor(MIDNIGHT.bg)
    const lp = relativeLuminance(s.bgBase)
    const lr = relativeLuminance(s.bgRail)
    const ls = relativeLuminance(s.bgSurface)
    const lb = relativeLuminance(s.borderSubtle)
    assert.ok(lr > lp, 'rail nao acima da pagina')
    assert.ok(ls > lr, 'surface nao acima de rail')
    assert.ok(lb > ls, 'borda nao acima de surface')
  })

  it('preserva o fundo escolhido literalmente', () => {
    assert.equal(surfaceRampFor('#123456').bgBase, '#123456')
  })

  it('preserva o matiz do fundo nas derivadas', () => {
    // Um fundo quente nao pode virar derivada azulada.
    const s = surfaceRampFor('#2a1a10')
    const [r, g, b] = hexToRgb(s.bgSurface)
    assert.ok(r > b, `derivada perdeu o matiz: ${s.bgSurface}`)
    assert.ok(g >= b)
  })

  it('NAO tinge a superficie com a cor da letra', () => {
    // O bug que o dono reportou: escolher a letra mudava a pagina. Com letra
    // vermelha, `bgSurface` e `borderSubtle` saiam vermelhos, porque a funcao
    // derivava as superficies misturando a LETRA no fundo. A superficie e o
    // fundo mais um pouco de LUZ; luz nao tem cor.
    const comAzul = surfaceRampFor('#000000',)
    const comVermelho = surfaceRampFor('#000000',)
    assert.equal(comAzul.bgSurface, comVermelho.bgSurface, 'a letra alterou a superficie')
    assert.equal(comAzul.borderSubtle, comVermelho.borderSubtle, 'a letra alterou a borda')
  })

  it('mudar a letra NAO muda nenhuma superficie', () => {
    // surfaceRampFor so recebe o fundo, entao a garantia e de assinatura. O
    // que precisa ser provado e o caminho completo, que e onde o bug aparecia:
    // deriveCustomTokens com letras diferentes, mesmo fundo.
    const fundo = '#000000'
    const primeira = deriveCustomTokens(fundo, '#eef3ff')
    for (const letra of ['#e82121', '#34d399', '#ffd166', '#ffffff', '#ad1a1a']) {
      const t = deriveCustomTokens(fundo, letra)
      assert.equal(t.bgSurface, primeira.bgSurface, `letra ${letra} alterou bgSurface`)
      assert.equal(t.bgRail, primeira.bgRail, `letra ${letra} alterou bgRail`)
      assert.equal(t.borderSubtle, primeira.borderSubtle, `letra ${letra} alterou a borda`)
    }
  })

  it('a superficie nao ganha tingimento novo', () => {
    // Nao se exige cor neutra: um fundo azul tem que dar superficie azul. O que
    // nao pode acontecer e a superficie ganhar matiz que o fundo nao tinha — que
    // e exatamente o que a cor da LETRA provocava.
    for (const fundo of ['#000000', '#020617', '#101b24', '#111318', '#2a1a10']) {
      const s = surfaceRampFor(fundo)
      const spread = (hex: string) => {
        const [r, g, b] = hexToRgb(hex)
        return Math.max(r, g, b) - Math.min(r, g, b)
      }
      const base = spread(fundo)
      for (const chave of ['bgSurface', 'bgRail', 'borderSubtle'] as const) {
        assert.ok(
          spread(s[chave]) <= base + 1,
          `${chave} ${s[chave]} ganhou tingimento que o fundo ${fundo} nao tem`,
        )
      }
    }
  })

  it('a superficie e exatamente neutra quando o fundo e', () => {
    // Com fundo preto puro nao ha cor herdada, entao o derivado tem de sair
    // cinza de verdade.
    const s = surfaceRampFor('#000000')
    const [r, g, b] = hexToRgb(s.bgSurface)
    assert.equal(Math.max(r, g, b) - Math.min(r, g, b), 0, `derivada ${s.bgSurface} tem matiz`)
  })

  it('escurece a superficie quando o fundo e claro', () => {
    // Fundo branco: subir a superficie brigaria com a letra. Ela tem de descer.
    const s = surfaceRampFor('#ffffff')
    assert.ok(relativeLuminance(s.bgSurface) < relativeLuminance(s.bgBase), 'nao desceu')
  })
})

describe('deriveCustomTokens', () => {
  it('devolve os dois conjuntos juntos', () => {
    const t = deriveCustomTokens('#041018', '#eef3ff')
    for (const k of [
      'bgBase',
      'bgSurface',
      'bgRail',
      'borderSubtle',
      'textPrimary',
      'textBody',
      'textMuted',
      'textFaint',
      'textGhost',
    ]) {
      assert.match(String(t[k as keyof typeof t]), /^#[0-9a-f]{6}$/, `${k} invalido`)
    }
  })

  it('a rampa usa o fundo derivdo, nao o cru', () => {
    // Se a rampa usasse o fundo cru, a superficie e a pagina divergiriam e o
    // contraste mostrado na UI mentiria.
    const t = deriveCustomTokens('#041018', '#eef3ff')
    assert.equal(relativeLuminance(t.bgSurface) > relativeLuminance(t.bgBase), true)
    assert.ok(contrastRatio(t.textGhost, t.bgSurface) > 0)
  })
})

describe('readability', () => {
  it('aprova um par com contraste bom', () => {
    const r = readability('#eef3ff', '#000000')
    assert.equal(r.ok, true)
    assert.equal(r.bodyOk, true)
    assert.ok(r.ratio > 15)
  })
  it('reprova letra quase igual ao fundo', () => {
    const r = readability('#1a1a1a', '#000000')
    assert.equal(r.ok, false)
    assert.equal(r.bodyOk, false)
  })
  it('distingue "grande texto" de "corpo"', () => {
    // `#666666` no preto da 3.66:1. Passa o piso de texto grande (3:1) e reprova
    // o de corpo (4.5:1). A primeira versao deste teste usou `#767676`, que da
    // 4.54:1 e PASSA em corpo - a premissa do teste estava errada, nao a funcao.
    const r = readability('#666666', '#000000')
    assert.equal(r.ok, false, 'nao deveria passar como corpo')
    assert.equal(r.bodyOk, true, 'deveria passar como texto grande')
  })
})

describe('cor de fundo escolhida', () => {
  // A paleta da secao "Cor de fundo". Cada uma tem que chegar intacta em
  // `bgBase` — e o token que PINTA A PAGINA. Sem isso o seletor mudava os
  // cartoes e deixava o fundo parado, que e o defeito que o dono viu.
  const FUNDOS = [
    '#0b0f1a',
    '#141414',
    '#0f172a',
    '#0b1a2b',
    '#0d1b14',
    '#1a0f1f',
    '#1f0f12',
    '#1c1710',
    '#e8eaf0',
  ]

  it('o fundo escolhido chega intacto no token que pinta a pagina', () => {
    for (const bg of FUNDOS) {
      assert.equal(
        deriveCustomTokens(bg, '#eef3ff').bgBase,
        bg,
        `${bg} nao chegou em bgBase — a pagina continuaria no tom do tema`,
      )
    }
  })

  it('cada fundo tem superficie e borda acima dele, nunca iguais', () => {
    for (const bg of FUNDOS) {
      const t = deriveCustomTokens(bg, '#eef3ff')
      assert.notEqual(t.bgSurface, t.bgBase, `${bg}: superficie colada no fundo`)
      assert.notEqual(t.borderSubtle, t.bgBase, `${bg}: borda colada no fundo`)
      assert.notEqual(t.borderSubtle, t.bgSurface, `${bg}: borda colada na superficie`)
    }
  })
})

describe('letra padrao derivada do fundo', () => {
  it('fundo escuro pede letra clara', () => {
    for (const bg of ['#0b0f1a', '#141414', '#0f172a', '#0b1a2b', '#0d1b14']) {
      assert.equal(
        readability(textDefaultFor(bg), bg).bodyOk,
        true,
        `${bg} com a letra derivada nao e legivel como corpo`,
      )
    }
  })

  it('fundo claro pede letra escura', () => {
    for (const bg of ['#e8eaf0', '#f4f6fb', '#ffffff']) {
      assert.equal(
        readability(textDefaultFor(bg), bg).bodyOk,
        true,
        `${bg} com a letra derivada nao e legivel como corpo`,
      )
    }
  })

  it('a letra do tema seria ILEGIVEL num fundo claro — por isso ela nao e herdada', () => {
    // Este e o defeito exato. `#eef3ff` e a letra de todos os temas escuros; num
    // fundo claro ela da 1.08:1. A pagina inteira virava um retangulo que nao se
    // le. E por isso que `applyCustomColorsToDocument` deriva a letra do fundo
    // quando ninguem escolheu uma.
    const letraDoTema = '#eef3ff'
    const r = readability(letraDoTema, '#e8eaf0')
    assert.equal(r.bodyOk, false, 'a premissa quebrou: a letra do tema passou a ser legivel')
    assert.ok(r.ratio < 1.5, `esperava contraste destruido, deu ${r.ratio}`)

    // E o caminho certo, lado a lado.
    assert.ok(readability(textDefaultFor('#e8eaf0'), '#e8eaf0').ratio > 10)
  })

  it('o par derivado tem os quatro degraus da rampa distintos', () => {
    // Uma rampa achatada e o jeito de a hierarquia sumir sem ninguem perceber:
    // todo texto vira a mesma cor. Com a letra derivada tem de continuar
    // separando titulo, corpo, apagado e fantasma.
    for (const bg of ['#0b0f1a', '#e8eaf0']) {
      const r = textRampFor(textDefaultFor(bg), bg)
      const degraus = [r.textPrimary, r.textBody, r.textMuted, r.textFaint, r.textGhost]
      assert.equal(
        new Set(degraus).size,
        degraus.length,
        `${bg}: a rampa de texto colapsou, ${degraus.join(' / ')}`,
      )
    }
  })
})

describe('o cinza dos paineis', () => {
  const FUNDOS = ['#0b0f1a', '#141414', '#0f172a', '#0b1a2b', '#0d1b14', '#1a0f1f', '#e8eaf0']

  it('sem cor escolhida o painel fica no derivado do tema', () => {
    for (const bg of FUNDOS) {
      assert.equal(
        deriveCustomTokens(bg, textDefaultFor(bg)).cardSurface,
        surfaceRampFor(bg).cardSurface,
        `${bg}: sem escolha o painel tem de ser o do tema`,
      )
    }
  })

  it('a cor escolhida vence o derivado', () => {
    // Este e o pedido: o cinza dos cartoes, do poster, do estado vazio e do
    // painel de download parou de ser fixo. Quem escolheu, escolheu.
    for (const painel of ['#2a2f3a', '#3a3f4a', '#101010', '#c8ccd4']) {
      const t = deriveCustomTokens('#0b0f1a', '#eef3ff', painel)
      assert.equal(t.cardSurface, painel, `o painel escolhido ${painel} nao chegou`)
    }
  })

  it('o painel escolhido sobrevive a um fundo trocado depois', () => {
    // Trocar o fundo refaz a derivacao inteira. Se o painel nao sobreviver, ele
    // e so valido na primeira combinacao e some na segunda — que e como o dono
    // perderia a escolha sem nenhum aviso.
    for (const fundo of ['#0b0f1a', '#0f172a', '#e8eaf0']) {
      assert.equal(
        deriveCustomTokens(fundo, textDefaultFor(fundo), '#2a2f3a').cardSurface,
        '#2a2f3a',
        `o painel se perdeu ao trocar o fundo para ${fundo}`,
      )
    }
  })

  it('o derivado bate com o que o CSS pinta', () => {
    // O CSS faz `--card-surface: color-mix(bg-surface 88%, tone-lift)`. Se o JS
    // disser um valor e o CSS pintar outro, o painel aparece com dois tons
    // diferentes: o das telas da app e o da foto da paleta. E nenhum dos dois
    // avisa, porque cada um esta "correto" sozinho.
    //
    // A conta do `color-mix` e feita AQUI, com aritmetica explicita, e nao
    // chamando um helper: um helper com o peso invertido passaria o teste
    // comparando duas expressoes erradas que concordam entre si.
    const colorMix = (a: string, pesoA: number, b: string) => {
      const A = hexToRgb(a)
      const B = hexToRgb(b)
      return A.map((v, i) => Math.round(v * pesoA + B[i] * (1 - pesoA)))
    }

    for (const bg of FUNDOS) {
      const s = surfaceRampFor(bg)
      const peloCss = colorMix(s.bgSurface, 0.88, toneLiftFor(bg))
      const peloJs = hexToRgb(s.cardSurface)
      const delta = Math.max(...peloCss.map((v, i) => Math.abs(v - peloJs[i])))
      // Tolerancia de 1/255: arredondamento de `color-mix` no navegador.
      assert.ok(
        delta <= 1,
        `${bg}: CSS diz rgb(${peloCss}) e o JS diz rgb(${peloJs}) — delta ${delta}`,
      )
    }
  })

  it('cada tom da paleta e distinto e vai subindo', () => {
    // Uma paleta com dois tons iguais e uma paleta que nao faz nada: o dono
    // clica e a tela nao muda.
    for (const bg of FUNDOS) {
      const cores = PANEL_TONES.map((t) => panelToneColor(bg, t.lift))
      assert.equal(
        new Set(cores).size,
        cores.length,
        `${bg}: tons repetidos, ${cores.join(' / ')}`,
      )
      const luminancias = cores.map(relativeLuminance)
      // A paleta tem de ser MONOTONICA: ou sobe inteiro ou desce inteiro, conforme
      // a polaridade do fundo. Um degrau parado no meio e um cartao que nao
      // responde ao clique.
      const subiu = luminancias[1] > luminancias[0]
      for (let i = 1; i < luminancias.length; i += 1) {
        assert.ok(
          (luminancias[i] > luminancias[i - 1]) === subiu,
          `${bg}: o tom ${i} quebrou a monotonicidade — ${cores.join(' / ')}`,
        )
      }
    }
  })

  it('os tons acompanham a polaridade do fundo', () => {
    // Num fundo escuro os tons clareiam; num claro eles escurecem. E o que faz
    // a paleta funcionar em qualquer tema em vez de virar a mesma lista de
    // cinzas que o dono reclamou de ver.
    for (const bg of ['#0b0f1a', '#0f172a', '#1a0f1f']) {
      const primeiro = relativeLuminance(panelToneColor(bg, PANEL_TONES[0].lift))
      const ultimo = relativeLuminance(panelToneColor(bg, PANEL_TONES[PANEL_TONES.length - 1].lift))
      assert.ok(ultimo > primeiro, `${bg}: no escuro a paleta tem de clarear`)
    }
    for (const bg of ['#e8eaf0', '#f4f6fb']) {
      const primeiro = relativeLuminance(panelToneColor(bg, PANEL_TONES[0].lift))
      const ultimo = relativeLuminance(panelToneColor(bg, PANEL_TONES[PANEL_TONES.length - 1].lift))
      assert.ok(ultimo < primeiro, `${bg}: no claro a paleta tem de escurecer`)
    }
  })

  it('os tons acima do "Seco" se separam da pagina; o "Seco" nao', () => {
    // A premissa original era "o painel sempre se separa da pagina". O dono
    // pediu o contrario — "deixa os cartao seco sem nada" — e a medicao no app
    // confirmou que o degrau, e nao uma sombra, era o que ele via:
    // `border=0px`, `outline=0px`, `shadow=none` nos tres cartoes.
    //
    // Entao o tom `Seco` (lift 0) tem de ser EXATAMENTE a cor da pagina, e os
    // demais continuam se separando. `lift > 0` e o que faz a hierarquia
    // existir; `lift === 0` e o cartao sem nada.
    for (const bg of FUNDOS) {
      const pagina = surfaceRampFor(bg).bgSurface
      for (const t of PANEL_TONES) {
        const painel = panelToneColor(bg, t.lift)
        const delta = Math.max(
          ...hexToRgb(pagina).map((v, i) => Math.abs(v - hexToRgb(painel)[i])),
        )
        if (t.lift === 0) {
          assert.equal(
            delta,
            0,
            `${bg} no tom "${t.label}": lift 0 tem de dar a MESMA cor da pagina, deu delta ${delta}`,
          )
        } else {
          assert.ok(
            delta >= 3,
            `${bg} no tom ${t.label}: painel colado na pagina (delta ${delta})`,
          )
        }
      }
    }
  })
})
