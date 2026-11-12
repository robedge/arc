# Technical Specification: Learning Loop

- **Functional Specification:** `context/spec/011-learning-loop/functional-spec.md`
- **Status:** Draft
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

The brain gets one new bridge tool, `suggest_knowledge_update`. It calls the tool at the end of a finished request, once per suggestion. The main process validates the call, stores the suggestion in a new `knowledge_suggestions` table and pushes the waiting list to the renderer. The renderer shows a cyan chip in the session header and a dialog with one card per suggestion. Accept, Edit and Discard are renderer IPC calls to a new `KnowledgeSuggestionService`, which writes into the group's knowledge folder through `KnowledgeService`.

Four things keep this safe and cheap:

- **The brain can only suggest.** `suggest_knowledge_update` is the only part reachable from the MCP bridge. Accepting and discarding are renderer IPC only, so the brain cannot apply its own suggestions. The brain stays read-only.
- **No extra brain turns.** The trigger is a prompt instruction (brain prompt v7), not an Arc-sent "any suggestions?" turn. A session that learned nothing costs nothing beyond the added prompt section.
- **The main process enforces the limits.** The cap of 5 per request, not repeating, the Settings switch and "not while workers run" are checked in the tool, not left to the prompt.
- **Accept re-checks the disk.** Each update suggestion stores the file's revision at suggest time. Accept goes through the existing revision check, so a note that changed since is never overwritten.

Affected areas: the bridge and brain prompt (`src/main/bridge`, `src/main/sessions`), knowledge services (`src/main/knowledge`), one new table and one setting (`src/main/db`), the IPC contract (`src/shared`), and the renderer (session header, a new dialog, Settings, event history).

No new dependency is needed. The existing specialists cover the work.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Facts checked before designing

| Fact                                                                                                                                                              | Where                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Every real brain has the bridge (`workersEnabled = deps.bridge !== undefined`), so chat-only sessions can suggest too.                                           | `src/main/sessions/session-service.ts:2024`                                  |
| There is no "brain finished with no workers running" hook. Turns settle in `onEvent` case `turn-result`; `workersRepo.countActive(sessionId)` counts live workers. | `src/main/sessions/orchestrator.ts` ~2080                                    |
| The brain knows only the knowledge folder path (its working directory). There is no manifest, so it must read the folder to avoid duplicates.                    | `orchestrator.ts` ~398                                                       |
| `KnowledgeService.create` writes an empty `.md` and never fails on a taken name (`uniqueName` adds " (2)").                                                       | `src/main/knowledge/knowledge-service.ts:102`, `knowledge-paths.ts:89`       |
| `KnowledgeService.save(itemId, content, baseRevision)` throws `EXTERNAL_MODIFIED` when the file changed.                                                          | `knowledge-service.ts:184`                                                   |
| The watcher drops Arc's own writes and watches only the open group, so Accept must emit `knowledge:changed` itself.                                               | `src/main/knowledge/knowledge-watcher.ts`                                    |
| The project has no line-diff library. Review diffs come from `git diff`.                                                                                          | `src/main/git/review-git.ts:186`                                             |
| A brain reply can carry a `MessagePrompt` that the renderer draws as an action (`review-link`).                                                                   | `src/shared/types/session.ts:99`, `MessageBubble.svelte:36`                  |
| "Suggestion" already means token-usage tips (`usage_suggestions`, `SuggestionsList.svelte`). New code uses `KnowledgeSuggestion…` names.                         | `src/main/usage/`, `src/renderer/src/lib/components/usage/`                  |
| Text files up to `IMPORT_MAX_BYTES` (20 MB) are editable; text types are in `TEXT_EXTENSIONS`.                                                                    | `src/shared/limits.ts`                                                       |

### 2.2 The bridge tool

New file `src/main/bridge/tools/suggest-knowledge-update.ts`, listed in `registry.ts`, role `brain`, not long-running. One call per suggestion.

