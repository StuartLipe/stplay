/// <reference types="vite/client" />

export {}

export type DownloadProgressEvent = {
  id: string
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'canceled'
  received?: number
  total?: number
  speed?: number
  filePath?: string
  folder?: string
  error?: string
}

export type PlayerDetectResult = {
  ok: boolean
  internal?: boolean
  libmpv?: boolean
  mpv?: boolean
  mpvOne?: boolean
  stur?: boolean
  vlc?: boolean
  mpc?: boolean
}

export type PlayerEventPayload = {
  type: string
  current?: number
  value?: number | boolean
  percent?: number
  reason?: string
  retry?: number
  of?: number
}

/**
 * Estado do updater, lido do processo principal.
 *
 * `portable` e o campo que decide a mensagem: o executavel portatil e um
 * arquivo unico auto-extraivel, sem pasta de instalacao para o NSIS
 * substituir, entao o updater nao tem onde aplicar nada. Quem esta nele precisa
 * baixar o instalador na mao, e a UI precisa dizer isso em vez de fingir que
 * deu certo.
 */
export type UpdaterStatus = {
  ok: boolean
  packaged: boolean
  portable: boolean
  dev: boolean
  current: string
  lastCheck: number | null
  shownVersion: string | null
  /**
   * Ha instalador baixado esperando? Vem do estado em disco, nao do objeto do
   * `electron-updater`: esse objeto e recriado a cada boot e perderia a info.
   */
  disponivelParaInstalar: boolean
  /** Versao do instalador pronto, para o texto da caixa de reiniciar. */
  versaoPronta: string | null
  installing: boolean
}

export type UpdaterCheckResult = {
  ok: boolean
  skipped?: boolean
  available?: boolean
  version?: string
  reason?: string
  message?: string
}

/**
 * Eventos que o processo principal empurra para o renderer.
 *
 * `downloaded` carrega `firstTime`: e o que separa "ha versao nova" de "me
 * lembra de novo". Sem ele, o cartaz reaparece toda vez que o app abre ate a
 * pessoa reiniciar, e o que era evento de uma vez vira nagging.
 */
export type UpdaterEvent =
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string | null }
  | { type: 'progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'downloaded'; version: string; firstTime: boolean }
  /** O portatil achou a versao nova e NAO baixou nada. Ver `ehPortatil`. */
  | { type: 'portable'; version: string | null }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    sturplay?: {
      proxyBase: string
      coverBase?: string
      clearCoverCache?: () => Promise<{ ok: boolean }>
      player?: {
        detect: () => Promise<PlayerDetectResult>
        /** Dev/teste: { path, engine?: 'libmpv'|'mpv'|'auto'|'vlc'|'mpc' } */
        open: (payload: {
          path?: string
          url?: string
          engine?: string
          startTime?: number
          bounds?: { x: number; y: number; width: number; height: number }
        }) => Promise<{ ok: boolean; error?: string; engine?: string }>
        start: (payload: {
          engine: string
          url: string
          startTime?: number
          live?: boolean
          bounds?: { x: number; y: number; width: number; height: number }
        }) => Promise<{ ok: boolean; error?: string; engine?: string }>
        hide?: () => Promise<{ ok: boolean }>
        hideSync?: () => { ok: boolean }
        restoreShell?: () => { ok: boolean }
        stop: () => Promise<{ ok: boolean }>
        command: (op: string, value?: number | boolean) => Promise<{ ok: boolean }>
        setBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
        syncOverlay: (rect: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
        setOverlayMeta?: (meta: Record<string, unknown>) => Promise<{ ok: boolean }>
        setOverlayListOpen?: (open: boolean) => Promise<{ ok: boolean }>
        setOverlayIgnoreMouse?: (ignore: boolean) => Promise<{ ok: boolean }>
        sendOverlayAction?: (action: Record<string, unknown>) => Promise<{ ok: boolean }>
        sendOverlayUi?: (payload: Record<string, unknown>) => Promise<{ ok: boolean }>
        uiFullscreen?: () => Promise<{ ok: boolean }>
        onUiFullscreen?: (callback: () => void) => () => void
        onUiKey?: (callback: (payload: { key?: string }) => void) => () => void
        onEvent: (callback: (payload: PlayerEventPayload) => void) => () => void
        onOverlayMeta: (callback: (payload: Record<string, unknown>) => void) => () => void
        onOverlayAction?: (callback: (payload: Record<string, unknown>) => void) => () => void
        onOverlayUi?: (callback: (payload: Record<string, unknown>) => void) => () => void
      }
      window?: {
        setFullscreen: (enabled: boolean) => Promise<{ ok: boolean; fullscreen?: boolean }>
        isFullscreen: () => Promise<{ ok: boolean; fullscreen: boolean }>
        onFullscreenChanged?: (callback: (payload: { fullscreen: boolean }) => void) => () => void
      }
      nativePlayer?: {
        open: (
          url: string,
          startTime?: number,
          preferred?: 'vlc' | 'mpc',
        ) => Promise<{ ok: boolean; error?: string; player?: string }>
        detect?: () => Promise<PlayerDetectResult>
        embed?: (
          url: string,
          startTime?: number,
        ) => Promise<{ ok: boolean; error?: string }>
        setBounds?: (rect: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
        command?: (op: string, value?: number) => Promise<{ ok: boolean }>
        stop: () => Promise<void>
        stopExternal?: () => Promise<{ ok: boolean }>
        focus?: () => Promise<{ ok: boolean }>
        onEvent: (callback: (payload: PlayerEventPayload) => void) => () => void
      }
      openDownloadsFolder?: (folder?: string) => Promise<{ ok: boolean; path?: string }>
      dev?: {
        reportInternalTest: (payload: {
          at: string
          results: Array<{ name: string; ok: boolean; ms: number; error?: string }>
          allOk: boolean
        }) => Promise<{ ok: boolean; path?: string }>
      }
      downloads?: {
        getFolder: () => Promise<{ ok: boolean; path?: string }>
        pickFolder: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
        setFolder: (folder: string) => Promise<{ ok: boolean; path?: string; error?: string }>
        openFolder: (folder?: string) => Promise<{ ok: boolean; path?: string }>
        reveal: (filePath: string) => Promise<{ ok: boolean }>
        start: (payload: {
          id: string
          url: string
          name: string
          extension?: string
        }) => Promise<{ ok: boolean; filePath?: string; folder?: string; error?: string; canceled?: boolean }>
        pause: (id: string) => Promise<{ ok: boolean }>
        resume: (id: string) => Promise<{ ok: boolean; error?: string }>
        cancel: (id: string) => Promise<{ ok: boolean }>
        onProgress: (callback: (payload: DownloadProgressEvent) => void) => () => void
      }
      updater?: {
        status: () => Promise<UpdaterStatus>
        check: (manual?: boolean) => Promise<UpdaterCheckResult>
        install: () => Promise<{ ok: boolean; alreadyRunning?: boolean; message?: string }>
        openReleases: () => Promise<{ ok: boolean }>
        onEvent: (callback: (payload: UpdaterEvent) => void) => () => void
      }
    }
  }
}
