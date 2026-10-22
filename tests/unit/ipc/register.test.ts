import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AppErrorException } from '@shared/errors'
import { wrapHandler } from '../../../src/main/ipc/wrap-handler'

const schema = z.object({ name: z.string() }).strict()
const logger = { warn: vi.fn(), error: vi.fn() }
const make = (fn: (r: { name: string }) => unknown, trusted = true) =>
  wrapHandler({ channel: 'test:chan', isTrustedSender: () => trusted, logger }, schema, fn)

describe('wrapHandler', () => {
  it('returns ok for a valid request', async () => {
    const res = await make((r) => ({ hello: r.name }))({}, { name: 'a' })
    expect(res).toEqual({ ok: true, data: { hello: 'a' } })
  })

  it('returns VALIDATION_FAILED for an invalid request and skips the handler', async () => {
    const fn = vi.fn()
    const res = await make(fn)({}, { name: 5 })
    expect(res).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns a thrown AppErrorException as its code and details', async () => {
    const res = await make(() => {
      throw new AppErrorException('GROUP_NAME_DUPLICATE', { name: 'x' })
    })({}, { name: 'a' })
    expect(res).toEqual({
      ok: false,
      error: { code: 'GROUP_NAME_DUPLICATE', details: { name: 'x' } }
    })
  })

  it('maps unknown errors to INTERNAL and logs them', async () => {
    const res = await make(() => Promise.reject(new Error('boom')))({}, { name: 'a' })
    expect(res).toEqual({ ok: false, error: { code: 'INTERNAL' } })
    expect(logger.error).toHaveBeenCalled()
  })

  it('rejects an untrusted sender without running the handler', async () => {
    const fn = vi.fn()
    const res = await make(fn, false)({}, { name: 'a' })
    expect(res.ok).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })
})
