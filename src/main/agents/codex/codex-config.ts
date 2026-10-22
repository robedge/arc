import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MCP_SERVER_NAME } from '../../bridge/types'
import type { CodexStartRequest } from '../agent-adapter'
import type { JsonObject } from './codex-types'

/**
 * What goes into `thread/start` and `thread/resume` (tech spec 2.1, 2.3 and spike results S3, S10).
 * Every setting that decides what the agent may do is set on the thread, not in the user's
 * `config.toml`, so the user's own Codex configuration cannot loosen it.
 */

/** The only provider id Arc runs Codex under; it beats a custom default in the user's config. */
export const CODEX_MODEL_PROVIDER = 'openai'

/** Every command that is not trusted read-only comes to Arc (the user's decision). */
export const CODEX_APPROVAL_POLICY = 'untrusted'

/** Arc's own tools never prompt; a call may block for as long as a human or a queued merge takes. */
export const BRIDGE_STARTUP_TIMEOUT_SEC = 20
export const BRIDGE_TOOL_TIMEOUT_SEC = 86_400

/** The `arc` MCP server entry for `config.mcp_servers`. The token travels in the child env, never in argv or config. */
export function arcServerConfig(
  bridge: { url: string },
  bridgeTools: readonly string[] | undefined
): JsonObject {
  return {
    url: bridge.url,
    bearer_token_env_var: 'ARC_BRIDGE_TOKEN',
    required: true,
    startup_timeout_sec: BRIDGE_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: BRIDGE_TOOL_TIMEOUT_SEC,
    default_tools_approval_mode: 'approve',
    ...(bridgeTools ? { enabled_tools: [...bridgeTools] } : {})
  }
}

/**
 * The override for one of the user's own MCP servers: nothing but the approval mode. A tool of
 * theirs with an `approval_mode` of its own keeps beating the server default, so those tools are
 * set to `prompt` as well (spike S8b).
 */
export function personalServerConfig(approvalTools: readonly string[] = []): JsonObject {
  return {
    default_tools_approval_mode: 'prompt',
    ...(approvalTools.length > 0
      ? {
          tools: Object.fromEntries(
            approvalTools.map((tool) => [tool, { approval_mode: 'prompt' }])
          )
        }
      : {})
  }
}

/**
 * Where a working copy's git data lives: its admin directory (`<common>/worktrees/<id>` for a
 * linked worktree, read from its `.git` file, never guessed from the folder name) and the common
 * directory it shares. A folder with no `.git` file (a plain repository has a `.git` directory, which
 * is its own common directory) gives `null`.
 */
export function gitDirsOf(worktree: string): { gitdir: string; common: string } | null {
  const dotGit = join(worktree, '.git')
  let text: string
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return { gitdir: dotGit, common: dotGit }
    text = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  const gitdirText = match?.[1]
  if (!gitdirText) return null
  const gitdir = isAbsolute(gitdirText) ? gitdirText : resolve(worktree, gitdirText)
  let common = dirname(dirname(gitdir))
  const commondirFile = join(gitdir, 'commondir')
  if (existsSync(commondirFile)) {
    const relative = readFileSync(commondirFile, 'utf8').trim()
    if (relative) common = resolve(gitdir, relative)
  }
  return { gitdir, common }
}

/**
 * The git directories a linked worktree writes to when it commits (spike S3). Codex carves `.git`
 * out of a writable root and follows the worktree's `.git` file to its admin directory, so the
 * admin directory has to be listed itself, together with `objects`, `refs` and `logs` of the
 * common directory. Nothing else of the repository's `.git` is writable: its `hooks` and `config` stay protected.
 *
 * A folder with no `.git` file (or a plain repository, whose `.git` is a directory) adds nothing.
 */
export function gitRootsFor(worktree: string): string[] {
  try {
    if (!statSync(join(worktree, '.git')).isFile()) return []
  } catch {
    return []
  }
  const dirs = gitDirsOf(worktree)
  if (!dirs) return []
  return [
    dirs.gitdir,
    join(dirs.common, 'objects'),
    join(dirs.common, 'refs'),
    join(dirs.common, 'logs')
  ]
}

/**
 * A worker's own working copies: its `cwd` and the extra directories that are not read-only (the
 * knowledge folder and the other checkouts are listed in `readOnlyDirs`).
 */
