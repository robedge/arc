# Tasks: Learning Loop

Conventions for every Verify task below, the same as specs 007 to 010:

- **Build and gates (targeted, per the user's 2026-10-20 instruction):** run `pnpm lint && pnpm typecheck && pnpm format:check`, then `npx electron-vite build`. Run only the tests the slice added or changed, plus the existing ones that cover files it touched (`ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run <name filters>`, `npx playwright test <files>`). Do NOT run the full unit or e2e suites in slice Verify tasks. They run once, in the last slice: `pnpm test:unit`, then `pnpm test:e2e`.
- **Tests come first:** write the failing test before the code it covers.
- **Fakes only:** the fake CLIs and a temp HOME (`HARNESS_CLAUDE_BIN`, `HARNESS_CODEX_BIN`, `HARNESS_E2E=1`, `HARNESS_USER_DATA`). Never run a real `claude`, `codex` or `agent` with a model turn, never touch `~/.claude`, `~/.codex`, `~/.cursor` or Arc's own data, and no network.
- **Names:** "Suggestion" already means token-usage tips. Use `KnowledgeSuggestion…` for types and components and `data-knowledge-suggestion…` for attributes. Sample text must pass `tests/unit/name-denylist.test.ts`.
- **Clean up:** delete throwaway specs, screenshots outside `docs/screenshots/` and `test-results/`, stop every process you started by its PID (never pipe a stop command into another command), and confirm `pgrep -fl "fake-claude|fake-codex|fake-cursor|fake-mcp"` is empty.

- [x] **Slice 1: A suggestion from the brain shows in the session and can be discarded**

  > The brain calls `suggest_knowledge_update` for a new note. The session header shows "Suggestions N", the dialog lists the card (title, reason, destination, text), Discard removes it, and waiting suggestions survive a restart. Nothing is written to knowledge yet.
  - [x] Table `knowledge_suggestions` (tech spec 2.4), migration `0029_knowledge_suggestions` via `pnpm db:generate`, and `KnowledgeSuggestionsRepo` (`insert`, `listWaiting`, `get`, `setOutcome`, `countForRequest`, `discardAllWaiting`). Review the generated SQL for the partial index and CHECKs. Unit tests: CHECK violations, the `setOutcome` guard, cascade with the session, the migration on existing data. **[Agent: sqlite-database]**
  - [x] `KnowledgeSuggestionService` with `suggest` (new notes only for now: section lookup, Projects and Links refused, name sanitised and kept inside the root, text extension check), `listWaiting` and `discard`; shared types (`KnowledgeSuggestionView`); channels `knowledge-suggestions:list` and `:discard`; the `session:knowledge-suggestions` push; `SessionSnapshot.knowledgeSuggestions`; construction in `build-services.ts`; session events `knowledge-suggested` and `knowledge-discarded` through a public wrapper around `logSessionEvent`. Unit tests with `knowledge-test-env.ts` and a handler test; update `all-handlers.test.ts`. **[Agent: electron-main]**
  - [x] Bridge tool `suggest_knowledge_update` (`kind: 'new'` path), `BridgeServices.suggestKnowledgeUpdate` behind `brainOnly`, the registry entry, `BRAIN_TOOLS`, and brain prompt v7 (`BRAIN_PROMPT_VERSION` 7, the "on" section, `PROMPT_UPDATE_NOTE_V7`). `requestId` is the session's latest user message id. Unit tests: the bridge role list, refusal codes `unknown_section`, `section_not_allowed`, `not_text_file`, and `brain-prompt-v7` modelled on `brain-prompt-v6.test.ts`. **[Agent: agent-orchestration]**
  - [x] Renderer: `knowledge-suggestions.svelte.ts` store (snapshot, push wiring in `App.svelte`, reset on close, optimistic discard with rollback), `KnowledgeSuggestionsChip.svelte` after `AttentionBadge` in `SessionHeader.svelte`, `KnowledgeSuggestionsDialog.svelte` and `KnowledgeSuggestionCard.svelte` (new-note body in a `<pre>`, Discard only), and the three `EVENT_STYLE` entries. jsdom tests for chip, dialog, card and store; a11y sweep. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions): a fake-brain scenario suggests two new notes. An e2e sees "Suggestions 2", opens the dialog, discards one, relaunches and still sees "Suggestions 1"; no macOS notification was sent and the Needs attention count did not change; the event history lists the suggestion and the discard. **[Agent: agent-orchestration]**

