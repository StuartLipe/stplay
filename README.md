# ST PLAY

Player de IPTV para desktop Windows. Eletro, com reprodutor próprio, listas M3U e Xtream Codes, EPG, favoritos e download.

## O que ele faz

- Toca canais ao vivo, filmes e séries, de painel Xtream Codes ou de lista M3U
- EPG, favoritos, "continuar assistindo" e busca
- Download de filmes e séries
- Vários players, com escolha automática e opção de forçar
- Interface em português, com tema escuro, tamanho de fonte e densidade ajustáveis
- **Atualização automática** — ele verifica sozinho e só pede para reiniciar quando a instalação está pronta

## Instalar

Baixe o **instalador** (`ST-PLAY-Setup-<versão>.exe`). É ele que permite atualização automática.

O `ST-PLAY-<versão>.exe` é o portátil: roda sem instalar, mas **não se atualiza sozinho** — é um arquivo único, sem pasta de instalação para o programa substituir. Se você começar no portátil, migre para o instalador.

## Conferir se o instalador é o certo

O nome do arquivo não prova nada. Qualquer um pode salvar um executável com o nome `ST-PLAY-Setup-1.0.0.exe` — o Windows mostra o nome, não a origem. O `sha256` que aparece ao lado de cada arquivo na release é a impressão digital do conteúdo, e é o que distingue o meu de qualquer outro com o mesmo nome.

Rode no PowerShell, na pasta onde baixou:

```powershell
Get-FileHash ".\ST-PLAY-Setup-1.0.0.exe" -Algorithm SHA256
```

Compare com o `sha256:` da lista de assets na página da release.

**Se bater** — é o arquivo publicado aqui. Pode instalar.

**Se não bater** — não é este instalador. Ou o download veio corrompido, ou veio de outro lugar com o mesmo nome. Apague e baixe de novo da release. **Não instale.**

Vale conferir principalmente se o arquivo veio por WhatsApp, Telegram, e-mail ou link de terceiro.

## Atualização automática

O app confere a release uma vez por dia, baixa em segundo plano e só pede para reiniciar quando a instalação está pronta.

- **Nada é instalado sem você mandar.** O instalador sempre aparece com a barra e o botão de cancelar.
- **O aviso aparece uma vez por versão**, não uma vez por dia. O item "Atualizações" ganha um ponto que fica aceso até você resolver.
- Para forçar: **Configurações → Atualizações → Verificar agora**.

Se você instalar uma versão nova na mão, é só baixar o instalador e rodar por cima — ele substitui a anterior e mantém seus dados.

## Licença

MIT. Ver [LICENSE](LICENSE).