export function workingCopiesOf(options: CodexStartRequest): string[] {
  const readOnly = new Set(options.readOnlyDirs ?? [])
  return [options.cwd, ...(options.addDirs ?? []).filter((dir) => !readOnly.has(dir))]
}

/** The directories a worker may write: its working copies and the git directories they commit into. */
export function writableRootsFor(options: CodexStartRequest): string[] {
  const roots: string[] = []
  for (const tree of workingCopiesOf(options)) roots.push(tree, ...gitRootsFor(tree))
  return [...new Set(roots)]
}

/** The thread-level `config` overrides. */
export function buildThreadConfig(options: CodexStartRequest): JsonObject {
  const config: JsonObject = {}
  const servers: JsonObject = {}
  // The user's own servers keep their command and env from `config.toml` (overrides merge, spike S10);
  // only the approval mode is set, so every call of theirs reaches Arc's approvals.
  for (const name of options.codex.personalMcpServers ?? []) {
    if (name !== MCP_SERVER_NAME) {
      servers[name] = personalServerConfig(options.codex.personalMcpApprovalTools?.[name])
    }
  }
  // The servers the user switched off (spec 009): only the switch is sent, the rest of their entry stays theirs.
  for (const name of options.codex.disabledMcpServers ?? []) {
    if (name !== MCP_SERVER_NAME) servers[name] = { enabled: false }
  }
  if (options.bridge) {
    servers[MCP_SERVER_NAME] = arcServerConfig(options.bridge, options.bridgeTools)
  }
  if (Object.keys(servers).length > 0) config['mcp_servers'] = servers
  if (options.access === 'worker-write') {
    config['sandbox_workspace_write'] = {
      writable_roots: writableRootsFor(options),
      // The default roots include /tmp and $TMPDIR: a repository under either would look writable for the wrong reason.
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
      network_access: false
    }
  }
  return config
}

/**
 * Params shared by `thread/start` and `thread/resume`. Instructions and MCP config are sent again on
 * every resume. The brain reads only (`read-only` is enforced by the OS sandbox); a worker writes in
 * its working copies (`workspace-write`). There is no full-access fallback.
 */
export function buildThreadParams(options: CodexStartRequest): JsonObject {
  const params: JsonObject = {
    cwd: options.cwd,
    model: options.model,
    modelProvider: CODEX_MODEL_PROVIDER,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    approvalsReviewer: 'user',
    sandbox: options.access === 'brain-readonly' ? 'read-only' : 'workspace-write',
    config: buildThreadConfig(options)
  }
  // `developerInstructions`, never `baseInstructions`: the latter replaces Codex's own prompt.
  if (options.instructions) params['developerInstructions'] = options.instructions
  return params
}

export function buildThreadStartParams(options: CodexStartRequest): JsonObject {
  return { ...buildThreadParams(options), ephemeral: false }
}

export function buildThreadResumeParams(options: CodexStartRequest, threadId: string): JsonObject {
  // `excludeTurns`: the history is not needed, and replaying it through the pipe is slow.
  return { ...buildThreadParams(options), threadId, excludeTurns: true }
}

/**
 * The env keys Codex agents never get: API keys and every `CODEX_*` setting but the login's home,
 * so the subscription login is used (tech spec 2.1).
 */
export function isForbiddenCodexEnvKey(key: string): boolean {
  return key.startsWith('OPENAI_') || (key.startsWith('CODEX_') && key !== 'CODEX_HOME')
}

/**
 * Adds the Codex-specific entries to the agent env and drops the forbidden keys. `CODEX_HOME`
 * passes only when the start options or the user's own env set it. Arc's own `ARC_*` entries are
 * applied last, so `extraEnv` cannot change who the agent is.
 */
export function finishCodexEnv(
  env: Record<string, string>,
  options: CodexStartRequest,
  userEnv: NodeJS.ProcessEnv
): Record<string, string> {
  const out: Record<string, string> = {}
  const codexHome = options.codex.codexHome ?? userEnv['CODEX_HOME']
  if (codexHome) out['CODEX_HOME'] = codexHome
  for (const [key, value] of Object.entries(env)) {
    if (!isForbiddenCodexEnvKey(key)) out[key] = value
  }
  out['ARC_AGENT'] = '1'
  out['ARC_AGENT_ROLE'] = options.role
  out['ARC_PROVIDER'] = 'codex'
  if (options.bridge) out['ARC_BRIDGE_TOKEN'] = options.bridge.token
  return out
}
