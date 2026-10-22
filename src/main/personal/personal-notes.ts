import type { BypassReport } from '../../shared/types/provider'

/** Event-log notes about the user's own hooks, rules and MCP servers (spec 007 section 2.6). */

/** Once per session, when a user hook or Codex rule can skip Arc's approvals. */
export const BYPASS_NOTE =
  "Your hooks, Codex rules or Cursor settings can skip some of Arc's approvals. See Settings → Providers."

/** Once per session, when the list of the user's Codex MCP servers could not be read. */
export const DEGRADED_MCP_NOTE =
  "Arc couldn't read your Codex MCP servers, so it asks before every tool call Codex raises for them."

/** The event `kind` of the bypass note; the orchestrator looks for it to write the note once per session. */
export const BYPASS_EVENT_KIND = 'bypass-warning'

/** True when the report lists anything that can skip Arc's approvals. */
export function reportHasBypass(report: BypassReport): boolean {
  const cursor = report.cursor
  return (
    report.claudeHookEvents.length > 0 ||
    report.codexAllowPrefixes.length > 0 ||
    (cursor !== undefined &&
      (cursor.allowEntries.length > 0 ||
        cursor.approvalMode !== undefined ||
        cursor.hookEvents.length > 0))
  )
}
