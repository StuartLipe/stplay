/**
 * REGRAS DE OCULTAR E RESTAURAR — a parte que nao depende de React.
 *
 * POR QUE ESTE ARQUIVO EXISTE: quase toda decisao aqui ja custou retrabalho uma
 * vez, e todas as regras estao escritas em um lugar so para poderem ser
 * testadas sem montar a tela inteira.
 *
 * O QUE ESTA FIXADO NESTE ARQUIVO, E POR QUE:
 *
 * 1. As quatro categorias DO APP nao podem ser ocultadas. Ocultar "Todos"
 *    deixaria a tela sem lista e sem volta. `podeOcultarCategoria` e o portao.
 *
 * 2. A coluna e filtrada PELOS OCULTADOS, nao so a grade. Ocultar so os itens
 *    deixa a categoria listada com contagem zero, e contagem zero parece um
 *    clique que nao funcionou — pior do que nao ter clicado.
 *
 * 3. A contagem dos botoes e calculada DEPOIS do filtro, pela mesma razao de (2).
 *
 * 4. Ocultar devolve a selecao para "Todos". A categoria ocultada some da coluna,
 *    e a selecao apontando para uma categoria invisivel e um estado sem saida.
 *
 * 5. Restaurar e sempre por ESCOLHA. "Restaurar tudo" direto e o pior dos dois
 *    jeitos: esconder um cartao por engano e levar outros junto nao tem como
 *    corrigir, porque o que sumiu nao tem mais nome em lugar nenhum.
 */

/** As quatro que sao do APP, nunca do servidor, e nunca podem ser ocultadas. */
export const CATEGORIAS_DO_APP = [
  'Todos',
  'Favoritos',
  'Continuar Assistindo',
  'Adicionado Recentemente',
] as const

/** A categoria neutra, para onde a selecao volta quando algo e ocultado. */
export const CATEGORIA_TODOS = 'Todos'