- [x] **Slice 2: Accepting a new note writes it to the group's knowledge**

  > Accept creates the note in its section, the card leaves, and a confirmation row with Open appears in the dialog. A taken name, a failed save and a busy storage move each show their message and change nothing.
  - [x] `KnowledgeService.createWithContent` with the strict name check and the `ITEM_NAME_TAKEN` error; `KnowledgeSuggestionService.accept` for new notes (re-validation, `AcceptOutcome`, `SUGGESTION_NOT_FOUND`, `IO_FAILED` with `details.location`, `STORAGE_BUSY`); the `knowledge-suggestions:accept` channel; `knowledge:changed` with the new `'suggestion'` reason; the `knowledge-accepted` event; `name_taken` at suggest time. Unit tests: accepted in the app folder and in a linked folder (file written, no commit), name taken, write failure keeps the suggestion, traversal names. **[Agent: electron-main]**
  - [x] Renderer: Accept on the card, the `problems` map with `name-taken`, `save-failed` (Try again) and `storage-busy`, the confirmation row with **Open**, the dialog staying open after the last accept, `lib/navigate-knowledge.ts` (`openKnowledgeItem`), and the `'suggestion'` reason handled like `'external'` in `knowledge.handleChanged`. jsdom tests for each state and for navigation. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e accepts a new-note suggestion, sees "Added to Notes › …", clicks Open and lands on the note with the suggested text; a second scenario hits a taken name and an unreachable linked folder and confirms nothing was written. **[Agent: svelte-frontend]**

- [x] **Slice 3: Suggestions that change an existing note**

  > The brain suggests replacement edits to an existing text file. The card shows added and removed lines; Accept applies them; a note that changed or was deleted since refuses with the spec's messages.
  - [x] `src/shared/text-diff.ts` (`diffLines`, 3 context lines, the 2,000-line fallback) with unit tests. **[Agent: electron-main]**
  - [x] The tool's `kind: 'update'` path: `file` and `edits` validation, edits applied in memory, `hunks_json` and `base_revision` stored; refusal codes `file_not_found`, `edit_not_found`, `edit_ambiguous`. Unit tests for each. **[Agent: agent-orchestration]**
  - [x] `accept` for updates through `KnowledgeService.save` with the stored revision; an existence check so a deleted file yields `ITEM_NOT_FOUND`; `current(id)` and the `:current` channel; "Add as a new note" (`accept` with a name and section on a missing target). Unit tests: applied, changed since, deleted, add as new. **[Agent: electron-main]**
  - [x] Renderer: `ui/DiffSnippet.svelte` (the `compact` gutter on `DiffLine`, separator rows, a named focusable region), the update body on the card, problems `changed` (Show current, Discard) and `missing` (Add as a new note, Discard), and the `canAcceptNow` guard with the `unsaved-edits` problem. jsdom tests; a11y sweep. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e accepts an update and checks the file gained the added lines and lost the removed ones with the rest unchanged; edits the note outside Arc and sees "This note has changed since the suggestion was made."; deletes a target and adds the suggestion as a new note. **[Agent: electron-main]**

- [x] **Slice 4: Editing a suggestion before accepting**

  > Edit lets the user change the text, a new note's name and its section; Accept saves the user's version and Cancel restores the brain's.
  - [x] `accept(id, edits)` with `text`, `name` and `sectionId`; `resultText(id)` and the `:result-text` channel; the `accepted_edited` status with `edited_content` and "Accepted after editing" in the event. Unit tests, including an edited update keeping the changed-since check. **[Agent: electron-main]**
  - [x] `KnowledgeSuggestionEditor.svelte` (`TextArea`, Name and Section for new notes only, `eligibleSuggestionSections`, inline `ErrorText` validation, Accept and Cancel, Escape returns to the card), and `name-taken` opening the editor on the name field. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e edits a new note's text, name and section and finds it saved as edited; Edit then Cancel shows the original text and saves nothing; the event history reads "Accepted after editing". **[Agent: svelte-frontend]**

- [x] **Slice 5: Accept all and Discard all**

  > With more than one suggestion waiting, the dialog footer offers both. Accept all reports any suggestion that could not be applied and leaves it waiting.
  - [x] `acceptAll` (oldest first, continues past failures, per-item results, one push at the end) and `discardAll`; channels `:accept-all` and `:discard-all`. Unit tests, including two suggestions on the same note. **[Agent: electron-main]**
  - [x] Footer buttons shown only above one waiting suggestion, the inline "Discard all N suggestions?" confirmation, per-card problems after a partial Accept all, focus moving to the next card after a removal, and the polite live region with the waiting count. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e accepts three at once and the chip disappears; discards three after confirming and the knowledge folder is unchanged; the dialog is driven with the keyboard alone, including Escape. **[Agent: svelte-frontend]**

