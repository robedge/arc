# Technical Specification: Inline Needs Attention

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Today the main process pushes the waiting requests of a session to the renderer (`session:attention`), and the renderer draws them with four hand-written cards inside a modal opened from a header button. The spike added a second, unrelated way to draw interactive content: the brain's `show_surface` tool, which stores an A2UI surface on a system message and draws it with a generic renderer.

This spec joins the two:

1. **The main process builds a surface for every request.** A pure builder turns each request into plain A2UI component JSON, using only generic catalog parts. No model and no Express are involved. The surface travels with the request in the existing `session:attention` push.
2. **One generic renderer, two mount points.** The spike's `SurfaceView` loses its hard-coded "send a message to the brain" click and takes an `onAction` callback instead. A brain panel is mounted by an adapter that sends `[Surface action]` messages. A request panel is mounted by a different adapter that calls the existing answer IPC. What a click does is decided by where the surface is mounted, never by anything inside the surface.
3. **A dock replaces the header button and the modal.** A new `AttentionDock` sits between the message list and the composer on the Brain tab. The header badge, the dialog and the four cards are deleted.
4. **A user answer writes a record.** The one place that handles a user's answer posts a system message with a new prompt kind. No schema change is needed.
5. **The spike becomes real code.** Catalog id, file locations, wording and tests are promoted; three generic parts are added; existing sessions are told about `show_surface`.

Affected systems: attention service and coordinator, branch-on-demand answer path, orchestrator (system message, brain prompt), worker manager (stop), the surface catalog and brain tool, the IPC event type, and in the renderer the conversation, tabs, header, step-in bar, message bubble, active-session store and design preview. No provider adapter changes. No database migration. No real provider turns are needed to build or test the request panels.

This spec replaces the needs-attention presentation described in spec 002 (badge and dialog pattern) and spec 003, and the dialog card of spec 013 section 2.3. It promotes the A2UI spike (commit `87219ef`).

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Request surfaces (main process)

| Topic | Design |
|---|---|
| Builder | New `src/main/surface/attention-surface.ts`: `buildAttentionSurface(view, { allowAlways })` returns a `Surface`. Pure: no Electron, database or clock. `surfaceId` is the request id. |
| Determinism | The same request always yields byte-identical JSON. The renderer relies on this to keep what the user typed when the list is pushed again, and to reset a panel only when its surface really changed (a failed "Bring them along"). |
| Where it is attached | `AttentionView` (`src/shared/types/session.ts`) gains `surface: Surface`. It is set in `attentionView()` and `branchQuestionViews()` in `src/main/sessions/attention-service.ts`. The `session:attention` payload shape is otherwise unchanged. |
| What stays outside the surface | Kind, `from`, `route`, `workerId` and the id remain plain `AttentionView` fields. The renderer wrapper draws the frame from them (section 2.4). |
| `allowAlways` | False for requests routed to a worker's terminal and for requests for more access. The builder then leaves the "Always allow this in this session" button out. |
| `from` label | The computation inside `attentionView()` is extracted to a pure helper `attentionFrom(row, workerLabel)` so the view and the record (section 2.6) cannot disagree. |

Surface content per kind, all from generic parts:

| Kind | Parts |
|---|---|
| Permission, command | Text "Wants to run", `CodeBlock` with the command, optional reason `Text`, buttons |
| Permission, tool from a connected server | Text, `KeyValue` (Server, Tool), `CodeBlock` with the arguments and limits of 10 lines / 400 characters, or Text "No arguments.", buttons |
| Permission, more access | Text, reason, `KeyValue` (Read, Write, Network), buttons without "always" |
| Question | Text, `TextField` "Your answer" bound to `/answer` with Enter-to-submit, Button "Send" requiring `/answer` |
| Question with choices | Per question `i`: header and question `Text`, `ChoicePicker` bound to `/q{i}`, `TextField` "Other" bound to `/o{i}`; Buttons "Decline" and "Submit", the latter requiring `/q{i}` or `/o{i}` for every `i` |
| Unsaved changes | Optional warning `Callout`, Text "Waiting to start: …", file list, `ChoicePicker` in radio display bound to `/choice` with a description per option (three options after a failed carry), Button "Continue" requiring `/choice` |

Button events and the answer they map to:

