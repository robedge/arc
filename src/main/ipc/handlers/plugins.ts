import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

export function registerPluginHandlers(services: Pick<AppServices, 'pluginService'>): void {
  const { pluginService } = services
  handle('plugins:list', () => pluginService.list())
  handle('plugins:install', ({ name, marketplace }) => pluginService.install(name, marketplace))
  handle('plugins:update', ({ id }) => pluginService.update(id))
  handle('plugins:uninstall', ({ id }) => pluginService.uninstall(id))
  handle('plugins:check-updates', () => pluginService.checkUpdates())
}
