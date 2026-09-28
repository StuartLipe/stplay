/** Só grava cache se o catálogo na tela for desta playlist. */
export function canPersistCatalog(ownerId: string | null | undefined, playlistId: string | null | undefined) {
  return Boolean(ownerId && playlistId && ownerId === playlistId)
}
