import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { loadKey, type LoadRole } from '../../shared/types/agent-load'
import type { BypassReport, CursorBypass } from '../../shared/types/provider'
import {
  describePrefix,
  isCoveredByArcRules,
  readUserAllowRules
} from '../agents/codex/codex-user-rules'
import { readCursorUserConfig } from '../agents/cursor/cursor-user-config'
import type { PluginViewSource } from '../plugins/plugin-view'
import { NOTHING_OFF, type OffFor } from './load-selection'
import { hookEventsOf, isRecord, readUserHooks, type ConfigLog } from './claude-user-config'

/**
 * Finds what can skip Arc's approvals (spec 007 section 2.6, tech spec 2.3). Arc allows it and says
 * so: Settings lists it and the event log notes it once per session.
 * - Claude: a user hook can answer "allow" on `PreToolUse` (a `permissionDecision`) and on
 *   `PermissionRequest`, and Claude then never asks the permission tool. Arc cannot see such a call.
 *   The events of the user's `~/.claude/settings.json` and of the enabled plugins' hooks are listed.
 * - Codex: a `decision="allow"` entry of `$CODEX_HOME/rules/*.rules` skips both the approval and the
 *   sandbox. Arc's per-folder `arc.rules` turns the protected ones back into prompts; the rest are listed.
 *
 * - Cursor: an `allow` entry for `Shell`, `Write` or `Mcp` in `~/.cursor/cli-config.json` or a project's
 *   `.cursor/cli.json`, an `approvalMode` other than `allowlist`, and hook events that can answer "allow"
 *   run the action without a permission request. Arc's deny file blocks the protected ones; the rest are listed.
 *
 * Read-only. Only event names and command prefixes are returned; the contents of a hook or a rule never are.
 */

/** Hook events whose hooks can answer with an "allow" decision. */
export const ALLOW_CAPABLE_HOOK_EVENTS: readonly string[] = ['PreToolUse', 'PermissionRequest']

export interface BypassDetectorDeps {
  /** Read per call so tests can fake it (default: the process HOME). */
  getHome?: () => string
  /** `$CODEX_HOME`, or `~/.codex` (default: from the process env). */
  getCodexHome?: () => string
  /** The enabled plugins of the agent view (`PluginViewService.sources`). */
  plugins?: {
    sources: (repoPaths: readonly string[], role?: LoadRole) => Promise<PluginViewSource[]>
  }
  /** What the user switched off per role (spec 009); left out, everything is on. */
  off?: OffFor
  log?: ConfigLog
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** A plugin's hook events: `hooks/hooks.json` and the manifest's `hooks` (inline, or the path(s) of file(s)). */
async function pluginHookEvents(plugin: PluginViewSource): Promise<string[]> {
  const events: string[] = []
  const fromFile = async (path: string): Promise<void> => {
    const file = await readJson(path)
    if (isRecord(file)) events.push(...hookEventsOf(isRecord(file['hooks']) ? file['hooks'] : file))
  }
  await fromFile(join(plugin.installPath, 'hooks', 'hooks.json'))
  const declared = plugin.manifest['hooks']
  if (isRecord(declared)) events.push(...hookEventsOf(declared))
  const paths = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  for (const path of paths) {
    if (typeof path === 'string') {
      await fromFile(isAbsolute(path) ? path : resolve(plugin.installPath, path))
    }
  }
  return events
}

export class BypassDetector {
  constructor(private readonly deps: BypassDetectorDeps = {}) {}

  async detect(repoPaths: readonly string[] = []): Promise<BypassReport> {
    const [brain, workers, codex, cursor] = await Promise.all([
      this.claudeHookEvents(repoPaths, 'brain'),
      this.claudeHookEvents(repoPaths, 'workers'),
      this.codexRules(),
      this.cursorSetup(repoPaths)
    ])
    // The union is what some agent can still hit; the lists per role are for the Settings warning.
    const claudeHookEvents = ALLOW_CAPABLE_HOOK_EVENTS.filter(
      (event) => brain.includes(event) || workers.includes(event)
    )
    return { claudeHookEvents, claudeHookEventsByRole: { brain, workers }, ...codex, cursor }
  }

  /**
   * The allow-capable events in the user's settings and in the enabled plugins' hooks for one role,
   * in a fixed order. Events and plugins the user switched off for that role are not counted.
   */
  private async claudeHookEvents(repoPaths: readonly string[], role: LoadRole): Promise<string[]> {
    const found = new Set<string>()
    const off = (this.deps.off ?? NOTHING_OFF)(role)
    try {
      const home = (this.deps.getHome ?? homedir)()
      for (const event of hookEventsOf(await readUserHooks(home))) {
        if (!off.has(loadKey.hook(event))) found.add(event)
      }
      for (const plugin of (await this.deps.plugins?.sources(repoPaths, role)) ?? []) {
        for (const event of await pluginHookEvents(plugin)) found.add(event)
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not read the Claude hooks for the approval-bypass check', error)
    }
    return ALLOW_CAPABLE_HOOK_EVENTS.filter((event) => found.has(event))
  }

  private async cursorSetup(repoPaths: readonly string[]): Promise<CursorBypass> {
    try {
      return await readCursorUserConfig((this.deps.getHome ?? homedir)(), repoPaths)
    } catch (error: unknown) {
      this.deps.log?.warn('could not read the Cursor settings for the approval-bypass check', error)
      return { allowEntries: [], hookEvents: [] }
    }
  }

  private async codexRules(): Promise<
    Pick<BypassReport, 'codexAllowPrefixes' | 'codexRulesCovered'>
  > {
    const codexHome =
      this.deps.getCodexHome?.() ??
      process.env['CODEX_HOME'] ??
      join((this.deps.getHome ?? homedir)(), '.codex')
    try {
      const { prefixes } = await readUserAllowRules(codexHome)
      const uncovered = prefixes.filter((prefix) => !isCoveredByArcRules(prefix))
      return {
        codexAllowPrefixes: [...new Set(uncovered.map(describePrefix))],
        codexRulesCovered: prefixes.length - uncovered.length
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not read the Codex rules for the approval-bypass check', error)
      return { codexAllowPrefixes: [], codexRulesCovered: 0 }
    }
  }
}
