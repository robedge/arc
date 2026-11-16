# Real turns (spec 015, Slice 4)

Run on 2026-11-15, one run per spike, approved by the user the same day. Versions: `codex-cli 0.163.0`, Cursor `agent` 2026.11.13-eacade1 (Free tier, Auto), Claude Code 2.1.325 (model `haiku`). K1 and K2 used a scripted local Responses provider, so no model call and no network beyond 127.0.0.1. K3 to K5 were real turns on the user's logged-in subscriptions, in temp directories with throwaway repos (the only push went to a local bare repo). Scripts: `scripts/spike-015-codex.mjs`, `scripts/spike-015-cursor.mjs`, `scripts/spike-015-claude.mjs`. Captures and per-spike READMEs: `tests/fixtures/codex/0.163.0/skip-approvals/`, `tests/fixtures/cursor/2026.11.13-eacade1/skip-approvals/`, `tests/fixtures/claude/skip-approvals/`.

| ID  | Question                                                                                         | Result                                                  | Evidence                                                                               |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| K1  | Under `dangerFullAccess` + `untrusted`, do command and file-change approvals and `arc.rules` prompt rules still reach the client? | Proven (also under the `workspaceWrite` root `/` fallback) | `k1-danger.jsonl`, `k1-fallback.jsonl`, `results.json`                                 |
| K2  | Does a `turn/start` `sandboxPolicy` override apply, persist, restore explicitly, and run an accepted command unsandboxed? | Proven, with one requirement for the restore            | `k2-override.jsonl`, `results.json`                                                    |
| K3  | Is `cli.json` re-read between two prompts of one Cursor process?                                  | Disproven: the removed deny still blocked prompt 2      | `k3.jsonl` (notes and tool calls)                                                      |
| K4  | Does `git push` ask over ACP with no deny; what does the agent see after `reject_once`; does an allow skip the ask? | Asks: proven. Project allow skips the ask: proven. User-level allow: unproven | `k4.jsonl`                                                                             |
| K5  | Does a `--resume` relaunch without the deny rules accept an Edit into an added folder unasked?    | Proven: the Edit went through, no denial                | `k5-process2-resume.jsonl`, `k5-summary.json`                                          |

## K1 (Codex, scripted): proven

`thread/start` with `sandbox: "danger-full-access"`, `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`. The server echoed `"sandbox":{"type":"dangerFullAccess"},"approvalPolicy":"untrusted"`. Every non-trusted action still came to the client as a server request, and each was answered `accept`:

- command: `item/commandExecution/requestApproval` for `/bin/zsh -lc 'touch <wt>/k1-cmd.txt && echo made'` (exit 0 after accept);
- file change: `item/fileChange/requestApproval` for a patch inside the worktree, and again for a patch to a file outside it (both files existed afterwards);
- prompt rule over a user allow: with `~/.codex/rules/default.rules` (the temp `CODEX_HOME`) holding `prefix_rule(pattern=["git","push"], decision="allow")`, the worktree with `.codex/rules/arc.rules` raised `item/commandExecution/requestApproval` with `reason` "`/bin/zsh -lc 'git push origin HEAD'` requires approval by policy". The control worktree without `arc.rules` pushed with no request at all, so the user allow rule is live and `arc.rules` is what stops it.

The fallback (`workspace-write`, `config.sandbox_workspace_write.writable_roots ["/"]`, network on; the server echoed `{"type":"workspaceWrite","writableRoots":["/"],"networkAccess":true,...}`) gave the identical result for all five turns, so it is available but not needed.

Caveats: the scripted provider is `modelProvider: "scripted"`, not `openai`. File changes were raised by `apply_patch` run through `exec_command` (Codex intercepts it), because the generic scripted model lists no `apply_patch` tool; the request is the same `item/fileChange/requestApproval`. The freeform `apply_patch` tool was not driven.

Consequence for Slice 5 and the brain: file changes keep asking under `dangerFullAccess`, so the brain `classifyBrainAction` refusal of `apply_patch` still works. **No Open Question is raised.** The Codex brain can be lifted to `danger-full-access` as the tech spec says. Use `dangerFullAccess`; the root-`/` fallback is not needed and is not built.

## K2 (Codex, scripted): proven, with a restore requirement

One thread started `workspace-write` (writable root = the worktree, `exclude_slash_tmp` and `exclude_tmpdir_env_var` true, network off). Each turn wrote a file in a temp dir outside the worktree and one inside it. Every turn also raised `item/commandExecution/requestApproval`, answered `accept`.

| Turn                           | `sandboxPolicy` on `turn/start`                                  | Outside write                                         |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| T1 baseline                    | none                                                             | `zsh:1: operation not permitted`, `outside-exit=1`     |
| T2                             | `{"type":"dangerFullAccess"}`                                    | `outside-exit=0`, file exists                          |
| T3                             | none                                                             | `outside-exit=0` (the override persists)               |
| T4 restore                     | `workspaceWrite`, `writableRoots`, `networkAccess:false`, `excludeSlashTmp:true`, `excludeTmpdirEnvVar:true` | `operation not permitted`, `outside-exit=1` |
| T5                             | none                                                             | `operation not permitted` (the restore persists)       |
| T6 restore without the excludes | `workspaceWrite`, `writableRoots`, `networkAccess:false`         | `outside-exit=0`: the system temp dir is writable again |

`thread/settings/updated` echoed the override on T2, T4 and T6 (`{"type":"dangerFullAccess"}`; `workspaceWrite` with `excludeTmpdirEnvVar` and `excludeSlashTmp` true, then false). An accepted command ran unsandboxed under the override (T2, T3), and an explicit restore took effect on the next turn and stayed.

Consequence for Slice 5:

