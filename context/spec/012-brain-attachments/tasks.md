# Tasks: Attachments for the Brain

Conventions for every Verify task below, the same as specs 007 to 011:

- **Build and gates (targeted, per the user's 2026-10-20 instruction):** run `pnpm lint && pnpm typecheck && pnpm format:check`, then `npx electron-vite build`. Run only the tests the slice added or changed, plus the existing ones that cover files it touched (`ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run <name filters>`, `npx playwright test <files>`). Do NOT run the full unit or e2e suites in slice Verify tasks. They run once, in the last slice: `pnpm test:unit`, then `pnpm test:e2e`.
- **Tests come first:** write the failing test before the code it covers.
- **Fakes only:** the fake CLIs and a temp HOME (`HARNESS_CLAUDE_BIN`, `HARNESS_CODEX_BIN`, `HARNESS_E2E=1`, `HARNESS_USER_DATA`). Never run a real `claude`, `codex` or `agent` with a model turn, never touch `~/.claude`, `~/.codex`, `~/.cursor` or Arc's own data, and no network. **The only exception is Slice 1:** the three real turns S1, S2 and S3, approved by the user on 2026-11-12, one run each.
- **Names:** main-side types are `Attachment…` (`AttachmentService`, `AttachmentMeta`, `AttachmentRef`); attributes are `data-attachment…`. Sample text and file names must pass `tests/unit/name-denylist.test.ts`.
- **Test files:** small generated fixtures only (a few KB). Size-limit tests use a sparse or generated file in a temp folder, never a committed 20 MB file.
- **Clean up:** delete throwaway specs, screenshots outside `docs/screenshots/` and `test-results/`, revert any regenerated file under `docs/screenshots/` the slice did not mean to change, stop every process you started by its PID (never pipe a stop command into another command), and confirm `pgrep -fl "fake-claude|fake-codex|fake-cursor|fake-mcp"` is empty.

- [x] **Slice 1: Prove that each real brain can see an image and open an attached file**

  > Three real turns, one per provider, decide how attachments are delivered (tech spec 2.2). Nothing user-visible changes; the result is recorded fixtures and a confirmed capability table.
  - [x] S1, Claude: one real stream-json turn with a small base64 `image` block and a text block naming a PDF and a text file in an `--add-dir` folder, using the brain's flags. Record the raw output under `tests/fixtures/claude/attachments/` and note: did the model describe the image, did it read the PDF and the text file, and what did the replayed user event contain. Run once. **[Agent: agent-orchestration]**
  - [x] S2, Codex: confirm `localImage` in the pinned 0.162.1 schema (`codex app-server generate-json-schema`, no model), then one real `turn/start` with a `localImage` outside the cwd and a text file path in the attachments folder, under the brain's read-only sandbox. Record under `tests/fixtures/codex/0.162.1/attachments/`. Run once. **[Agent: agent-orchestration]**
  - [x] S3, Cursor: one real ACP `session/prompt` with an `image` block and a text file path outside the cwd (Auto model, Free tier). Record under `tests/fixtures/cursor/`. Run once. **[Agent: agent-orchestration]**
  - [x] Verify: write the three outcomes into tech spec 2.2 and 2.8 (the capability table, the fallbacks taken, the inline image limit), amend 2.9 if a provider cannot read outside its working directory, and list anything that failed under `## Open Questions` at the end of this file. Confirm the fixtures hold no secrets or account details and no real process is left running. **[Agent: agent-orchestration]**

- [x] **Slice 2: Attach a file to a message in an open session, send it, and see it on the message**

  > The Attach button opens the file picker, the file appears under the message box with its name and size, Send delivers it to a Claude brain as a listed path, and the sent message shows it. Images show as a name for now.
  - [x] Table `message_attachments` and column `workers.attachments_json` (tech spec 2.5), migration `0030` via `pnpm db:generate`, and `MessageAttachmentsRepo` (`insertMany`, `listForMessages`, `get`, `getMany`, `listForSession`). Unit tests: ordering, the batch load, cascades with message and session, CHECK violations, unique position, the migration on existing data. **[Agent: sqlite-database]**
  - [x] `src/main/attachments/`: `attachment-validate.ts` (all rules in tech spec 2.4), `AttachmentService` (`newDraft`, `stagePaths`, `pick`, `remove`, `discardDraft`, count under a per-draft lock), the staging folder layout, `src/shared/attachments.ts` (types, `ATTACHMENTS_MAX_PER_MESSAGE`), channels `attachments:new-draft | stage-paths | pick | remove | discard-draft`, construction in `build-services.ts`. Unit tests for every validation rule and refusal reason, name sanitising, symlinks, and concurrent adds; a handler test; update `all-handlers.test.ts`. **[Agent: electron-main]**
  - [x] Send path: `sessions:send-message` accepts `draftId` and `attachmentIds` and allows empty text with attachments; the send order in tech spec 2.6 (check, copy, one transaction, delete staged; a per-draft lock); `ATTACHMENT_UNREADABLE`; `SessionMessage.attachments` loaded with one extra query per page; the response returns the stored attachments. Unit tests: missing staged file, copy failure, insert failure, double send. **[Agent: electron-main]**
  - [x] Delivery, Layer 1: `AttachmentRef`, `AgentHandle.send(text, attachments?)`, `Orchestrator.send` and `sendToBrain` passing it through after pending notes, the session's attachments folder created with the session and always in the brain's `addDirs`, and the text block in the Claude adapter. Unit tests: the turn shape, notes ordering, `launchKey` unchanged by a message with attachments. **[Agent: agent-orchestration]**
  - [x] Renderer: `stores/attachments.svelte.ts`, `lib/attach-input.ts` (picker path only), `ui/AttachmentChip.svelte` and `ui/AttachmentRow.svelte` (name, size, remove; no thumbnail yet), `sessions/AttachField.svelte` in `Composer.svelte` with the paperclip `IconButton` ("Attach files"), the `paperclip` icon, `canSend` with attachments only, the draft surviving a session switch, and a read-only row in `MessageBubble.svelte`. jsdom tests; a11y sweep. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions): an e2e queues a text file and a PDF in the stubbed picker, sees both under the box, removes one, sends with no text, sees the attachment on the message, and finds the text block with the stored path in `FAKE_CLAUDE_LOG` and the folder in argv. A second run switches session before sending and finds the attachment still listed. **[Agent: electron-main]**

