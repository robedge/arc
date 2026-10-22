import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchCodexRig } from './codex-rig'
import type { CodexRig, CodexRigOptions } from './codex-rig'

/**
 * Plumbing for the spec 010 acceptance specs: the codex rig (fake Claude, fake Codex, a fake Cursor wrapper whose
 * state file a test can change while Arc runs) plus the fake Cursor's `acp` mode: its log, its scripts and
 * filters over what Arc sent to it. Header of tests/e2e/fixtures/fake-cursor.mjs documents the FAKE_CURSOR_*
 * variables and the script steps.
 */

const CURSOR_SCENARIOS = resolve('tests/e2e/fixtures/cursor-scenarios')

/** The folder of a cursor scenario: per-role scripts for the fake Cursor (`worker.jsonl`) and the fake Claude (`brain.jsonl`). */
export function cursorScenario(name: string): string {
  return join(CURSOR_SCENARIOS, name)
}

export interface CursorRigOptions extends Omit<CodexRigOptions, 'scenario'> {
  /** A folder under cursor-scenarios, used for the fake Cursor's scripts. */
  cursorScenario?: string
  /**
   * The fake Claude scenario (under claude-scenarios). Defaults to the `cursorScenario` folder, whose `brain.jsonl`
   * is then the Claude brain.
   */
  scenario?: string
}

export interface CursorRig extends CodexRig {
  /** Where Arc's fake Cursor processes log (argv, env, recv, send, session, agent, permission, mcpResult, shell). */
  cursorLogPath: string
}

/** Launches Arc with the three fakes. The returned rig also removes the Cursor log directory on dispose. */
export async function launchCursorRig(options: CursorRigOptions): Promise<CursorRig> {
  const logDir = await realpath(await mkdtemp(join(tmpdir(), 'arc-cursor-log-')))
  const cursorLogPath = join(logDir, 'fake-cursor.log')
  writeFileSync(cursorLogPath, '')
  const scenario = options.scenario ?? `../cursor-scenarios/${options.cursorScenario ?? ''}`
  const { cursorScenario: name, ...rest } = options
  const rig = (await launchCodexRig({
    ...rest,
    scenario,
    cursor: {
      FAKE_CURSOR_LOG: cursorLogPath,
      ...(name ? { FAKE_CURSOR_SCRIPT_DIR: cursorScenario(name) } : {}),
      ...options.cursor
    }
  })) as CursorRig
  rig.cursorLogPath = cursorLogPath
  const dispose = rig.dispose
  rig.dispose = async () => {
    await dispose()
    await rm(logDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  return rig
}

// ---- the log -------------------------------------------------------------------------------

type Rec = Record<string, unknown>

/** Parsed lines of the fake Cursor log. */
export function readCursorLog(rig: Pick<CursorRig, 'cursorLogPath'>): Rec[] {
  if (!existsSync(rig.cursorLogPath)) return []
  return readFileSync(rig.cursorLogPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Rec)
}

type Log = Pick<CursorRig, 'cursorLogPath'>

/** The ACP messages Arc sent to the fake (`recv` records), optionally only one method. */
export function cursorReceived(rig: Log, method?: string): Rec[] {
  return readCursorLog(rig).flatMap((l) => {
    const msg = l['recv'] as Rec | undefined
    return msg && typeof msg === 'object' && (method === undefined || msg['method'] === method)
      ? [msg]
      : []
  })
}

export interface CursorPrompt {
  text: string
  sessionId?: string
  /** The role and worker slug the fake Cursor had identified when it logged the prompt. */
  role?: string
  slug?: string
}

/** The `session/prompt` requests Arc sent, in order. */
export function cursorPrompts(rig: Log): CursorPrompt[] {
  return readCursorLog(rig).flatMap((l) => {
    const msg = l['recv'] as
      { method?: string; params?: { sessionId?: string; prompt?: { text?: string }[] } } | undefined
    if (msg?.method !== 'session/prompt') return []
    const role = l['role'] as string | undefined
    const slug = l['slug'] as string | undefined
    const sessionId = msg.params?.sessionId
    return [
      {
        text: (msg.params?.prompt ?? []).map((p) => p.text ?? '').join('\n'),
        ...(sessionId ? { sessionId } : {}),
        ...(role ? { role } : {}),
        ...(slug ? { slug } : {})
      }
    ]
  })
}

/** How many `session/cancel` notifications Arc sent. */
export function cursorCancels(rig: Log): number {
  return cursorReceived(rig, 'session/cancel').length
}

export interface CursorPermissionAnswer {
  toolCallId?: string
  outcome: string
  optionId?: string
}

/** The answers Arc gave to the fake's `session/request_permission` requests, in order. */
export function cursorPermissionAnswers(rig: Log): CursorPermissionAnswer[] {
  return readCursorLog(rig).flatMap((l) => {
    const p = l['permission'] as CursorPermissionAnswer | undefined
    return p ? [p] : []
  })
}

/** The bridge calls the fake Cursor made (`mcp` steps), as { tool, isError, text }. */
export function cursorMcpResults(rig: Log): { tool: string; isError: boolean; text: string }[] {
  return readCursorLog(rig).flatMap((l) => {
    const r = l['mcpResult'] as { tool: string; isError: boolean; text: string } | undefined
    return r ? [r] : []
  })
}

/** The commands the fake Cursor really ran (`shell` steps). */
export function cursorShellRuns(rig: Log): { cmd: string; code: number }[] {
  return readCursorLog(rig).flatMap((l) => {
    const s = l['shell'] as { cmd: string; code: number } | undefined
    return s ? [s] : []
  })
}

export interface CursorSessionStart {
  method: string
  sessionId?: string
  cwd?: string
  mcpServers: {
    type?: string
    name?: string
    url?: string
    headers?: { name: string; value: string }[]
  }[]
}

/** Every `session/new` and `session/load` Arc sent, with the `mcpServers` of each. */
export function cursorSessions(rig: Log): CursorSessionStart[] {
  return readCursorLog(rig).flatMap((l) => {
    const s = l['session'] as Partial<CursorSessionStart> | undefined
    return s?.method ? [{ ...s, method: s.method, mcpServers: s.mcpServers ?? [] }] : []
  })
}

/** Every agent the fake Cursor chose a script for: its role, worker slug, whether it resumed, and the script file. */
export function cursorAgents(rig: Log): {
  role?: string
  slug?: string
  resumed: boolean
  script?: string
}[] {
  return readCursorLog(rig).flatMap((l) => {
    const a = l['agent'] as
      { role?: string; slug?: string; resumed?: boolean; script?: string } | undefined
    return a ? [{ ...a, resumed: a.resumed === true }] : []
  })
}
