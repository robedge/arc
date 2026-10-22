<!--
This document describes HOW to build the feature at an architectural level.
It is NOT a copy-paste implementation guide.
-->

# Technical Specification: Groups & Knowledge Sections

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Draft
- **Author(s):** redgell (drafted with the sqlite-database, electron-main, svelte-frontend, and electron-release specialists)

---

## 1. High-Level Technical Approach

This is the first feature, so it also sets up the app skeleton: Electron + TypeScript via electron-vite, a Svelte 5 renderer, and SQLite through better-sqlite3 + Drizzle.

- **Source of truth.** The filesystem owns knowledge *items*. Each group has one **knowledge root**: either app-managed (`~/Library/Application Support/Arc/groups/<group-id>/knowledge/`) or a folder the user links. Each section is a subfolder of that root. **SQLite** owns groups, project memberships, the section registry, and storage configuration, plus a disposable index of items that can be rebuilt from disk at any time.
- **Process split.** All filesystem access, validation, and persistence run in the main process behind a typed IPC contract with a uniform `Result`/error-code shape. The renderer is a cache of main-process state. It refreshes on push events and maps error codes to the exact messages in the functional spec.
- **Outside changes.** A chokidar watcher on each knowledge root picks up edits made outside the app within 5 seconds. Link, unlink, move-and-merge, and export are crash-safe: files are copied and verified, the database is updated in one transaction, and only then is the source deleted.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Project scaffolding

- **Single package** (no pnpm workspace): one app, one artifact. `src/shared` provides the boundary between processes.
- **Layout:**
  - `src/main/` (lifecycle, services, IPC handlers, `db/`, logging)
  - `src/preload/` (contextBridge)
  - `src/renderer/` (Svelte app)
  - `src/shared/` (IPC contract types, error codes, validation limits: 60/40/100/200 characters, 20 MB, file-type allowlist)
  - `tests/unit/`, `tests/e2e/`, `resources/` (icon, entitlements), `docs/screenshots/`
- **Root config files:**
  - `electron.vite.config.ts`, `electron-builder.yml`, `drizzle.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `.prettierrc`
  - `tsconfig.json`, with references to `tsconfig.node.json` (main/preload/shared) and `tsconfig.web.json` (renderer/shared)
- **Key dependencies:**

  | Dependency | Role |
  |---|---|
  | electron, electron-vite, vite | Shell and build for the three targets; Electron is pinned to one major version |
  | svelte 5, @sveltejs/vite-plugin-svelte | Renderer (plain Vite, no SvelteKit) |
  | tailwindcss v4, @tailwindcss/vite | Styling (renderer only) |
  | better-sqlite3, drizzle-orm, drizzle-kit | Database and migrations (native module) |
  | zod | IPC request validation in main |
  | chokidar v4 | Watching knowledge roots (pure JS, no native rebuild) |
  | CodeMirror 6 (+ lang-markdown/sql/json/yaml, lazy) | Editing text items |
  | markdown-it + DOMPurify | Markdown preview, sanitized |
  | pdfjs-dist | Read-only PDF rendering |
  | electron-log | Logging |
  | Dev: electron-builder, @electron/rebuild, vitest, @testing-library/svelte, @playwright/test, typescript, eslint + typescript-eslint + eslint-plugin-svelte, prettier (+ svelte and tailwind plugins), svelte-check | Tooling |

- **Scripts:** `dev`, `build`, `typecheck` (`tsc -b` + `svelte-check`), `lint`, `format`, `test:unit`, `test:e2e`, `package` (arm64 `.app`/`.dmg`), `db:generate`, and `postinstall` (`electron-builder install-app-deps`).
- **Standards:**
  - TypeScript `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
  - ESLint flat config with type-aware rules on main/shared, `no-floating-promises`, and an import restriction so the renderer cannot import from `src/main`.
- **pnpm settings:** `packageManager` and `engines` are pinned, and `pnpm.onlyBuiltDependencies` lists `better-sqlite3` and `electron` (pnpm 10 blocks install scripts by default).

### 2.2. Data model (SQLite, `src/main/db/`)

IDs are text ULIDs and timestamps are epoch ms. Case-insensitive uniqueness uses a `name_key` column (`trim → NFC → lowercase`) with a unique index, not `COLLATE NOCASE`, which only folds ASCII.