- [x] **Slice 3: Paste and drop, thumbnails and the full-size preview**

  > A pasted screenshot or a dropped file becomes an attachment. Images show a thumbnail under the box and on the sent message, and open at full size.
  - [x] `attachments:stage-bytes` (one pasted image per call, size checked in the handler, "Pasted image N" numbering per draft), thumbnails made at stage time with `nativeImage`, and the `arc-attachment://` protocol (tech spec 2.7) registered with the knowledge scheme, plus `arc-attachment:` in `img-src`. Unit tests for the request handler (bad id, wrong kind, path outside root, non-GET, thumbnail fallback) and the CSP. **[Agent: electron-main]**
  - [x] Renderer: `extractPasted` with the five paste rules (tech spec 2.10), `onpaste` on the Composer textarea, `DropZone` around the box with the new `label` prop ("Drop to attach"), files with no path reported, thumbnails in the chip, `ui/ImagePreview.svelte` on `Modal` with Escape and focus return, the row's keyboard model (`role="toolbar"`, roving focus, Delete removes), the `image` icon, and thumbnails on sent messages. jsdom tests for each paste rule, numbering, drop, keyboard and preview. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e pastes a generated PNG through a synthetic clipboard event and drops two files, sees "Pasted image 1", loads a thumbnail through `arc-attachment://` with no CSP error in the console, opens and closes the preview with the keyboard, and sends. Check a Finder-copied file once in the real app (fake brain); if it does not arrive with a path, add the main-side clipboard fallback and note it under `## Open Questions`. **[Agent: svelte-frontend]**

- [x] **Slice 4: Refusals and limits**

  > A file that is the wrong type, too large, one too many, a folder or unreadable is refused with its message, and the rest are kept.
  - [x] `sessions/AttachmentNotices.svelte`: one line per refused file in a `role="status"` region with the spec's five messages, dismissible, at most 3 lines then "and N more were refused.", cleared on the next add and on send; the `staging` and `error` chip states; Send disabled while anything is staging. jsdom tests for each message and the mixed allowed-and-refused drop. **[Agent: svelte-frontend]**
  - [x] Main: close any gap the earlier slices left against tech spec 2.4 (HEIC, SVG as text, empty files, unknown extensions by content, permission denied), with the unit tests that prove each. **[Agent: electron-main]**
  - [x] Verify: an e2e attaches a ZIP, an oversized generated file, a folder and an eleventh file, and sees each message while the allowed files stay attached. **[Agent: svelte-frontend]**

