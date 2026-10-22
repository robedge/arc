# Tasks: Stepping In on a Worker

Verify tasks drive the built app with throwaway Playwright `_electron` scripts. They launch `out/main/index.js` with:

- `e2eEnv(userDataDir)`, which sets `HARNESS_E2E=1` and `HARNESS_E2E_OFFSCREEN=1`, so windows open off-screen;
- `HARNESS_CLAUDE_BIN=tests/e2e/fixtures/fake-claude.mjs`.

The fake CLI plays brain and worker scenario scripts. It acknowledges `control_request` interrupts and logs every stdin line to `FAKE_CLAUDE_LOG`. No task makes a real model call or changes the user's `~/.claude`.

Every Verify task does the following:

- Uses temporary git repositories and a temporary userData folder.
- Saves screenshots to the session scratchpad, never the repo.
- Ends by stopping the app and every fake process it started, by recorded PID.
- Deletes its scripts, screenshots, temporary repositories and userData folders.
- Runs full test suites one after another, never in parallel.

- [x] **Slice 1: Step in, type to the worker, hand back**

  > A worker's terminal tab gets Step in. Clicking it stops the worker's current step and shows "You stepped in" with an input line. The card and tab show "You're in control". Typed lines reach the worker and its replies appear, and Escape stops a reply. Hand back returns the tab to watch-only and the worker carries on. Approvals, the brain lockout and quitting come in later slices.
  - [x] Add migration `0022_worker_user_control.sql` (tech spec §2.2):
    - on `workers`: `user_control`, `control_started_at`, `control_user_messages` and `control_last_message`;
    - `worker_worktrees.control_base_sha`;
    - `attention_requests.route`, default `queue`;
    - the `worker_held_messages` table with its index and cascades.

    Define `UserControl` and `AttentionRoute` once in the schema, mirror them in `shared/types/session.ts`, and add a test that checks the two copies match.

    Add the repository functions:
    - `WorkersRepo`: `beginControl`, `setControl`, `endControl`, `recordControlMessage`, `listControlled`, `pauseAllActiveControl`;
    - `WorktreesRepo`: `setControlBase`, `listControlBases`, `clearControlBase`;
    - `HeldMessagesRepo`: `enqueue`, `listUndelivered`, `markDelivered`.

    Write repository tests. **[Agent: sqlite-database]**
  - [x] Implement the core control flow in the worker manager (tech spec §2.1 and §2.4):
    - `canStepIn`: `starting`, `working`, `needs_approval` or `has_question`; no resolvers; not already controlled.
    - `stepIn`: record the heads and `control_base_sha`; persist `active` and set `controlActive` before the interrupt; clear the helper timers and the rate-limit gate entry; call `interrupt()`, storing `paused` if the outcome is `killed` or there is no process.
    - `controlActive` guards in `onTurnResult` and in `settleTurn` itself: no nudge, failure or stop while controlled. Track `controlReplying`.
    - `sendInput`: verbatim `handle.send`, update the message counter and the last-message excerpt.
    - `interruptControlled`.
    - A basic `handBack`: clear control and send the tech spec's hand-back text. The held messages and the summary come in Slice 3.
    - Terminal log lines through `TranscriptFormatter`: "You stepped in", `> text`, "Interrupted" and "You handed back".
    - `user-control` events with "You stepped in on <label>" and "You handed <label> back".
    - `notifyBrain` notes at step-in and at hand-back.
    - `userControl` and `controlReplying` on `WorkerView` and `WorkerDetails`.

    Add the IPC channels `workers:step-in`, `workers:hand-back`, `workers:send-input` (1 to 20,000 characters) and `workers:interrupt` to the contract and wire them through the orchestrator.

    Write unit tests for eligibility, step-in order, the guards (including a late turn result and a helper timer firing), `paused` after `killed`, slash text passed verbatim, and hand-back. Extend the fake CLI only if a scenario step is missing. **[Agent: agent-orchestration]**
  - [x] Build the renderer side (tech spec §2.5):
    - `worker-status.ts`: `STEPPABLE`, `canStepIn` and `controlLabel`.
    - The worker tab header in `ConversationTabs.svelte`: Step in before Details, busy while it runs; Hand back when controlled; the control chip.
    - `WorkerCard.svelte`: the control label with `data-worker-control`, and no attention tone while controlled.
    - New `StepInBar.svelte` with the input line:
      - its own textarea, id `worker-input-{id}`, labelled "Message to <label>";
      - the slash-menu logic lifted out of `Composer.svelte` into a shared helper, reusing `CommandMenu` and `filterCommands`;
      - Enter sends and Shift+Enter inserts a new line, with IME composition ignored;
      - Escape closes the menu, then interrupts only while `controlReplying`;
      - a draft kept per worker.
    - New `stores/worker-control.svelte.ts`: `stepIn`, `handBack`, `sendInput` and `interrupt`, with drafts, errors and `reset()`.
    - Focus moves to the input on Step in and back to the Step in button on Hand back.
    - Design Preview states.

    Write jsdom tests:
    - new: `worker-step-in.test.ts`;
    - extended: `worker-status.test.ts`, `worker-terminal-tabs.test.ts` and the input label in `a11y-sweep.test.ts`.

    Run `composer.test.ts` and `command-menu.test.ts` unchanged. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build. Run lint, typecheck, format check and the full unit and e2e suites; specs 001–005 must still pass.
    - Autonomous session, one repository, a fake worker in a long `delay`:
      - Open its tab and click Step in. The fake CLI log shows an interrupt `control_request`, the tab shows "You stepped in" and an input line, the card shows "You're in control", and the event log shows "You stepped in on W1 · …".
      - No "report_done" nudge reaches the worker's stdin.
      - Type "What have you changed so far?" and press Enter. The line is echoed, the fake worker's scripted reply appears, and the stdin log holds the line verbatim.
      - A typed `/awos:spec x` reaches stdin verbatim.
      - Press Escape during a scripted long reply. An interrupt is logged and "Interrupted" shows.
      - Click Hand back. The tab is watch-only again, the hand-back text is on stdin, the worker finishes and merges, and the event log shows "You handed W1 · … back".
    - A finished worker's tab shows no Step in button.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Approvals and questions in the terminal**

  > While the user is in control, risky actions and worker questions show as cards above the input line, with Approve and Deny or an answer box, instead of in Needs attention. The brain can't answer them. A question that was already waiting moves out of Needs attention into the terminal.
  - [x] Implement attention routing (tech spec §2.4):
    - `AttentionCoordinator.routeToTerminal(workerId)` at step-in: `route='terminal'` and `escalated=true`, and the brain timer cancelled.
    - New `requestPermission`, `requestQuestion` and `askBrain` calls from a controlled worker still run classification, coverage, allow rules and Auto-approve, which never covers protected actions. Anything that would ask is created with `route='terminal'`, with no brain timer and no brain note. An `ask_brain` answer from the user becomes the tool result.
    - `resolveRequest` on a terminal request throws `not_resolvable`.
    - `routeBack(workerId)` at hand-back.
    - The Needs-attention list, the badge and the counts filter on `route='queue'`, and `route` is added to the attention view.

    Write unit tests for each path, including a pending push at step-in, which stays blocked until it is answered. Add a fake CLI scenario: a worker `tool` step with `Bash git push`. **[Agent: agent-orchestration]**
  - [x] Pin the terminal requests in `StepInBar.svelte` above the input:
    - reuse `PermissionCard`, `QuestionCard` and `StructuredQuestionCard`, with `PermissionCard`'s Always-allow made optional and hidden here;
    - wrap them in a group labelled "Needs your answer";
    - answers go through the existing `attention:answer`;
    - the store splits the pending requests by `route` and also hides any request whose worker is controlled from the Needs-attention view.

    Write jsdom tests, extending `attention-live.test.ts`. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites as in Slice 1.
    - A worker that is waiting on a push approval in Needs attention:
      - Step in. The badge clears, and the terminal shows the exact `git push …` command with Approve and Deny and no Always allow.
      - Approve. The push step continues.
    - While controlled, a new push request appears only in the terminal, and the brain's scripted `resolve_request` gets `not_resolvable`.
    - An `ask_brain` question while controlled is answered in the terminal, and the worker's next output reflects the answer.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: The brain waits; hand-back summary**

  > While the user is in control, the brain's messages to that worker are held and delivered after hand-back. Its merges are refused, nothing auto-merges, and a "done" from the worker waits for hand-back. At hand-back the brain gets a summary of the files changed and the user's messages.
  - [x] Implement the brain lockout and the full hand-back (tech spec §2.4):
    - **Held messages:** `message()` on a controlled worker enqueues the text in `worker_held_messages` and returns `{ delivered:false, queued:true }`. The `message_worker` result and description gain `queued`. `syncWorker`'s message is held the same way, while its merge into the worktree still runs.
    - **Merges:** `mergeWorker` refuses first with `worker_user_control` and the tech spec's message, and auto-merge skips controlled workers.
    - **`report_done` while controlled:** record it but don't stop. At hand-back, tell the worker it already reported done.
    - **Summary:** add `diffStatSince(path, sha)` in `src/main/git/`, run against the working tree so uncommitted edits count.
    - **Hand back, in full:** send the hand-back text, then each held message in order, and mark them delivered. The brain note includes the diffstat, the message count and the last excerpt.

    Write unit tests:
    - held messages queued, then delivered in order;
    - the merge refusal and the auto-merge skip;
    - `report_done` while controlled;
    - `diffStatSince` against a temporary repository, including uncommitted edits;
    - the text of the brain note. **[Agent: agent-orchestration]**
  - [x] Verify:
    - Build and run the suites as in Slice 1.
    - With W1 controlled and W2 running:
      - The brain's scripted `message_worker` to W1 does not reach W1's stdin, and its `merge_worker` on W1 gets `worker_user_control`.
      - W2 finishes and merges as usual.
      - The user tells W1 to "use 5 retries", and the fake worker edits a file.
      - Hand back. W1's stdin shows the hand-back text and then the held brain message, and the brain's stdin note lists the changed file and "1 message".
    - A worker that calls `report_done` while controlled keeps running until hand-back, then stops cleanly.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Leaving while in control**

  > Closing a controlled worker's tab asks "Hand W1 · api-retry back to the brain?" with Hand back, Keep it paused and Cancel. Quitting Arc leaves the worker paused: after reopening, its card shows "You're in control (paused)", and typing or Hand back resumes it. Details also offers Step in and Hand back.
  - [x] Implement quitting and recovery while controlled (tech spec §2.4):
    - `stopInterrupted` and `recoverInterrupted` skip controlled rows;
    - shutdown and startup run `pauseAllActiveControl()`, and the exit classifier treats a controlled exit as paused;
    - the AskUserQuestion cancellation at startup doesn't stop a controlled worker;
    - when the worker is paused, `sendInput` and `handBack` relaunch it with `--resume`, using the typed text or the hand-back text as the first message;
    - with no working copy left, typing returns `VALIDATION_FAILED`;
    - the user's Stop clears `user_control`.

    Write unit tests for startup recovery with an `active` row, the relaunch first message, and Stop. **[Agent: agent-orchestration]**
  - [x] Build the leaving flows in the renderer:
    - `requestClose(id)` on the tab close button and the Delete key opens a `Modal` titled "Hand <label> back to the brain?" with three outcomes:
      - **Hand back:** hands back, then closes the tab;
      - **Keep it paused:** closes the tab only;
      - **Cancel or Escape:** leaves the tab open.
    - If hand-back fails, the error shows through `ErrorText` and the dialog stays open.
    - The paused label, and Hand back offered whatever the worker's status.
    - Step in or Hand back in `WorkerDetails.svelte`. Step in also opens the tab and closes Details.

    Write jsdom tests: `worker-control-close.test.ts`, plus the details buttons. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites as in Slice 1.
    - Close a controlled tab:
      - The dialog shows the three buttons. Cancel keeps the tab open.
      - Keep it paused closes the tab, and the card still shows "You're in control".
      - Reopen the tab and choose Hand back from the close dialog. The worker carries on.
    - Quit while in control, then relaunch on the same userData:
      - The card shows "You're in control (paused)", and the worker is not marked stopped.
      - Type a line. The fake CLI log shows a `--resume` launch whose first message is that line.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 006-stepping-in-on-a-worker` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- Criteria 2.2 "the worker's answer refers to its earlier work" and 2.4 "later work uses 5 retries" describe model behaviour, which the fake CLI cannot show. `tests/e2e/worker-step-in.spec.ts` asserts the mechanism instead: the typed line reaches the same live conversation verbatim (no new launch; a `--resume` launch after a restart), and the hand-back turn follows it in that conversation. Whether the real model acts on the text needs a manual check with the real CLI. Accepted 2026-10-19 during /awos:verify: the scripted mechanism check stands.
- The functional spec shows the event log text as "You stepped in on W1 · api-retry" and "You handed W1 · api-retry back". The product logs "W1 api-retry" (no middle dot; the card, tab and close dialog do use the dot). The criteria only require the worker's name, so they pass; decide whether the spec text or the log text should change. Resolved 2026-10-19: the spec text now matches the log.