| Table | Key columns | Constraints / relationships |
|---|---|---|
| `groups` | `id`, `name`, `name_key`, `sort_order`, `created_at`, `updated_at` | `name_key` UNIQUE |
| `projects` | `id`, `path` (canonical), `display_name`, `is_git`, `last_seen_at`, `created_at` | `path` UNIQUE. One row per distinct folder. Deleted when it no longer belongs to any group. "Folder not found" is computed, not stored |
| `group_projects` | `group_id`, `project_id`, `sort_order`, `added_at` | PK (`group_id`, `project_id`), so a folder can't be added twice to the same group. `group_id` cascades on delete; `project_id` is RESTRICT; index on `project_id` |
| `sections` | `id`, `group_id`, `kind` (`projects`/`notes`/`docs`/`playbooks`/`links`/`custom`), `name`, `name_key`, `folder_name` (null for projects), `sort_order` | UNIQUE (`group_id`, `name_key`). Built-ins are seeded when a group is created, so custom names like "Docs" collide with them. Partial UNIQUE (`group_id`, `kind`) where `kind <> 'custom'`. Cascades with the group |
| `knowledge_storage` | `group_id` (PK), `mode` (`app`/`linked`), `linked_path`, `kept_aside` (bool), `pending_op`, `updated_at` | CHECK: `linked_path` is not null exactly when `mode='linked'`. Cascades with the group. The app-managed root and `knowledge.kept/` paths are derived from `group_id` |
| `knowledge_items` (cache) | `id`, `group_id`, `section_id`, `rel_path`, `kind` (`note`/`playbook`/`doc_text`/`doc_binary`/`link`/`item`), `title`, `description`, `url`, `mime`, `size_bytes`, `mtime_ms`, `content_hash`, `is_editable`, `indexed_at` | UNIQUE (`group_id`, `rel_path`). Upserted by `rel_path`, so IDs stay stable across rebuilds. Can be dropped and rebuilt; on any disagreement, disk wins |

- **Section registry vs disk:** the `sections` table is authoritative and `.arc/meta.json` mirrors it. On reconcile:
  - A subfolder on disk with no registry row and a valid name that doesn't clash is adopted as a custom section.
  - A registry row with a missing folder has its folder recreated.
- **Database file:** `~/Library/Application Support/Arc/arc.db`, opened with WAL, `foreign_keys=ON`, and `busy_timeout`.
- **Migrations:** drizzle-kit generates SQL into `src/main/db/migrations/`, and that folder is shipped as an electron-builder `extraResource`.
  - `migrate()` runs synchronously at startup, before IPC handlers are registered.
  - The database is backed up to `arc.db.bak-<version>` before any pending migration.
  - A migration failure shows a blocking error dialog and the app does not start.
  - The first migration is `0000_init`.
- **Code layout:** `src/main/db/schema/` (one file per table group), `src/main/db/repositories/`, and `src/main/db/client.ts`.
- **Multi-step operations run in one transaction.** For example, creating a group inserts the `groups` row, the 5 seeded sections, and the `knowledge_storage` row in one transaction, and then creates the folder.

### 2.3. On-disk knowledge layout

```
<knowledge root>/
  Notes/  Docs/  Playbooks/  Links/  <Custom Section>/
  .arc/meta.json
```

- **Notes, Playbooks, custom items:** `<sanitized title>.md`. The display title is stored in YAML front matter (`title:`) whenever sanitizing the filename loses characters.
- **Docs:** imported files keep their original filename. Text types are editable. PDF and images are view-only.
- **Links:** one `.md` file per link, with front matter `url`, `title`, and the description in the body. URLs read from disk are revalidated every time.
- **`.arc/meta.json`:** `version`, `sections` (an ordered array of `{folder, name, kind}`), `items` (a map from `rel_path` to `{description}`), and `updatedAt`. It is written atomically, unknown fields are preserved, and if it is corrupt the app rebuilds defaults and keeps a `.bak`.
- **Filename sanitizing:**
  - Characters `/ : \ NUL`, leading dots, and trailing dots and spaces are stripped.
  - Names are compared NFC-normalized and case-folded, because APFS is case-insensitive.
  - A rename that only changes letter case goes through a temporary name.

