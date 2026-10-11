/**
 * Tokens de tema derivados de duas cores escolhidas pelo dono.
 *
 * A rampa de texto estava gravada como hex literal em cada bloco de tema. Isso
 * funciona enquanto a cor da letra vier do tema, mas quebra no primeiro minuto
 * em que a pessoa escolhe a propria: `--text-primary` mudaria e os quatro
 * degraus abaixo continuariam nos valores do tema, com um contraste sem sentido
 * entre eles.
 *
 * Aqui a rampa e CALCULADA a partir de `--text-primary` e do fundo, e o
 * contraste e o criterio. E a mesma conta que `derive-text-ramp.mjs` fez para
 * gerar os valores padrao — so que agora roda em runtime, quando a cor muda.
 *
 * Duas cores sao a entrada de proposito: fundo e letra. O acento tem o seu
 * proprio caminho (`applyAccentToDocument` / `accentInkFor`), e duplicar a conta
 * abriria uma divergencia.
 */

export type Ramp = {
  textPrimary: string
  textBody: string
  textMuted: string
  textFaint: string
  textGhost: string
}

export type SurfaceRamp = {
  bgBase: string
  bgSurface: string
  bgRail: string
  borderSubtle: string
  /** O cinza dos painéis: cartões, pôster, estado vazio, painel de download. */
  cardSurface: string
}

export type CustomTokens = SurfaceRamp & Ramp

/** Os degraus da rampa: [chave, contraste alvo, piso de legibilidade]. */
const DEGRAUS: Array<[keyof Ramp, number, number]> = [
  // `alvo: 99` marca o topo, que sai literal e nao passa por busca nenhuma.
  ['textPrimary', 99, 4.5],
  ['textBody', 12, 4.5],
  ['textMuted', 8, 4.5],
  ['textFaint', 4.8, 3.5],
  ['textGhost', 3.5, 3.0],
]

