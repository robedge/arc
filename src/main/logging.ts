import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

/**
 * Configure file logging. Call after app.setName('Arc') and any userData override.
 * Default: ~/Library/Logs/Arc/main.log. With HARNESS_USER_DATA set, logs go under
 * the userData dir so tests stay isolated.
 */
export function configureLogging(): void {
  const override = process.env['HARNESS_USER_DATA']
  if (override) {
    log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
  } else {
    log.transports.file.resolvePathFn = () => join(app.getPath('logs'), 'main.log')
  }
  log.initialize()
}

export const ipcLog = log.scope('ipc')
export const knowledgeLog = log.scope('knowledge')
export const cliLog = log.scope('cli')
export const sessionsLog = log.scope('sessions')
export const dbLog = log.scope('db')
export { log }
