import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdaterCheckResult, UpdaterEvent, UpdaterStatus } from '../global'

/*
 * Atualizacao automatica, vista pelo renderer.
 *
 * Sao tres estados visiveis e eles nao sao o mesmo numero:
 *
 *   versaoDisponivel  o `latest.yml` diz que existe versao nova. O download
 *                     comecou sozinho e NINGUEM esta olhando. Se a UI
 *                     mostrasse "baixando 40%" aqui, estaria transformando um
 *                     download silencioso em um cartaz que o usuario nao
 *                     pediu — e o pacote tem 145 MB.
 *
 *   pronto            o instalador esta baixado e esperando. So aqui aparece o
 *                     "Reiniciar".
 *
 *   instalando        o `quitAndInstall` foi chamado. Daqui para frente quem
 *                     fala e o instalador, nao o app.
 *
 * O `firstTime` que o main manda no evento `downloaded` e o que segura o
 * cartaz. Uma vez mostrado para uma versao, nao reaparece — quem ignorou
 * recebe a atualizacao no proximo boot pelo `autoInstallOnAppQuit`, entao
 * insistir nao compra nada e so cansa.
 *
 * Este arquivo mora separado do componente porque a regra de fast-refresh do
 * oxlint nao aceita um arquivo que exporta componente e hook juntos: o
 * componente so pode exportar componente, senao o HMR recarrega a tela
 * inteira a cada alteracao neste arquivo.
 */

export type UpdateToastState = {
  /**
   * `atual` e o "voce ja esta na versao mais recente". Nao e `error`: o cartaz de
   * erro abre com "Nao foi possivel atualizar" no titulo, e a pessoa lia essa
   * frase em cima de "Voce esta na versao mais recente". Duas frases que se
   * contradizem, com a pior na linha de cima.
   */
  phase: 'idle' | 'available' | 'ready' | 'installing' | 'portable' | 'error' | 'atual'
  version?: string
  percent?: number
  message?: string
}

export const UPDATE_TOAST_IDLE: UpdateToastState = { phase: 'idle' }

