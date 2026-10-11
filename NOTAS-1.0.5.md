## ST PLAY 1.0.5

### Player

- **O botão de ajuste de tela está onde os controles estão.** Ele ficava na barra
  de cima do player, que no modo nativo fica atrás do vídeo — dava para ver que
  estava lá, mas não dava para chegar. Agora fica no rodapé, ao lado do botão de
  tela cheia, e funciona nos dois motores.
- **O MPEG voltou a mostrar o carregamento.** A tela ficava preta e sem animação
  até o vídeo aparecer. A causa era o motor anunciar "tocando" no instante em que
  o arquivo carregava, muito antes do primeiro quadro — e o app usa "tocando"
  como sinal de que pode esconder o véu de carregamento.
- **O cursor some junto com a barra.** Ele ficava parado sobre o vídeo com os
  controles já apagados. Além disso, os controles nunca escondiam sozinhos: cada
  movimento de mouse rearmava o temporizador de quatro segundos sem parar.

### Seek

- **Segurar a seta não trava mais.** Os saltos de dez segundos vão como
  deslocamento relativo — "ande dez segundos daqui" — em vez de um destino
  absoluto calculado a partir de uma posição velha da interface. Cinco cliques
  seguidos iam para o mesmo ponto cinco vezes; agora vão para cinco pontos
  seguidos.
- **Arrastar a barra não mudou.** Arrastar é escolher um destino, e aí o absoluto
  continua certo.

### Favoritos

- **A contagem parou de mentir.** O número no canto era o total de itens salvos,
  e um item pode ter saído da lista sem nunca ter saído do salvamento — ele ficava
  invisível e sem como remover. Agora conta o que aparece, e o item preso é
  sinalizado.
- **Dá para limpar.** "Limpar todos" apaga a lista inteira, e "tirar os que
  sumiram" apaga só os que não estão mais nas listas.

### Sobre

- **Tela nova em Configurações → Sobre**, com o nome, o perfil e um botão para
  baixar a versão mais recente. O app não distribui lista de canais: ele não tem
  uma, e diz isso.
- **O link abre no navegador de verdade.** O navegador padrão do Windows
  muitas vezes não existe; o app agora lê o registro e abre no navegador que você
  usou por último.

### Notas

- O push para o GitHub segue separado da release. Publicar esta versão não
  altera o histórico do repositório.
