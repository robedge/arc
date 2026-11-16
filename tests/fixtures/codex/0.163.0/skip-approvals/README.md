# Codex skip-approvals spikes K1 and K2 (spec 015, Slice 4)

Run on 2026-11-15 with `codex-cli 0.163.0` (`cli-version.txt`). **No model call and no network beyond 127.0.0.1.**
`scripts/spike-015-codex.mjs` drives `codex app-server` over stdio JSON-RPC (`initialize` with
`experimentalApi: true`, `thread/start`, `turn/start`), the way `src/main/agents/codex/codex-adapter.ts` does,
against a scripted local Responses provider (a tiny HTTP server that replays one fixed tool call per turn).

Command: `node scripts/spike-015-codex.mjs` (writes here; `--only k1|k2`). The script was run several times
while it was being built (it is scripted, so reruns cost nothing); the files here come from its last full run.
A rerun after the final lint-only edit gave the same approval counts and file results.

## Setup

- A temp root with its own `CODEX_HOME` (a `config.toml` naming the scripted provider, and `rules/default.rules` with
  the user-level rule `prefix_rule(pattern=["git","push"], decision="allow")`) and its own `HOME`. The user's `~/.codex`
  is never read or written.
- A throwaway git repo, a local bare `remote.git` (the only push target), and linked worktrees. The `rules` worktrees
  hold `.codex/rules/arc.rules` with the line Arc writes: `prefix_rule(pattern=["git","push"], decision="prompt")`. The
  `control` worktrees have no `arc.rules`.
- `thread/start`: `modelProvider: "scripted"` (not `openai`: Arc's value cannot be used without a real login),
  `model: "scripted-model"`, `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`. A known model slug made this
  build list no tools for the scripted provider, so an unknown slug is used and Codex lists its generic tools
  (`exec_command` and others; see `provider-requests.json`).
- The client answers every approval request `accept` and records it.
- No `apply_patch` tool is listed for the unknown model, so the file-change turns run `apply_patch <<'PATCH' ...` through
  `exec_command`; Codex intercepts it and raises `item/fileChange/requestApproval` (not `item/commandExecution/...`).
  The freeform `apply_patch` tool itself was not exercised.

## Files

- `k1-danger.jsonl`: K1 under `sandbox: "danger-full-access"`. `k1-fallback.jsonl`: the same under the fallback
  (`workspace-write` with `config.sandbox_workspace_write {writable_roots: ["/"], network_access: true}`; the server echoes
  `{"type":"workspaceWrite","writableRoots":["/"],"networkAccess":true,...}`).
- `k2-override.jsonl`: K2, six turns on one thread.
- `results.json`: per turn, the approvals that reached the client, the completed items (exit code, output, file changes), the
  `thread/settings/updated` echoes, and whether the files exist. `provider-requests.json`: what the scripted server saw.
- Each `.jsonl` line is `{dir: c2s|s2c, t: ms, msg}`. Scrubbed: the temp root is `<TMP>`, home `<HOME>`, the provider port
  `<PORT>`; no account or token exists in these files.

## K1 result (proven, for both modes)

Under `danger-full-access` and under the fallback, with `untrusted`:

| Turn                                        | Approval that reached the client                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `touch <wt>/k1-cmd.txt && echo made`        | `item/commandExecution/requestApproval` (exit 0 after accept)                                                  |
| patch adding `k1-patch.txt` in the worktree | `item/fileChange/requestApproval`                                                                              |
| patch adding a file outside the worktree    | `item/fileChange/requestApproval` (file created after accept)                                                  |
| `git push origin HEAD` with `arc.rules`     | `item/commandExecution/requestApproval`, `reason`: "... requires approval by policy" (user allow rule present) |
| `git push origin HEAD` without `arc.rules`  | none: the user's allow rule ran it silently (control; it pushed to `remote.git`)                               |

## K2 result (proven)

One thread started `workspace-write` (writable root = the worktree, `/tmp` and `$TMPDIR` excluded, network off). Each turn
runs `echo N > <outside>/tN.txt` then `echo N > <wt>/in-tN.txt`:

| Turn                                | `turn/start` `sandboxPolicy`                                                                                       | Outside write                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| T1 baseline                         | none                                                                                                               | `operation not permitted`, exit 1                      |
| T2 override                         | `{type:"dangerFullAccess"}`                                                                                        | exit 0, file exists (accepted command ran unsandboxed) |
| T3 no override                      | none                                                                                                               | exit 0: the override persists                          |
| T4 restore                          | `{type:"workspaceWrite", writableRoots:[wt], networkAccess:false, excludeSlashTmp:true, excludeTmpdirEnvVar:true}` | `operation not permitted`, exit 1                      |
| T5 no override                      | none                                                                                                               | `operation not permitted`: the restore persists        |
| T6 restore without the tmp excludes | `{type:"workspaceWrite", writableRoots:[wt], networkAccess:false}`                                                 | exit 0: **the system temp dir is writable again**      |

`thread/settings/updated` is sent on the turns that carry an override (T2, T4, T6) and echoes the policy. It reports
`writableRoots: []` for a restore whose only root is the thread's cwd (the cwd is implicitly writable; inside writes worked in
every turn).