const AUTO_HIDE_MS = 10000

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const [toast, setToast] = useState<UpdateToastState>(UPDATE_TOAST_IDLE)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState(0)
  // Timer do fechamento automatico. Precisa ser ref e nao estado porque o
  // efeito de cleanup roda em troca de `agendarFechar` — se fosse estado, cada
  // re-render criaria um timer novo e o antigo continuaria pendente.
  const timer = useRef<number | null>(null)

  const agendarFechar = useCallback((ms: number) => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setToast(UPDATE_TOAST_IDLE)
      timer.current = null
    }, ms)
  }, [])

  const fechar = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setToast(UPDATE_TOAST_IDLE)
  }, [])

  useEffect(() => {
    let vivo = true

    // Rele o estado do processo principal. O `available` de la e o que diz se
    // ha instalador esperando em `pending`, e ele so vira `true` quando o
    // download termina — o que nao emite "status", emite "downloaded". Sem
    // esta releitura, o ponto do menu nunca acenderia.
    const relerStatus = async (): Promise<UpdaterStatus | null> => {
      try {
        const s = await window.sturplay?.updater?.status()
        if (vivo) setStatus(s || null)
        return s || null
      } catch {
        return null
      }
    }

    void relerStatus().then((s) => {
      if (!vivo || !s) return
      // Quem ja tem o instalador pronto ao abrir o app nao precisa de download
      // nenhum — e o unico caso em que o cartaz aparece sem download novo ter
      // acontecido nesta sessao.
      if (s.disponivelParaInstalar && s.installing === false) {
        setToast({ phase: 'ready', version: s.versaoPronta || s.shownVersion || undefined })
      }
    })

    const off = window.sturplay?.updater?.onEvent((payload: UpdaterEvent) => {
      if (!vivo) return
      if (payload.type === 'available') {
        setToast({ phase: 'available', version: payload.version, percent: 0 })
        setProgress(0)
      } else if (payload.type === 'progress') {
        setProgress(payload.percent)
        // O download em andamento so vira texto se a pessoa estiver olhando
        // a tela de Configuracoes. No cartaz, nao.
        setToast((atual) =>
          atual.phase === 'available' ? { ...atual, percent: payload.percent } : atual,
        )
      } else if (payload.type === 'downloaded') {
        setProgress(100)
        setToast({ phase: 'ready', version: payload.version })
        /*
         * Este cartaz NAO fecha sozinho.
         *
         * Medido no log do dono, no update real de 1.0.5:
         *
         *   05:40:31  update-downloaded 1.0.5
         *   05:40:46  quitAndInstall solicitado
         *
         * O download de 138 MB leva minutos, e o cartaz vivia `AUTO_HIDE_MS`
         * (10 s). O dono nao viu o popup: ele apareceu, ficou 10 segundos e
         * sumiu — o que ele viu foi o botao de Configuracoes virar "Reiniciar
         * agora". O unico cartaz da tela inteira que some sozinho e justamente
         * o que fecha o ciclo: chegou a hora de agir e nada sinaliza.
         *
         * O `firstTime` ja protege do incomodo de verdade — uma vez por versao,
         * nunca mais. Esconder nao protege de nada e ainda tira a pessoa do
         * fluxo: fechar "Agora nao" e um gesto, e nao um temporizador competindo
         * com quem esta lendo a tela.
         */
        void relerStatus()
      } else if (payload.type === 'portable') {
        /*
         * Este era o furo. O cartaz tem um ramo inteiro para o portatil
         * (`phase: 'portable'`) e NADA emitia essa fase: o branch era codigo
         * morto. Pior, o main nao checava nada — quem usasse o portatil
         * baixava os 144 MB do instalador e o rodava, gaining uma segunda copia
         * do app instalada em `%LOCALAPPDATA%\Programs` enquanto o portatil
         * continuava sendo o que a pessoa abria. Duas copias, sem ninguem ter
         * pedido.
         *
         * Agora o main detecta antes de `checkForUpdates()` e emite isto. Sem
         * download, sem copia duplicada, e com a versao na mensagem.
         */
        setToast({ phase: 'portable', version: payload.version || undefined })
        setStatus((atual) => (atual ? { ...atual, portable: true } : atual))
      } else if (payload.type === 'not-available') {
        fechar()
      } else if (payload.type === 'error') {
        setToast({ phase: 'error', message: payload.message })
        agendarFechar(AUTO_HIDE_MS)
      }
    })

    return () => {
      vivo = false
      off?.()
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [agendarFechar, fechar])

  const checarManual = useCallback(async (): Promise<UpdaterCheckResult> => {
    setChecking(true)
    try {
      const resultado = (await window.sturplay?.updater?.check(true)) || { ok: false }
      if (resultado.reason === 'dev') {
        setToast({ phase: 'error', message: 'O updater so roda no app empacotado (instalado).' })
        return resultado
      }
      if (resultado.reason === 'check-failed') {
        setToast({ phase: 'error', message: 'Nao foi possivel falar com o GitHub. Tente de novo.' })
        return resultado
      }
      if (resultado.skipped) return resultado
      if ((resultado as { portable?: boolean }).portable) {
        // O `portable` ja emitiu o evento e o cartaz ja esta no ar; o
        // `setToast` aqui sobrescreveria com "disponivel" e perderia o aviso.
        return resultado
      }
      if (resultado.available) {
        setToast({ phase: 'available', version: resultado.version, percent: 0 })
        setProgress(0)
      } else {
        setToast({
          phase: 'atual',
          version: (resultado as { version?: string }).version,
        })
        agendarFechar(AUTO_HIDE_MS)
      }
      return resultado
    } catch {
      setToast({ phase: 'error', message: 'Falha ao verificar atualizacoes.' })
      return { ok: false }
    } finally {
      setChecking(false)
    }
  }, [agendarFechar])

  const instalar = useCallback(async () => {
    setToast((atual) => ({ ...atual, phase: 'installing' }))
    const r = await window.sturplay?.updater?.install()
    if (r && !r.ok) {
      setToast({ phase: 'error', message: r.message || 'Nao foi possivel iniciar a instalacao.' })
      agendarFechar(AUTO_HIDE_MS)
    }
  }, [agendarFechar])

  const abrirReleases = useCallback(async () => {
    await window.sturplay?.updater?.openReleases()
    fechar()
  }, [fechar])

  return { status, toast, checking, progress, fechar, checarManual, instalar, abrirReleases }
}
