## ST PLAY 1.0.4

### Imagem

- **O vídeo não tem mais borda preta.** A tela de vídeo aparecia sempre com
  tarja ao redor. O ajuste agora é um botão na barra de cima, ao lado do
  coração, que alterna entre três modos: caber inteiro, preencher cortando a
  borda, e esticar.
- **O padrão é "preencher".** É o que a TV entrega do mesmo canal: a janela da
  TV e 16:9 e a fonte também, então sobra nada. No PC a janela nunca tem
  exatamente o aspecto da fonte, e por isso sobrava sempre.
- **Funciona nos dois motores nativos.** A mudança vai para o mpv por IPC
  (`keepaspect` + `panscan`) e para o player interno por CSS. Nos dois
  caminhos, e sem reiniciar o canal.

### Player

- **O STUR já vem escolhido na instalação nova.** Quem já tem o app instalado
  continua no motor que escolheu — a escolha é respeitada, nada foi trocado
  por baixo dos panos. Para trocar, é em Configurações → Reprodutor de Vídeo.

### Correções

- **Ajuste de tela cheia no MPEG.** O vídeo ficava do tamanho da tela inteira
  ao sair do modo tela cheia, e o clique fora do app ainda pausava. A causa era
  uma linha que não observava a janela para o motor MPEG.
- **A tela cheia não pisca mais.** O botão e o F11 invertem o estado lendo a
  janela de verdade, em vez de confiar no espelho do renderer. O ESC deixou de
  matar o vídeo ao sair.

### Notas

- O push para o GitHub segue separado da release. Publicar esta versão não
  altera o histórico do repositório.