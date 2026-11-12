import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

export function registerAgentLoadHandlers(services: Pick<AppServices, 'loadCatalogue'>): void {
  const { loadCatalogue } = services
  handle('agent-load:get', () => loadCatalogue.list())
  handle('agent-load:codex', () => loadCatalogue.listCodex())
  handle('agent-load:cursor', () => loadCatalogue.listCursor())
}