| Field            | Type                               | Notes                                                                                      |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `kind`           | `'new' \| 'update'`                | Explicit, not inferred.                                                                    |
| `title`          | string, 1-80                       | The one-line title.                                                                        |
| `reason`         | string, 1-400                      | Where in the session the brain learned it.                                                 |
| `section`        | string, 1-80                       | Section name or folder, matched case-insensitively.                                        |
| `name`           | string, 1-80 (new only)            | May end in an extension from `TEXT_EXTENSIONS`; defaults to `.md`.                         |
| `content`        | string, 1-20,000 (new only)        | The full text.                                                                             |
| `file`           | string (update only)               | Path of the file inside the section.                                                       |
| `edits`          | 1-5 of `{old_text, new_text}`      | `old_text` 1-4,000 and must occur exactly once; `new_text` 0-4,000; edits may not overlap. |
| `asked_by_user`  | boolean, optional                  | True when the user asked for suggestions in this request.                                  |

Updates use replacement pairs, not the full file text. Pairs are cheap for large schema dumps, they express removed lines, and they don't depend on the brain reproducing a long file exactly.

The tool returns `{ ok: true, id, remainingThisRequest }`. Refusals are `BridgeToolError`s with a one-line hint the brain can act on:

| Code                  | When                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `unknown_section`     | No section matches. The hint lists the valid names.                                     |
| `section_not_allowed` | Projects or Links.                                                                      |
| `file_not_found`      | Update target is missing.                                                               |
| `not_text_file`       | Target is binary, a link, or not editable.                                              |
| `edit_not_found`      | An `old_text` does not occur.                                                           |
| `edit_ambiguous`      | An `old_text` occurs more than once, or edits overlap.                                  |
| `name_taken`          | A new note's name already exists in the section.                                        |
| `cap_reached`         | 5 suggestions already made for this request.                                            |
| `duplicate`           | The same suggestion is waiting or was accepted in this session.                         |
| `already_discarded`   | The user discarded the same suggestion in this session.                                 |
| `workers_running`     | A worker is active and `asked_by_user` is not true.                                     |
| `suggestions_off`     | The setting is off and `asked_by_user` is not true.                                     |

Wiring:

