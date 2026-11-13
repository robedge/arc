# Technical Specification: Attachments for the Brain

- **Functional Specification:** `context/spec/012-brain-attachments/functional-spec.md`
- **Status:** Draft
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

An attachment is a file that Arc copies when the user adds it, keeps with the session when the message is sent, and hands to the brain as a path the brain can read.

1. **Staging.** When the user pastes, drops or picks a file, the main process validates it and copies it into a staging folder. The renderer only holds metadata (`id`, name, kind, size).
2. **Sending.** `sessions:create` and `sessions:send-message` carry the staged ids. The main process copies the files into `userData/sessions/<sessionId>/attachments/`, and writes the message row and its attachment rows in one transaction.
3. **Delivery.** The brain's turn gets a text block that lists each attachment with its absolute path. That folder is a read-only directory for the brain, so every provider can open the file with its own tools. Images are also sent as native image input where the provider supports it.
4. **Workers.** `spawn_worker` and `message_worker` gain an `attachments` field (attachment ids). The worker gets the same folder read-only and the same text block.
5. **Display.** A new `arc-attachment://` protocol serves thumbnails and full-size images to the renderer, for staged and sent attachments.

Text files and PDFs are never inlined into the prompt. This keeps large files out of the context until the brain chooses to read them, and keeps file contents as tool results, not as user instructions.

Affected areas: a new `src/main/attachments/` service and IPC handlers, the session service and orchestrator, all three provider adapters, two bridge tools and the brain prompt, one new table and one new column, a new protocol and a CSP entry, and the renderer's message box, New Session dialog and message bubble.

No new dependency is needed. The existing specialists cover the work.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Facts checked before designing

| Fact                                                                                                                                                                  | Where                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The whole path from IPC to the agent carries plain strings: `create()` / `sendMessage()` → `Orchestrator.send(text)` → `sendToBrain` → `AgentHandle.send(text)`.      | `session-service.ts:430,1661`, `orchestrator.ts:966,1017`, `agent-adapter.ts:189` |
| `sessions:create` requires `request` of at least 1 character; `sessions:send-message` is `{sessionId, text: min(1)}.strict()`.                                        | `src/shared/ipc/contract.ts:200,295`                                              |
| Claude's `send()` already writes `content` as an array of blocks, and runs with `--replay-user-messages`.                                                             | `claude-adapter.ts:333,72`                                                        |
| Codex input is `text` or `skill` only. A `localImage` input (a path) exists in the app-server schema of the installed 0.163.0; the pinned 0.162.1 is not yet checked. | `codex-types.ts:18`, `codex-adapter.ts:466,537`                                   |
| Cursor sends `prompt: [{type:'text'}]`. Recorded real fixtures advertise `promptCapabilities: {image: true, embeddedContext: false}`; Arc does not parse it.          | `acp-client.ts:128`, `cursor-types.ts:99`, `tests/fixtures/cursor/`               |
| The brain's readable directories are `addDirs` (projects + knowledge); `launchKey()` hashes cwd + `addDirs`. Cursor has no add-dir equivalent.                        | `session-service.ts` ~2050, `orchestrator.ts:169`                                 |
| `userData/sessions/<id>` holds `brain/` and worker logs, and is deleted with the session.                                                                             | `build-services.ts:522`, `session-service.ts:1637`                                |
| Unsent text drafts are renderer memory only, in a non-reactive `Map`.                                                                                                 | `stores/active-session.svelte.ts:70`                                              |
| The preload exposes `invoke`, `on` and `getPathForFile`. `Dialogs.pickFiles` has an e2e stub.                                                                         | `src/preload/index.ts:23`, `src/main/platform/dialogs.ts`                         |
| The CSP allows `img-src 'self' data: arc-knowledge:`. `blob:` is not allowed.                                                                                         | `src/main/app/csp.ts`                                                             |
| `ui/DropZone.svelte` already turns dropped files into paths and gets past the window-level drop guard.                                                                | `App.svelte:36,111`                                                               |
| The open-session box (`Composer.svelte`) and the first-message box (`NewSessionDialog.svelte`) are two separate components with no paste or drop handling.            | `components/sessions/`                                                            |
| All three fakes record the full user turn (`FAKE_CLAUDE_LOG`, `FAKE_CODEX_LOG`, `FAKE_CURSOR_LOG`).                                                                   | `tests/e2e/fixtures/`                                                             |
| `IMPORT_MAX_BYTES` (20 MB) and `TEXT_EXTENSIONS` already exist. Error codes `FILE_UNSUPPORTED` and `FILE_TOO_LARGE` exist.                                            | `src/shared/limits.ts`, `src/shared/errors.ts`                                    |

