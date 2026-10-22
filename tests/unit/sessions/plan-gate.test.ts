import { describe, expect, it } from 'vitest'
import { matchApprovedEntry, sameRepos } from '../../../src/main/sessions/plan-gate'
import type { GatePlan } from '../../../src/main/sessions/plan-gate'

const entry = (name: string, repos: string[]) => ({
  name,
  task: 't',
  repos,
  model: null,
  rationale: ''
})

const plans: GatePlan[] = [
  { id: 'p1', status: 'replaced', workers: [entry('old', ['api'])] },
  {
    id: 'p2',
    status: 'approved',
    workers: [entry('api-retry', ['api']), entry('both', ['api', 'web'])]
  },
  { id: 'p3', status: 'proposed', workers: [entry('pending', ['api'])] },
  { id: 'p4', status: 'rejected', workers: [entry('nope', ['api'])] }
]
const free = (): boolean => false

describe('matchApprovedEntry', () => {
  it('matches an approved entry by name and repos, ignoring case and order', () => {
    expect(matchApprovedEntry(plans, 'API-Retry', ['API'], free)?.entry.name).toBe('api-retry')
    expect(matchApprovedEntry(plans, 'both', ['web', 'api'], free)?.plan.id).toBe('p2')
  })

  it('ignores replaced, proposed and rejected plans', () => {
    for (const name of ['old', 'pending', 'nope']) {
      expect(matchApprovedEntry(plans, name, ['api'], free)).toBeNull()
    }
  })

  it('needs the same repos, not a subset or a superset', () => {
    expect(matchApprovedEntry(plans, 'both', ['api'], free)).toBeNull()
    expect(matchApprovedEntry(plans, 'api-retry', ['api', 'web'], free)).toBeNull()
  })

  it('skips an entry that already has a worker', () => {
    expect(
      matchApprovedEntry(
        plans,
        'api-retry',
        ['api'],
        (id, e) => id === 'p2' && e.name === 'api-retry'
      )
    ).toBeNull()
  })

  it('compares repo lists as sets', () => {
    expect(sameRepos(['a', 'b'], ['B', 'a'])).toBe(true)
    expect(sameRepos(['a', 'a'], ['a'])).toBe(true)
    expect(sameRepos(['a'], ['b'])).toBe(false)
  })
})

describe('matchApprovedEntry with a command', () => {
  const withCommand = (name: string, command?: string) => ({
    ...entry(name, ['api']),
    ...(command ? { command } : {})
  })
  const planWithCommands: GatePlan[] = [
    {
      id: 'c1',
      status: 'approved',
      workers: [withCommand('spec', '/awos:spec retry'), withCommand('plain')]
    }
  ]

  it('matches an entry with the same command, ignoring case and spacing', () => {
    expect(
      matchApprovedEntry(planWithCommands, 'spec', ['api'], free, ' /AWOS:spec retry ')?.entry.name
    ).toBe('spec')
  })

  it('refuses another command, no command, or a command on an ordinary entry', () => {
    expect(matchApprovedEntry(planWithCommands, 'spec', ['api'], free, '/awos:tech')).toBeNull()
    expect(matchApprovedEntry(planWithCommands, 'spec', ['api'], free)).toBeNull()
    expect(matchApprovedEntry(planWithCommands, 'plain', ['api'], free, '/awos:spec')).toBeNull()
    expect(matchApprovedEntry(planWithCommands, 'plain', ['api'], free)?.entry.name).toBe('plain')
  })
})

describe('matchApprovedEntry with a provider-prefixed command', () => {
  const plan: GatePlan[] = [
    {
      id: 'c2',
      status: 'approved',
      workers: [{ ...entry('review', ['api']), command: 'codex:review BRANCH=main' }]
    }
  ]

  it('treats codex:name and /name as the same command', () => {
    expect(
      matchApprovedEntry(plan, 'review', ['api'], free, '/review BRANCH=main')?.entry.name
    ).toBe('review')
    expect(
      matchApprovedEntry(plan, 'review', ['api'], free, 'codex:review BRANCH=main')?.entry.name
    ).toBe('review')
    expect(matchApprovedEntry(plan, 'review', ['api'], free, '/review other')).toBeNull()
  })
})