### 2.4. Main-process services (`src/main/`)

| File | Responsibility |
|---|---|
| `app/bootstrap.ts` | Builds the service graph, runs migrations, registers the protocol (privileged scheme before `ready`) and IPC, and starts watchers and the availability checker |
| `ipc/register.ts` | `handle()` wrapper: zod-validates the request, checks the sender is the app window, catches errors, and returns `Result` |
| `groups/group-service.ts` | Group create/rename/delete/list. Delete order: optional export → database delete → remove the app-managed folder (only when `mode='app'` and the path equals `<appData>/groups/<id>/`) |
| `groups/project-service.ts` | Add (picker or dropped paths), remove, relocate, list. Canonicalizes paths, detects git, rejects files and duplicates |
| `knowledge/section-service.ts` | Section registry plus folder lifecycle. Built-ins can't be changed. Custom rename moves the folder; delete returns the item count first |
| `knowledge/knowledge-service.ts` | Item list/read/create/save/rename/delete/describe, import, link upsert, kind detection |
| `knowledge/knowledge-paths.ts` | `resolveInRoot()` (the only way to build an item path), name sanitizing, and `uniqueName()` for "name (2).ext" |
| `knowledge/meta-store.ts` | Reads and writes `.arc/meta.json` |
| `knowledge/atomic-write.ts` | Temp file → fsync → rename; registers each write with the watcher's echo-suppression map |
| `knowledge/knowledge-storage-service.ts` | Link/unlink/locate/use-app-storage/export state machine, with a lock per group and the `pending_op` marker |
| `knowledge/knowledge-index.ts` | Reconciles `knowledge_items` against disk (compares mtime and size, re-parses only what changed) |
| `knowledge/knowledge-watcher.ts` | One chokidar watcher per knowledge root of a recently used group. Emits `knowledge:changed` |
| `knowledge/availability-service.ts` | Checks that project folders and knowledge roots exist and are readable. Emits `availability:changed` |
| `protocol/knowledge-protocol.ts` | Read-only `harness-knowledge://` handler for PDFs and images |
| `platform/dialogs.ts` | Wraps the native open/save dialogs; the folder picker allows multi-select. Has an E2E stub mode (see section 4) |
| `platform/shell-service.ts` | `openLink` (http/https only) and `reveal` (Finder) for paths main resolved itself |

**Rule:** the renderer never sends filesystem paths except (a) paths of files the user dropped, read in preload via `webUtils.getPathForFile`, and (b) folders the user picked through main's own dialogs. Main checks every one of them with `stat`. Everything else is referenced by ID.

### 2.5. IPC contract (`src/shared/ipc/contract.ts`)

- **Preload API:** preload exposes `window.harness`, which has:
  - `invoke(channel, request): Promise<Result<T>>` and `on(event, callback): unsubscribe`, both typed from the contract
  - `getPathForFile(file)`
- **Result type:** `Result<T> = { ok: true, data: T } | { ok: false, error: { code: ErrorCode, details?: { name?, count? } } }`.

