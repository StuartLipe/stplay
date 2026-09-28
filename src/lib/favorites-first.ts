/**
 * Favoritos primeiro, preservando a ordem relativa dentro de cada bloco.
 *
 * A lista "Todos" de canais ao vivo saia sem ordenacao nenhuma — era a ordem em
 * que o painel entregou os canais. Um canal favoritado no fim de 2.064 ficava
 * no fim de 2.064, o que anulava a pratica de favoritar: o atalho de acesso
 * rapido que o proprio app oferece.
 *
 * A particao e ESTAVEL de proposito. Um `sort()` com o favorito como criterio
 * embaralharia os 2.000 nao-favoritos a cada re-render e a cada clique em
 * qualquer botao, e o usuario perderia a posicao da lista a cada troca. Aqui os
 * favoritos sobem inteiros, na mesma ordem relativa, e o resto nao se move.
 */

/**
 * @param items      lista na ordem atual
 * @param isFavorite predicado; recebe o item e devolve se esta favoritado
 */
export function favoritesFirst<T>(items: readonly T[], isFavorite: (item: T) => boolean): T[] {
  const favorites: T[] = []
  const rest: T[] = []
  for (const item of items) {
    if (isFavorite(item)) favorites.push(item)
    else rest.push(item)
  }
  return favorites.length === 0 ? items.slice() : [...favorites, ...rest]
}

/** Atalho para o caso comum: lista de canais + conjunto de ids favoritados. */
export function favoritesFirstById<T extends { id: string }>(
  items: readonly T[],
  favoriteIds: readonly string[],
): T[] {
  if (favoriteIds.length === 0) return items.slice()
  const set = new Set(favoriteIds)
  return favoritesFirst(items, (item) => set.has(item.id))
}
