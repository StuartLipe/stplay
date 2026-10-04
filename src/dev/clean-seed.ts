/**
 * Limpa as playlists seed pelo storage legitimo do app.
 *
 * Uso: abrir no Electron com `?devCleanSeed=1`
 *
 * `seed-fiber-*` era o id do seed antigo, que criava uma playlist por endpoint.
 * As entradas viraram duplicata do que ja estava salvo, entao remover nao
 * perde nada: o host continua em `src/dev/saved-endpoints-data.ts` e no
 * `HOSTS-SERVIDORES.txt` da area de trabalho.
 *
 * Nada e escrito direto no leveldb: isso corromperia o log, porque a gravacao
 * tem tamanho diferente do registro antigo.
 */

import { loadActiveId, loadPlaylists, saveActiveId, savePlaylists } from '../lib/storage'

export function cleanSeedPlaylists(): { removed: string[]; total: number } {
  const current = loadPlaylists()
  const isSeed = (id: string) => String(id).startsWith('seed-')

  const keep = current.filter((p) => !isSeed(p.id))
  const removed = current.filter((p) => isSeed(p.id)).map((p) => p.name)

  if (removed.length === 0) return { removed, total: keep.length }

  savePlaylists(keep)

  // A playlist ativa pode ter sido a seed; cai para a primeira que sobrou.
  const active = loadActiveId()
  if (active && !keep.some((p) => p.id === active) && keep.length > 0) {
    saveActiveId(keep[0].id)
  }

  return { removed, total: keep.length }
}