| Channel | Request | Response |
|---|---|---|
| `groups:list` | — | `Group[]` |
| `groups:create` / `groups:rename` | `{name}` / `{groupId, name}` | `Group` |
| `groups:delete` | `{groupId, exportTo?}` | `void` (aborted if the export fails) |
| `projects:list` | `{groupId}` | `Project[]` (`id`, `name`, `path`, `isGit`, `available`) |
| `projects:pick` / `projects:add` | `{groupId}` / `{groupId, paths[]}` | `{added: Project[], skipped: {path, code}[]}` |
| `projects:remove` / `projects:relocate` | `{groupId, projectId}` / `{projectId}` (opens the picker) | `void` / `Project` |
| `sections:list` | `{groupId}` | `Section[]` (with `itemCount`, `builtIn`) |
| `sections:create` / `sections:rename` / `sections:delete` | `{groupId, name}` / `{sectionId, name}` / `{sectionId}` | `Section` / `Section` / `{removed}` |
| `items:list` | `{sectionId}` | `ItemSummary[]` (`id`, `title`, `description`, `kind`, `editable`, `revision`) |
| `items:read` | `{itemId}` | `{type: 'text', content, revision}` or `{type: 'binary', url, mime}` |
| `items:create` | `{sectionId, title, description?}` | `ItemSummary` |
| `items:save` | `{itemId, content, baseRevision}` | `{revision}` or error `EXTERNAL_MODIFIED` |
| `items:rename` / `items:setDescription` / `items:delete` | `{itemId, title}` / `{itemId, description}` / `{itemId}` | `ItemSummary` / `void` / `void` |
| `items:pickImport` / `items:import` | `{sectionId}` / `{sectionId, paths[], onConflict?: Record<name, 'replace' \| 'keepBoth' \| 'skip'>}` | `ImportReport {added, failed: {name, code}[], conflicts: {name}[]}` |
| `links:upsert` | `{sectionId, itemId?, url, title?, description?}` | `ItemSummary` |
| `storage:get` | `{groupId}` | `StorageState {mode, path, available, keptAside, hasKnowledge}` |
| `storage:link` | `{groupId, strategy: 'move-merge' \| 'folder-only'}` (opens the picker) | `StorageState` |
| `storage:unlink` | `{groupId, restore: 'copy-back' \| 'kept-aside'}` | `StorageState` |
| `storage:locate` / `storage:useAppStorage` | `{groupId}` (opens the picker) / `{groupId}` | `StorageState` |
| `storage:export` | `{groupId}` (opens the picker) | `{count, path}` |
| `shell:openLink` / `shell:openUrl` / `shell:reveal` | `{itemId}` / `{url}` / `{groupId, sectionId?, itemId?}` | `void` |

**Push events:** `knowledge:changed {groupId, sectionIds[], itemIds?[], reason: 'external' | 'storage'}`, `availability:changed {groupId, projectId?, knowledgeRoot?: boolean, available}`, `storage:progress {groupId, phase, done, total}`.

**Error codes** live in `src/shared/errors.ts`. The renderer's `lib/ipc/messages.ts` is the only place that maps codes to the functional spec's strings:

| Code | Message (from the functional spec) |
|---|---|
| `GROUP_NAME_REQUIRED` | Group name is required. |
| `GROUP_NAME_TOO_LONG` | Group name must be 60 characters or fewer. |
| `GROUP_NAME_DUPLICATE` | A group with this name already exists. |
| `SECTION_NAME_INVALID` | Section name must be 1–40 characters. |
| `SECTION_NAME_DUPLICATE` | A section with this name already exists in this group. |
| `PROJECT_DUPLICATE` | This folder is already in the group. |
| `PROJECT_NOT_DIRECTORY` | Only folders can be added as projects. |
| `TITLE_REQUIRED` | Title is required. |
| `LINK_URL_INVALID` | Enter a full web address starting with http:// or https://. |
| `FILE_TOO_LARGE` | '{name}' is larger than 20 MB and was not added. |
| `FILE_UNSUPPORTED` | '{name}' isn't a supported file type. |
| `FOLDER_MISSING` | Folder not found |
| `KNOWLEDGE_ROOT_MISSING` | Knowledge folder not found |
| `EXTERNAL_MODIFIED` | (shows the "changed on disk" banner) |
| `LINK_TARGET_INVALID`, `PATH_OUTSIDE_ROOT`, `IO_FAILED`, `INTERNAL` | Generic failure toast; details are logged |

Unique-constraint violations are caught and mapped to the matching `*_DUPLICATE` code, which covers race conditions.

### 2.6. Key logic