- [x] **Slice 5: Attachments on the first message of a new session**

  > The New Session dialog accepts attachments the same three ways. Cancelling discards them. Commands and plan feedback refuse attachments.
  - [x] `sessions:create` accepts `draftId` and `attachmentIds`, allows an empty request with attachments, writes the session, message and attachment rows in one transaction, and still writes nothing when the provider's CLI is unavailable (staged files stay). Session titles and previews handle an empty request. Unit tests. **[Agent: electron-main]**
  - [x] Refusals before anything is written: a message with attachments that starts with "/" ("Attachments can't be sent with a command.") and one that would be plan feedback ("Attachments can't be added to plan feedback."), as typed errors the renderer maps. Unit tests in the orchestrator and session service. **[Agent: agent-orchestration]**
  - [x] Renderer: `AttachField` in `NewSessionDialog.svelte` with a draft per opening of the dialog, the paperclip in the footer, validation that accepts attachments without text, `attachments:discard-draft` on cancel, Escape in the preview closing only the preview, and the two refusal messages in `Composer.svelte` with text and attachments kept. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e starts a session with a pasted image and no text and finds it on the first message and in the fake's log; cancels a dialog with an attachment, reopens it and finds none, with the staging folder empty; sends "/review" with an attachment and a message during a waiting plan and sees each refusal with the box unchanged. **[Agent: svelte-frontend]**

- [x] **Slice 6: Native image input, Codex and Cursor brains, and the can't-read warning**

  > Images reach each provider the way Slice 1 proved works. A brain that can't read a kind of file shows the warning when one is attached.
  - [x] Claude: base64 `image` blocks for images at or under the inline limit, larger ones by path only, and replayed user events stripped of `image` blocks before the event log and raw logs. Unit tests, including that no log line holds base64. **[Agent: agent-orchestration]**
  - [x] Codex: `CodexInput` gains `localImage`; the text block and image inputs in both `turn/start` call sites and the queued-send path; the attachments folder in the Codex brain's read access (no copy fallback is needed, S2). Cursor: parse `promptCapabilities`, send an `image` block when advertised, and the text block (no copy fallback is needed, S3). Mid-turn sends carry their attachments in each adapter. Unit tests per adapter; extend the fakes only if a test needs it. **[Agent: agent-orchestration]**
  - [x] `ATTACHMENT_SUPPORT` in `src/shared/attachments.ts` with the values from Slice 1, and the warning in `AttachmentNotices` for the session's brain provider and for the provider picked in the New Session dialog: "[brain name] can't read [kind]. It will be sent as a file the brain may not be able to open." jsdom tests per provider and kind. **[Agent: svelte-frontend]**
  - [x] Verify: e2e runs on the fake Claude, Codex and Cursor brains each send an image and a PDF and assert the fake's log holds the native image input and the text block; the PDF shows the warning on Codex and Cursor and not on Claude. **[Agent: agent-orchestration]**

- [x] **Slice 7: The brain passes an attachment to a worker**

  > The brain names attachments when it starts or messages a worker. The worker can open them, and its task lists them.
  - [x] `spawn_worker` and `message_worker` gain `attachments` (ids, at most 10) with a tool error listing the valid ids for an unknown one; `workers.attachments_json` written; the session's attachments folder in every worker's `addDirs` and `readOnlyDirs` (no copy fallback, Slice 1); the text block and native image input on the worker's first message and on `message_worker`, including held messages; brain prompt v8 (`BRAIN_PROMPT_VERSION` 8, the attachments section including the instruction to open a listed file when the request depends on it, the same line in the worker's first message, the deferred prompt-update note). Unit tests, with `brain-prompt-v8` modelled on `brain-prompt-v7.test.ts`. **[Agent: agent-orchestration]**
  - [x] Renderer: the worker's task view lists passed attachments by name, images opening `ImagePreview`. jsdom test. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e sends a message with an image, the fake brain spawns a worker with that id, the worker's task lists the image, and the fake worker's log holds the path; an unknown id returns the tool error. Run once each with a Claude and a Codex worker. **[Agent: agent-orchestration]**

