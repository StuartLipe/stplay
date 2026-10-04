/**
 * NOVIDADES — o que mudou de verdade em cada versão.
 *
 * Regra do dono, três partes:
 *
 * 1. A página mostra **o que mudou e onde**, nunca o detalhe. As áreas viram as
 *    linhas ("Mudanças no player"), e o que mudou fica dentro, atrás de um
 *    clique. A primeira versão desta página trazia um parágrafo por área e
 *    ninguém lia — o texto só confirmava o que o título já dizendo.
 *
 * 2. O que entra aqui é o que a pessoa percebe. Nada de refatoração, nada de
 *    nome de arquivo, nada de "melhorias internas" como texto. Se não muda a tela
 *    ou o comportamento, não entra.
 *
 * 3. A VERSÃO DA NOTA É A VERSÃO DO APP. A política do dono é uma versão só,
 *    substituível a cada build, e a primeiravez que este arquivo Written na mão
 *    saiu 1.0.3 com o app em 1.0.2: a página mostrou "1.0.3" no topo e marcou
 *    "instalada" na nota antiga. Por isso existe `versaoDoApp()` e o teste que
 *    compara esta constante com o `package.json` — o número é lido de um lugar
 *    só, e a nota não pode divergir dele.
 *
 * Os dados são versionados no app (não vêm de rede) por dois motivos: a página
 * funciona offline e não pode falhar por causa de um endpoint. O custo é que
 * uma nota nova só chega junto com um build novo — que é exatamente o momento em
 * que a pessoa ainda vai ler.
 */

import { createRequire } from 'node:module'

export type GrupoNovidade = {
  /** O rótulo da LINHA, escrito como a pessoa falaria: "Mudanças no player". */
  nome: string
  itens: string[]
}

export type Novidade = {
  versao: string
  /** ISO `AAAA-MM-DD`. Só para ordenar e exibir; nada de parse de locale aqui. */
  data: string
  grupos: GrupoNovidade[]
}

/**
 * Lê a versão do `package.json`.
 *
 * Em Vite o `import.meta.env` não é o caminho: este arquivo é importado por
 * teste em node puro, onde `import.meta.env` não existe. O `createRequire`
 * relativo ao próprio arquivo acha o `package.json` da raiz nos dois lados, e o
 * `try` cobre o caso em que nem isso resolve — aí a constante abaixo manda.
 */
function lerVersaoDoApp(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../../package.json') as { version?: string }
    if (pkg?.version) return pkg.version
  } catch {
    // Cai no valor declarado embaixo, que é o mesmo número.
  }
  return '1.0.2'
}

export const VERSAO_APP = lerVersaoDoApp()

export const NOVIDADES: Novidade[] = [
  {
    versao: VERSAO_APP,
    data: '2026-10-04',
    grupos: [
      {
        nome: 'Mudanças no player',
        itens: [
          'A tela de espera só some com quadro decodificado. Antes um temporizador de 6 s liberava a imagem e o filme começava com 3 s de buffer — era a gagueira.',
          'Continuar de onde parou abre direto no ponto salvo, em vez de o player ler o arquivo do começo a cada retomada.',
          'O ao vivo não trata mais a troca interna de origem como se fosse zape. Isso desligava o cache e acumulava minutos de atraso no canal.',
        ],
      },
      {
        nome: 'Mudanças na janela do player',
        itens: [
          'O vídeo não cobre mais o catálogo ao arrastar a janela.',
          'Sair da tela cheia não deixa o vídeo deslocado do lugar.',
          'Título que o servidor não tem agora é avisado em ~8 s, em vez de ficar carregando para sempre.',
        ],
      },
      {
        nome: 'Mudanças na interface',
        itens: [
          'O cursor some junto com os controles, na tela cheia.',
          'Favorito de filme e série é um coração na ficha.',
          'Esta página: Novidades, com o que mudou em cada versão.',
        ],
      },
    ],
  },
]

/** Chave do "já li até aqui". Guardar a VERSÃO, não um booleano: assim quem pula de 1.0.1 para 1.0.3 não vê aviso para o que nunca chegou a ler. */
const CHAVE_VISTA = 'stplay:novidades:vista'

/**
 * Compara versões `A.B.C` numericamente por segmento.
 *
 * String resolve errado em `1.0.10` vs `1.0.9` — "10" < "9" em alfabeto, então a
 * 1.0.10 seria vista como mais antiga que a 1.0.9 e o aviso nunca apareceria.
 * Segmento não numérico vira 0, que é o que um `-beta` sem número precisa.
 */
export function compararVersoes(a: string, b: string): number {
  const segA = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  const segB = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  const tamanho = Math.max(segA.length, segB.length)
  for (let i = 0; i < tamanho; i++) {
    const dif = (segA[i] ?? 0) - (segB[i] ?? 0)
    if (dif !== 0) return dif < 0 ? -1 : 1
  }
  return 0
}

/** Mais nova primeiro. Não muta o array original: o chamador pode passar a constante. */
export function novidadesOrdenadas(lista: Novidade[] = NOVIDADES): Novidade[] {
  return [...lista].sort((x, y) => compararVersoes(y.versao, x.versao))
}

/** A entrada da versão que está rodando, ou `null` se esta build não tem nota. */
export function novidadeDaVersao(versao: string, lista: Novidade[] = NOVIDADES): Novidade | null {
  return lista.find((n) => n.versao === versao) ?? null
}

/**
 * Existe novidade que a pessoa ainda não abriu?
 *
 * Em dev a versão é a do `package.json` e a lista pode não ter a nota — daí o
 * `null`: sem nota da versão corrente não existe o que avisar, e `false` é a
 * resposta honesta. Sem esse `null` o ponto apareceria para sempre num app de
 * desenvolvimento.
 */
export function temNovidadeNaoVista(
  versaoAtual: string | null,
  vista: string | null,
  lista: Novidade[] = NOVIDADES,
): boolean {
  if (!versaoAtual) return false
  const nota = novidadeDaVersao(versaoAtual, lista)
  if (!nota) return false
  if (!vista) return true
  return compararVersoes(versaoAtual, vista) > 0
}

/**
 * Lê/limpa o "já li até aqui".
 *
 * `Number(localStorage.getItem(...))` era a temptation: o valor é "10" e vira 10,
 * mas `"9"` também vira 9 e `"1.0.10"` vira NaN. String, e a comparação fica com
 * `compararVersoes`.
 */
export function lerNovidadeVista(): string | null {
  try {
    return globalThis.localStorage?.getItem(CHAVE_VISTA) ?? null
  } catch {
    // Modo privado / storage bloqueado: sem estado, e a página ainda funciona.
    return null
  }
}

export function marcarNovidadeVista(versao: string): void {
  try {
    globalThis.localStorage?.setItem(CHAVE_VISTA, versao)
  } catch {
    // Sem storage não há como lembrar; a página abre e mostra tudo mesmo assim.
  }
}

/** `2026-10-04` -> `4 de outubro de 2026`. Data já vem em ISO; parsear com `new Date` atrasa um dia em fusos negativos. */
export function formatarData(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number)
  if (!a || !m || !d) return iso
  const meses = [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ]
  return `${d} de ${meses[m - 1]} de ${a}`
}