- **Path canonicalization.** Every project path and linked path goes through `realpath`, then has its trailing slash stripped, then is NFC-normalized. If the folder is missing, `path.resolve` is used instead.
- **Locate…** updates `projects.path`, which fixes the project in every group that contains it. If the new path already belongs to another project row, the memberships are merged into that row.
- **Git detection.** A project is a git repository if `.git` exists (as a folder or a file). If not, the app runs `git -C <path> rev-parse --git-dir` with a 2-second timeout, which also catches subfolders of a repository. The result is refreshed on every availability check.
- **Availability checks.** Run on app start, on window focus, when a group is opened, and every 30 seconds for the open group. Each check is `stat` plus `access(R_OK)`. An event is only emitted when the status changes.
- **Import**, per file, independently (one failure never stops the batch):
  1. `stat`. Folders are rejected, and anything over 20 MB is rejected with `FILE_TOO_LARGE`.
  2. Check the extension against the allowlist:
     - text: `md txt sql json yaml yml csv graphql gql proto`
     - binary: `pdf png jpg jpeg gif webp svg`
  3. Sniff the first 4 KB:
     - PDF must start with `%PDF-`; image types are checked by their magic bytes; SVG must contain `<svg`.
     - Text files must be valid UTF-8 with no NUL bytes.
     - Any mismatch fails with `FILE_UNSUPPORTED`.
  4. If the name is taken, the file is returned in `conflicts` and nothing is written until the renderer calls again with `onConflict`. "Keep Both" uses `uniqueName()`, which compares case-insensitively.
  5. Copy to a temp file, then rename it into place. The original file is never touched.
- **Autosave.**
  - The renderer debounces for 600 ms and also flushes on blur, on switching items, and before the window closes.
  - Main writes atomically. An item's `revision` is `mtimeMs:size:hash`.
  - `baseRevision` must match what's on disk. If it doesn't, the save fails with `EXTERNAL_MODIFIED` and nothing is written.
- **Link with "Move existing knowledge here".** The app first checks the target is writable and that neither folder contains the other. Then:
  1. Set `pending_op`.
  2. Copy each file using `COPYFILE_EXCL`, renaming through `uniqueName()` if the name is taken. Nothing is ever overwritten.
  3. Merge `meta.json`: the target's descriptions win, source descriptions are re-keyed to their new names, and the section lists are combined.
  4. Verify the copies (count and size).
  5. Update `knowledge_storage` in one transaction, then delete the source and clear `pending_op`.

  If anything fails before step 5, only the files this run created are rolled back, using a run manifest. If the folders are on different volumes (`EXDEV`), the app falls back to copy, verify, then delete.
- **Link with "Use the folder's contents only".** The app-managed `knowledge/` folder is renamed to `knowledge.kept/` (same volume, so this is atomic). Then `kept_aside=1` and `mode='linked'` are set, and the folder's subfolders are reconciled into sections.
- **Unlink.**
  - **Copy back:** the linked tree is copied into `knowledge.tmp/`, which is then renamed to `knowledge/` and `mode` is set to `app`. The linked folder is never modified.
  - **Restore kept-aside:** `knowledge.kept/` is renamed back to `knowledge/`.
- **Export before delete.** The knowledge root, including `.arc/`, is copied to `<chosen folder>/<group name>-knowledge/` (with a unique name). The file count is verified before the delete goes ahead.
- **Startup recovery.** At startup the app looks for a set `pending_op` or leftover `knowledge.tmp/` folders, and finishes or rolls back each operation according to its manifest.
- **Watcher** (chokidar v4):
  - Options: `ignoreInitial`, `awaitWriteFinish {stabilityThreshold: 200}`, depth 2; ignores temp files, `.DS_Store`, and dot-folders other than `.arc`.
  - Events are coalesced over 300 ms and mapped to section IDs, then the index is reconciled and `knowledge:changed` is emitted. This meets the 5-second requirement.
  - The app's own writes are dropped using a short-lived map of path to expected mtime and hash.
  - Watching pauses during bulk storage operations.
  - A full rescan also runs when the window regains focus.
  - Listing is capped at about 5,000 files per root, with a logged warning.

### 2.7. Renderer (`src/renderer/`)

- **Shell:** `App.svelte` has the `GroupSidebar` on the left and the `GroupView` on the right. `GroupView` contains a header with a settings button, `SectionNav` (built-in tabs, then custom tabs, then "Add Section"), and the active section pane. There is no router; a `ui` store selects what to show.
- **Components** (`lib/components/`):
  - `shell/`: GroupSidebar, GroupView, SectionNav
  - `sections/`: ProjectsSection, ProjectRow, ItemSection (Notes, Playbooks, custom), DocsSection, LinksSection, LinkForm
  - `items/`: ItemList, ItemDetail, MarkdownEditor, MarkdownPreview, TextDocEditor, PdfViewer, ImageViewer
  - `settings/`: KnowledgeStorageSettings
  - `dialogs/`: NameDialog, ConfirmDelete (group/section/item/project variants), ImportConflictDialog (with "apply to all"), LinkFolderDialog, UnlinkDialog
  - `banners/`: StorageMissingBanner, ChangedOnDiskBanner
  - `ui/`: Button, Modal, TextField, DropZone, SaveIndicator, Toaster
