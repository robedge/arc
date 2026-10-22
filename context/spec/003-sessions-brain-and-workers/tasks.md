# Tasks: Sessions with a Brain and Workers

Verify tasks drive the built app with throwaway Playwright `_electron` scripts that launch `out/main/index.js` with `HARNESS_USER_DATA=<temp dir>`, `HARNESS_E2E=1` and `HARNESS_CLAUDE_BIN=tests/e2e/fixtures/fake-claude.mjs`. The fake CLI plays a scenario script, so no Verify task uses the user's subscription. The only real CLI call is the Slice 1 spike.

Every Verify task does the following:

- Uses temporary git repositories made by the fixture helper.
- Saves screenshots to the session scratchpad, never the repo.
- Ends by stopping the app and every fake or real `claude` process it started, by recorded PID.
- Deletes its scripts, screenshots, temporary repositories and temporary userData folders.

- [x] **Slice 1: Sessions tab and Claude Code check**

  > A group opens on a new Sessions tab, placed first, with an empty state and a New Session button. Arc checks whether Claude Code is installed and signed in. The tab shows the matching banner with Retry when it isn't. The engine's CLI facts are confirmed and recorded.
  - [x] Run spike S0 (tech spec §2.1) against the real CLI. The user has approved one short `--model haiku` session.
    - Confirm the `--permission-prompt-tool` request and response shape.
    - Confirm that the stream-json `control_request` interrupt keeps the process alive.
    - Confirm whether `MCP_TOOL_TIMEOUT` is honored.
    - Confirm that plan mode plus `mcp__arc__*` in `--allowedTools` still allows bridge calls.
    - Confirm whether `--verbose` is needed.
    - Save the recorded streams to `tests/fixtures/claude/2.1.302/`: a text turn, a tool turn, an interrupt, a permission prompt and an auth failure.
    - Write the findings into the tech spec §2.1 table. If a finding contradicts the design, stop and report it before changing anything.

    **[Agent: agent-orchestration]**
  - [x] Add `src/main/agents/cli-resolver.ts`:
    - Login-shell PATH resolution, using sentinels, a 3 s timeout, a static fallback list and a cache.
    - The `HARNESS_CLAUDE_BIN` override, honored only in e2e and dev.
    - `checkClaude()`, returning ok, missing, signed-out or error from `--version` and `auth status --json`.

    Add the `cli:retry-check` channel and the `cli:status` event to the contract. Wire the check at startup in `bootstrap.ts`. Add unit tests for PATH parsing and each state. **[Agent: electron-main]**
  - [x] Add `tests/e2e/fixtures/fake-claude.mjs`:
    - It answers `--version` and `auth status` from `FAKE_CLAUDE_AUTH`.
    - It replays NDJSON scenario scripts (`delay`, `emit`, `waitForStdin`, `exit`, `hang`).
    - It logs argv and stdin to `FAKE_CLAUDE_LOG`.

    Add a git fixture helper for e2e and unit tests that creates temporary repositories with `git init -b dev`, `GIT_CONFIG_GLOBAL=/dev/null` and a fixed author. It also makes a dirty repository, one without `dev`, and a non-git folder. **[Agent: electron-main]**
  - [x] Add the Sessions tab:
    - A `SECTION_SESSIONS` sentinel, hard-coded first in `SectionNav`.
    - The `ui.activeSectionId` fallback changed to Sessions, while `storage.missing` still forces Projects.
    - `sessions/SessionsTab.svelte`, with an EmptyState and a New Session button that is disabled for now.
    - `sessions/CliBanner.svelte`, using the four texts from tech spec §2.11 and a Retry button.

    Update `tests/renderer/section-nav.test.ts` and add renderer tests for the default tab and each banner state. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build. Run the full unit, renderer and e2e suites; the spec 001 and 002 specs must still pass.
    - Launch with the fake CLI and `FAKE_CLAUDE_AUTH=ok`. Selecting a group opens the Sessions tab first, and no banner shows.
    - Relaunch with `FAKE_CLAUDE_AUTH=out`. The signed-out banner shows the exact text.
    - Switch the fake CLI to ok and click Retry. The banner clears.
    - Point `HARNESS_CLAUDE_BIN` at a missing file. The "isn't installed" banner shows.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Start a session and chat with the brain**

  > The user starts a session from the New Session dialog. The fixed-height session screen opens, and the brain's reply streams in word by word. The user can stop a reply, keep chatting, and see the session get a short name. There are no workers or branches yet.
  - [x] Add the Drizzle schema and repositories for `sessions`, `messages` and `events` (tech spec §2.8). Generate migration `0005_sessions_brain_workers` with only these tables for now; later slices add theirs in new migrations. Add repository unit tests against a temporary SQLite file, covering create, page and streaming flush. **[Agent: sqlite-database]**
  - [x] Build the agent layer:
    - `claude-parser.ts`, the normalized `AgentEvent`, with fixture tests from Slice 1.
    - `agent-adapter.ts` and `claude-adapter.ts`, with brain arguments per tech spec §2.3 (the `--mcp-config` flag is left off until Slice 5).
    - `process-supervisor.ts`: process group, env allowlist, NDJSON splitting, stderr ring, the interrupt-to-SIGINT-to-kill ladder, and exit classification.

    Add unit tests with a tiny fake child script. **[Agent: agent-orchestration]**
  - [x] Add `session-service.ts` and a first `orchestrator.ts`:
    - Create, list, open (snapshot) and rename.
    - Send a message, and stop a reply.
    - Brain naming, and `deriveName`.
    - The batcher, used for `session:brain-delta` and `session:message`, with a `seq` on each push.
    - Message persistence, flushing at most every 1 s or 2 KB.

    Add the matching channels and events from tech spec §2.9, and a CLI-unavailable error that keeps the draft. Add unit tests with a fake adapter. **[Agent: electron-main]**
  - [x] Add `NewSessionDialog` with validation and defaults, and `SessionRow` list entries. Add `SessionScreen` with its grid layout, `SessionHeader` (name with inline rename), `Conversation` (stick to the bottom, "Jump to latest", "Load earlier"), `MessageBubble` (plain text while streaming, markdown when complete, a "Stopped" tag) and `Composer` (Enter to send, Shift+Enter for a new line, Stop).

    Also add:
    - `BrainCard`, with the new `RingLogo spinning` prop.
    - The `MarkdownPreview` `copyCode` option, so code blocks get a Copy button.
    - The `stream-buffer` and `active-session` stores, with event routing in `App.svelte`.
    - Design Preview entries.
    - Renderer tests from the tech spec §4 list for these components.

    **[Agent: svelte-frontend]**
  - [x] Verify, using a fake CLI scenario that streams a titled reply containing a code block:
    - Start a session with an empty request. "Enter a request for the brain." shows.
    - Start one with "Why is the orders report slow?". The screen opens, the reply streams in, the brain card shows "Thinking" and then Idle, and the session gets a short name.
    - Shift+Enter makes a new line. Enter sends.
    - Stop halts a "hang" scenario and marks the reply Stopped.
    - Copy shows "Copied".
    - At 1100×720 every part of the screen is visible, and only the conversation scrolls.
    - Rename the session. The new name shows in the header and the list.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: Sessions are saved, reopened and deleted**

  > The Sessions tab lists sessions newest first, with a status. Reopening a session after quitting shows the conversation as it was within 10 seconds, and the brain remembers the earlier conversation. Sessions can be deleted.
  - [x] Store `brain_claude_session_id` from the `init` event. Lazily respawn the brain with `--resume` on the next message after reopening. Add `sessions:delete` (stop processes, cascade, remove `userData/sessions/<id>/`) and `sessions:page`. Add the derived list status (Working, Needs attention, Idle, Stopped) and the `session:summary` event. Startup recovery marks `streaming` messages `stopped`. Add unit tests. **[Agent: electron-main]**
  - [x] Add the row menu with Rename and Delete, and `DeleteSessionDialog` with the wording from the functional spec. Add the `sessions-list` store and wire it to `session:summary`. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Create two sessions. The list is newest first and shows each status.
    - Quit, relaunch and open the first session. The conversation is back within 10 s.
    - Send a follow-up. The fake CLI log shows `--resume <id>`.
    - Delete a session. It disappears from the list.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: The session branch and unsaved-changes dialog**

  > Starting or reopening a session puts each git project on `arc/<slug>`, created from `dev` or the main branch. A repository with unsaved changes asks the user to choose Set aside, Commit them first, Bring them along or Cancel. Non-git projects show as Read only.
  - [x] Add the `session_projects` table, its repository and a new migration. **[Agent: sqlite-database]**
  - [x] Add `src/main/git/git.ts`, an allowlisted wrapper using the `ExecFn` pattern, and `session-git.ts`:
    - Base-branch detection with its fallbacks.
    - The slug, including the collision suffix.
    - The `status --porcelain` dirty check.
    - The four choices, with Cancel rolling back repositories already switched.
    - Checkout on reopen.

    The branch is created after the brain names the session. Add unit tests against real temporary repositories. **[Agent: agent-orchestration]**
  - [x] Wire `needsDirtyChoice` and `sessions:resolve-dirty` into create and open. Add `DirtyTreeDialog`, the header branch chip (`arc/x ← dev`) and the "Read only" chips. Add the session-branch delete warning to `DeleteSessionDialog`. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify, with fixture repositories (api on `dev`, web without `dev`, a dirty repository, a plain folder):
    - Start "Fix order sync". The header shows `arc/fix-order-sync ← dev`, and the api checkout is on that branch.
    - web is created from its main branch.
    - The dirty repository opens the dialog with all four choices.
    - Cancel leaves every repository on its original branch with its changes still in place.
    - Set aside creates a stash.
    - The plain folder shows as Read only.
    - After deleting the session, the branches still exist.
    - Clean up as described above.

    **[Agent: agent-orchestration]**

