## ST PLAY 1.0.2

Repositório em https://github.com/StuartLipe/stplay

### Player STUR / MPEG

- **Engine "STUR direto-primeiro" igual ao Smarters** — abre fluxo bruto (raw), tenta 5× com retry, mostra **Buffering 0–100%**, usa **gpu-next** com suporte a DV/HDR, e o botão "Assistir direto" pula a ficha e abre o player em fullscreen blindado (sem piscar, sem redimensionar).
- **Congelamento de canal ao vivo corrigido** no player mpv — canais lentos não são mais julgados "mortos".
- **MPEG-TS / HLS**: pipeline mais robusta, menos travamentos em troca de segmento.

### Qualidade de vida

- **Diagnóstico silenciado** — o autoteste de F11 que não verificava nada foi removido; logs de diagnóstico pararam de poluir o console.
- **Limpeza de código** — remoção de lixo de `splice` residual e correção da causa raiz documentada no comentário.

### Atualização automática

- A 1.0.1 já tinha o ciclo completo (verifica 1×/dia, baixa em background, pede confirmação com barra visível). A 1.0.2 mantém o mesmo comportamento — quem ignorou a 1.0.1 recebe esta direto.

---

### Conferir no Windows

```
Get-FileHash ".\ST-PLAY-Setup-1.0.2.exe" -Algorithm SHA256
```

### Nota sobre versões

A 1.0.2 sucede a 1.0.1 publicada em 30/09/2026. As builds 1.0.5–1.0.10 nunca existiram publicamente — eram testes internos do atualizador. Quem tiver uma delas instalada precisa instalar a 1.0.0 ou superior na mão: o atualizador só avança de versão.