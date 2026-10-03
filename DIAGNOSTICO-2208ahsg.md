# Diagnóstico — painel 2208ahsg.top

Data: 2026-10-01
Escopo: app `st` (React + Vite + Electron) contra o painel Xtream do usuário.

## Resumo

O app **não** sofria de bloqueio do painel, Cloudflare, DNS ou User-Agent.
A causa era **rate limit (HTTP 429) em rajada**, combinada com **timeout
ausente na carga da playlist**.

Ambos corrigidos. Suíte: 264 testes passando, build limpo.

## O que foi descartado

| Hipótese | Verificação | Resultado |
| --- | --- | --- |
| Cloudflare bloqueando | `curl` direto + headers de cliente | HTTP 200 em ambos os esquemas |
| IP liberado / whitelist | `allowed_ips` na resposta da API | `null` — sem restrição |
| DNS do servidor | `nslookup` em 8.8.8.8 | resolve; TLS válido |
| User-Agent | curl com e sem `VLC/3.0.20` | idêntico (200) |
| Conta expirada | `auth` / `status` | `1` / `Active` |
| Timeout de rede | endpoints grandes | 9,1 MB em 4 s; 7,7 MB em 2,5 s |

## Causa 1 — 429 em rajada (principal)

Medido em `get_live_streams`, requisições repetidas:

```
tentativa 1 -> HTTP 429
tentativa 2 -> HTTP 200
tentativa 3 -> HTTP 200
...          -> HTTP 200
```

O painel **não envia `Retry-After`**. `retryWaitMs()` caía no piso de 4 s e o
retry só fazia 3 tentativas. Com `PANEL_MAX = 2`, a carga de catálogo dispara
6+ requests de uma vez, estoura a cota, e tudo falha junto.

Correções em `src/lib/proxy.ts`:

- `PANEL_MAX`: `2` → `1` (serializa a rajada)
- `PANEL_MIN_GAP_MS = 350` (espaça requests ao mesmo painel)
- `maxAttempts`: `3` → `6`
- backoff sem `Retry-After`: piso de 4 s → 2 s

Validação com a lógica corrigida, contra o painel real:

```
get_vod_categories   OK  HTTP 200  tentativas=1
get_series_categories OK HTTP 200  tentativas=1
get_live_categories  OK  HTTP 200  tentativas=1
get_live_streams     OK  HTTP 200  tentativas=1
get_vod_streams      OK  HTTP 200  tentativas=1
get_series           OK  HTTP 200  tentativas=1
6/6 em 8s
```

## Causa 2 — timeout ausente na playlist

`loadXtreamFullM3u()` chamava `fetchText()` **sem** `timeoutMs`, heredando o
padrão em vez de `PANEL_LARGE_TIMEOUT_MS` (240 s).

A playlist deste painel tem **99,5 MB / 334.014 canais / 668.031 linhas** e leva
~91 s só no download. O fetch abortava no meio e a falha aparecia como
"playlist vazia" — sintoma, não causa.

Correção em `src/lib/xtream.ts`: passa `PANEL_LARGE_TIMEOUT_MS` nas duas
chamadas (`ts` e fallback `m3u8`).

Bench do parser contra a playlist real:

```
entrada : 99.5 MB
read    : 223 ms
parse   : 435 ms
canais  : 334.014
grupos  : 103
heap    : 110 MB
TOTAL   : 658 ms   (limite: 240000 ms)
```

Parsing não é gargalo. O timeout era.

## Instrumentação adicionada

Você pediu ajuda para logar sem saber como. Três pontos:

**`src/lib/proxy.ts`** — nova função `logNet()`. Escreve no console do renderer
**e** em `%APPDATA%\ST PLAY\internal-debug.log` (via `internalDebug`), que já
existia. Cobre: request OK, request falhado, espera por rate limit, exaustão de
tentativas, tamanho de resposta, JSON inválido.

**`electron/main.cjs`** — loga cada `proxy upstream ok` / `proxy upstream
falhou` com status, `content-length`, content-type e duração.

Como ver:

```powershell
Get-Content "$env:APPDATA\ST PLAY\internal-debug.log" -Tail 60
```

Procure `[net]` (renderer) e `proxy upstream` (main).

## Verificações

```
npx tsc -b     exit 0
node --check electron/main.cjs   exit 0
npm test        264 pass / 0 fail
npm run build   exit 0
```

Lint: 1 warning pré-existente em `main.cjs` (`shell` não usado), não
introduzido aqui.

## Observação

`max_connections: 2` na conta. Fechar o app oficial durante o teste evita
disputar cota, mas **não** era a causa — o teste com 4 requests simultâneas
passou após a serialização.

## Não resolvido aqui

`rplaydigital.online` está **NXDOMAIN** (também no 8.8.8.8). Esse servidor do
mesmo dono está fora do ar; não há o que configurar no app.

---

# Complemento — credencial 508313420 (host ggfiberpre.fun)

## Como o host foi encontrado

O fornecedor informou `rplaydigital.online` como DNS dessa credencial. Esse
domínio morreu (NXDOMAIN até no 8.8.8.8), mas o app do fornecedor (`com.fiber.ibo`,
v3.9) continuava autenticando — porque usa **outro host**, salvo no aparelho.

Sem root no dispositivo, o caminho foi o logcat: o app usa OkHttp, que loga cada
requisição no nível INFO. `adb logcat` expõe a URL completa.

```powershell
adb logcat -c
adb shell monkey -p com.fiber.ibo -c android.intent.category.LAUNCHER 1
adb logcat -d | Select-String "player_api"
```

Host: **`ggfiberpre.fun`**. O pacote real do app é `com.xplay.ibotv`
(`com.fiber.ibo` é só o alias de instalação); ele embute `com.mega.flix` e a
classe `Xtream-Codes-Api`, mas **nenhum host** — a config vem do aparelho.

## Validação do host contra o app

Mesmo caminho do app (headers do proxy, throttling novo, timeout 240s):

```
autenticacao   auth=1  status=Active  allowed_ips=undefined  max_conn=2
               server_info.url=mdrive.meuserver.sbs  porta=80
categorias     live 36 | vod 38 | series 26
dumps          live_streams  1.752 itens    0,6MB   0s
               vod_streams  45.082 itens   16,5MB   5s
               series        9.902 itens    9,7MB   4s
playlist       80,8MB em 97s -> 337.375 canais em 628ms | 94 grupos
stream real    HTTP 200
```

**Nenhuma alteração de código foi necessária.** O host entra em
`Host/DNS` no app e a credencial funciona.

## 39 filmes sem nome (dado do painel, não bug)

0,087% do catálogo. O painel devolve `tvg-name=""` e `name=null` em
`get_vod_streams` para 39 de 45.082 itens — confirmado também em
`get_vod_info`. Ou seja: o dado não existe na origem, e a API oficial não o
recupera.

O app não quebra: `id` cai no fallback `${group}::${name}::${url}`, que é único
por URL. Aparecem listados sem título. Corrigível só com o painel fornecendo o
nome.