- [x] **Slice 5: Plan-first plans and workers in their own working copies**

  > In Plan-first mode the brain posts a plan card. The user can change models, ask for changes or reject. Approving starts the workers, each in a detached worktree. Worker cards show live status, details and Stop, and the event log records what happens.
  - [x] Add the `plans`, `workers`, `worker_worktrees` and `worker_commits` tables, their repositories and a new migration. Add unit tests, including `nextNumber`. **[Agent: sqlite-database]**
  - [x] Add the MCP bridge:
    - `@modelcontextprotocol/sdk`, pinned exactly.
    - `bridge-server.ts`: streamable HTTP in stateless mode on `127.0.0.1:0`, a Host check, per-agent tokens, tools filtered by role, and 0600 config files.
    - Tools: `propose_plan` (blocking), `spawn_worker`, `message_worker`, `get_worker_status`, `report_progress` and `report_done`.

    In the orchestrator, add:
    - the plan-first gate;
    - effective-model resolution, with a known-alias check;
    - worker adapters (cwd is the worktree, with `acceptEdits`);
    - detached `git worktree add` at the session-branch tip, recording the HEAD sha after each commit;
    - worker exit classification (Done, Stopped or Failed, with a reason);
    - Stop.

    Extend the fake CLI so it makes MCP tool calls against the real bridge. Add unit tests for the gate, model precedence and exit handling. **[Agent: agent-orchestration]**
  - [x] Add the brain model picker on the main side:
    - a `sessions.brain_model` column (default `'sonnet'`) in a new migration;
    - `brainModel` in `sessions:set-config` and the header;
    - `resolveBrainModel` uses `brain_model` and no longer the worker `model`;
    - a change applies on the next turn by respawning with `--resume <id> --model <new>` once the current reply ends.

    Add unit tests. **[Agent: electron-main]**
  - [x] Add the `sessions:plan-decision`, `workers:get` and `workers:stop` channels, and the `session:plan`, `session:worker-changed` and `session:event-logged` events with their throttling. **[Agent: electron-main]**
  - [x] Add:
    - `PlanCard`: model `Select` per worker; Approve, Ask for changes (focuses the Composer) and Reject; Replaced and Rejected states.
    - `AgentColumn` and `WorkerCard`, using the `worker-status.ts` word and tone map.
    - `WorkerDetails`, with Stop behind a confirmation.
    - `EventLog`.
    - The header worker-model menu ("Workers · Auto") and the brain-model menu ("Brain · Sonnet").
    - Design Preview entries.
    - Renderer tests.

    **[Agent: svelte-frontend]**
  - [x] Verify, using a Plan-first fake scenario with two workers:
    - The plan card lists the name, task, projects and model for each worker, and no worker cards exist yet.
    - Change one model and Approve. The cards show Working, then Done, with the chosen model.
    - The worktrees exist under userData, detached at the session-branch tip.
    - Ask for changes replaces the plan, and Reject leaves no workers.
    - Setting the worker model forces that model on every worker.
    - Changing "Brain · Sonnet" to Opus while a reply streams: the reply finishes, the next brain run in the fake CLI log has `--resume <id> --model opus`, and the header shows "Brain · Opus".
    - Stopping a worker shows Stopped and logs "Stopped by you".
    - A crash scenario shows Failed with a reason, and the brain posts its next step.
    - Clean up as described above.

    **[Agent: agent-orchestration]**