| Event | Context | Answer |
|---|---|---|
| `approve` / `deny` / `always` | none | `attention:answer` `{approve}` / `{approve:false}` / `{approve, always}` |
| `send` | `{text}` | `attention:answer` `{text}` |
| `submit` | `{q0…, o0…}` | `attention:answer` `{answers}` keyed by question text; non-empty "Other" text replaces the picks |
| `decline` | none | `attention:answer` `{decline: true}` |
| `continue` | `{choice}` | `sessions:answer-branch-question` `{questionId, choice}` |

The mapping lives in a pure function `toAnswer(view, eventName, context)` in new `src/shared/attention-action.ts`. It returns the IPC name and payload, or null for anything that does not fit (unknown event, empty answer, a choice not offered). Both IPC contracts stay exactly as they are.

### 2.2. Catalog changes

File: `src/main/surface/arc-catalog.ts`. Catalog id changes from `arc:catalog/spike-1` to `arc:catalog/1`. All parts are generic and available to the brain; there are no request-only parts.

| Part | Change |
|---|---|
| `CodeBlock` (new) | `text`, optional `maxLines`, `maxChars`. When a limit is exceeded the block is cut and offers "Show more" / "Show less". |
| `KeyValue` (new) | `items: [{label, value}]`; a value may be a string or a list of strings (shown one per line, in mono). |
| `Text` | New optional `maxLines`: longer text is cut with "Show more" / "Show less". |
| `ChoicePicker` | Options gain an optional `description`. New `display`: `buttons` (default) or `radio`. New optional `overriddenBy`: a data path; while that path holds non-empty text the picks are shown as not selected. Single and multiple selection keep the basic catalog's `variant`. |
| `TextField` | New optional `submit`: the id of a Button; pressing Enter runs that button's action if the button is enabled. |
| `Button` | New optional `requires`: a list of entries, each a data path or a list of alternative paths. The button is enabled when every entry has a non-empty value (string, or non-empty list) at one of its paths. |
| `Callout` | Unchanged; used for the failed-carry message. |

These are Arc extensions inside Arc's own catalog, which is how A2UI v1.0 expects custom behaviour to be added. `src/shared/surface.ts` needs no new child-reference keys, since no new part has children.

### 2.3. The generic renderer (renderer)

The spike files move out of `components/sessions/` and stop being marked as throwaway.

| File | Responsibility |
|---|---|
| `src/renderer/src/lib/components/surface/SurfaceView.svelte` | Props `{ surface, idPrefix, onAction }`. Holds the local copy of the data model, resolves bindings, evaluates `requires`, draws the node tree. Owns busy and error state around `await onAction(...)`: buttons are disabled while busy; a returned string is shown as the panel's error; a thrown error shows "Could not send the answer. Try again." |
| `src/renderer/src/lib/components/surface/parts/` | One file each for the heavier parts: `CodeBlock`, `KeyValue`, `ChoicePicker`, `Table`, `Stat`. Layout parts and `Text` stay inline in `SurfaceView`. |
| `src/renderer/src/lib/components/surface/SurfaceChart.svelte` | Moved unchanged. |
| `src/renderer/src/lib/components/surface/BrainSurface.svelte` | Adapter for a surface on a message. Its `onAction` builds the `[Surface action]` text, sends it with `sessions:send-message` and adds the user message. This is the spike's `fire()` moved out of the generic view. Used by `MessageBubble.svelte`. |
| `src/shared/surface.ts` | Keeps the schema, structure check, pointer helpers and action parsing. Gains the pure helpers the view needs (`requires` evaluation, context resolution) so they can be unit tested. |

`onAction` receives `{ surfaceId, name, label, sourceComponentId, context }` with the context already resolved to plain values (no reactive proxies cross IPC). An unknown component still renders nothing, and logs a warning in development.

`SurfaceView` initialises its model once per mounted surface. If the `surface` prop changes to different JSON (compared by serialised text), the model is reset.

### 2.4. The dock and request panels (renderer)

