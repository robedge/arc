import { describe, expect, it } from 'vitest'
import { RESOLVER_MARKER, commandName, workerLabel } from '../../../src/main/sessions/worker-label'

const row = { number: 2, slug: 'api-retry', dependsOnJson: '[]' }

describe('workerLabel', () => {
  it('uses the slug for an ordinary worker', () => {
    expect(workerLabel(row)).toBe('W2 api-retry')
    expect(workerLabel({ ...row, command: null })).toBe('W2 api-retry')
  })

  it('shows only the command name, not its arguments', () => {
    expect(workerLabel({ ...row, command: '/awos:spec retry settings' })).toBe('W2 · /awos:spec')
    expect(workerLabel({ ...row, command: '/user:agent-browser' })).toBe('W2 · /user:agent-browser')
  })

  it('names the conflict resolver whatever else is set', () => {
    expect(
      workerLabel({ ...row, dependsOnJson: JSON.stringify([RESOLVER_MARKER]), command: '/x' })
    ).toBe('Conflict resolver')
  })

  it('reads the command name', () => {
    expect(commandName('/awos:spec a b')).toBe('awos:spec')
    expect(commandName('awos:spec')).toBeNull()
    expect(commandName(null)).toBeNull()
  })
})