- [x] **Slice 6: Autonomous mode, worker limit and switching modes**

  > In Autonomous mode the brain starts workers itself, up to the worker limit. Extra workers wait as Queued. The user can switch modes and change the limit from the header.
  - [x] In the orchestrator:
    - Count running workers against `worker_limit`, and store extra workers as `queued`.
    - Drain the queue whenever a worker leaves a running status.
    - Apply `sessions:set-config` changes to mode and limit to the next `spawn_worker`.

    Add unit tests. **[Agent: agent-orchestration]**
  - [x] Add the header mode and limit menu ("Autonomous · Limit 3") and the Queued card state. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - In an Autonomous session with limit 2, the brain asks for 3 workers. Two cards show Working and one shows Queued; the queued one starts when a worker finishes.
    - Switching a Plan-first session to Autonomous keeps running workers going, and the next workers start without a plan card.
    - Clean up as described above.

    **[Agent: agent-orchestration]**

- [x] **Slice 7: Approvals and questions reach the user**

  > A worker's permission request or question goes to the brain first. What the brain can't decide, or isn't allowed to, reaches the user through the Needs attention badge, the amber card, a macOS notification and the group's amber dot. Requests survive quitting.
  - [x] Add the `attention_requests` table, its repository (with the pending partial index) and a new migration. **[Agent: sqlite-database]**
  - [x] Add `src/main/policy/classify.ts`: a shell-word tokenizer, the four categories, and escalation for anything unparsable. Add a unit table of at least 60 commands, including false positives.

    Add these bridge tools:
    - `request_permission`, wired as `--permission-prompt-tool`, using the response shape confirmed in S0;
    - `ask_brain`;
    - `resolve_request`, which returns `policy_requires_user` for requests that must go to the user;
    - `escalate_to_user`;
    - `ask_user`.

    Escalate automatically when the brain hasn't acted after 60 s. Send progress notifications every 20 s and set `MCP_TOOL_TIMEOUT`. Add unit tests. **[Agent: agent-orchestration]**
  - [x] Add `attention-service.ts` (persistence, counts per session and group, `attention:answer`, `sessions:attention-summary`) and `notification-service.ts` (fires only when no window is focused, deduplicated by request). A click focuses the window and sends `session:open-attention`, with a pending-navigation buffer. Add the e2e stubs `__e2e.notifications` and `clickNotification`. Add unit tests. **[Agent: electron-main]**
  - [x] Wire the header `AttentionBadge` and `AttentionDialog` to live requests, and add its `initialRequestId` prop. A WorkerCard in an attention state opens the dialog with its own request first. Add the GroupSidebar amber dot, using `sessions-list` counts loaded at startup. Add `navigateToAttention()`, with a toast if the leave guard refuses. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify, with fake scenarios:
    - A question the brain answers from notes: the worker continues and no badge appears.
    - A request to run `git push origin arc/fix-order-sync`: the badge shows "Needs attention 1" and the card shows Needs approval. Approve clears both.
    - A request to run `brew install`: it reaches the user even though the plan mentions it.
    - A denied request: the event log shows "Denied by you".
    - An answered question: the answer is logged.
    - With the app in the background, a stub notification fires, and clicking it opens the dialog.
    - The amber group dot shows while a request is pending.
    - After quitting and reopening, the request and badge are still there.
    - Clean up as described above.

    **[Agent: agent-orchestration]**