| File | Responsibility |
|---|---|
| `src/renderer/src/lib/components/sessions/RequestPanel.svelte` | The fixed frame around one request: `<article>` with an amber (permission) or accent (question, unsaved changes) border, the kind label, the title for unsaved changes, and the `from` line; then `SurfaceView` for the body. Its `onAction` calls `toAnswer` and then `activeSession.answerAttention` or `answerBranchQuestion`, returning the error text. This file is the only place a surface click can reach an answer call. |
| `src/renderer/src/lib/components/sessions/AttentionDock.svelte` | Region labelled "Needs attention". Heading button "Needs attention · N" with `aria-expanded`, which folds and unfolds the list. Panels in a keyed list, oldest first. When folded the list is hidden, not unmounted, so typed values survive. Height capped at half the conversation with its own scroll. |
| `Conversation.svelte` | New `dock` snippet rendered between the scroller region and the footer region, outside the scrolling list. A `ResizeObserver` re-pins the message list to the bottom when the dock changes height and the list was at the bottom. |
| `ConversationTabs.svelte` | Passes the dock into `Conversation` on the Brain tab. While a worker tab is in front and requests wait, the Brain tab shows an amber count and its accessible name becomes "Brain, N waiting". Selecting the Brain tab unfolds the dock. |
| `StepInBar.svelte` | Uses `RequestPanel` for the terminal-routed requests instead of the old cards. The builder already omits "always" for these. |
| `SessionHeader.svelte` | The badge, the dialog and their handlers are removed. |
| `MessageBubble.svelte` | Draws a message whose prompt is an attention record as one quiet, borderless, truncated line with the full text in the native `title` (the codebase has no tooltip component). Uses `BrainSurface` for surface prompts. |

Store changes in `src/renderer/src/lib/stores/active-session.svelte.ts`:

| Removed | Added |
|---|---|
| `attentionDialog`, `openAttention`, `closeAttention` | `attentionFolded` (boolean), `attentionFocus` (`{ requestId, nonce }` or null), `focusRequest(requestId?)`, `toggleAttentionFold()` |

`focusRequest` selects the Brain tab, unfolds the dock and sets the focus target. The dock scrolls that panel into view and highlights it for two seconds; under reduced motion the highlight is a static outline with no fade. `applyAttention` unfolds the dock when the pushed list contains a request id that was not there before. `navigate-attention.ts` and `WorkerCard.svelte` call `focusRequest` where they called `openAttention`.

Deleted: `ui/AttentionBadge.svelte`, `ui/attention/AttentionDialog.svelte`, the four `ui/attention/*Card.svelte` files and `ui/attention/types.ts`. `DesignPreview.svelte` shows the dock (unfolded with all four kinds, and folded), a record line, and samples of the new parts instead of the badge and dialog samples.

Accessibility: a visually hidden polite status region outside the dock announces a new request ("New request: Permission from W2 api-retry"). After an answer, focus moves to the first control of the next panel, or to the message box when the dock is empty.

### 2.5. Keeping brain panels apart from request panels

| Guarantee | How |
|---|---|
| The brain cannot place anything in the dock | The dock is fed only from `session:attention`. It never reads messages. |
| A brain panel click cannot answer a request | `BrainSurface` only sends a message. Only `RequestPanel` calls the answer functions, and only the dock and the step-in bar mount it. |
| The brain cannot draw the request frame | The frame is fixed markup in `RequestPanel`, not a catalog part. Brain panels keep the plain message bubble. |
| The brain cannot use parts outside the catalog | `compileExpress` already rejects unknown components and unknown properties (verified with a probe). The old JSON input path is removed from `show_surface` (section 2.7). |
| A stored surface is not trusted on read | `parsePrompt` additionally checks that every component name of a stored surface is in the catalog, and drops the prompt otherwise. |

A brain panel can still contain the words "Permission" and "Approve". The frame and the position above the message box are what distinguish a real request.

### 2.6. Records