- **State (Svelte 5 runes, `lib/stores/*.svelte.ts`):**

  | Store | Holds |
  |---|---|
  | `groups` | The group list |
  | `ui` | The selected group, section, and item, plus the open dialog |
  | `groupDetail(groupId)` | Sections, projects, and storage state |
  | `knowledge(sectionId)` | Item summaries |
  | `itemDraft` | Text, `lastSavedRevision`, `dirty`, and save status |

  - Push events mark the affected stores stale and refetch them, debounced by about 150 ms.
  - Responses that arrive after the user has switched groups are ignored.
  - A focus event refetches the selected group.
- **Editor:**
  - CodeMirror 6 is wrapped in a Svelte action, with language modes loaded lazily by file extension.
  - Markdown has Edit and Preview modes you toggle between.
  - The preview uses markdown-it with `html: false`, then DOMPurify. Links in the preview open through `shell:openUrl` (http/https only; main revalidates), while saved link items open through `shell:openLink`.
  - `SaveIndicator` shows Saving…, then Saved.
- **Reconciling a changed open item:**

  | Situation | What happens |
  |---|---|
  | The new revision equals `lastSavedRevision` | Ignored (it's the app's own write) |
  | The editor has no unsaved changes | The content is replaced silently |
  | The editor has unsaved changes | `ChangedOnDiskBanner` offers Reload or Keep mine, and autosave pauses until the user chooses |
  | The file was deleted on disk | A banner offers "Save as new" or "Close" |

  This reconcile logic is written as a pure function so it can be tested directly.
- **Viewers:**
  - Images use `<img src="harness-knowledge://…?rev=…">`, and SVG is only ever shown through `<img>`.
  - PDFs render with pdf.js page by page into a canvas, with the worker bundled by Vite.
  - The CSP allows `img-src` and `connect-src` for `harness-knowledge:`; `script-src` stays `'self'`.
- **Drag and drop:**
  - `DropZone` calls `preventDefault` on `dragover`, and drops anywhere else in the window are blocked so the window never navigates to a dropped file.
  - Paths are read synchronously in the drop handler via `window.harness.getPathForFile`, because the dropped-file data is no longer available after the event.
  - Folder drops go to `projects:add` and file drops go to `items:import`. Main decides what's valid; the renderer never inspects files itself.

### 2.8. Security

- **Paths:** `resolveInRoot()` rejects `/`, `\`, NUL, `..`, and leading dots in names. It requires the `realpath` of the parent folder to sit inside `realpath(root)`. Symlinks that point outside the root are skipped when listing and refused when reading or writing.
- **Protocol:** `harness-knowledge://<groupId>/<itemId>` accepts GET only. It looks the item up through the database and `resolveInRoot`, and serves only the binary allowlist with `nosniff`. SVG is served with `Content-Security-Policy: sandbox; default-src 'none'`. Anything else returns 404, and the protocol never serves directories or `file://` paths.
- **Links:** opened only through `shell.openExternal`, after `new URL()` confirms the protocol is `http:` or `https:`.
- **Window lockdown:** `window.open` and `will-navigate` are denied.
- **Finder:** reveal and open are only ever called with paths that main resolved itself.
- **Renderer:** `contextIsolation` and `sandbox` are on, and `nodeIntegration` is off.
- **IPC:** every request is zod-validated and the sender frame is checked.
- **Logging:** electron-log channels `ipc`, `knowledge`, and `db`. Logs include paths but never file contents.

---

## 3. Impact and Risk Analysis

- **System Dependencies:**
  - This feature creates the app skeleton, database, IPC conventions, and error handling that every later spec builds on.
  - The sessions spec will add tables that reference `groups.id`. Those foreign keys should use RESTRICT, so deleting a group has to deal with its sessions explicitly.
  - The read-only status of non-git projects in sessions is recorded here (`is_git`) but enforced in the sessions spec.
