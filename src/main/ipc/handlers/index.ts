import type { AppServices } from '../../app/app-services'
import { registerAgentLoadHandlers } from './agent-load'
import { registerAppHandlers, type AppHost } from './app'
import { registerGroupHandlers, registerProjectHandlers } from './groups'
import { registerKnowledgeHandlers } from './knowledge'
import { registerPluginHandlers } from './plugins'
import { registerProviderHandlers } from './providers'
import { registerReviewHandlers } from './review'
import { registerSessionHandlers } from './sessions'
import { registerSettingsHandlers } from './settings'
import { registerStorageHandlers } from './storage'
import { registerUsageHandlers } from './usage'
import { registerWorkerHandlers } from './workers'

/** Registers every IPC channel of the contract, one domain module at a time. */
export function registerAllHandlers(services: AppServices, host: AppHost): void {
  registerAppHandlers(host)
  registerProviderHandlers(services)
  registerGroupHandlers(services)
  registerProjectHandlers(services)
  registerStorageHandlers(services)
  registerKnowledgeHandlers(services)
  registerSettingsHandlers(services)
  registerAgentLoadHandlers(services)
  registerPluginHandlers(services)
  registerUsageHandlers(services)
  registerSessionHandlers(services)
  registerReviewHandlers(services)
  registerWorkerHandlers(services)
}
