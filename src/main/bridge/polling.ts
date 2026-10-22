import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { BridgeToolError, defineTool } from './types'
import type { AnyBridgeTool, BridgeAgent } from './types'

/**
 * The polling shape of long bridge calls for Cursor agents (tech spec 2.5, spike M1). Cursor cancels
 * an MCP call after 60 s and sends no `progressToken`, so the keepalive cannot hold it open. A call
 * that is still waiting after about 50 s therefore returns `{status:'pending', waitId, message}`
 * while the work goes on, and the agent calls `wait_for({waitId})`, which again returns within about
 * 50 s: the final result, or `pending` once more.
 */

/** Under Cursor's 60 s MCP timeout, with room for the round trip. */
export const CURSOR_POLL_MS = 50_000

/** The providers whose MCP calls time out at 60 s. */
export function pollsLongCalls(agent: BridgeAgent): boolean {
  return agent.provider === 'cursor'
}

export interface PendingResult {
  status: 'pending'
  waitId: string
  message: string
}

/** What `WaitRegistry.run` and `wait` give back: the work's value, or a pending reply. */
export type PollOutcome<T> = { done: true; value: T } | { done: false; pending: PendingResult }

interface Wait {
  /** Settles with the work's outcome; never rejects (the error is kept in the outcome). */
  settled: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
  who: string
}

/** The calls of one agent that were handed back as pending. Cleared when the agent's token is revoked. */
export class WaitRegistry {
  private readonly waits = new Map<string, Wait>()

  constructor(private readonly pollMs: number = CURSOR_POLL_MS) {}

  /** Starts watching `work`. Resolves with its value if it finishes in time, else with a pending reply. */
  run<T>(work: Promise<T>, who: string): Promise<PollOutcome<T>> {
    const settled = work.then(
      (value): { ok: true; value: unknown } => ({ ok: true, value }),
      (error: unknown): { ok: false; error: unknown } => ({ ok: false, error })
    )
    const waitId = `w_${randomBytes(6).toString('hex')}`
    return this.race(waitId, { settled, who }) as Promise<PollOutcome<T>>
  }

  /** `wait_for`: the stored call's outcome, or pending again. Throws `unknown_wait_id` for an id it does not hold. */
  wait(waitId: string): Promise<PollOutcome<unknown>> {
    const wait = this.waits.get(waitId)
    if (!wait) {
      throw new BridgeToolError(
        'unknown_wait_id',
        'There is no pending call with that waitId. It may have finished and been returned already.'
      )
    }
    return this.race(waitId, wait)
  }

  clear(): void {
    this.waits.clear()
  }

  get size(): number {
    return this.waits.size
  }

  private async race(waitId: string, wait: Wait): Promise<PollOutcome<unknown>> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.pollMs)
    })
    const winner = await Promise.race([wait.settled, timeout]).finally(() => clearTimeout(timer))
    if (winner === 'timeout') {
      this.waits.set(waitId, wait)
      return {
        done: false,
        pending: {
          status: 'pending',
          waitId,
          message: `Still waiting for ${wait.who}. Call wait_for(waitId) to keep waiting.`
        }
      }
    }
    this.waits.delete(waitId)
    if (winner.ok) return { done: true, value: winner.value }
    throw winner.error
  }
}

/**
 * Cursor agents only: the way to keep waiting for a call that came back pending. The server runs it
 * itself (it needs the agent's `WaitRegistry`), so `run` is never reached.
 */
export const waitForTool: AnyBridgeTool = defineTool({
  name: 'wait_for',
  role: 'any',
  readOnly: true,
  description:
    'Keep waiting for a call that returned {status:"pending", waitId}. Pass that waitId. Returns the call\'s own result once it is ready, or {status:"pending", waitId} again after about 50 seconds; call wait_for again until you get the result.',
  inputShape: { waitId: z.string().min(1) },
  run: () => {
    throw new Error('wait_for is run by the bridge server')
  }
})