### 2.2 Real-CLI checks needed first

Three behaviours cannot be proven with the fakes. Each needs one real turn, approved by the user as the spec 010 Cursor spikes were. They form the first slice, and their recordings go under `tests/fixtures/`.

| #   | Provider | What the turn proves                                                                                                             | If it fails                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| S1  | Claude   | A base64 `image` block over stream-json reaches the model, and the brain can read a PDF and a text file by path from an add-dir. | Images go by path only.                                             |
| S2  | Codex    | `localImage` with a path outside the cwd works on 0.162.1, and the read-only brain sandbox can read the attachments folder.      | Copy attachments into the brain's own folder (`codex-brain/<id>/`). |
| S3  | Cursor   | An ACP `image` block reaches the model, and Cursor's tools can read an absolute path outside the cwd.                            | Images by path only; copy attachments into the cwd.                 |

The user approved these three turns on 2026-11-12, one run each. Any further real turn needs a new approval.

**Outcome (run on 2026-11-12, one real turn each).** Recordings and findings are in `tests/fixtures/claude/attachments/`, `tests/fixtures/codex/0.163.0/attachments/` and `tests/fixtures/cursor/2026.10.19-6bbf2c4/attachments/`, each with a README.

| #   | Result  | What the real turn proved                                                                                                                                                                                                                                                                                                                                       | What it did not prove                                                                                                                                                                                               |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Passed  | Claude 2.1.322, model haiku. The model read the base64 `image` block ("Error 4012") with no tool call. It read a one-page PDF by path with `Read` and a text file by path, both from an `--add-dir` folder, with no permission denial. The replayed user event echoed the full base64 of the image. A PDF `Read` also put base64 into a `tool_result` event.    | Large images near the 5 MB limit. Multi-page or scanned PDFs. The permission prompt tool in the loop.                                                                                                               |
| S2  | Partial | Codex 0.163.0, not the pinned 0.162.1 (not installed on this Mac). `localImage` is in the schema. The model read the image outside the cwd ("Error 4012"). A no-model `command/exec` under the read-only sandbox could `cat` and `ls` the attachments folder outside the cwd and could not write there. The schema has no PDF input and no inline base64 image. | The model never opened the text file. It ran no tool and guessed "3 attempts". So a model-run read of a listed path was not seen, and neither was an approval prompt under `untrusted`. Nothing was run on 0.162.1. |
| S3  | Passed  | Cursor 2026.10.19-6bbf2c4, Free tier, Auto. `initialize` advertised `promptCapabilities.image: true` and `embeddedContext: false`. The model read the image and read a text file at an absolute path outside the cwd, in `ask` mode, with no permission request. Cursor writes its own copy of an image block under `~/.cursor/projects/<slug>/assets/`.        | `agent` mode (a worker's mode). Large images. PDFs. Whether that copy under `~/.cursor` is ever cleaned up.                                                                                                         |

### 2.3 Storage on disk

| Location                                                                 | Holds                                                                       | Removed when                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `userData/attachment-staging/<draftId>/<attachmentId>/<stored name>`     | Files added to a message that is not yet sent, plus `thumb.png` for images. | The attachment is removed, the draft is discarded or sent, or at app start (the whole staging root is cleared). |
| `userData/sessions/<sessionId>/attachments/<attachmentId>/<stored name>` | Files of sent messages, plus `thumb.png`.                                   | The session is deleted (existing `removeSessionDir`).                                                           |

- `attachmentId` and `draftId` are ULIDs made by the main process. They are the only variable path segments; the stored name is the sanitised base name (control characters and separators stripped, 120 characters at most).
- A draft id belongs to one message box: one per open session, and one per opening of the New Session dialog.
- Staged files do not survive an app restart, because text drafts don't either.
- Attachment contents and paths are not written to the main log.

### 2.4 Validation at attach time

Done in the main process, in `src/main/attachments/attachment-validate.ts`. The renderer is never trusted for type, size or count.

| Check        | Rule                                                                                                                                              | Refusal reason |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Regular file | `realpath` then `stat`; a directory is refused.                                                                                                   | `folder`       |
| Readable     | The file can be opened.                                                                                                                           | `unreadable`   |
| Size         | 1 byte to `IMPORT_MAX_BYTES` (20 MB). An empty file is refused as unsupported.                                                                    | `too_large`    |
| Count        | Staged plus in-flight items for the draft are at most `ATTACHMENTS_MAX_PER_MESSAGE` (10).                                                         | `too_many`     |
| Image        | Extension and magic bytes both say PNG, JPEG, GIF or WebP.                                                                                        | `unsupported`  |
| PDF          | `%PDF-` in the first 1 KB.                                                                                                                        | `unsupported`  |
| Text         | Extension in `TEXT_EXTENSIONS`, or the first 8 KB has no NUL byte and decodes as UTF-8. SVG counts as text. HEIC, archives, audio and video fail. | `unsupported`  |

Each file gets a `kind` of `image`, `pdf` or `text`. The renderer maps refusal reasons to the spec's messages.

### 2.5 Data model

New table `message_attachments` (migration `0030`, generated with the project's `db:generate`):

| Column        | Type              | Notes                                               |
| ------------- | ----------------- | --------------------------------------------------- |
| `id`          | text, primary key | ULID; also the folder name on disk.                 |
| `message_id`  | integer, not null | References `messages.id`, cascade on delete.        |
| `session_id`  | text, not null    | References `sessions.id`, cascade on delete.        |
| `position`    | integer, not null | Order within the message; unique with `message_id`. |
| `kind`        | text, not null    | `image`, `pdf` or `text` (checked).                 |
| `mime`        | text, not null    |                                                     |
| `size_bytes`  | integer, not null | Checked against the 20 MB limit.                    |
| `name`        | text, not null    | Display name, including "Pasted image 1".           |
| `stored_name` | text, not null    | Sanitised file name on disk.                        |
| `created_at`  | integer, not null |                                                     |

The path is derived from `session_id`, `id` and `stored_name` by one helper; no path is stored.

New column `workers.attachments_json` (nullable text) in the same migration: the attachments the brain passed to that worker, as `[{id, name, kind}]`.

New `MessageAttachmentsRepo` (`insertMany`, `listForMessages(messageIds)`, `get`, `getMany(ids, sessionId)`, `listForSession`). `MessagesRepo` is unchanged; the code that builds `SessionMessage` loads a page of messages and then their attachments in one further query.

### 2.6 Main-process service and IPC

New `src/main/attachments/attachment-service.ts` (`AttachmentService`), built in `build-services.ts`.

| Channel                     | Request                                                          | Response                                              |
| --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `attachments:new-draft`     | `{}`                                                             | `{draftId}`                                           |
| `attachments:stage-paths`   | `{draftId, paths: string[]}`                                     | `{attachments: AttachmentMeta[], refused: Refusal[]}` |
| `attachments:stage-bytes`   | `{draftId, bytes: Uint8Array, mime}` (one pasted image per call) | Same shape.                                           |
| `attachments:pick`          | `{draftId}`; opens the file picker, then stages                  | Same shape.                                           |
| `attachments:remove`        | `{draftId, id}`                                                  | `{}`                                                  |
| `attachments:discard-draft` | `{draftId}`                                                      | `{}`                                                  |

- `AttachmentMeta` is `{id, name, kind, mime, size}`. `Refusal` is `{name, reason}`.
- Pasted images are named "Pasted image N" by the service, numbered per draft.
- `sessions:create` and `sessions:send-message` gain optional `draftId` and `attachmentIds` (at most 10). The text may be empty when `attachmentIds` is not. `sessions:send-message` returns the stored attachments with the message id.
- New error code `ATTACHMENT_UNREADABLE` with the file's name in its details, for a staged file that is missing at send time.

**Send order** (in `SessionService`, one lock per draft so a double click cannot send twice):

1. Check that every staged file is still readable. If not, fail with `ATTACHMENT_UNREADABLE`; nothing is written.
2. Copy the files into the session's attachments folder.
3. In one transaction, insert the message row and the attachment rows (and the session row for `sessions:create`).
4. Delete the staged copies.

If a copy fails, the copied folders are removed and no rows exist. If the insert fails, the transaction rolls back and the copied folders are removed. `sessions:create` still writes nothing when the provider's CLI is unavailable, and the staged files stay for a retry.

### 2.7 The `arc-attachment://` protocol

New `src/main/protocol/attachment-protocol.ts`, modelled on the knowledge protocol and registered in the same `registerSchemesAsPrivileged` call.

- URL: `arc-attachment://staged/<attachmentId>` and `arc-attachment://sent/<attachmentId>`, with `?thumb=1` for the thumbnail.
- GET only. The id must be a ULID. The file is found by id (the service's staging index, or the `message_attachments` row), never by a path from the URL. The resolved path must be a regular file inside the staging root or the session's attachments folder.
- Only attachments of kind `image` are served, with `nosniff`.
- Thumbnails are made once at stage time with `nativeImage` (96 px high) and saved as `thumb.png`. If `nativeImage` cannot decode the file, the original is served.
- CSP: add `arc-attachment:` to `img-src` only.

### 2.8 Delivery to the brain

`AgentHandle.send(text, attachments?)` gains an optional list of `AttachmentRef` (`{id, name, kind, mime, size, path}`). `Orchestrator.send` and `sendToBrain` pass it through. Each adapter decides how to deliver, so the orchestrator stays provider-blind.

**Layer 1, every provider and every kind.** A text block is appended to the user's text, after any pending notes:

```text
[Attachments for this message]
- <id> · <name> · <kind> · <size> · <absolute path>
```

The session's attachments folder is always in the brain's `addDirs` (read-only), created when the session is created. It is the same for the life of the session, so `launchKey()` does not change when a message has attachments.

**Layer 2, images only, subject to the checks in 2.2.**

| Provider | Native image input                                                               |
| -------- | -------------------------------------------------------------------------------- |
| Claude   | A base64 `image` block per image of 5 MB or less. Larger images go by path only. |
| Codex    | A `localImage` input with the stored path. `CodexInput` gains this variant.      |
| Cursor   | An ACP `image` block when the agent advertised `promptCapabilities.image`.       |

Claude replays user messages, and S1 showed the replayed event holds the image's full base64. Today `claude-parser.ts` already keeps no base64: `parseUser` (lines 531 to 553) turns only `tool_result` blocks into events, so the replayed `image` block is ignored, and `resultText` (lines 185 to 196) keeps only the `text` blocks of a tool result, so the base64 a PDF `Read` returns as a `document` block is dropped too. The Claude adapter feeds each stdout line to the parser (`claude-adapter.ts:218-221`) and I found no code that writes raw stdout to disk. The one place a whole line could survive is the `unknown` event, which keeps `raw` when a user event fails the schema (`claude-parser.ts:299,533`); the terminal log and the orchestrator ignore `unknown` events (`terminal-log.ts:170`, `orchestrator.ts:2271`). So the rule is: no event, event log, raw log or main log line may hold base64 from an `image` block or from a PDF `document` block or `tool_use_result.file.base64`. Slice 6 adds a test for that, and any future raw-line logging must strip those fields first. Cursor and Codex do not echo image bytes, so only the outgoing prompt needs care there.

**Capability table.** New `src/shared/attachments.ts` holds `ATTACHMENT_SUPPORT`, a static table per provider, because the warning must show in the New Session dialog before any process exists.

| Provider | Image | PDF | Text |
| -------- | ----- | --- | ---- |
| Claude   | yes   | yes | yes  |
| Codex    | yes   | no  | yes  |
| Cursor   | yes   | no  | yes  |

The values are confirmed by S1 to S3, with these limits: the files were small (one-page PDF, a few KB of image and text); Codex text reading is proven by a no-model command, not by the model; Cursor was run in `ask` mode, not the worker's `agent` mode. Codex and Cursor stay at "no" for PDF because no input exists (Codex) or none was shown to work (Cursor `embeddedContext` is false). The 5 MB inline limit for Claude stays as written. It has not been tested near the limit.

**No copy fallback.** All three providers read the session attachments folder in place, outside their working directory, so no fallback is taken: attachments are not copied into `codex-brain/<id>/` or into the cwd. Images still also go by path in the Layer 1 block, which is the fallback for an image over the limit.

**Prompt rule.** The Codex model answered without opening a path it was given. The brain prompt and the worker's first message must therefore tell the agent to open a listed file when the request depends on it, and not to guess from the file name.

The renderer shows the functional spec's warning when a draft holds a kind the session's brain provider does not support.

**Other paths through `send`:**

| Case                                             | Behaviour                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| The message is a `/command`                      | The send is refused before anything is written: "Attachments can't be sent with a command." The text and attachments stay in the box. |
| A plan is waiting and the text would be feedback | The send is refused: "Attachments can't be added to plan feedback." The text and attachments stay in the box.                         |
| The brain is mid-turn                            | The attachments ride with the queued message in each adapter (Codex's queue already holds structured input).                          |
| Handoff to another provider                      | The handoff summary lists the session's earlier attachments in the Layer 1 format. Native blocks are not re-sent.                     |
| Stop                                             | Nothing to undo. Sent attachments stay.                                                                                               |

### 2.9 Passing attachments to workers

- `spawn_worker` and `message_worker` gain `attachments?: string[]` (attachment ids, at most 10). An id that is not an attachment of this session is a tool error that lists the valid ids.
- The worker's launch adds the session's attachments folder to `addDirs` and `readOnlyDirs` (`worker-manager.ts`), for every worker, so the launch does not depend on what is passed later.
- The worker's first message, or the `message_worker` text, gets the Layer 1 block. Native image input applies on the worker's provider as it does for the brain.
- `workers.attachments_json` records what was passed; the worker's task view lists them by name.
- `BRAIN_PROMPT_VERSION` goes from 7 to 8. The prompt explains the attachments block and the `attachments` field, and tells the brain to open a listed file when the request depends on it (the worker's first message says the same). Running sessions get a deferred prompt-update note, as for earlier versions.

**Confirmed position (Slice 1):** workers read attachments in place from the session folder, so no copy next to the worktree is needed. S1 (Claude `--add-dir`), S2 (Codex read-only sandbox, by a no-model command) and S3 (Cursor `ask` mode) each read a file outside the working directory without a prompt. Limits: a worker is not the brain. Cursor in `agent` mode, and a model-run Codex read under `approvalPolicy: untrusted` (where a `cat` may ask for approval), were not observed. Those two are checked with the fakes in the Slice 7 e2e plus a manual note, and a failure there reopens the copy fallback (a folder next to the worktree, never inside the repository).

### 2.10 Renderer

| Piece                                                 | Responsibility                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stores/attachments.svelte.ts`                        | Reactive drafts keyed by draft id: items with state `staging`, `ready` or `error`. Results land in the draft that started them, even after a session switch. |
| `lib/attach-input.ts`                                 | `extractPasted(clipboardData)` and the calls to the staging channels.                                                                                        |
| `components/sessions/AttachField.svelte`              | Shared by both message boxes: wraps the box in `DropZone`, holds the Attach button, the row, the notices and the preview.                                    |
| `components/sessions/AttachmentNotices.svelte`        | One line per refused file (`role="status"`), dismissible, at most 3 lines then "and N more were refused." Also the brain-can't-read warning.                 |
| `ui/AttachmentRow.svelte`, `ui/AttachmentChip.svelte` | The row and its items. `role="toolbar"` with roving focus: Left/Right, Home/End, Enter or Space opens an image, Delete or Backspace removes.                 |
| `ui/ImagePreview.svelte`                              | Full-size image on top of `Modal`. Escape closes only the preview and returns focus to the item that opened it.                                              |
| `ui/DropZone.svelte`                                  | New optional `label` prop that shows "Drop to attach" while files are dragged over.                                                                          |
| `ui/icons.ts`                                         | New `paperclip` and `image` icons.                                                                                                                           |
| `Composer.svelte`, `NewSessionDialog.svelte`          | Embed `AttachField`, wire `onpaste`, pass ids on send. `canSend` becomes "text or a ready attachment, nothing staging, not sending".                         |
| `MessageBubble.svelte`                                | Shows a read-only row after the text. Images open `ImagePreview`; other files show name and size.                                                            |
| `DesignPreview.svelte`                                | Samples for the chip states, the row, the notices and the drop overlay.                                                                                      |

**Paste rules** (`extractPasted`):

1. No files on the clipboard: do nothing; the text pastes as usual.
2. A file with a path (copied in Finder): stage by path.
3. A file with no path (a screenshot): read its bytes and stage them.
4. If every file has no path and the clipboard also has plain text (a copy from a spreadsheet or document), treat it as text.
5. Prevent the default paste only when something was attached.

`SessionMessage` gains `attachments?: {id, name, kind, size}[]`. The local insert after a send uses the stored attachments returned by `sessions:send-message`.

Cancelling the New Session dialog discards its staged attachments (`attachments:discard-draft`), as it discards its text today.

### 2.11 Functional spec changes made for this design

Confirmed by the user on 2026-11-12 and applied to `functional-spec.md` (see its Change Log):

- A file is copied when it is attached, so deleting the original before sending does not block the send.
- "[name] could no longer be read. Remove it or attach it again." stays for the case that Arc's own copy is missing at send time.
- New refusal "[name] couldn't be read." for a file Arc cannot open.
- A message with attachments is refused when it is a command or would be plan feedback.
- Cancelling the New Session dialog discards its attachments.

### 2.12 Where the build differs from this design

Found while documenting the feature as built. `context/product/architecture.md` describes the built behaviour.

- **Image data in Claude's echo (2.8).** No stripping code was needed. The parser makes no event from a replayed user message, so nothing is stored. An echo over the 4 MB output line limit is dropped, and the adapter expects it, so no error line is shown.
- **`workers.attachments_json` (2.5).** It stores `[{id, name, kind, size}]`, with the size added for the worker details list.
- **Command workers (2.9).** A worker started from a command gets the attachments block in its system prompt, so its first message stays the bare command. It gets no native image.
- **Held messages.** A message held while the user is stepped in on a worker is delivered later with the text block only, and no native image.
- **Resumed workers.** Nothing is sent again on resume. The worker's conversation already holds the block.
- **Undelivered message.** If a plan starts waiting after the refusal check, the message is already stored and the user sees a notice that it was not delivered and should be sent again.
- **Cursor workers.** The attachments folder is in the worker's write deny list.
- **Inline limit (2.8).** The 5 MB limit applies to Claude and Cursor. Codex has no limit, because it receives a path.
- **IPC (2.6).** `attachments:remove` and `attachments:discard-draft` return nothing. `attachments:stage-paths` accepts 1 to 100 paths per call.
- **Codex version.** The real check ran on 0.163.0 (2.2), not the pinned 0.162.1 named in 2.1.

---

## 3. Impact and Risk Analysis

**System Dependencies**

- `AgentHandle.send` changes for all three adapters and every caller.
- The brain prompt version changes, so resumed sessions get a prompt-update note.
- A new privileged scheme is registered next to `arc-knowledge:`; both must be in the one registration call.
- `sessions:create` and `sessions:send-message` accept empty text with attachments; code that assumes non-empty user message text (titles, previews, the plan-comment path) must handle it.

**Potential Risks & Mitigations**

| Risk                                                                              | Mitigation                                                                                                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A provider cannot see the file, and the brain answers as if nothing was attached. | The real-CLI checks S1 to S3 run before any other slice; each has a stated fallback.                                                    |
| A large base64 image makes one very long stdin line and breaks a Claude turn.     | Inline images are capped at 5 MB; larger ones go by path. The write path's backpressure is tested with a 5 MB image.                    |
| Base64 image data leaks into the event log through replayed user messages.        | The Claude parser drops `image` blocks from replayed user events; a unit test asserts the log has none.                                 |
| A crafted file name or URL reads a file outside the attachments folders.          | Ids are ULIDs made by the main process, files are found by id, and resolved paths are checked against the root, as for knowledge files. |
| A text attachment carries instructions aimed at the brain.                        | Text files are never inlined; the brain reads them as tool results. The prompt says attachments are material from the user, not orders. |
| Screenshots with secrets stay on disk.                                            | Staging is cleared at every start; sent attachments are deleted with the session; contents and paths are not logged.                    |
| Two adds race past the limit of 10.                                               | The service counts staged and in-flight items per draft under a lock.                                                                   |
| A crash between copying files and inserting rows leaves folders with no row.      | A start-up sweep removes attachment folders in a session that have no matching row.                                                     |
| Finder-copied files may not appear in `clipboardData.files` with a path.          | Checked in the first renderer slice in the real app; the fallback is a main-side clipboard read of the file URL.                        |
| `nativeImage` cannot decode some GIF or WebP files.                               | The original is served when no thumbnail could be made.                                                                                 |
| The image preview inside the New Session dialog closes both on Escape.            | `ImagePreview` stops the key event; a jsdom test covers the stacked case.                                                               |
| The pinned Codex 0.162.1 differs from the 0.163.0 schema that was read.           | S2 runs on the pinned version; `localImage` is used only if it passes.                                                                  |

---

## 4. Testing Strategy

- **Fakes only**, as in earlier specs: `HARNESS_CLAUDE_BIN`, `HARNESS_CODEX_BIN`, `HARNESS_E2E=1`, `HARNESS_USER_DATA`. The only real turns are S1 to S3, each approved once.
- **Unit (main):** validation (each kind, each refusal, name sanitising, symlinks, empty files), the service (stage, remove, discard, count under concurrency, start-up clearing), the send order (missing staged file, copy failure, insert failure, orphan sweep), the repository (ordering, batch load, cascades, checks), the protocol request handler (bad ids, wrong kind, path outside root), each adapter's turn shape with attachments, the replay stripping, the bridge tools' id checks, and brain prompt v8.
- **Renderer (jsdom):** paste rules, drop and the overlay, per-file refusals, remove, send enablement, drafts across a session switch, the row's keyboard model, the preview and its Escape handling, the warning per provider, `MessageBubble` with attachments, and the Design Preview block.
- **End to end (Playwright, fake brains):** attach by the stubbed file picker and by drop, send as the first message and as a later message, assert the fake's log holds the text block and the native image input for Claude, Codex and Cursor, restart Arc and see the attachments on the message, delete the original file and see them still, pass an attachment to a worker and see it in the worker's first message, and load a thumbnail through `arc-attachment://` under the CSP.
- **Not covered by automation:** a real clipboard screenshot and a real Finder drag. These are checked by hand once and recorded under Open Questions in `tasks.md`.