export function normalizeHex(value: string, fallback = '#000000'): string {
  const raw = String(value || '').trim()
  const curto = raw.match(/^#([0-9a-fA-F]{3})$/)
  if (curto) {
    const [a, b, c] = curto[1]
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase()
  }
  const cheio = raw.match(/^#([0-9a-fA-F]{6})$/)
  if (cheio) return `#${cheio[1]}`.toLowerCase()
  return fallback.toLowerCase()
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1)
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Mistura `a` por `p` e `b` por `1 - p`, em sRGB — igual ao `color-mix` do CSS. */
export function mixHex(a: string, b: string, p: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  return rgbToHex([
    ca[0] * p + cb[0] * (1 - p),
    ca[1] * p + cb[1] * (1 - p),
    ca[2] * p + cb[2] * (1 - p),
  ])
}

/**
 * `quantidade` de `sobre` entra por cima de `base`.
 *
 * Existe porque `mixHex` pesa o PRIMEIRO argumento, e isso ja inverteu uma
 * chamada: `mixHex(base, tinta, 0.05)` devolvia 95% de tinta, e a superficie
 * derivada saia quase branca. O significado esta travado no teste
 * "blendOver pesa o segundo argumento".
 */
export function blendOver(base: string, sobre: string, quantidade: number): string {
  return mixHex(sobre, base, quantidade)
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}


/**
 * A luz usada para levantar uma superficie acima do fundo.
 *
 * Branco para fundo escuro, preto para fundo claro. E o mesmo valor do
 * `--tone-lift` do CSS, e precisa ser a MESMA regra: se o JS e o CSS discordarem
 * sobre o que e clarear, a superficie derivada em runtime e a do stylesheet
 * ficam diferentes e a troca de fundo aparece meio caminho.
 *
 * O `--tone-lift` substituiu `--text-primary` em `--card-surface`,
 * `--surface-raised` e `--poster-scrim-border`. Essas tres regras usavam a cor
 * da LETRA como se fosse luz, e com letra vermelha 12% dela em cada card
 * deixava a pagina inteira vermelha — o sintoma de escolher a letra e ver o
 * tema mudar junto.
 */
export function toneLiftFor(bgBase: string): string {
  return relativeLuminance(normalizeHex(bgBase, '#0b0f1a')) < 0.5 ? '#ffffff' : '#000000'
}

/**
 * Rampa de cinco degraus derivada da cor de letra contra o fundo.
 *
 * O topo sai LITERAL: quem escolheu a letra escolheu a letra, e a leitura de
 * contraste na UI e que informa o preco.
 *
 * Os quatro degraus derivados tem dois casos, e a forma da busca e OPOSTA em
 * cada um — errar isso erra nos dois:
 *
 *   normal: o topo ja passa do alvo. O degrau escurece em direcao ao fundo e a
 *           busca acha onde o contraste chega no alvo. O contraste DECRECE com
 *           a mistura, entao o predicado e verdadeiro no COMECO.
 *
 *   ruim: o topo nao passa do alvo (letra clara em fundo claro). Nao existe
 *           nada entre "nao legivel" e "mais nao legivel", entao o degrau e
 *           empurrado para LONGE do fundo. O contraste CRESCE com a mistura,
 *           entao o predicado e verdadeiro no FIM.
 *
 * A versao anterior usava o mesmo predicado nos dois casos: no normal devolvia
 * o topo em todos os degraus, e no ruim devolvia preto em todos.
 */
export function textRampFor(textPrimary: string, bgBase: string): Ramp {
  const topo = normalizeHex(textPrimary, '#eef3ff')
  const fundo = normalizeHex(bgBase, '#0b0f1a')
  const out = {} as Ramp

  for (const [chave, alvo] of DEGRAUS) {
    if (chave === 'textPrimary') {
      out.textPrimary = topo
      continue
    }

    if (contrastRatio(topo, fundo) >= alvo) {
      let lo = 0
      let hi = 1
      for (let i = 0; i < 24; i += 1) {
        const meio = (lo + hi) / 2
        if (contrastRatio(blendOver(topo, fundo, meio), fundo) > alvo) lo = meio
        else hi = meio
      }
      out[chave] = blendOver(topo, fundo, hi)
      continue
    }

    // Caso degenerado: a letra escolhida nao passa do alvo contra o fundo, e
    // nao existe nada entre "nao legivel" e "mais nao legivel" — resolver por
    // contraste aqui saturava os quatro degraus no mesmo quase-preto
    // (`#020202` quatro vezes), que e rampa nenhuma.
    //
    // Entao neste caso a rampa usa RAZOES FIXAS em direcao ao FUNDO. Isso
    // preserva a semantica do degrau: "ghost" e o mais fraco, e fraco e
    // proximidade ao fundo, seja o fundo claro ou escuro. Misturar para longe do
    // fundo daria a ordem invertida num fundo claro — o "ghost" com mais
    // contraste que o "primary".
    //
    // O resultado nao bate o piso de contraste, e nao deveria: o par escolhido
    // ja e ilegivel e nenhum degrau conserta isso. O que importa e que os quatro
    // continuem distintos e ordenados, para a hierarquia sobreviver. A leitura
    // de contraste na UI e que avisa do preco.
    const RAZOES: Record<string, number> = {
      textBody: 0.3,
      textMuted: 0.52,
      textFaint: 0.7,
      textGhost: 0.86,
    }
    out[chave] = blendOver(topo, fundo, RAZOES[chave])
  }
  return out
}

/**
 * A letra que o tema deveria usar com um fundo escolhido.
 *
 * Só entra quando a pessoa escolheu FUNDO e não escolheu letra. Sem isto, um
 * fundo claro herdava a letra clara do tema e o par saía em 1.08:1 — a página
 * inteira virava um retângulo impossível de ler. A letra do tema é a resposta
 * certa para o fundo do tema e a errada para qualquer outro.
 *
 * A polaridade do fundo decide: quase preto pede letra clara, quase branco
 * pede letra escura. Os dois tons ficam longe o bastante das bordas para a
 * rampa derivada ter os quatro degraus distintos.
 */
export function textDefaultFor(bgBase: string): string {
  const base = normalizeHex(bgBase, '#0b0f1a')
  return relativeLuminance(base) < 0.5 ? '#eef3ff' : '#14161c'
}

/**
 * Os tons do painel, e o cinza que o dono pediu para escolher.
 *
 * O que ele viu era o `--card-surface`: o fundo de `.favorites-panel`, de
 * `.poster-card`, do "Selecione um canal" e do painel de downloads. Este era o
 * cinza fixo, e nao o fundo da pagina — a confissao que o dono corrigiu.
 *
 * Os tons sao expressos como quanto de LUZ entra, e nao como cores absolutas.
 * E o que faz a paleta funcionar em qualquer tema: o painel "Bem claro" num
 * tema escuro e num tema claro tem de ficar claro em relacao a SUA pagina, e
 * nao virar a mesma cor nos dois. Guardar o hex final continua sendo simples —
 * o que muda e de onde ele sai.
 */
export type PanelTone = {
  label: string
  hint: string
  /** Quanto de clareador entra por cima da superficie do tema. */
  lift: number
}

export const PANEL_TONES: PanelTone[] = [
  // `lift: 0` e o unico tom que NAO levanta nada: o painel fica exatamente na
  // cor da pagina. E o que o dono pediu ao dizer "deixa os cartao seco sem
  // nada" — o que ele estava vendo era o degrau entre a moldura e o conteudo,
  // e nao uma sombra em cartao nenhum (a medicao no app deu `border=0px`,
  // `outline=0px`, `shadow=none` nos tres cartoes).
  { label: 'Seco', hint: 'Igual à página, sem nada', lift: 0 },
  { label: 'Discreto', hint: 'Quase igual à página', lift: 0.05 },
  { label: 'Marcado', hint: 'Um degrau acima', lift: 0.11 },
  { label: 'Forte', hint: 'Bem separado', lift: 0.2 },
  { label: 'Bem claro', hint: 'Painel em destaque', lift: 0.32 },
]

/** O hex de um tom, calculado contra a superficie do tema que estiver valendo. */
export function panelToneColor(bgBase: string, lift: number): string {
  const base = normalizeHex(bgBase, '#0b0f1a')
  return blendOver(blendOver(base, toneLiftFor(base), 0.05), toneLiftFor(base), lift)
}

/**
 * As tres superficies derivadas do fundo.
 *
 * A primeira versao derivava daqui da COR DA LETRA, e isso tingia a pagina
 * inteira. O clareador e o `--tone-lift`, a mesma coisa que o CSS usa.
 *
 * Os percentuais sao pequenos de proposito: `--bg-surface` e `--bg-rail` ficam
 * logo acima da pagina, e `--border-subtle` e uma linha, nao um painel. O que da
 * a superficie elevada ja e `color-mix` em cima destes no CSS.
 */
export function surfaceRampFor(bgBase: string): SurfaceRamp {
  const base = normalizeHex(bgBase, '#0b0f1a')
  const clareador = toneLiftFor(base)
  return {
    bgBase: base,
    bgSurface: blendOver(base, clareador, 0.05),
    bgRail: blendOver(base, clareador, 0.02),
    borderSubtle: blendOver(base, clareador, 0.11),
    // `--card-surface` e o cinza dos paineis. O CSS faz
    // `color-mix(bg-surface 88%, tone-lift)`, que e 12% de clareador: o mesmo
    // numero, escrito do outro lado, para o JS e o CSS concordarem.
    cardSurface: blendOver(blendOver(base, clareador, 0.05), clareador, 0.12),
  }
}

/**
 * Tudo junto, que e o que a UI aplica no documento.
 *
 * O `panel` e a cor escolhida para o cinza dos paineis. Sem ele, o painel fica
 * no derivado — que e o certo, porque quem nao escolheu quer o tema. Com ele, a
 * escolha vence: quem escolheu a cor escolheu a cor, e o piso de contraste de
 * um painel nao e o de um texto.
 */
export function deriveCustomTokens(bg: string, text: string, panel?: string): CustomTokens {
  const superficie = surfaceRampFor(bg)
  const cardSurface = panel ? normalizeHex(panel, superficie.cardSurface) : superficie.cardSurface
  return { ...superficie, cardSurface, ...textRampFor(text, superficie.bgBase) }
}

/**
 * Leitura de contraste para a UI mostrar enquanto a pessoa escolhe.
 *
 * `null` nunca: a UI usa `ok` (acima de 4.5:1) e `bodyOk` (acima de 3:1) para
 * avisar, nunca para bloquear. Quem escolhe a cor escolhe a cor.
 */
export function readability(text: string, bg: string): {
  ratio: number
  ok: boolean
  bodyOk: boolean
} {
  const ratio = contrastRatio(normalizeHex(text, '#000000'), normalizeHex(bg, '#ffffff'))
  return {
    ratio: Number(ratio.toFixed(2)),
    ok: ratio >= 4.5,
    bodyOk: ratio >= 3,
  }
}
