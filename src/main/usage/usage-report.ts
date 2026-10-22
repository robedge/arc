import type { UsageRepo } from '../db/repositories/usage-repo'
import type { UsageSuggestionsRepo } from '../db/repositories/usage-suggestions-repo'
import type { PlanSnapshot, SpenderKind, UsageRange, UsageReport } from '../../shared/types/usage'

/** Rows kept per Biggest spenders kind. */
export const SPENDER_LIMIT = 20

export interface UsageReportDeps {
  repo: Pick<UsageRepo, 'rangeTotals' | 'dailyByProvider' | 'biggestSpenders'>
  suggestions: Pick<UsageSuggestionsRepo, 'listForRange'>
  /** `PlanUsageService.meters()`: the current plan limits per set-up provider. */
  plans: () => PlanSnapshot['plans']
  now: () => number
}

const kinds: readonly SpenderKind[] = ['session', 'worker', 'command']

/** Assembles what `usage:get-report` answers for one range. */
export function buildUsageReport(deps: UsageReportDeps, range: UsageRange): UsageReport {
  const now = deps.now()
  const [session, worker, command] = kinds.map((kind) =>
    deps.repo.biggestSpenders(range, kind, SPENDER_LIMIT, now)
  )
  return {
    range,
    totals: deps.repo.rangeTotals(range, now),
    daily: deps.repo.dailyByProvider(range, now),
    spenders: { session: session ?? [], worker: worker ?? [], command: command ?? [] },
    plans: deps.plans(),
    suggestions: deps.suggestions.listForRange(range, now),
    generatedAt: now
  }
}
