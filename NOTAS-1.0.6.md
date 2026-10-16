## ST PLAY 1.0.6

### Atualização

- **O app não "baixa" mais a versão que você já tem.** A tela mostrava
  "Instalada: 1.0.5" ao lado de um "Baixando a 1.0.5" que não existia: o
  atualizador devolvia a release atual como se fosse novidade e o cartaz
  aparecia sozinho. Agora ele compara a versão antes de dizer que há
  atualização.
- **"Você já está na versão mais recente" tem a cara certa.** Antes esse
  aviso saía no cartão de erro, com "Não foi possível atualizar" escrito por
  cima — duas frases se contradizendo, com a pior na linha de cima.
- **O aviso de reinício não some mais.** Ele vivia 10 segundos, e o download
  de 138 MB leva minutos: o cartaz nascia quando a installation acabava e
  evaporava antes de você olhar. Agora fica na tela até você clicar em
  "Reiniciar" ou fechar.
- **Se o instalador falhar, o botão continua lá.** A tela de reiniciar era
  apagada *antes* de o instalador rodar. Se o Windows barrasse — SmartScreen,
  antivírus, permissão — o botão sumia e não voltava.

### Conteúdo adulto

- **A categoria adulta agora é trancada de verdade.** O nome que o painel usa
  é "CANAIS | ADULTOS", e o app não reconhecia: o **S** final fazia a
  categoria passar como comum. Com a senha de 4 dígitos ligada, ela aparecia
  normalmente, desprotegida, ao lado de todo o resto. Era o inverso do que a
  tela prometia.
- **Uma regra só, em vez de duas.** O carregador e a interface tinham padrões
  diferentes para a mesma pergunta, e discordavam sobre esse nome. Os dois
  usam agora a mesma regra, com 14 testes segurando o comportamento.

### Controle parental

- **A senha não abre com o número que você acabou de apagar.** Ao digitar os
  4 dígitos, o campo confirmava 40 milissegundos depois — se você falhasse
  um dígito nesse intervalo, ele confirmava mesmo assim.

### Listas

- **Clicar fora da caixa não joga mais o que você digitou.** No cadastro e na
  edição de lista, o clique no escuro fechava a janela e levava junto host,
  usuário e senha, sem aviso. Na confirmação de remoção, o mesmo clique
  confirmava a exclusão. Agora os cinco diálogos saem só pelo botão.

### Player

- **A mensagem do STUR parou de accusing o navegador.** Quando o app está
  aberto e o que falta é o mpv, ela dizia "só funciona no app ST PLAY (.exe),
  não no navegador" — e a pessoa estava no app. Agora diz que o mpv não foi
  encontrado nesta instalação.

### Diagnóstico

- **Travamento agora deixa rastro.** As exceções que escapavam do processo
  principal iam só para o console, que morre com a janela. Agora vão também
  para o arquivo de log, que é de onde dá para investigar depois.