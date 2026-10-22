import type { z } from 'zod'
import { AppErrorException, err, ok } from '@shared/errors'
import type { Result } from '@shared/errors'

export interface HandlerLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WrapOptions<TEvent> {
  channel: string
  isTrustedSender: (event: TEvent) => boolean
  logger: HandlerLogger
}

/**
 * Electron-free core of `handle()`: sender check, zod validation, error mapping.
 * Always resolves a Result; never rejects. Logs never include request payloads.
 */
export function wrapHandler<TEvent, TSchema extends z.ZodType, TRes>(
  options: WrapOptions<TEvent>,
  schema: TSchema,
  fn: (request: z.infer<TSchema>, event: TEvent) => TRes | Promise<TRes>
): (event: TEvent, raw: unknown) => Promise<Result<TRes>> {
  const { channel, isTrustedSender, logger } = options
  return async (event, raw) => {
    if (!isTrustedSender(event)) {
      logger.warn(`${channel}: rejected untrusted sender`)
      return err('INTERNAL')
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      logger.warn(`${channel}: invalid request`)
      return err('VALIDATION_FAILED')
    }
    try {
      return ok(await fn(parsed.data, event))
    } catch (error: unknown) {
      if (error instanceof AppErrorException) return err(error.code, error.details)
      logger.error(`${channel}: unhandled error`, error)
      return err('INTERNAL')
    }
  }
}
