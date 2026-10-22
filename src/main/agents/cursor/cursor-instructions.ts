/**
 * Lines of Arc's instructions that only Cursor agents get. Cursor cancels an MCP call after 60 s
 * (spike M1), so a bridge call that is still waiting after about 50 s comes back as pending and the
 * agent follows it up with `wait_for` (`bridge/polling.ts`).
 */

/** How the agent reaches Arc's tools: Cursor lists them under the MCP server's name and loads them lazily. */
export const CURSOR_TOOL_LINE =
  "- Arc's tools are the tools of the MCP server named `arc` (report_progress, report_done, ask_brain). They are in your tool list; call them directly."

/** The wait_for convention, for every Cursor agent that has long-waiting tools. */
export const CURSOR_WAIT_FOR_LINE =
  '- A tool that has to wait (ask_brain, propose_plan, ask_user, merge_worker) can answer {"status":"pending","waitId":"..."} after about 50 seconds. That is not the answer yet and not an error: call the `wait_for` tool of the `arc` server with that waitId, and repeat until you get the real result. Do not ask the same question again.'

/** Cursor's reject carries no text, so the rule is in the instructions; Arc also repeats the reason in front of the next prompt. */
export const CURSOR_REJECTED_LINE =
  "- If an action is rejected, don't work around it; call ask_brain."
