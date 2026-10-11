/**
 * NOVIDADES — o que mudou de verdade na versão que está instalada.
 *
 * Regra do dono, três partes:
 *
 * 1. A página mostra **o que mudou e onde**, nunca o detalhe. As áreas viram as
 *    linhas ("Mudanças no player"), e o que mudou fica dentro, atrás de um
 *    clique. A primeira versão desta página trazia um parágrafo por área e
 *    ninguém lia — o texto só confirmava o que o título já dizia.
 *
 * 2. O que entra aqui é o que a pessoa percebe. Nada de refatoração, nada de
 *    nome de arquivo, nada de "melhorias internas" como texto. Se não muda a tela
 *    ou o comportamento, não entra.
 *
 * 3. **A VERSÃO NÃO ESTÁ AQUI.** Ela vem do app, por prop, e este arquivo é
 *    carregado pelo renderer. Duas tentativas anteriores fracassaram por causa
 *    disso, e as duas ensinam a mesma coisa:
 *
 *      a) `versao: '1.0.3'` digitado aqui — o `package.json` foi para 1.0.2 e a
 *         tela passou a mostrar "1.0.3" no topo com "instalada" na nota antiga.
 *
 *      b) `createRequire` lendo o `package.json` — funciona em node, e QUEBRA no
 *         navegador: "Module node:module has been externalized for browser
 *         compatibility", no carregamento do módulo. O `try/catch` não salva,
 *         porque o `import` é içado antes do corpo da função.
 *
 *    Tirar o número do dado mata a classe inteira do bug: não existe mais
 *    segunda fonte pra divergir. A política do dono é uma versão só,
 *    substituível a cada build, então a entrada mais recente É a versão
 *    instalada, e o texto ao lado dela vem de `updaterStatus.current`.
 *
 * Os dados são versionados no app (não vêm de rede) por dois motivos: a página
 * funciona offline e não pode falhar por causa de um endpoint. O custo é que
 * uma nota nova só chega junto com um build novo — que é exatamente o momento em
 * que a pessoa ainda vai ler.
 */

export type GrupoNovidade = {
  /** O rótulo da LINHA, escrito como a pessoa falaria: "Mudanças no player". */
  nome: string
  itens: string[]
}

export type Novidade = {
  /** ISO `AAAA-MM-DD`. Só para ordenar e exibir; nada de parse de locale aqui. */
  data: string
  grupos: GrupoNovidade[]
  /**
   * Só para entradas ANTIGAS, se um dia existirem. A entrada mais recente nunca
   * usa isto: ela mostra a versão que o app informou.
   */
  versao?: string
}

export const NOVIDADES: Novidade[] = [
  {
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

/**
 * Mais nova primeiro, por data.
 *
 * Ordena por `versao` quando as duas entradas têm uma (entrada antiga), e cai
 * para a data quando nenhuma tem — que é o caso de hoje, com uma entrada só.
 * Ordenar por `versao` unconditionally quebrava assim que a segunda entrada
 * existisse sem número.
 */
export function novidadesOrdenadas(lista: Novidade[] = NOVIDADES): Novidade[] {
  return [...lista].sort((a, b) => {
    if (a.versao && b.versao) return compararVersoes(b.versao, a.versao)
    return b.data.localeCompare(a.data)
  })
}

/**
 * Existe novidade que a pessoa ainda não abriu?
 *
 * A entrada mais recente descreve a versão que está rodando — não existe uma
 * nota por versão. Então a pergunta é: tem conteúdo, e a versão do app é mais
 * nova do que a última que a pessoa abriu?
 *
 * `versaoAtual` nulo é dev sem status carregado: sem número não há como comparar,
 * e `false` é a resposta honesta. Com lista vazia também — não há o que ler.
 */
export function temNovidadeNaoVista(
  versaoAtual: string | null,
  vista: string | null,
  lista: Novidade[] = NOVIDADES,
): boolean {
  if (!versaoAtual) return false
  if (lista.length === 0) return false
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
