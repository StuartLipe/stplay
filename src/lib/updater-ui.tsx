import { Download, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { UpdateToastState } from './use-updater'

/*
 * O cartaz flutuante de atualizacao.
 *
 * Irmao do `.player-resume-toast`, e nao o mesmo componente: aquele e
 * `position: absolute` DENTRO do player, e a atualizacao nao tem player — ela
 * precisa sobreviver a estar em qualquer tela, inclusive a home. Por isso o
 * CSS deste e `position: fixed` e o componente fica montado no shell, fora do
 * fluxo de views.
 *
 * A pílula, o blur, a borda e o `slideInToast` sao os mesmos do outro de
 * proposito: dois cartazes com a mesma forma e nomes diferentes na base do CSS
 * divergiriam na primeira mudanca de espacamento.
 *
 * Os botoes NAO ficam no icone. O "Agora nao" e um `X` de 13px: quem le a
 * pílula inteira a 3 metros nao precisa de texto, e o gesto fecha mais rapido
 * porque dispensa leitura. "Reiniciar" e texto porque e a acao que a pessoa
 * pode nao querer dar e precisa saber o que vai acontecer.
 */

/** O cartaz flutuante. Fica no shell, nao no player. */
export function UpdateToast({
  toast,
  progress,
  onClose,
  onInstall,
  onOpenReleases,
}: {
  toast: UpdateToastState
  progress: number
  onClose: () => void
  onInstall: () => void
  onOpenReleases: () => void
}) {
  if (toast.phase === 'idle') return null

  if (toast.phase === 'portable') {
    return (
      <div className="update-toast" role="status">
        <div className="update-toast-copy">
          <Download size={17} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>
              {toast.version ? `A ${toast.version} esta disponivel` : 'Voce esta na versao portatil'}
            </strong>
            <span>
              O portatil nao se atualiza sozinho — ele nao tem pasta de instalacao para o programa
              substituir. Baixe o instalador para receber as proximas versoes.
            </span>
          </div>
        </div>
        <div className="update-toast-actions">
          <button onClick={onClose}>Agora nao</button>
          <button className="is-primary" onClick={onOpenReleases}>
            Baixar instalador
          </button>
        </div>
      </div>
    )
  }

  if (toast.phase === 'available') {
    return (
      <div className="update-toast" role="status">
        <div className="update-toast-copy">
          <RefreshCw size={17} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>
              Baixando a {toast.version || 'nova versao'}
              {toast.percent ? ` — ${toast.percent}%` : ''}
            </strong>
            <span>Isso acontece em segundo plano. Pode continuar usando o app.</span>
          </div>
        </div>
        <div className="update-toast-progress">
          <div style={{ width: `${progress || toast.percent || 0}%` }} />
        </div>
        <div className="update-toast-actions">
          <button onClick={onClose}>Ocultar</button>
        </div>
      </div>
    )
  }

  if (toast.phase === 'error') {
    return (
      <div className="update-toast" role="status">
        <div className="update-toast-copy">
          <RotateCcw size={17} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Nao foi possivel atualizar</strong>
            <span>{toast.message}</span>
          </div>
        </div>
        <div className="update-toast-actions">
          <button onClick={onClose}>Fechar</button>
          <button className="is-primary" onClick={onOpenReleases}>
            Abrir releases
          </button>
        </div>
      </div>
    )
  }

  const instalando = toast.phase === 'installing'
  return (
    <div className="update-toast" role="status">
      <div className="update-toast-copy">
        <Download size={17} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong>{instalando ? 'Instalando…' : `Atualização pronta — ${toast.version || ''}`}</strong>
          <span>
            {instalando
              ? 'O app vai fechar e abrir de novo em instantes.'
              : 'Clique para reiniciar e instalar.'}
          </span>
        </div>
      </div>
      {!instalando && (
        <div className="update-toast-actions">
          <button onClick={onClose} title="Agora nao">
            <X size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            Agora nao
          </button>
          <button className="is-primary" onClick={onInstall}>
            Reiniciar
          </button>
        </div>
      )}
    </div>
  )
}