- [x] **Slice 6: Limits, not repeating, and the line under the brain's answer**

  > At most 5 suggestions per request, never the same one twice, none while workers run, and the brain's answer ends with a line that opens the dialog.
  - [x] Main-process enforcement in the tool: `cap_reached` (count by `requestId`, reset by a user message and not by an `[Arc]` turn), the `dedupe_key` with `duplicate` and `already_discarded`, `workers_running`, and `asked_by_user`. A batched deferred note to the brain after discards, modelled on `pendingUndoNotes`. Unit tests for each. **[Agent: agent-orchestration]**
  - [x] `MessagePrompt` variant `knowledge-suggestions` with `settleSuggestionsReply` in the `turn-result` path, the system-message fallback when the turn has no visible reply, and the separate system message when the reply already carries `review-link`. Unit tests modelled on `review-link.test.ts`. **[Agent: agent-orchestration]**
  - [x] `MessageBubble.svelte` renders the prompt as a link-style button that opens the dialog. jsdom test. **[Agent: svelte-frontend]**
  - [x] Verify: fake-brain scenarios show a sixth suggestion refused, a discarded suggestion refused in a later request, a refusal while a worker runs, and a reply ending with "I have 2 suggestions for this group's knowledge." that opens the dialog. **[Agent: agent-orchestration]**

- [x] **Slice 7: The "Suggest knowledge updates" switch**

  > A new Knowledge page in Settings holds the switch, on by default. Off means the brain suggests nothing on its own; asking in plain words still works and waiting suggestions stay.
  - [x] Setting `knowledge.suggestOnFinish` in every hand-kept list (`appSettingSchemas`, `appSettingDefaults`, `getAll`, `AppSettings`, the `settings:set` schema, the settings handler, the Design Preview fixture, `AppSettings` literals in tests). Unit tests. **[Agent: sqlite-database]**
  - [x] The Orchestrator's `suggestKnowledge` getter, `BrainPromptInput.suggestOnOwn` with the "off" prompt variant, `pendingSuggestNote` when the setting changes under a running brain, and the `suggestions_off` refusal unless `asked_by_user`. Unit tests. **[Agent: agent-orchestration]**
  - [x] `KnowledgeSettings.svelte` with the `Toggle` and help text, the `knowledge` page in `SettingsView.svelte` and `SettingsPage`. jsdom test. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e switches it off and a finishing brain's suggestion is refused and nothing appears; a scenario with `asked_by_user` still produces suggestions; two waiting suggestions are still listed after switching off; the switch is still off after a relaunch. **[Agent: agent-orchestration]**

- [x] **Slice 8: Other providers, Design Preview and docs**

  > Codex and Cursor brains can call the tool, the new components appear in the Design Preview, and the product docs describe what was built.
  - [x] One scenario each on `fake-codex.mjs` and `fake-cursor.mjs` in which the brain calls `suggest_knowledge_update` and the chip appears; confirm the tool is in Codex's `enabled_tools` and Claude's `ToolSearch` select line. **[Agent: agent-orchestration]**
  - [x] Design Preview blocks: the chip (several counts), `DiffSnippet` with a long line, and a card in each state (new, update, each problem, editing), with fixed props and no IPC; extend `design-preview.test.ts`; confirm the contrast, motion-cap and palette guards pass. **[Agent: svelte-frontend]**
  - [x] Update `context/product/architecture.md` (the tool, the table and migration, the service, the IPC channels, the setting) and mark the learning loop as built in `context/product/product-definition.md`. **[Agent: agent-orchestration]**
  - [x] Verify: the two provider e2e specs and the preview test pass; open Help › Design Preview in the built app and confirm the new blocks render. **[Agent: svelte-frontend]**

- [x] **Slice 9: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 011-learning-loop` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- Criterion 2.4-13 ("Save or discard your edits to this note first."): covered by `canAcceptNow` and the store, card and batch jsdom tests, which show the message and block the IPC call. It is not covered end to end because the real app cannot reach the state. The Knowledge suggestions dialog opens from the session header, and leaving the knowledge screen flushes or clears the open note's draft before the dialog can be opened. What an e2e can and does cover is the nearest real flow (`tests/e2e/knowledge-suggestions-acceptance.spec.ts`, "2.4-9 and 2.4-13"): the user types into the note in Arc's editor, autosave writes it, and Accept is refused with "This note has changed since the suggestion was made." and keeps the typed text. The main process's revision check is the backstop, as the technical spec says.
- Criteria 2.1-1 and 2.1-3 (the brain learns a lasting fact; the brain replies that it has no suggestions): the fake brain's replies are scripted, so the e2e tests prove what Arc does around them (a stored suggestion shows; no chip, line, system message or Arc-sent turn when there is none, `ks-none`). What is not covered is the real model choosing to suggest, choosing not to, or wording "I have no suggestions". The prompt text tests (`brain-prompt-v7`) pin the instruction. The "manual sample on real sessions" from the technical spec's risk table is still to do, and Codex and Cursor brains may skip the optional end-of-reply call.
- Full-suite run (Slice 9): the unit suite passes (352 files, 4449 tests). The e2e suite ran 286 tests: 283 passed and 3 failed, all in the Claude model list (`tests/e2e/provider-models.spec.ts` lines 11 and 84, `tests/e2e/codex-provider-choose.spec.ts` line 98). They expect three Claude models and get four, because `fable` is now in the list. That list comes from code this spec did not change, so the failures are not caused by the learning loop, but the e2e suite stays red until those expectations are updated or the specs are pinned to the fake Claude.