| Topic | Design |
|---|---|
| Storage | A system message through the existing `postSystemMessage`, with `content` holding the full plain text and a new prompt kind. `prompt_json` is free-form, so there is no migration. |
| Prompt shape | `{ kind: 'attention-record', decision, subject, answer?, from }` with `decision` one of `approved`, `denied`, `always`, `answered`, `declined`, `branch`. Added to the `MessagePrompt` union and to the `parsePrompt` whitelist in `src/main/sessions/message-prompt.ts`. |
| Text | Built by one pure function `recordText(prompt)` in `src/shared/`, used for `content` and by the renderer: "Approved: <subject> (<from>)", "Denied: …", "Always allowed in this session: …", "Answered: <question> → <answer> (<from>)", "Declined: <question> (<from>)", "Unsaved changes in <project>: <choice label> (Arc)". |
| Subject | Command text; "<server> · <tool>" for a tool; "more access" plus the reason for an access request; the question text (first question, plus "and N more" for several). |
| Where written, requests | In `AttentionCoordinator.answer()`, the user-only entry point, after the request is settled and before `resolveCovered()`. Only when the row's route is `queue`. A new host method `recordAnswer` is wired to the orchestrator's `postSystemMessage`. An "always" answer writes one record; the other requests it clears write none. |
| Where written, unsaved changes | In `SessionService.answerBranchQuestion`, after `BranchOnDemand.answer` returns `ok` (this includes "Don't start"). `not-open` and `failed` write nothing; a failed "Bring them along" is recorded only when a later choice succeeds. |
| Not written for | Answers in a stepped-in worker's terminal, the brain's `resolve_request`, auto-approval, withdrawn or cancelled requests. |
| The brain | Records are system messages, which the hand-off preamble already skips. Nothing new is sent to the brain. |
| Session list | Nothing in the session list derives from messages, so a record does not change a session's status or order. |
| Ordering | `postSystemMessage` flushes pending brain text before it emits, so a record made while the brain is replying appears after the text shown so far. |

### 2.7. Promoting the spike (main process)

| Item | Change |
|---|---|
| Wording | Remove "SPIKE" and "Throwaway" from `src/shared/surface.ts`, `src/main/surface/*`, `src/main/bridge/tools/show-surface.ts` and the brain instruction line in `orchestrator.ts`. |
| Old input shape | Remove the `components` input and the `format_changed` refusal from `show_surface`; `express` becomes required. |
| Tool description | Keep the generated component signatures. Shorten the fixed guide text and the example so the new parts do not grow the per-turn cost. |
| Existing sessions | `BRAIN_PROMPT_VERSION` goes to 10 with `PROMPT_UPDATE_NOTE_V10` telling a resumed brain that it can show panels with `show_surface`. Added to the `promptUpdateNote` chain in the same way as version 9. |
| `ask_user` description | "It appears in their Needs attention list" becomes "It appears above their message box." |
| Scripts and fixtures | `scripts/spike-a2ui.ts` and the spike fixtures are renamed without "spike", or removed if no test uses them. |

### 2.8. A stopped worker's waiting requests

Today, stopping or removing a worker leaves its pending requests in place, so their panels would stay docked. The functional spec requires the panel to leave.

- New `AttentionCoordinator.cancelForWorker(workerId)`: sets the worker's pending requests to `cancelled`, marks them delivered, and pushes the new list.
- Called from `WorkerManager.stop()` only when the stop was asked for by the user, and from worker removal.
- Not called on quit, crash or restart: a resumed worker still needs its requests.
- Unsaved-changes questions are already closed by the existing orphan cancellation.

**Decided (user, 2026-11-14):** the step-in bar switches to `RequestPanel` and the old cards are deleted (2.4); a worker's waiting requests are cancelled on user stop and removal (2.8); existing sessions learn `show_surface` through brain prompt version 10 (2.7).

### 2.9. Amendments from review (2026-11-14)

