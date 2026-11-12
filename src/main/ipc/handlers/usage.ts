import { buildUsageReport } from '../../usage/usage-report'
import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

type UsageServices = Pick<
  AppServices,
  'usage' | 'suggestions' | 'usageRepo' | 'suggestionsRepo' | 'plans' | 'codexLimits' | 'cursorPlan'
>

export function registerUsageHandlers(services: UsageServices): void {
  const { usage, suggestions, usageRepo, suggestionsRepo, plans, codexLimits, cursorPlan } =
    services
  handle('usage:get-session', ({ sessionId }) => usage.snapshot(sessionId))
  handle('usage:dismiss-suggestion', ({ id }) => suggestions.dismiss(id))
  handle('usage:get-report', ({ range }) =>
    buildUsageReport(
      { repo: usageRepo, suggestions: suggestionsRepo, plans: () => plans.meters(), now: Date.now },
      range
    )
  )
  handle('plan:get', () => plans.snapshot())
  handle('plan:dismiss-notice', ({ key }) => plans.dismissNotice(key))
  handle('plan:refresh', async () => {
    await Promise.all([codexLimits.refresh(), cursorPlan.refresh()])
    return plans.snapshot()
  })
}
