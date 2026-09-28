/** Qual playlist abrir: a última usada no perfil, senão a primeira. */
export function resolveLastPlaylistId(
  playlistIds: string[],
  savedActiveId: string | null | undefined,
  profileLastId?: string | null,
): string | null {
  if (profileLastId && playlistIds.includes(profileLastId)) return profileLastId
  if (savedActiveId && playlistIds.includes(savedActiveId)) return savedActiveId
  return playlistIds[0] ?? null
}

/** Reabre o app no último perfil, sem voltar à tela de escolha. */
export function shouldRestoreLastSession(profileId: string | null | undefined, profileIds: string[]) {
  return Boolean(profileId && profileIds.includes(profileId))
}