- `BridgeServices.suggestKnowledgeUpdate(agent, input)` in `src/main/bridge/types.ts`, implemented in `Orchestrator.bridgeServices()` behind `brainOnly(agent)`. It delegates to a narrow port `{ suggest(sessionId, groupId, requestId, input) }` injected into the Orchestrator, so the knowledge service never imports the Orchestrator.
- Add the tool to the hand-kept `BRAIN_TOOLS` list (it feeds the prompt and Claude's `ToolSearch "select:…"` line).
- Claude's `--allowedTools` and Codex's `enabled_tools` derive from the registry. Cursor already allows any `arc` tool. No provider-specific code.

**What "a request" is.** A request runs from one user message to the next. Arc's own `[Arc] …` turns (worker notes, the all-workers-finished summary) belong to the request of the last user message. `requestId` is the id of the session's latest `messages` row with role `user`, so the cap survives a restart and needs no in-memory counter.

### 2.3 The brain's prompt

- `BRAIN_PROMPT_VERSION` goes from 6 to 7, with a `PROMPT_UPDATE_NOTE_V7` and a `storedVersion < 7` branch in `promptUpdateNote`, as for earlier versions.
- `BrainPromptInput` gains `suggestOnOwn: boolean`. The v7 section has two variants:
  - **On:** when a request is finished, nothing is running and no question is pending, the brain may call the tool, up to 5 times, at the end of its reply. It reads the knowledge folder first and suggests only lasting facts (how parts fit together, a fact about the data, a convention, an easily missed step). It never suggests session summaries or lists of its changes, only text files in Notes, Docs, Playbooks or custom sections, and it says nothing when it has none.
  - **Off:** it does not suggest on its own; it does so only when the user asks, passing `asked_by_user: true`.
- The Orchestrator gets a `suggestKnowledge: () => boolean` dependency (a getter over app settings, so it sees changes without subscribing).
- When the setting changes while a brain is running, a `pendingSuggestNote` is queued beside `pendingCommandsNote` and prepended to the next user message by `sendToBrain`.
- When the user discards suggestions, their titles are batched into one deferred note ("The user discarded: … Don't suggest it again."), as `pendingUndoNotes` does. Accepts need no note: the file now holds the text.

**The line under the brain's answer.** `MessagePrompt` gains `{ kind: 'knowledge-suggestions'; count }`. In the `turn-result` path, beside `settleSummaryReply`, a new `settleSuggestionsReply` tags the turn's last visible brain message with the number of suggestions stored during that turn. Two edge cases:

- The turn produced no visible reply: Arc posts a system message carrying the prompt.
- The reply already carries `review-link` (a message holds one prompt): the review link stays, and the suggestions line goes in its own system message.

The renderer draws Arc's own text ("I have N suggestions for this group's knowledge."); it does not parse the brain's sentence.

### 2.4 Data model

New table `knowledge_suggestions` (`src/main/db/schema/knowledge-suggestions.ts`), migration `0029_knowledge_suggestions.sql` generated with `pnpm db:generate --name knowledge_suggestions`. No backfill.

| Column             | Type                | Notes                                                                                   |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------- |
| `id`               | text, primary key   |                                                                                         |
| `session_id`       | text, not null      | Foreign key to `sessions.id`, cascade on delete.                                        |
| `group_id`         | text, not null      | Plain value, so Accept works without the session being open.                            |
| `request_id`       | text, not null      | Id of the user message the suggestion belongs to (for the cap).                         |
| `action`           | text, not null      | `new` or `update`.                                                                      |
| `title`, `reason`  | text, not null      |                                                                                         |
| `section_id`       | text, not null      | Plain value, re-resolved at Accept.                                                     |
| `section_name`     | text, not null      | Snapshot for display and the event history.                                             |
| `target_rel_path`  | text, nullable      | Set for an update.                                                                      |
| `proposed_name`    | text, nullable      | Set for a new file.                                                                     |
| `proposed_content` | text, not null      | New: the text. Update: the full resulting file text (edits applied at suggest time).    |
| `hunks_json`       | text, nullable      | Update only: the diff computed at suggest time, so what the user sees never shifts.     |
| `base_revision`    | text, nullable      | Update only: the file's revision at suggest time.                                       |
| `dedupe_key`       | text, not null      | Unique.                                                                                 |
| `status`           | text, not null      | `waiting`, `accepted`, `accepted_edited`, `discarded`. Default `waiting`.               |
| `edited_content`   | text, nullable      | What the user saved when they edited before accepting.                                  |
| `created_at`       | integer, not null   |                                                                                         |
| `resolved_at`      | integer, nullable   | Null exactly while `waiting`.                                                           |

Design choices:

- **No foreign keys to `sections` or `knowledge_items`.** Items are dropped and re-created when files change outside Arc. A cascade would silently erase a waiting suggestion, and the "no longer exists" case needs the stored path to survive.
- **`dedupe_key`** is a hash of session, action, section, target (path or lowercased name) and whitespace-normalised content. The unique index covers every status, so discarded and accepted rows block repeats. Insert uses "on conflict do nothing" and returns the existing row's status, which the tool turns into `duplicate` or `already_discarded`.
- **Resolved rows are kept.** Dedupe and the event history need them. They go with the session.
- **Indexes:** waiting rows by `(session_id, created_at desc)`, and `(session_id, request_id)` for the cap. Check the generated SQL keeps the partial index and CHECK constraints.

Repository `src/main/db/repositories/knowledge-suggestions-repo.ts`, class `KnowledgeSuggestionsRepo`: `insert`, `listWaiting`, `get`, `countForRequest`, `setOutcome` (guarded by `status = 'waiting'`, returns whether a row changed), `discardAllWaiting` (returns the ids).

**Setting.** `knowledge.suggestOnFinish`, boolean, default `true`. It must be added in every hand-kept list: `appSettingSchemas`, `appSettingDefaults` and `getAll` in `app-settings-repo.ts`; `AppSettings` in `src/shared/types/provider.ts`; the `settings:set` schema in `contract.ts`; the patch copy in `src/main/ipc/handlers/settings.ts` (a key missing there is silently dropped); the Design Preview fixture; and the `AppSettings` literals in renderer tests.

**Session events.** Kinds follow the existing hyphenated style: `knowledge-suggested`, `knowledge-accepted`, `knowledge-discarded`. `text` is the title plus the destination and, for outcomes, "Accepted", "Accepted after editing" or "Discarded". `dataJson` holds the suggestion id, action, section and target.

### 2.5 Main-process services

**`KnowledgeSuggestionService`** (`src/main/knowledge/knowledge-suggestion-service.ts`), built in `src/main/app/build-services.ts` after `KnowledgeService`.

| Method                              | Called from       | What it does                                                                                                         |
| ----------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `suggest(sessionId, …, input)`      | Bridge tool only  | Validates (2.2), applies edits in memory, computes the diff, inserts, logs the event, pushes the waiting list.       |
| `listWaiting(sessionId)`            | Renderer, snapshot | Newest first.                                                                                                        |
| `resultText(id)`                    | Renderer          | The full proposed text of an update, for Edit.                                                                       |
| `current(id)`                       | Renderer          | The target file's current text, for Show current.                                                                    |
| `accept(id, edits?)`                | Renderer          | Applies a new or update suggestion. `edits` is `{ text?, name?, sectionId? }`.                                       |
| `discard(id)`                       | Renderer          | Marks it discarded and queues the brain's deferred note.                                                             |
| `acceptAll(sessionId)`              | Renderer          | Sequential, oldest first, does not stop on a failure, returns a result per suggestion.                               |
| `discardAll(sessionId)`             | Renderer          | Marks all waiting ones discarded.                                                                                    |

Accept and discard work without a live brain (a reopened, idle session). Events are written through a public wrapper around `SessionService.logSessionEvent`, which already falls back to the repository when no orchestrator runs. The service reaches it through a late reference, the pattern `build-services.ts` uses for the watcher.

**Additions to `KnowledgeService`:**

- `createWithContent(sectionId, name, content, { failOnExisting })`: same validation as `create`, a strict name check (case-insensitive, NFC) and one atomic write. A taken name throws a new error code, `ITEM_NAME_TAKEN` (`src/shared/errors.ts`). The check reuses the name-key logic in `knowledge-paths.ts` through a small exported helper.
- Updates use the existing `save(itemId, content, baseRevision)`.

**Outcomes of Accept**, as typed errors the renderer switches on:

| Situation                                | Error                                    | Spec message                                                        |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| File changed since suggested             | `EXTERNAL_MODIFIED`                      | "This note has changed since the suggestion was made."              |
| File deleted                             | `ITEM_NOT_FOUND`                         | "This note no longer exists."                                       |
| New note's name is taken                 | `ITEM_NAME_TAKEN`                        | "A note with this name already exists."                             |
| Write failed, or root missing            | `IO_FAILED` / `KNOWLEDGE_ROOT_MISSING`   | "Couldn't save to [location]." (`details.location`)                 |
| A storage move is in progress            | `STORAGE_BUSY`                           | Same card state as a failed save, with Try again.                   |
| Already handled elsewhere                | `SUGGESTION_NOT_FOUND` (new)             | The card is removed quietly.                                        |

The suggestion service checks that the target file exists before saving, so a deleted file reliably yields `ITEM_NOT_FOUND` (today `readDisk` can report `IO_FAILED` on the first call).

**"Add as a new note"** is `accept(id, { name, sectionId })` on an update whose file is gone: it creates a new file from `proposed_content`.

**Editing an update** saves the user's full text with the stored `base_revision`, so the changed-since check still applies.

**Not in this spec:** re-applying an update on top of a file that changed. A changed file always refuses.

**Diff.** New pure module `src/shared/text-diff.ts`: `diffLines(a, b, { context: 3 })` returns the `DiffHunk[]` shape change review already uses. It runs once at suggest time. Above 2,000 lines on either side it returns no hunks and the card shows the replaced and added text from the edits instead.

**After Accept** the service emits `knowledge:changed` itself. The payload's `reason` union gains `'suggestion'`; the renderer treats it like `'external'` (the section list refreshes, an open clean note reloads).

**Safety.** Validation runs at suggest time and again at accept time: paths through `resolveInRoot`, names through `sanitizeName`, Projects and Links refused, only editable text targets, extensions from `TEXT_EXTENSIONS`.

### 2.6 IPC contract

All in `src/shared/ipc/contract.ts` with strict zod schemas; handlers in `src/main/ipc/handlers/knowledge-suggestions.ts`.

| Channel                              | Request              | Response                                                        |
| ------------------------------------ | -------------------- | --------------------------------------------------------------- |
| `knowledge-suggestions:list`         | `{ sessionId }`      | `KnowledgeSuggestionView[]`                                     |
| `knowledge-suggestions:accept`       | `{ id, edits? }`     | `AcceptOutcome`, or a typed error (2.5)                         |
| `knowledge-suggestions:accept-all`   | `{ sessionId }`      | `{ results: [{ id, outcome \| error }] }`                       |
| `knowledge-suggestions:discard`      | `{ id }`             | void                                                            |
| `knowledge-suggestions:discard-all`  | `{ sessionId }`      | void                                                            |
| `knowledge-suggestions:result-text`  | `{ id }`             | `{ text }`                                                      |
| `knowledge-suggestions:current`      | `{ id }`             | `{ text }`                                                      |

- **`KnowledgeSuggestionView`:** `id`, `sessionId`, `kind`, `title`, `reason`, `sectionId`, `sectionName`, `target { itemId | null, name, relPath | null }`, `text` (new only), `hunks` (update only), `createdAt`. An update's full text is not in the view; Edit fetches it.
- **`AcceptOutcome`:** `groupId`, `sectionId`, `sectionName`, `itemId`, `name`, `edited`. This is what the confirmation and its Open link need.
- **Push event** `session:knowledge-suggestions { sessionId, waiting }`, added to `IpcEvents` and `eventFlags`. It never triggers a macOS notification and is separate from `session:attention`.
- **`SessionSnapshot.knowledgeSuggestions`** carries the waiting list when a session is opened.

### 2.7 Renderer

| Piece                 | File                                                                                   | Notes                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store                 | `lib/stores/knowledge-suggestions.svelte.ts`                                           | `list`, `dialogOpen`, `problems` (by id), `editingId`, `busyIds`, `confirmations`. Fed by the snapshot and the push event (wired in `App.svelte`), reset on session close.                   |
| Header chip           | `lib/components/ui/KnowledgeSuggestionsChip.svelte`                                    | Accent tokens, count pill, no animation. Visible text "Suggestions N", accessible name "Knowledge suggestions, N waiting". Rendered after `AttentionBadge` in `SessionHeader.svelte`.         |
| Dialog                | `lib/components/knowledge-suggestions/KnowledgeSuggestionsDialog.svelte`               | `Modal` size `lg`, title "Knowledge suggestions", scroll list as in the attention dialog. Footer: Accept all and Discard all (when more than one waits), Close.                               |
| Card                  | `…/KnowledgeSuggestionCard.svelte`                                                     | Accent shell from `QuestionCard`: title, reason, destination line, body, then Accept / Edit / Discard.                                                                                        |
| Diff                  | `lib/components/ui/DiffSnippet.svelte`                                                 | Wraps `toUnifiedRows` + `DiffLine` (new `compact` gutter prop), hunk headers replaced by a thin separator, a focusable named region, scrolls inside the card.                                 |
| Editor                | `…/KnowledgeSuggestionEditor.svelte`                                                   | `TextArea` (not CodeMirror: the Modal focus trap skips it). Name and Section fields for new notes only; Section options from the group's eligible sections. Accept and Cancel.               |
| Message line          | `MessageBubble.svelte`                                                                 | Renders the `knowledge-suggestions` prompt as a link-style button that opens the dialog.                                                                                                      |
| Settings              | `lib/components/settings/KnowledgeSettings.svelte`                                     | New "Knowledge" page with the "Suggest knowledge updates" `Toggle` and its help text.                                                                                                         |
| Event history         | `lib/components/sessions/event-kinds.ts`                                               | Three `EVENT_STYLE` entries.                                                                                                                                                                  |
| Navigation            | `lib/navigate-knowledge.ts`                                                            | `openKnowledgeItem({ groupId, sectionId, itemId })` through the guarded setters; closes the dialog.                                                                                           |
| Design Preview        | `lib/preview/DesignPreview.svelte`                                                     | The chip, `DiffSnippet` and a card in each state, with fixed props and no IPC.                                                                                                                |

Behaviour worth stating:

- **Problem states.** `problems[id]` is one of `changed`, `missing`, `name-taken`, `save-failed` (with the location), `storage-busy`, `unsaved-edits`. Each maps to the message and buttons in functional spec 2.4. It lives in the store so it survives a pushed list.
- **Removal.** Accept and Discard remove the card optimistically and restore it at its original index on error, following `usage.dismissSuggestion()`.
- **Confirmation.** After Accept, a row at the top of the dialog reads "Added to Docs › Database schema" with an **Open** button. The dialog stays open when the list empties after an accept and closes with Close, so the confirmation is reachable by keyboard. The toast store is not changed (toasts sit outside the modal focus trap and dismiss after 5 s).
- **Unsaved edits.** A pure guard `canAcceptNow(suggestion, itemDraft)` in `lib/knowledge-suggestions/guards.ts` runs before the accept call and sets the `unsaved-edits` problem. In practice the draft is cleared when the knowledge screen is left, so the guard rarely fires; the main process's revision check is the backstop.
- **Discard all** asks once, inline in the footer ("Discard all N suggestions?" with Discard and Keep), which avoids stacking a second modal.
- **Keyboard.** Tab moves through each card's buttons in order; Escape in edit mode returns to the card and a second Escape closes the dialog; after a card is removed focus moves to the next card's Accept; a polite live region announces the waiting count.

---

## 3. Impact and Risk Analysis

**System dependencies**

- Bridge registry, `BRAIN_TOOLS` and the bridge role-list test.
- The brain prompt version, which every resumed session picks up as a one-time note.
- `KnowledgeService`, `knowledge:changed` consumers (`knowledge.handleChanged`, `itemDraft`).
- `SessionSnapshot`, the IPC contract and `tests/unit/ipc/handlers/all-handlers.test.ts`.
- The setup-overhead estimate (spec 008) counts tool descriptions, so the measured setup rises slightly for every brain.
- `context/product/architecture.md` lists `suggest_knowledge_update` as planned and must be updated.

**Risks and mitigations**

| Risk                                                                                  | Mitigation                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brain suggests too much or trivia.                                                | Cap of 5 and dedupe in the main process; a tight prompt; a manual sample on real sessions before calling it done.                                              |
| The brain suggests mid-work.                                                          | `workers_running` refusal in the tool.                                                                                                                          |
| `asked_by_user` is the brain's own claim, so a brain could set it to get past the switch. | Accepted for v1: the user still approves every suggestion. Recorded as an assumption.                                                                       |
| Cursor and Codex brains skip optional end-of-reply tool calls.                        | Expect fewer suggestions there. Asking in plain words always works. No extra turns are added to compensate.                                                     |
| A suggestion goes stale.                                                              | Revision check at Accept; nothing is written on a mismatch.                                                                                                     |
| A brain-supplied name or path escapes the knowledge folder.                           | `resolveInRoot` and `sanitizeName` at suggest and accept time; unit tests for traversal names.                                                                  |
| Two suggestions change the same note and both are accepted.                           | The second fails with "changed since"; Accept all reports it per item and leaves it waiting.                                                                    |
| Extra prompt tokens on every brain start.                                             | One short section; no extra turns.                                                                                                                              |
| The generated migration drops the partial index or CHECKs.                            | Review the generated SQL; a migration test on existing data.                                                                                                    |
| Name clash with token-usage "suggestions".                                            | `KnowledgeSuggestion…` type, component and `data-knowledge-suggestion` attribute names throughout.                                                              |

**Decisions confirmed with the user**

- The trigger is prompt-only; Arc sends no extra turn to ask for suggestions.
- The confirmation lives in the dialog, and the dialog stays open after the last accept.
- The switch goes on a new Settings page named "Knowledge".

**Assumptions still open**

- "A request" runs from one user message to the next.
- The brain declares `asked_by_user` itself.
- A changed file always refuses; there is no re-apply or merge.

---

## 4. Testing Strategy

**Unit, main (`tests/unit/`)**

- `shared/text-diff`: additions, removals, context lines, the large-file fallback.
- `db/knowledge-suggestions`: dedupe across statuses, CHECK violations, the `setOutcome` guard, cascade with the session; the migration applies on existing data (model: `tests/unit/db/usage-suggestions.test.ts`, `migration-0026.test.ts`).
- `db/app-settings-repo` and `ipc/handlers/settings`: the new key and its default.
- `knowledge/knowledge-service`: `createWithContent` and `ITEM_NAME_TAKEN`.
- `knowledge/knowledge-suggestion-service` (with `knowledge-test-env.ts`): new and update accepted, edited accept, name taken, changed, deleted and "add as new", write failure keeps the suggestion, accept all with a partial failure, discard, refused targets, traversal names, linked folder with no commit.
- `bridge/bridge-server`: the role list; each refusal code; the cap resetting on a user message but not on an `[Arc]` turn; `workers_running`; `suggestions_off` with and without `asked_by_user`.
- `sessions/brain-prompt-v7` (model: `brain-prompt-v6.test.ts`), the deferred discard and setting notes (model: `plugin-change-note.test.ts`), and the message tag with its two fallbacks (model: `review-link.test.ts`).

**Unit, renderer (`tests/renderer/`)**

- Chip, dialog, card (each problem state), `DiffSnippet`, editor validation, the store (optimistic removal and rollback, pushed lists keeping problems), `canAcceptNow`, `openKnowledgeItem`, the message line, the Settings page, event-history labels.
- Design Preview test: the new blocks render with no IPC.
- Guards the new surfaces must pass: contrast, motion cap (nothing loops), no default palette, a11y sweep, name denylist.

**End to end (`tests/e2e/knowledge-suggestions.spec.ts`)**, with new fake-brain scenarios under `tests/e2e/fixtures/claude-scenarios/`:

- The brain suggests one new note and one update after a reply: the chip reads "Suggestions 2", accepting the new one creates the note, the update shows marked lines.
- Edit then Cancel, Edit then Accept, Discard, Accept all, Discard all.
- A note edited after the suggestion shows "changed since"; a deleted one offers Add as a new note; a taken name; an unreachable linked folder.
- A sixth suggestion in one request is refused; a discarded one is not offered again.
- The setting off: nothing appears on its own, asking still works, waiting ones stay.
- No macOS notification and no change to the Needs attention count.
- Suggestions survive quitting and reopening Arc.
- One scenario each on the fake Codex and fake Cursor brains for the tool call itself.

The Feature Testing & Regression slice maps every acceptance criterion in the functional spec to these tests.