| Topic | Design |
|---|---|
| Dock height | The dock wrapper in `Conversation.svelte` keeps `max-height: 50%` as the base. `AttentionDock` measures its heading plus first panel and raises the cap to that height when it is larger, limited to 80% of the conversation. The list still scrolls for everything after the first panel. Panel vertical spacing in `RequestPanel` is tightened. |
| Unsaved-changes record | `SessionService.answerBranchQuestion` posts the record before it awaits `BranchOnDemand.answer`, once the question is known to be open. The `attention-record` prompt gains optional `failed: true`. On a `failed` result the stored message is updated (content and prompt) and pushed again, the way the `continue-workers` message is re-pushed; `recordText` then reads "Unsaved changes in <project>: <choice> did not work (Arc)". `not-open` removes nothing because nothing was posted. This replaces "a failed carry writes no record" in 2.6. |
| Window size (separate from this spec's topic, requested with it) | The main window opens filling the work area of the display it opens on (the screen minus the menu bar and Dock), not in macOS full screen. End-to-end runs keep their fixed window size. |

---

## 3. Impact and Risk Analysis

**System dependencies**

- `session:attention` consumers: the active-session store only. The payload grows by one surface per request (small; a few kilobytes at most for long tool arguments, which are sent in full so "Show more" needs no round trip).
- The step-in bar changes implementation but not behaviour.
- `@a2ui/agent` stays a main-process dependency for brain panels only. Request panels do not use it.
- Brain prompt version change touches the pinned prompt tests of versions 7, 8 and 9.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| The generic parts cannot express a behaviour of today's cards, and the request panels regress. | Section 2.1 lists every behaviour against a part. Renderer tests port each existing card test to the panel before the cards are deleted. |
| What the user typed is lost when the list is pushed again. | Panels are keyed by request id, the model is initialised once, the builder is deterministic, and folding hides rather than unmounts. Covered by tests. |
| A brain panel is mistaken for, or acts as, a request. | Section 2.5: separate mount points, fixed frame, catalog check on compile and on read. A renderer test proves a brain "Approve" click only sends a message. |
| Cancelling requests on stop breaks a brain flow that expects the request to survive. | Limited to user stops and removal. Unit tests for user stop, removal, quit and crash. |
| About 30 test files reference the badge or dialog. | The end-to-end specs each define their own two locators, so the change per file is mechanical: one shared helper for "the request panel" in `tests/e2e/`, and `NEEDS_ATTENTION` in `tests/e2e/codex-rig.ts` updated once. |
| The dock makes the conversation jump or covers the latest message. | Dock is outside the scroller, capped at half height, and the list re-pins on dock resize. Checked with the `verify-ui` scripts for overflow and visibility. |
| A larger tool description costs tokens every brain turn. | Fixed text is shortened to offset the three new signatures; the description length is pinned by a unit test with an upper bound. |
| Existing sessions misuse `show_surface` after the version 10 note without having seen the tool before. | The tool description carries the full format, and a refusal names what is wrong. One real turn per provider is run once at the end (see section 4). |

---

## 4. Testing Strategy

**Unit (Vitest, main and shared)**

- `attention-surface`: one case per request kind; no "always" for terminal route and for access requests; the failed-carry variant offers three choices and a warning; identical input gives identical JSON; every produced component name is in the catalog and passes `surfaceProblem`.
- `attention-action`: every event to its answer; "Other" replaces picks; invalid context returns null.
- Records: written once for approve, deny, always, text, choices and decline on the queue route; not written for terminal route, `resolve_request`, auto-approval, withdrawal, or a failed answer; one record for an "always" answer that clears other requests. Unsaved changes: ok and skip write one, not-open and failed write none.
- `parsePrompt`: the record kind round-trips; a stored surface with an unknown component is dropped.
- Catalog and Express: the three new parts compile from Express; an unknown component and an unknown property are refused; `show_surface` without `express` is a validation error.
- `cancelForWorker`: user stop and removal cancel; quit and crash do not.
- Brain prompt: version 10 note chain; pinned tool lists updated.

**Renderer (Vitest)**

- Parts: `CodeBlock` cut and expand; `ChoicePicker` radio display, descriptions, and `overriddenBy`; `Button.requires` with alternatives; Enter-to-submit only when the button is enabled; `Text` `maxLines`.
- `SurfaceView`: `onAction` contract, busy state, returned and thrown errors, model reset only when the surface changes.
- `RequestPanel`: each kind renders its frame and answers through the right store call; error text stays with input in place.
- `AttentionDock`: count, order, fold and unfold, unfold on new request, typed values kept while folded and across pushes, focus and highlight, focus after answering, announcement.
- Isolation: a brain panel with an "Approve" button only sends a message while a real request stays pending.
- Brain tab count; header has no badge; record line in the conversation; design preview.

**End-to-end (Playwright)**

- Existing approval, question, command-question, unsaved-changes, step-in, MCP and provider specs switch from "open the dialog" to "use the docked panel".
- New `tests/e2e/spec-014-acceptance.spec.ts` covering the functional spec's criteria that need the real app: docked area and count, answering each kind, records surviving a restart, notification click and amber worker card leading to the panel, Brain tab count, fold and unfold, brain panel isolation.

**Real provider turns**

None are needed for request panels. For the promoted brain panels, one real turn per provider (Claude, Codex, Cursor on Auto) using the Express format with the new parts, run once at the end and approved by the user beforehand. The Express format has so far been tried live only with Claude.

**Order of checks**

Per slice, only the touched tests. Typecheck, lint, format, the full unit suite and the full end-to-end suite once at the end.