- [x] **Slice 8: Restarts, clean-up, handoff and documentation**

  > Sent attachments survive a restart and a deleted original. Nothing is left behind on disk. The docs describe the feature as built.
  - [x] Staging cleared at app start; the sweep of attachment folders with no row; the handoff summary listing a session's earlier attachments when the brain moves to another provider; no attachment contents or paths in the main log. Unit tests. **[Agent: electron-main]**
  - [x] Design Preview block "Attachments" (chip states, a long row, notices and warning, the drop overlay) with its test in `tests/renderer/design-preview.test.ts`. **[Agent: svelte-frontend]**
  - [x] Update `context/product/architecture.md` and `product-definition.md` for spec 012 (storage, the protocol, delivery per provider, the bridge tool fields, prompt v8). **[Agent: electron-main]**
  - [x] Update the three model-list e2e tests that fail on `main` (`tests/e2e/provider-models.spec.ts`, two tests, and `tests/e2e/codex-provider-choose.spec.ts`, one) to expect the four Claude models now listed, so the full e2e run can pass. Not part of this feature; requested by the user on 2026-11-12. **[Agent: agent-orchestration]**
  - [x] Verify: an e2e sends an image and a text file, deletes the originals, relaunches, and still sees the attachments and the full-size image; deletes the session and finds its attachments folder gone; relaunches with a staged, unsent attachment and finds the staging folder empty. **[Agent: electron-main]**

- [x] **Slice 9: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: [spec-directory]` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

Left unproven by Slice 1. None of these blocks the later slices.

- The pinned Codex 0.162.1 was not installed, so S2 ran on 0.163.0 and its recordings are under `tests/fixtures/codex/0.163.0/attachments/`. The `localImage` schema fragment is still to be diffed against 0.162.1 when a copy is at hand.
- A real Codex model did not open a listed text file. It guessed instead. Only a no-model `command/exec` showed the read-only sandbox allows the read. Whether a model-run read under `approvalPolicy: untrusted` asks the user for approval is unobserved. The v8 prompt instruction (tech spec 2.8 and 2.9) is the mitigation, and the Slice 7 e2e checks it with the fake.
- Cursor in `agent` mode (the worker's mode) was not run. Large images, multi-page or scanned PDFs, and an image near the 5 MB inline limit were not tested on any provider.
- Cursor writes its own copy of an attached image under `~/.cursor/projects/<slug>/assets/`. Arc does not control it and it was not on disk after the process exited. Worth one line in the user-facing docs if it turns out to persist.

Validation behaviour that the specs do not settle. The Slice 4 audit pinned the current behaviour in `tests/unit/attachments/attachment-rules.test.ts` and changed nothing:

- A file with a known text extension is accepted as text without looking at its content, so image or other binary data saved as `.txt`, `.md` or `.json` is attached as a text file.
- A file with an extension Arc does not know (for example `.heic`, `.zip` or `.dat`) is accepted as text when its content is plain text. Real HEIC, ZIP and PDF files under such names are still refused, because their content is binary.

Acceptance audit (Slice 9). All 32 criteria were mapped to tests. These are the ones that are only partly proven, and why. The other criteria are proven by a test that asserts the outcome in the criterion's "then" clause (see `tests/e2e/attachments-acceptance.spec.ts` and the earlier slice tests).

- 2.1, "clicks Attach and chooses a file in the file picker": the e2e stubs the native macOS file picker (`queuePicker`) and supplies the paths. Everything after the choice is real. The system dialog itself is not driven.
- 2.4, "the brain's answer includes "4012"" and "the brain's answer quotes it": a fake brain cannot read content. The e2e tests prove that Arc gives the brain the image block and the stored file path. That the model then reads them is proven once by the recorded real checks in `tests/fixtures/claude/attachments/` (Claude answered 4012, QZ-77 and 9) and `tests/fixtures/cursor/2026.10.19-6bbf2c4/attachments/` (Cursor read both). On Codex the image was read but the text file was not opened (see the first list above).
- 2.4, "the worker's report describes what the image shows": the e2e tests prove the worker is told the path, receives the image and lists it in its task. The report text depends on a real model and is not asserted.
- 2.5, "a session whose brain can't read images ... they see a warning that names the brain": no provider in the table lacks image support today, so no real session can show this warning. The warning logic is proven per kind by jsdom with a stubbed provider table (`attachment-warning.test.ts`) and end to end for PDFs on Codex and Cursor (`attachments-providers.spec.ts`). The image case on a real brain that cannot read images stays unproven until such a provider exists.

Follow-up requested by the user on 2026-11-12, not part of this spec:

- Age-based deletion of attachments. Today a sent attachment is kept until its session is deleted, with no expiry and no total size limit. A follow-up spec should delete attachments from sessions that have not been used for a set time (for example 90 days), and decide what the message shows afterwards.