- **Potential Risks & Mitigations:**

| Risk | Mitigation |
|---|---|
| A crash during link/move/unlink leaves knowledge half-merged | Copy, verify, then update the database, and only then delete the source. The `pending_op` marker, run manifest, and startup recovery handle the rest. Sources are never deleted before the database commit |
| Deleting a group removes the wrong folder | Folders are only deleted recursively when the path equals `<appData>/groups/<id>/` and `mode='app'`. Linked paths are never recursed into |
| Autosave overwrites an outside edit | The `baseRevision` check, the `EXTERNAL_MODIFIED` error, and the dirty-editor banner |
| Watcher echoes of the app's own writes, or event storms during `git pull` | The echo-suppression map, 300 ms coalescing, reconciling per section, and a rescan on focus |
| The database and disk drift apart | Disk wins for items, and the index can be rebuilt. The section registry is reconciled both ways |
| Names that differ only by letter case or Unicode form | The `name_key` columns. Names are compared NFC-normalized and case-folded everywhere, and case-only renames go through a temporary name |
| A linked folder inside a project repo makes the repo dirty, or folders nest inside each other | Linking is rejected if the folder is inside or contains the app storage folder or another group's root. A folder inside one of the group's project repos is allowed, with a warning that edits will show up as repo changes (confirmed) |
| Network or external drives: rename isn't atomic and the watcher misses events | Fall back to copy, verify, delete on `EXDEV`, and rescan on focus |
| Huge linked folders | Watch depth is 2, dot-folders are skipped, there's a 5,000-file cap with a warning, and the editor only renders the visible part of large text files |
| Malicious markdown or SVG in linked folders | markdown-it with `html: false` plus DOMPurify. SVG only through `<img>` with a sandbox CSP. A strict renderer CSP |
| better-sqlite3 built for the wrong Electron version, or packaging breaks | Electron is pinned, `install-app-deps` runs on install, `asarUnpack: **/*.node`, better-sqlite3 is external to the main bundle, migrations ship as an extraResource, and a packaged `--smoke` launch is part of the local release check |
| Ad hoc signed arm64 builds are blocked by Gatekeeper | `codesign -s -`. The README documents `xattr -dr com.apple.quarantine` for downloaded copies |

---

## 4. Testing Strategy

- **Unit tests (Vitest, run under Electron's Node via `ELECTRON_RUN_AS_NODE=1`, so there is one better-sqlite3 binary):**
  - Services against a temp folder per test (`fs.mkdtemp`) and an in-memory SQLite database with the real migrations applied.
  - Covered: name rules and case-insensitive uniqueness, path canonicalization, `resolveInRoot` traversal cases, `uniqueName`, the import allowlist/sniffing/size limit/partial success, conflicts (Replace/Keep Both/Skip), move-and-merge without overwriting, folder-only plus kept-aside, both unlink paths, export-then-delete, startup recovery from a simulated crash, watcher echo suppression and debounce, and git detection (repo, worktree, subfolder, non-git).
- **Component tests (Vitest + @testing-library/svelte, jsdom, mocked `window.harness`):**
  - Covered: dialog validation messages, the error-code-to-message table, autosave debounce with fake timers, the reconcile state machine, and store refresh on push events.
- **End-to-end (Playwright `_electron` against the built app):**
  - **Isolation:** each test uses a fresh `HARNESS_USER_DATA` folder and temp project folders.
  - **Stubbed native pieces:** when `HARNESS_E2E=1` is set, `platform/dialogs.ts` and `shell-service.ts` read queued responses and record their calls. Tests use `electronApp.evaluate` to queue picker results and to assert `openExternal` and `showItemInFolder` calls.
  - **Coverage:** one scenario per acceptance-criteria group in the functional spec, including "Saved" appearing within 2 seconds, an outside edit appearing within 5 seconds, PDF and image rendering, and the missing-folder states.
  - **Screenshots** go to `docs/screenshots/`.
- **CI:** none for now (decided 2026-10-16). All checks run locally through the scripts: `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, and `package` followed by a `--smoke` launch of the packaged app. GitHub Actions on `macos-14` is the planned option when CI is added.
