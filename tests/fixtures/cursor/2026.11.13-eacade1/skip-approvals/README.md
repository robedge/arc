# Cursor skip-approvals spikes K3 and K4 (spec 015, Slice 4)

Run on 2026-11-15 with Cursor `agent` 2026.11.13-eacade1 (`agent --version`), Free tier, model Auto (`default[]`), ONE run per
spike, approved by the user on 2026-11-15. `scripts/spike-015-cursor.mjs` speaks ACP to `agent acp` as `record-cursor.mjs`
does: `initialize`, `authenticate cursor_login`, `session/new {cwd, mcpServers: []}` (default `agent` mode),
`session/set_model default[]`, `session/prompt`. Every `session/request_permission` is answered `reject_once` (by option kind).
All work is in `mktemp` directories (throwaway repos; the only push goes to a local bare repo in the same root). `~/.cursor` is
not written by the script (Cursor keeps its own session files there); the user's own `cli-config.json` was not edited.

Commands: `node scripts/spike-015-cursor.mjs --confirm-real-run --scenario k3` and `... --scenario k4`
(a `--dry-run` that only does the handshake was run first for each).

Files: `k3.jsonl`, `k4.jsonl`: every JSON-RPC line (`c2s`/`s2c`, `t` in ms, `proc` A or B), plus `note` lines that record the
`cli.json` content at each step and each prompt's result. Scrubbed: temp root `<TMP>`, home `/Users/user`, email, session and tool
call ids renamed, the command list trimmed to three entries.

## K3: is `cli.json` re-read between prompts of one process? (disproven)

One process, one session, two prompts asking the file edit tool (not the shell) to create `<other>/p1.txt` then `<other>/p2.txt`
(`<other>` is a temp dir outside the repo).

1. `cli.json` = `{"permissions":{"allow":[],"deny":["Write(<TMP>/k3-other/**)"]}}`. Prompt 1: an `Edit` tool call on `p1.txt`,
   no permission request, no file; reply "Write permission denied: Blocked by permissions configuration".
2. `cli.json` rewritten to `{"permissions":{"allow":[],"deny":[]}}`. Prompt 2, same process and session: an `Edit` tool call on
   `p2.txt`, no permission request, no file; reply again "Write permission denied: Blocked by permissions configuration".

Result: the deny was **not** re-read; the removed entry still blocked the write. Caveat: the tool call `completed` carries no
`rawOutput` in either prompt, so the refusal text comes from the agent's reply, and no baseline prompt without any deny was run
(single run). The fresh-process case was not run here (K3 is only about a running process); earlier spike N4 showed a
`session/load` in a new process works (`n4-load.jsonl`).

## K4: does `git push` ask, and does an allow skip the ask?

- **A (proven): with no `Shell(git push)` deny and `allow: []`, the push asks.** `session/request_permission` for
  `` `git push origin HEAD:refs/heads/k4-a` `` (kind `execute`, content text "Shell allowlist is empty", options `allow_once`,
  `allow_always`, `reject_once`). Answered `reject_once`. What the agent saw and said: "The push did not run: it was rejected with
  `User rejected`." The tool call then `completed`; the bare remote had no branch.
- **B (proven for a project-level allow): a fresh process, project `cli.json` `{"permissions":{"allow":["Shell(git push)"],"deny":[]}}`
  skips the ask.** No `session/request_permission` was sent; the push ran (`exitCode 0`, `* [new branch] HEAD -> k4-b`), and the
  remote had `k4-b`.
- **User-level allow: unproven.** Editing `~/.cursor/cli-config.json` was out of bounds. Observation only: the user's config holds
  `allow: ["Shell(ls)"]`, yet request A said "Shell allowlist is empty" (the project file's `allow: []`), which hints that a project
  `permissions` block replaces the user's allow list. `git push` against the user's allow list was not tried.
