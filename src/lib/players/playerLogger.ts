export function playerLog(level: 'info' | 'warn' | 'error', scope: string, message: string, data?: unknown) {
  const prefix = `[player:${scope}]`
  const payload = data !== undefined ? [message, data] : [message]
  if (level === 'error') console.error(prefix, ...payload)
  else if (level === 'warn') console.warn(prefix, ...payload)
  else console.debug(prefix, ...payload)
  // Persiste em %APPDATA%\ST PLAY\internal-debug.log pra diagnosticar tela preta do STUR.
  try {
    const api = (window as unknown as { sturplay?: { dev?: { internalDebug?: (p: unknown) => unknown } } }).sturplay
    if (api?.dev?.internalDebug) {
      void Promise.resolve(
        api.dev.internalDebug({ scope: 'renderer', level, tag: prefix, message, data: serialize(data) }),
      ).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}

function serialize(data: unknown): unknown {
  if (data === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(data))
  } catch {
    return String(data)
  }
}
