import type { AppServices } from '../../app/app-services'
import { emit, handle } from '../register'

type SettingsServices = Pick<AppServices, 'appSettings' | 'commandCatalogue' | 'sessions'>

/** True when both lists hold the same keys, in any order. */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key))
}

export function registerSettingsHandlers(services: SettingsServices): void {
  const { appSettings, commandCatalogue, sessions } = services
  handle('settings:get', () => appSettings.getAll())
  handle('settings:set', (patch) => {
    const loadBefore = patch['agents.loadOff'] ? appSettings.get('agents.loadOff') : undefined
    const suggestBefore =
      patch['knowledge.suggestOnFinish'] !== undefined
        ? appSettings.get('knowledge.suggestOnFinish')
        : undefined
    appSettings.setMany(
      {
        ...(patch['providers.brain'] ? { 'providers.brain': patch['providers.brain'] } : {}),
        ...(patch['providers.workers'] ? { 'providers.workers': patch['providers.workers'] } : {}),
        ...(patch['usage.checkClaudePlanOnLaunch'] !== undefined
          ? { 'usage.checkClaudePlanOnLaunch': patch['usage.checkClaudePlanOnLaunch'] }
          : {}),
        ...(patch['knowledge.suggestOnFinish'] !== undefined
          ? { 'knowledge.suggestOnFinish': patch['knowledge.suggestOnFinish'] }
          : {}),
        ...(patch['approvals.skipAllByDefault'] !== undefined
          ? { 'approvals.skipAllByDefault': patch['approvals.skipAllByDefault'] }
          : {}),
        ...(patch['agents.loadOff'] ? { 'agents.loadOff': patch['agents.loadOff'] } : {})
      },
      Date.now()
    )
    const all = appSettings.getAll()
    emit('settings:changed', all)
    // Commands run in workers: when the Workers selection changed, the `/` list and the brains' lists follow.
    if (loadBefore && !sameKeys(loadBefore.workers, all['agents.loadOff'].workers)) {
      commandCatalogue.invalidate()
      emit('commands:changed', {})
      void sessions.pluginsChanged()
    }
    // Open brains hear about the knowledge suggestions switch with their next message, once, and only on a change.
    if (suggestBefore !== undefined && suggestBefore !== all['knowledge.suggestOnFinish']) {
      sessions.knowledgeSuggestSettingChanged()
    }
    return all
  })
}
