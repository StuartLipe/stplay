const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const logWriter = require('../log-writer.cjs')

function logPath() {
  try {
    return path.join(app.getPath('userData'), 'player.log')
  } catch {
    return path.join(process.cwd(), 'player.log')
  }
}

function write(level, scope, message, data) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data !== undefined ? { data } : {}),
  })
  // Antes: existsSync + statSync + mkdirSync + appendFileSync, por linha, no
  // processo principal. Quatro syscalls sincronas para escrever uma linha de
  // diagnostico, 5-6 vezes por zape. Ver electron/log-writer.cjs.
  logWriter.append(logPath(), line)

  const prefix = `[player:${scope}]`
  if (level === 'error') console.error(prefix, message, data ?? '')
  else if (level === 'warn') console.warn(prefix, message, data ?? '')
  else console.log(prefix, message, data ?? '')
}

module.exports = {
  info: (scope, message, data) => write('info', scope, message, data),
  warn: (scope, message, data) => write('warn', scope, message, data),
  error: (scope, message, data) => write('error', scope, message, data),
}