- [x] **Slice 8: Merging work, conflicts and sharing between workers**

  > Finished workers are merged into the session branch one at a time, and their cards turn Merged. Conflicts are resolved by a resolver worker, which asks the user only when it isn't confident. One worker's change can be shared with another. The brain ends with a summary, and the user's checkout is updated only when it is clean.
  - [x] Add the `merges` table, its repository and a new migration. **[Agent: sqlite-database]**
  - [x] Add these git operations:
    - A per-repo merge queue.
    - A temporary detached `_merge` worktree, `merge --no-ff <head sha>`, and `update-ref` with the old-value check.
    - Fast-forwarding the user's checkout only when it is clean; otherwise defer, with an event-log note.
    - The resolver worker for conflicts, giving `resolved` or `needs_user`.
    - `sync_worker` into the dependent worktree, followed by a `message_worker` note.
    - Removing the worktree after a merge.
    - `git worktree prune` and a `_merge` sweep at launch.

    Add the `merge_worker` and `sync_worker` bridge tools. Add unit tests against real temporary repositories (clean merge, conflict, dirty checkout, sync). **[Agent: agent-orchestration]**
  - [x] Add the Merged card state, the event-log formats for merges, conflicts and sharing ("Resolved conflict in …", "Shared W1 → W3"), and the final summary message. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify, with fake scenarios and fixture repositories:
    - A Done worker is merged: the card shows Merged and the session branch contains its commit.
    - Two workers edit the same file: the conflict is logged as resolved, and both changes are on the branch.
    - An unresolvable conflict raises a Needs attention question that names the file.
    - Sharing W1 → W3 is logged, and W3 has the change.
    - The final summary lists the changes and commits per repository.
    - A dirty user checkout is not touched and the event log says so.
    - Merged worktrees are removed.
    - Clean up as described above.

    **[Agent: agent-orchestration]**

