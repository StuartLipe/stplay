## ST PLAY 1.0.3

### Player

- **Mpeg não trava mais em 1% ao carregar.** O poll enfileirava `get_property`
  a cada 400 ms contra um socket que responde em ~1,2 s — a fila nunca esvaziava e
  `demuxer-cache-time` voltava `null` para sempre. Agora o percentual vem do
  relógio e só o `cache-buffering-state`, que o mpv empurra sozinho, corrige pra
  cima. Vale para ao vivo e para filme/série.
- **O spinner não some mais antes do vídeo aparecer.** O overlay escondia a tela
  de carregamento com `percent >= 100`, mas o `cache-buffering-state` chega a 100%
  antes do primeiro quadro decodificar. Depois disso sobrava uma tela preta sem
  explicação. Agora só o evento `playing` fecha o carregamento.
- **Áudio sem chiado e sem atraso.** As opções de sincronia e buffer de áudio que
  causavam o problema foram removidas; o perfil voltou ao original.
- **O canal não recarrega mais sozinho.** A recarga por atraso foi retirada do
  código. Ficar 50 segundos atrás não é mais motivo para descartar o que já foi
  baixado.

### Tela

- **Favoritos tem ações.** O botão de coração existia mas não aparecia — a classe
  CSS estava errada. Agora o card tem coração pra desfavoritar, retomar de onde
  parou e tirar de Continuar Assistindo. A lixeira confirma em dois toques.
- **Restaurar não fica mais atrás do player.** A folha abria centralizada na
  janela inteira, e o player é uma janela nativa que desenha por cima de qualquer
  camada. Ela agora cobre só a coluna de canais.
- **Restaurar funciona no detalhe da série.** O botão só existia na barra de
  ordenação, que desaparece quando uma série está aberta. Ele agora fica no canto
  superior direito do painel.

### Correções internas

- Chave ausente na lista de restaurar ocultos (aviso do React).
- Função morta removida do player mpeg.