/** Comparacao sem acento e sem caixa: "continuar assistindo" e "Continuar Assistindo". */
function chave(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

const CHAVES_DO_APP = new Set(CATEGORIAS_DO_APP.map(chave))

/** Esta categoria e uma das quatro do app? */
export function ehCategoriaDoApp(group: string): boolean {
  return CHAVES_DO_APP.has(chave(group))
}

/** O botao "Ocultar categoria" pode aparecer para esta categoria? */
export function podeOcultarCategoria(group: string): boolean {
  if (!group) return false
  return !ehCategoriaDoApp(group)
}

/**
 * A coluna de categorias: some SO a categoria real que foi ocultada.
 *
 * As quatro pilhas do APP ficam sempre, porque elas nao sao do servidor e nao
 * podem ser ocultadas — se "Todos" sumisse da coluna, a tela ficaria sem lista e
 * sem volta. Quem desaparece e a categoria do servidor que a pessoa mandou
 * ocultar.
 *
 * O filtro usa o MESMO texto que a ocultacao guardou, e nao uma comparacao
 * "normalizada": o conjunto `ocultos` foi gravado com o nome como veio da tela,
 * e comparar de outra forma faria a categoria oculta escapar do filtro e voltar
 * a aparecer com contagem zero.
 */
export function categoriasVisiveis(groups: string[], ocultos: Set<string>): string[] {
  return groups.filter((group) => ehCategoriaDoApp(group) || !ocultos.has(group))
}

/**
 * A contagem que o botao da coluna mostra.
 *
 * `ocultosNoGrupo` e quantos itens AINDA estao guardados naquele grupo (isto e,
 * ja fora da grade). Sem desconto, a categoria apareceria com um numero que a
 * grade nao tem — e a pessoa contaria os cartoes e nao bateria.
 */
export function contarAposFiltro(total: number, ocultosNoGrupo: number): number {
  const visivel = total - Math.max(0, ocultosNoGrupo)
  return visivel > 0 ? visivel : 0
}

/* ------------------------------------------------------------------ */
/* Folha de restauracao                                                */
/* ------------------------------------------------------------------ */

export type Selecao = ReadonlySet<string>

/**
 * A chave de uma linha da folha.
 *
 * POR QUE O PREFIXO EXISTE: categoria e titulo sao listas separadas, e um id de
 * titulo pode ser IGUAL ao nome de uma categoria (`vod-1` de um lado, e o nome
 * de uma categoria "vod-1" do outro — nomes de categoria vem do servidor sem
 * restricao). Sem prefixo, marcar a categoria marcaria o titulo tambem, e o
 * "Restaurar 2" contaria duas coisas que a pessoa marcou uma.
 *
 * POR QUE A CHAVE E FUNCAO E NAO CONSTANTE NO COMPONENTE: a folha usava a chave
 * com prefixo na LINHA e o nome cru na lista de "marcar tudo". Medido no app:
 * `Marcar tudo` produzia `Restaurar 2` com UMA linha na tela, e o rotulo do
 * botao nunca concordava com a selecao — o clique marcava uma chave que nenhuma
 * linha consultava. Os testes da regra nao pegaram isso porque a funcao pura nao
 * sabe da chave: a divergencia nascia em dois lugares diferentes, e a funcao e o
 * unico jeito de nao ter dois lugares.
 */
export function chaveCategoria(grupo: string): string {
  return `g:${grupo}`
}

export function chaveTitulo(id: string): string {
  return `i:${id}`
}

/** Um alvo marcavel da folha, ja com a chave resolvida. */
export type Alvo = {
  chave: string
  tipo: 'categoria' | 'titulo'
  nome: string
  /** Categoria de origem do titulo, quando existe. */
  origem?: string
}

/**
 * Todos os alvos marcaveis, na ordem em que aparecem na folha: categorias
 * primeiro, depois titulos.
 *
 * A folha deriva AS DUAS coisas desta lista — as linhas e o alvo do "Marcar
 * tudo" — para que nao possam divergir.
 */
export function alvosMarcaveis(
  grupos: string[],
  ids: string[],
  grupoDoTitulo: (id: string) => string | undefined,
): Alvo[] {
  return [
    ...grupos.map((g) => ({ chave: chaveCategoria(g), tipo: 'categoria' as const, nome: g })),
    ...ids.map((id) => ({
      chave: chaveTitulo(id),
      tipo: 'titulo' as const,
      nome: id,
      origem: grupoDoTitulo(id),
    })),
  ]
}

/** Alterna um item. A linha inteira e o alvo, entao isto e o clique do botao. */
export function alternar(selecao: Selecao, id: string): Set<string> {
  const proxima = new Set(selecao)
  if (proxima.has(id)) proxima.delete(id)
  else proxima.add(id)
  return proxima
}

/**
 * "Marcar tudo" / "Desmarcar tudo".
 *
 * O rotulo do botao e decidido AQUI, e nao no JSX, porque o texto e a acao
 * sao o mesmo estado: marcar tudo quando ja esta tudo marcado vira desmarcar.
 */
export function alternarTudo(selecao: Selecao, todos: string[]): Set<string> {
  const marcado = todos.filter((id) => selecao.has(id)).length
  if (marcado === todos.length && todos.length > 0) return new Set()
  return new Set(todos)
}

/** O rotulo do botao de marcar/desmarcar. */
export function rotuloMarcarTudo(selecao: Selecao, todos: string[]): 'Marcar tudo' | 'Desmarcar tudo' {
  const marcado = todos.filter((id) => selecao.has(id)).length
  return marcado === todos.length && todos.length > 0 ? 'Desmarcar tudo' : 'Marcar tudo'
}

/**
 * O rotulo do botao principal.
 *
 * Sem nada marcado ele mostra SO "Restaurar", e desabilitado. Texto de
 * instrucao dentro de um botao desabilitado le como uma terceira acao — foi
 * esse o motivo de a instrucao ir para o subtitulo do cabecalho.
 */
export function rotuloRestaurar(quantos: number): string {
  return quantos > 0 ? `Restaurar ${quantos}` : 'Restaurar'
}

/** Quantas coisas estao ocultadas neste contexto. */
export function totalOculto(ocultos: { channels: string[]; groups: string[] }): number {
  return ocultos.channels.length + ocultos.groups.length
}

/** O botao "Restaurar" aparece? So quando existe algo oculto no contexto atual. */
export function deveMostrarRestaurar(ocultos: { channels: string[]; groups: string[] }): boolean {
  return totalOculto(ocultos) > 0
}

/**
 * Depois de restaurar, a selecao precisa voltar para "Todos"?
 *
 * Sim quando a categoria selecionada era uma das restauradas: o conteudo volta
 * para o armazenamento mas nao aparece na lista, e a pessoa conclui que o botao
 * nao funcionou.
 */
export function selecaoDeveVoltarParaTodos(
  selecionada: string,
  categoriasRestauradas: string[],
): boolean {
  if (!selecionada) return false
  if (ehCategoriaDoApp(selecionada)) return false
  return categoriasRestauradas.some((c) => chave(c) === chave(selecionada))
}

/* ------------------------------------------------------------------ */
/* Botao de duas linhas ("orgao de ocultos")                           */
/* ------------------------------------------------------------------ */

export type LinhasDoBotao = {
  /** Primeira linha, sempre "Ocultar categoria". */
  rotulo: string
  /** Segunda linha: o nome da categoria, em fonte pequena. */
  nome: string
  /** Nome completo, para `title` e `aria-label`. */
  completo: string
}

/**
 * O botao "Ocultar categoria" em duas linhas.
 *
 * Nao se escreve "Ocultar categoria NETFLIX" num botao de meia largura: ou a
 * fonte encolhe, ou o texto vaza. O nome completo vai no `title`/`aria-label`,
 * que e o que o leitor de tela le e o que o tooltip mostra.
 */
export function linhasDoBotaoOcultar(group: string): LinhasDoBotao {
  const rotulo = 'Ocultar categoria'
  return {
    rotulo,
    nome: group ?? '',
    completo: group ? `${rotulo}: ${group}` : rotulo,
  }
}

/**
 * O subtitulo do cabecalho: contagem + instrucao.
 *
 * O zero e um caso a parte porque o botao "Restaurar" e FIXO na barra de
 * ordenacao. Sem isso a folha vazia mandaria "toque para marcar o que volta"
 * numa lista sem nada — a pessoa marca a propria parede e conclui que o botao
 * quebrou.
 */
export function subtituloDoCabecalho(quantos: number): string {
  if (quantos === 0) return 'Nada oculto neste tipo de conteúdo'
  const n = quantos === 1 ? '1 item' : `${quantos} itens`
  return `${n} · toque para marcar o que volta`
}
