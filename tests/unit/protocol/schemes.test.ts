import { beforeEach, describe, expect, it, vi } from 'vitest'

const register = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: register } }))

describe('registerAppSchemes', () => {
  beforeEach(() => register.mockClear())

  it('registers every scheme in one call with the same privileges', async () => {
    const { registerAppSchemes } = await import('../../../src/main/protocol/schemes')
    registerAppSchemes()
    expect(register).toHaveBeenCalledTimes(1)
    const list = register.mock.calls[0]![0] as Array<{ scheme: string; privileges: object }>
    expect(list.map((s) => s.scheme)).toEqual([
      'arc-knowledge',
      'arc-attachment',
      'arc-voice-model'
    ])
    expect(list[1]!.privileges).toEqual(list[0]!.privileges)
    expect(list[2]!.privileges).toEqual(list[0]!.privileges)
    expect(list[0]!.privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true
    })
  })
})
