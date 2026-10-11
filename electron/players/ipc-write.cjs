/**
 * Escrita segura no pipe IPC do mpv — evita EPIPE não tratado no processo main.
 * @param {import('net').Socket | null | undefined} socket
 * @param {string} line
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
function writeLine(socket, line) {
  return new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      resolve({ ok: false, error: 'ipc disconnected' })
      return
    }
    try {
      socket.write(line, (err) => {
        if (err) {
          resolve({ ok: false, error: err.code || err.message || 'write failed' })
          return
        }
        resolve({ ok: true })
      })
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : 'write failed',
      })
    }
  })
}

module.exports = { writeLine }
