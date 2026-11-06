## ST PLAY 1.0.7

Repositório em https://github.com/StuartLipe/stplay

### Gaveta de saga no player de filme

- O drawer do player de filme agora agrupa os filmes da mesma franquia em **blocos de saga**, em ordem de lançamento.
- Franchias que têm **duas séries** (Star Wars: a trilogia "Episódio I–III" e a série "Star Wars 2–8") aparecem separadas, com aviso **"outra saga desta franquia"** sobre o bloco lateral — assim o próximo capítulo nunca é confundido com um spin-off.
- **Dublado / Legendado** virou filtro de áudio único (um marcado por vez), vale para a lista e para a Continuação. A aba **"Continuação"** virou um botão liga/desliga.
- O agrupamento deixa de fora obras que só parecem da franquia: parody adulto (`[XXX] Barbie Cunnings`), *dublado* do próprio filme (`Star Wars Biornas`), duplicatas 4K e títulos de outra categoria.

### Popup de próximo capítulo

- Aparece **sobre a barra de tempo** quando falta pouco para o fim e existe um próximo capítulo, como na Netflix e na Crunchyroll.
- Funciona para **filme** (próximo da saga) e para **série** (próximo episódio, ou o primeiro da temporada seguinte).
- Botões **Começar** e **Agora não** — dispensar não deixa a oferta voltar sozinha.

### Busca e categorias

- A **busca agora respeita a categoria selecionada**: em ANIMAÇÃO, os resultados são só de animação (antes vinham filmes de ação e comédia).

### Continuar assistindo

- A linha volta com **o que foi visto por último** no topo, e trocar de categoria leva o scroll ao topo em vez de herdar o offset da anterior.

### Correções

- Nomes de filme longos aparecem inteiros no drawer (sem corte com reticências).
- Capa que falha deixa o espaço vazio em vez do ícone de imagem quebrada.
- Conteúdo adulto não entra na lista de continuação quando a proteção parental está trancada.
- Volume não é mais aplicado em duplicado ao arrastar o controle.

## Barra de tempo: arrastar sem travar

O arraste da barra de tempo congelava o video e so voltava sozinho depois.

**A causa.** O servidor de midia (`gmaster1.shop`) nao responde a range request: devolve `200 OK` com o arquivo inteiro em vez de `206 Partial Content`. Quem pede o byte X recebe o arquivo do comeco. Por isso um salto para TRAS obriga o mpv a reler o video desde o inicio, e um salto para FRENTE e so continuar lendo.

Duas coisas foram consertadas:

- **O arraste parou de buscar.** Durante o arraste, cada passo da barra mandava um seek ao motor — oito por segundo. Como a origem nao sabe buscar, cada seek invalidava a posicao de leitura e o demuxer voltava para o comeco do arquivo. Medido no app: a posicao ficava **5,8 s parada**, com a imagem travada. Agora o arraste so move o mostrador: **o video continua tocando** enquanto a pessoa arrasta, e existe **um unico salto**, no fim.
- **O salto final saia em duplicata.** `finishScrub` estava ligada em `onPointerUp`, `onLostPointerCapture`, `onKeyUp` e `onBlur`, e o Chromium dispara `pointerup` e depois `lostpointercapture`. A guarda `if (scrubPos === null) return` nao segurava, porque `scrubPos` e estado do React e so vale no proximo render. O log mostrava tres saltos para um arraste, e o primeiro ia para um alvo que nem era o final. A guarda virou um ref, que atualiza na hora.

**O que continua sendo caro.** Um salto grande para tras ainda rele o arquivo desde o inicio — nao ha como evitar sem que a origem suporte range. Isso e visivel so quando o alvo esta longe da posicao atual; saltos pequenos e saltos para frente sao instantaneos. Foi por isso que `+10s` e `-10s` resolvem o travamento: eles sao saltos relativos, e o mpv so continua lendo de onde esta.

**Medidor de congelamento.** O motor agora mede, sozinho, o tempo em que a posicao fica parada com o video nao pausado, e registra no log. Atras de `STPLAY_SCRUB_TRACE=1`, porque e um timer de 500 ms rodando o tempo todo.