- [x] **Slice 9: Watching a worker's terminal**

  > Open terminal shows a worker's live output as a readable, watch-only log, including the full output of a finished worker.
  - [x] Add `terminal-log.ts`: a plain-text transcript built from `AgentEvent`s and stderr (ANSI stripped), written to `userData/sessions/<sid>/workers/<wid>.log`, with a 1 MB tail in memory and a 20 MB cap on each file. Add the `workers:open-terminal` channel and the `worker:terminal` event (batched, with `seq`). Add unit tests. **[Agent: electron-main]**
  - [x] Add tabs to the conversation area: a permanent "Brain" tab plus one closable tab per opened worker terminal ("W1 · api-retry"). Add `TerminalPanel`, a monospace `role="log"` view that renders only the visible lines, follows the tail and ignores typing, shown in the worker's tab. Clicking a worker card opens or switches to its tab; amber cards still open Needs attention; a Details button on the card and in the tab header opens `WorkerDetails`. Add a Design Preview entry and renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Clicking a running worker's card opens its tab next to "Brain", and new lines arrive. Switching back to "Brain" and closing a tab work. The Details button opens details without opening a tab.
    - Typing sends nothing; the fake CLI's stdin log is unchanged.
    - A finished worker shows its full output.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 10: Quitting and continuing work**

  > Quitting stops every agent cleanly within 8 seconds. On reopening, the brain asks whether to continue stopped workers. Paused requests resume once answered, orphaned processes from a crash are cleaned up, and rate limits pause the work instead of failing it.
  - [x] Add `sessions.shutdown()` in `will-quit`, following tech spec §2.10: write Stopped with `stopped_by='quit'` first, settle bridge calls, run the kill ladder, revoke tokens and delete configs, with an 8 s ceiling. Add startup recovery (`stopped_by='crash'`, keeping `needs_approval` and `has_question`) and the `pids.json` ledger with its `ps lstart` and command check before any kill. Add unit tests. **[Agent: electron-main]**
  - [x] Add `workers:continue`:
    - Respawn with `--resume <workerClaudeSessionId>` in the existing worktree and send the continue prompt.
    - Deliver answers to requests that are already resolved as a user turn after the resume.
    - Handle rate limits: a "Waiting for limit" activity line, a paused queue, and a retry after `resetsAt` or 5 minutes, with no retry loop.

    Add unit tests. **[Agent: agent-orchestration]**
  - [x] Add `ContinueWorkersPrompt` (Continue and Not now) and a Continue button on stopped workers in `WorkerDetails`. Add renderer tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Quit with two Working workers. The quit finishes within 8 s and no `claude` processes are left.
    - Reopen the session. Both workers show Stopped and the prompt asks "2 workers were stopped when Arc closed. Continue them?".
    - Continue. Both return to Working, and the fake CLI log shows `--resume`.
    - A worker that was paused on a request stays paused until it is answered, then resumes.
    - Kill Arc with SIGKILL while a fake worker is running, then relaunch. The orphan is cleaned up, and a recycled-PID decoy process is left alone.
    - A rate-limit scenario shows "Waiting for limit".
    - Clean up as described above.

    **[Agent: electron-main]**

