/**
 * Um registro por numero de episodio, preferindo o `id` MAIOR.
 *
 * Painéis XUI devolvem o mesmo episodio varias vezes com `id` diferentes, e apenas
 * um deles tem arquivo no disco. Medido em `Brave 10 [L]` (series_id 44008):
 *
 *   S01E01  id=1607372  -> /series/.../1607372.mp4  200 text/html  (404 do painel)
 *   S01E01  id=2187891  -> /series/.../2187891.mp4  200 video/mp4 (ftypisom)
 *   S01E02  id=2187892  -> funciona
 *   S01E02  id=1607373  -> 404
 *
 * O `id` menor e sempre o quebrado, e vem PRIMEIRO na resposta. Sem esta
 * deduplicacao o app abre o episodio, cai na pagina de erro HTML e passa por
 * `.mp4 -> .mkv -> .avi -> .ts -> http -> ffmpeg` do MESMO id morto antes de
 * desistir.
 *
 * A regra e "um registro por episodio, id maior vence", que e a ordem observada
 * na medicao. O painel nao expoe qual id tem arquivo (o `direct_source` vem
 * vazio), entao a escolha e por essa ordem — e nao por sondar a rede, que
 * custaria uma requisicao por episodio so para montar a lista.
 *
 * Vive em arquivo proprio, e nao em `xtream.ts`, porque `xtream.ts` importa
 * `./m3u` sem extensao e o runner (`node --test --experimental-strip-types`) nao
 * resolve isso — o teste morria no import antes de rodar.
 */
export function dedupeEpisodesByNumber<T extends { id?: unknown; episode_num?: unknown }>(
  episodes: T[],
): T[] {
  const best = new Map<string, T>()
  const passthrough: T[] = []
  for (const ep of episodes) {
    const num = Number(ep?.episode_num)
    if (!Number.isFinite(num) || num <= 0) {
      passthrough.push(ep)
      continue
    }
    const key = String(num)
    const held = best.get(key)
    if (!held) {
      best.set(key, ep)
      continue
    }
    best.set(key, Number(ep.id) > Number(held.id) ? ep : held)
  }
  return [...best.values(), ...passthrough]
}