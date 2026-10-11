import type { DownloadedItem } from '../types'

/**
 * Identidade de um download.
 *
 * O `id` do download era o `id` cru do canal: `vod-5000` num painel, e
 * `vod-5000` no outro tambem. O id do catalogo so e unico DENTRO de um painel.
 * E o `playlistId` existia no tipo `DownloadedItem` desde o comeco e nunca era
 * preenchido em lugar nenhum.
 *
 * O que quebrava com isso:
 *
 *  1. `handleStartDownload` filtra a lista por `d.id !== item.id && d.url !==
 *     item.url` antes de inserir. Baixar o VOD 5000 do painel B removia da lista
 *     o download ja concluido do painel A — sem apagar o arquivo do disco. O
 *     app esquecia de um arquivo que continuava la, ocupando espaco.
 *
 *  2. No processo principal os jobs vivem num `Map` chaveado pelo id. Dois jobs
 *     com o mesmo id ocupam a mesma chave: o `Pausar` e o `Remover` matam o
 *     processo errado, e o `onProgress` de um job sobrescreve a barra do outro.
 *
 *  3. Filme e episodio nunca colidiam porque os ids do catalogo ja vem
 *     namespaced (`vod-`, `ep-`, `series-`). O que faltava era o namespace do
 *     painel, entao o problema era invisivel enquanto o usuario usava um painel
 *     so — que e como todo mundo comeca.
 *
 * A regra e um namespace explicito, com o painel dentro. E o mesmo criterio do
 * `continue-matching.ts`: comparar depois de tirar o prefixo seria empate entre
 * `vod-5000` e `series-5000`, e trocar o download de um pelo outro seria pior do
 * que o botao nao fazer nada.
 */

const KIND_SEGMENT: Record<DownloadedItem['kind'], string> = {
  movie: 'movie',
  series: 'series',
}

/**
 * Id canonico de um download, namespaced por painel.
 *
 * @param playlistId perfil/playlist dono do catalogo. Ausente ou vazio devolve
 *                   `null`: sem painel nao ha identidade confiavel, e inventar
 *                   uma seria pior do que recusar.
 * @param kind       'movie' | 'series'
 * @param rawId      id do canal no catalogo do painel
 */
export function downloadIdFor(
  playlistId: string | undefined | null,
  kind: DownloadedItem['kind'],
  rawId: string | undefined | null,
): string | null {
  const pid = String(playlistId ?? '').trim()
  const rid = String(rawId ?? '').trim()
  if (!pid || !rid) return null
  return `dl:${pid}:${KIND_SEGMENT[kind] ?? kind}:${rid}`
}

/** Extrai o namespace de um id canonico, ou `null` se ele for legado. */
export function downloadIdScope(
  id: string | undefined | null,
): { playlistId: string; kind: DownloadedItem['kind']; rawId: string } | null {
  const m = /^dl:([^:]+):(movie|series):(.+)$/.exec(String(id ?? '').trim())
  if (!m) return null
  return { playlistId: m[1], kind: m[2] as DownloadedItem['kind'], rawId: m[3] }
}

/**
 * `true` quando `a` e `b` apontam para o MESMO download.
 *
 * Tolera o item legado. Um download salvo pelo 1.0.6 tem `id: 'vod-5000'` cru e
 * `playlistId` ausente; o canonico tem `dl:painel:movie:vod-5000`. Sem essa
 * tolerancia, o primeiro retry depois da atualizacao criaria uma linha duplicada
 * em vez de reaproveitar a que ja existia — o usuario veria o mesmo filme duas
 * vezes na lista, e apagar uma deixaria a outra apontando para o mesmo arquivo.
 *
 * A url so entra como recurso de LEGADO. Quando os dois lados tem namespace, o
 * id manda e a url nunca e consultada: dois paineis distintos servem o mesmo
 * VOD pelo mesmo host com frequencia, e casar pela url fundiria dois downloads de
 * owners diferentes — que e o defeito que este modulo existe para impedir. O
 * primeiro rascunho fazia a checagem pela url sempre, e o proprio teste
 * "separa quando so o id coincide mas a url nao" reprovou o codigo.
 */
export function sameDownloadTarget(
  a: Pick<DownloadedItem, 'id' | 'url'> | null | undefined,
  b: Pick<DownloadedItem, 'id' | 'url'> | null | undefined,
): boolean {
  if (!a || !b) return false
  if (a.id && a.id === b.id) return true

  const scopeA = downloadIdScope(a.id)
  const scopeB = downloadIdScope(b.id)
  if (scopeA && scopeB) {
    // Dois ids canonicos ja carregam o dono. Se chegaram ate aqui sao
    // diferentes, e a url compartilhada nao prova o contrario.
    return false
  }

  // Pelo menos um dos lados e legado: a url e a unica ponte que sobrou.
  return Boolean(a.url && b.url && a.url === b.url)
}

/** Remove da lista todo download que aponta para o mesmo alvo de `target`. */
export function withoutDownloadTarget(
  items: DownloadedItem[],
  target: Pick<DownloadedItem, 'id' | 'url'>,
): DownloadedItem[] {
  return items.filter((item) => !sameDownloadTarget(item, target))
}

/** `true` se o item foi persistido por uma versao que nao usava namespace. */
export function isLegacyDownloadId(id: string | undefined | null): boolean {
  return !downloadIdScope(id)
}

/** Status que o processo principal nao consegue retomar depois de um reinicio. */
const ORPHANED = new Set<NonNullable<DownloadedItem['status']>>(['downloading', 'queued'])

/**
 * Reconcilia a lista persistida contra o que o processo principal realmente
 * sabe.
 *
 * A lista vive no localStorage do renderer; os jobs vivos vivem num `Map` do
 * processo principal, que morre com o app. Entao qualquer linha salva como
 * `downloading` ou `queued` e um ZUMBI: o main nao tem o job, o `Pausar` e o
 * `Continuar` resolvem contra um Map vazio e nao fazem nada, e a barra fica
 * congelada para sempre com o cabecalho contando "1 ativo".
 *
 * Aqui elas viram `error`, que e retryavel. A alternativa — deixar como esta, ou
 * descartar a linha — transformava um fechamento de app no meio de um download
 * em um item que so a lista de downloads conseguia tirar, sem nenhum caminho
 * para retomar.
 *
 * Devolve a MESMA referencia quando nada mudou, para o efeito de persistencia
 * nao gravar um byte novo a cada mount.
 */
export function reconcileDownloads(items: DownloadedItem[]): DownloadedItem[] {
  let changed = false
  const next = items.map((d) => {
    if (!d.status || !ORPHANED.has(d.status)) return d
    changed = true
    return {
      ...d,
      status: 'error' as const,
      speed: 0,
      error: 'Download interrompido quando o app foi fechado. Tente de novo.',
    }
  })
  return changed ? next : items
}

/**
 * Recorta a lista no teto, preservando os itens mais recentes.
 *
 * Sem teto ela so cresce: um job que falha fica para sempre, e cada linha
 * carrega nome, logo e mensagem de erro. O `localStorage.setItem` estava dentro
 * de um `catch` vazio, entao o estouro de cota era engolido em silencio — e a
 * partir dai TODO o estado de download se perdia a cada reinicio, sem aviso.
 */
export function capDownloads(items: DownloadedItem[], max = 100): DownloadedItem[] {
  return items.length > max ? items.slice(0, max) : items
}