- [x] **Slice 11: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 003-sessions-brain-and-workers` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- Real macOS notification display and click (2.7, last criterion): the e2e specs use the `__e2e.notifications` and `clickNotification` stubs, so they prove that Arc raises one deduplicated notification per request while no window is focused and that the click opens the session with the dialog. They cannot prove that macOS draws the banner, that the system permission prompt is answered, or that the click focuses the window from another app. Needs a manual check on a signed build.
- Real Claude CLI behavior (2.1 session naming, 2.4 word-by-word streaming, 2.5 model choice by task difficulty, 2.5 brain on Opus "remembering" the conversation, 2.2 the brain's explanation in a group with no projects): the specs use `tests/e2e/fixtures/fake-claude.mjs`. They prove Arc's side (the title line becomes the name, `--model opus` and `--resume <id>` are passed, streaming text is shown as it arrives) but not what the real model writes or whether a real resumed session recalls the earlier turns. Needs a manual check against the real CLI.
- Keychain / sign-in prompt (2.4): the signed-out banner is driven by the fake `auth status` answer. The real Claude Code sign-in, the macOS keychain prompt and the Retry after a real sign-in are not automated.
- Rate limits and "Waiting for limit" (slice 10) are covered by unit tests only; no e2e spec makes a real CLI report a limit.
- Spec wording: the event for a stop with unmerged commits is logged singular for one commit ("(1 unmerged commit discarded)"), while 2.6 writes "(N unmerged commits discarded)". The e2e test asserts the singular form; this reads as intended, but the spec text could say "commit(s)".
