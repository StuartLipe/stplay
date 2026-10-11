/** Pedidos grandes do catálogo (get_series / get_vod) partilham uma fila curta.
 *  get_series_info tem de saltar essa fila — senão os episódios esperam o dump. */
export function usesPanelQueue(url: string, opts?: { priority?: boolean }) {
  if (opts?.priority) return false
  if (/action=get_vod_info|action=get_series_info/i.test(url)) return false
  return /player_api\.php|\/get\.php/i.test(url)
}
