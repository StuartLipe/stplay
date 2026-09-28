## ST PLAY 1.0.0

Primeira versão pública. Repositório em https://github.com/StuartLipe/stplay

### Atualização automática

O app se atualiza sozinho. Verifica a release uma vez por dia, baixa em segundo plano e só pede para reiniciar quando a instalação está pronta. Sem barra de progresso de 145 MB, sem instalar sem você mandar.

- **Aviso uma vez por versão**, não uma vez por dia. Quem ignora não é importunado — e o item "Atualizações" ganha um ponto que fica aceso até você resolver.
- **O instalador sempre pede confirmação**, com a barra visível e botão de cancelar. Nada é trocado em silêncio, em nenhum dos dois caminhos.
- **A versão portátil avisa que não se atualiza.** Ela é um arquivo único, sem pasta de instalação para o programa substituir. Antes ela baixava 144 MB do instalador e criava uma segunda cópia do app sem ninguém pedir.
- **Configurações → Atualizações**, com "Verificar agora" para quem quiser forçar. A barra de progresso só aparece ali, onde você mandou verificar.

### Aparência

- **A capa do filme não ganha mais sombra ao passar do mouse.** Nunca foi o cartão: ele estava com `border: 0` e sem `box-shadow` desde antes. Era o overlay de play, cujo escurecimento de hover é opaco com a cor do fundo da página — pintava a capa inteira e deixava só o recorte arredondado do bloco escuro, que se lia como sombra. O contraste agora fica no botão.
- **O zoom da capa passou a animar.** `img.cover-ready` e `.poster-media img` empatavam em especificidade, e o `transition` de uma cancelava o da outra.
- **A densidade cabe em uma linha** — "Confortável" caía sozinho numa segunda linha.
- **A aparência escolhida virou o padrão**: quem instala do zero abre em AMOLED, cenário Horizonte, destaque branco.

### Player e navegação

Correções de player, navegação e armazenamento acumuladas desde a 1.0.5 — a janela não trava mais ao abrir canal, canal lento não é mais julgado canal morto, a busca sobrevive à ficha, e o badge de compatibilidade saiu dos cards.

O changelog completo está no [histórico de commits](https://github.com/StuartLipe/stplay/commits/main).

### Conferir no Windows

```
Get-FileHash ".\ST-PLAY-Setup-1.0.0.exe" -Algorithm SHA256
```

### Nota sobre versões anteriores

As builds 1.0.5 a 1.0.10 nunca existiram publicamente — foram testes internos da atualização automática. Quem tiver uma delas instalada precisa instalar a 1.0.0 na mão: o atualizador só avança de versão, e 1.0.0 é anterior a 1.0.10. Depois desta, a linha segue normal.