- `CodexHandle.setSandbox` sending `sandboxPolicy` on every later `turn/start` is the right mechanism; a turn without it keeps the last one, so a restore must always be sent explicitly.
- **The restore policy must carry `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true`** (matching `buildThreadConfig`'s `sandbox_workspace_write`), not only `writableRoots` and `networkAccess:false` as the tech spec 2.5 text says. Without them the restored sandbox lets a worker write under `/tmp` and `$TMPDIR`. The brain's restore is `{"type":"readOnly"}`; that exact shape was not run, but `readOnly` appears in the schema and in the spec 012 echo.
- The echo reports `writableRoots: []` when the only root is the cwd (implicitly writable), so an echo-based test should not expect the cwd in the list.

## K3 (Cursor, real): disproven

One process and session, two prompts, each asking the file edit tool (not the shell) to create a file in a temp dir outside the repo; every permission request would have been rejected (none came).

- `cli.json` = `{"permissions":{"allow":[],"deny":["Write(<TMP>/k3-other/**)"]}}`. Prompt 1: an `Edit` tool call on `p1.txt`, no permission request, no file, reply "Write permission denied: Blocked by permissions configuration".
- `cli.json` rewritten to `{"permissions":{"allow":[],"deny":[]}}`. Prompt 2: an `Edit` tool call on `p2.txt`, no permission request, no file (`files: p1.txt exists=false, p2.txt exists=false`), the same reply.

The running process kept enforcing the deny that was removed. Caveats: a single run; the refusal text comes from the agent reply (the tool call `completed` has no `rawOutput`); there was no baseline prompt without any deny.

Consequence for Slice 6: **apply the fallback.** Rewriting `.cursor/cli.json` on toggle is not enough for a running Cursor worker. Mark each live Cursor worker for a relaunch through ACP `session/load` at its next idle turn boundary (`n4-load.jsonl` shows `session/load` in a new process works). Still write the files, so the relaunch and later launches read the right set. This applies in both directions (turning skip off must relaunch too, or the lifted denies stay lifted).

## K4 (Cursor, real): the push asks; a project allow skips the ask

- A, no `Shell(git push)` deny, `allow: []`: Cursor sent `session/request_permission` for `` `git push origin HEAD:refs/heads/k4-a` `` (kind `execute`, content "Shell allowlist is empty", options `allow_once`, `allow_always`, `reject_once`). The recorder answered `{"outcome":"selected","optionId":"reject-once"}`. The agent's reply: "The push did not run: it was rejected with `User rejected`." The bare remote had no branch. Proven: with the publish deny removed, `isPublishAction` will see a normal ACP request, and a rejection reads as "User rejected" to the agent.
- B, a fresh process with the project `cli.json` `{"permissions":{"allow":["Shell(git push)"],"deny":[]}}`: no permission request; the push ran (`"exitCode":0`, `* [new branch] HEAD -> k4-b`) and the remote had `k4-b`. Proven for a project-level allow.
- User-level allow: **unproven.** `~/.cursor/cli-config.json` was not edited, as required. Hint only: the user's config has `Shell(ls)` allowed, yet request A said "Shell allowlist is empty", so a project `permissions` block (Arc's file always writes `allow: []`) may replace the user's allow list. A user-level `Shell(git push)` allow was not tried.

Consequence for Slice 6: **keep the publish denies whenever `BypassDetector` reports an allow entry** (and a hook or a non-allowlist mode), as the tech spec says; an allow that reaches Cursor lets the push through without asking, so the entries `Shell(git push)`, `Shell(gh)`, `Shell(glab)` must stay and the "blocked from pushing" note is written. The detector must also look at a project-level `.cursor/cli.json` the repository commits itself (Arc leaves that file alone), because that allow is proven to skip the ask. With no bypass reported, dropping the publish denies is safe: the push becomes a request in Needs attention. Whether a user-level allow is honoured when Arc's file says `allow: []` stays unproven, so the detector should stay conservative for the user-level report.

## K5 (Claude, real): proven

Process 1 created the session with the worker's flags, deny rules included (`--session-id`, `--permission-mode acceptEdits`, `--add-dir <other>`, `--disallowedTools Edit(/<TMP>/other/**) Write(...) NotebookEdit(...)`): result `success`, text "ok". Process 2 was `--resume <id>` with the same flags and no `--disallowedTools`; the prompt asked for `Read` then `Edit` on `<other>/notes.txt`. The stream shows:

```
Edit  {"file_path":"<TMP>/other/notes.txt","old_string":"status: old","new_string":"status: new"}
      -> is_error false: "The file <TMP>/other/notes.txt has been updated successfully."
result: subtype success, permission_denials [], permissionMode acceptEdits, additional_directories ["<TMP>/other"]
file after: "status: new"
```

No permission prompt or denial; the conversation id was the resumed one. A fresh tiny session counted as the created session; no `--permission-prompt-tool` was needed because a prompt would have shown as a `permission_denials` entry.

Consequence for Slice 7: the design holds. A `--resume` relaunch without `denyEditRules` for the knowledge folder and other checkouts lets edits into those `--add-dir` folders through under `acceptEdits`, and they reach Arc as neither a request nor an event (as tech spec 2.5 already says). Not run (single run each): the control that the same flags with the deny rules do block the Edit, so the "deny blocks, no deny allows" contrast rests on the deny design, not on a recorded pair.

## Side effects to know about

- Cursor and Claude keep their own session files for the scratch folders (`~/.cursor/...`, `~/.claude/projects/...`); the scripts wrote nothing there and the user's `cli-config.json`, `~/.codex`, `~/.claude/settings.json` were not edited.
- The Codex scripted runs used a temp `CODEX_HOME` and `HOME`; the user's `~/.codex` was not read.
