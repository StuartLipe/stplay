/**
 * DIAGNOSTICO: QUEM ESCONDE O BROWSSE.
 *
 * A QUEIXA: as vezes o app esta no painel dividido, a pessoa esta vendo um canal,
 * e de repente o catalogo e a lista de canais somem e o video fica por cima —
 * sem a pessoa pedir tela cheia.
 *
 * O QUE JA SE SABE, LIDO NO CODIGO (nao e palpite):
 *
 *   index.css  body.player-active .app-shell,
 *              body.player-active .topbar { visibility: hidden }
 *
 *   App.tsx:9476  useEffect(() => {
 *                   if (embedded) return
 *                   document.body.classList.add('player-active')
 *                 }, [embedded])
 *
 *   App.tsx:2179  {view.name === 'player' && (...) && (
 *                    <div className="details-overlay details-overlay-player">
 *                      <Player ... />        // L2186, SEM `embedded` -> false
 *
 *   App.tsx:2171  suspendLivePreview={view.name === 'player'}
 *
 * Entao: na view `player`, o browse CONTINUA montado (o bloco fecha em 2177) e o
 * Player de tela cheia monta JUNTO, com `embedded` false. O efeito acima roda sem
 * o `return` e põe `player-active` no <body> — e `document.body` e o MESMO de
 * todas as views. O browse inteiro fica `visibility: hidden`.
 *
 * O que falta e o porque: qual chamada trocou a view enquanto a pessoa assistia
 * no painel dividido. Nao da pra deduzir daqui — o autotest abre direto na view
 * `player` e nunca passa pelo estado que a pessoa esta descrevendo.
 *
 * POR QUE ISTO EXISTE: para a proxima vez que acontecer, o log responder quem foi,
 * com hora e com a pilha de chamadas. Sem isso o proximo palpite volta a ser
 * palpite.
 *
 * COMO: um MutationObserver no atributo `class` do <body> registra cada mudanca,
 * com a pilha de quem chamou. Como `classList.add` nao passa por um hook, o
 * Truque e monkey-patch de `DOMTokenList.prototype.add`/`remove` — ai a pilha
 * vem de verdade.
 */

import { playerLog } from './playerLogger'

const ALVO = 'player-active'
let instalado = false

/** Pilha curta: as poucas linhas acima do ponto que mexeu na classe. */
function pilha(): string {
  const linhas = (new Error().stack || '').split('\n').slice(2, 9)
  return linhas
    .map((l) => l.trim())
    .filter((l) => l.includes('/src/') || l.includes('at '))
    .slice(0, 5)
    .join(' <- ')
    .slice(0, 600)
}

export function instalarDiagnosticoPlayerActive(): () => void {
  // PORTAO: so no dev server.
  //
  // Este arquivo monkey-patcha `DOMTokenList.prototype.add`/`remove` para
  // capturar a pilha de quem mexeu em `player-active`. Isso coloca um wrapper em
  // TODA chamada de `classList` do app inteiro, nao so nas do player-active.
  // Instalar isso no build empacotado seria custo em todo `add()` por causa de um
  // diagnostico que ninguem vai ler em producao.
  //
  // `import.meta.env.DEV` e `true` no `npm run desktop` (que e como a pessoa
  // testa) e `false` depois do `vite build`, entao o diagnostico continua
  // disponivel para depurar e some sozinho no pacote.
  if (!import.meta.env.DEV) return () => undefined
  if (instalado) return () => undefined
  instalado = true

  const proto = DOMTokenList.prototype as unknown as {
    add: (this: DOMTokenList, ...t: string[]) => void
    remove: (this: DOMTokenList, ...t: string[]) => void
  }
  const addOriginal = proto.add
  const removeOriginal = proto.remove

  proto.add = function add(this: DOMTokenList, ...tokens: string[]) {
    const alvo = tokens.indexOf(ALVO) >= 0
    addOriginal.apply(this, tokens)
    if (alvo) {
      playerLog('warn', 'diag', `body.${ALVO} LIGADO`, {
        bodyClass: document.body.className,
        pilha: pilha(),
      })
    }
  }

  proto.remove = function remove(this: DOMTokenList, ...tokens: string[]) {
    const alvo = tokens.indexOf(ALVO) >= 0
    removeOriginal.apply(this, tokens)
    if (alvo) {
      playerLog('info', 'diag', `body.${ALVO} DESLIGADO`, {
        bodyClass: document.body.className,
        pilha: pilha(),
      })
    }
  }

  // Qualquer OUTRO caminho (setAttribute direto, className = ...) passa pelo
  // observer, entao nenhuma troca de classe escapa sem registro.
  const obs = new MutationObserver((registros) => {
    for (const r of registros) {
      const novo = document.body.className
      const tem = novo.split(/\s+/).includes(ALVO)
      playerLog(tem ? 'warn' : 'info', 'diag', 'body.className mudou', {
        classe: novo,
        playerActive: tem,
        origem: (r as unknown as { target?: Element }).target === document.body ? 'body' : 'outro',
      })
    }
  })
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  playerLog('info', 'diag', 'diagnostico de player-active instalado')

  return () => {
    obs.disconnect()
    proto.add = addOriginal
    proto.remove = removeOriginal
    instalado = false
  }
}

/**
 * Marca uma troca de view. Quem chama passa um rotulo curto do motivo, para o
 * log responder "foi o retry", "foi o clique no card", "foi o autotest".
 */
export function registrarTrocaDeView(de: string, para: string, motivo: string): void {
  playerLog('info', 'diag', 'troca de view', { de, para, motivo })
}