# Tasks: Groups & Knowledge Sections

Spec: [functional-spec.md](./functional-spec.md) · [technical-considerations.md](./technical-considerations.md)

**How Verify tasks work.** Each Verify task builds the app and drives it with a throwaway Playwright `_electron` script. That script uses a fresh `HARNESS_USER_DATA` temp folder, temp project folders, and stubbed native dialogs (`HARNESS_E2E=1`). The Verify task records the PID of every process it starts, stops them by PID when finished, and deletes the script, screenshots, and temp folders before it completes.

---

- [x] **Slice 1: App skeleton — create and list groups**

  > The app launches with a group sidebar. The user can create a group with validated names, and the group is still there after a restart.
  - [x] Initialize the repository: git init, a single-package pnpm project (`packageManager`, `engines`, `onlyBuiltDependencies` for better-sqlite3/electron), electron-vite with main/preload/renderer/shared targets, Svelte 5 + Tailwind v4 in the renderer, strict TypeScript project references, ESLint flat config (renderer-imports-main restriction), Prettier, svelte-check, and the scripts `dev`, `build`, `typecheck`, `lint`, `format`, `test:unit`, `test:e2e`, `db:generate`, `postinstall`. **[Agent: electron-release]**
  - [x] Set up the test harness. Vitest runs under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), with a helper for a temp folder per test. Playwright `_electron` runs against the built `out/`, with `HARNESS_USER_DATA` isolation. **[Agent: electron-release]**
  - [x] Create the database layer: `src/main/db/client.ts` opens `arc.db` (WAL, foreign_keys, busy_timeout), with a backup before pending migrations, synchronous `migrate()` at startup, and a blocking error dialog if a migration fails. Add `drizzle.config.ts`, a `groups` table (`name_key` UNIQUE), the `0000_init` migration, and `repositories/groups-repo.ts`. Migrations folder is wired as an extraResource. **[Agent: sqlite-database]**
  - [x] Build the main-process foundation:
    - `app/bootstrap.ts` and the window, with contextIsolation, sandbox, CSP, and window.open/will-navigate denied.
    - The `ipc/register.ts` `handle()` wrapper (zod validation, sender check, `Result`).
    - `src/shared/ipc/contract.ts` and `src/shared/errors.ts`, plus the shared validation limits.
    - Preload `window.harness.invoke`/`on`.
    - electron-log channels.
    - `platform/dialogs.ts` with the `HARNESS_E2E` queued-response stub mode.
    - `HARNESS_USER_DATA` support.

    **[Agent: electron-main]**
  - [x] Implement `groups/group-service.ts` for create and list, with name rules (1–60 characters, NFC + case-insensitive uniqueness, constraint errors mapped to `GROUP_NAME_DUPLICATE`), creating the app-managed `groups/<id>/knowledge/` folder, and the `groups:list`/`groups:create` channels. Add unit tests for the name rules and duplicates. **[Agent: electron-main]**
  - [x] Build the renderer shell: `App.svelte`, the `GroupSidebar` with "New Group", `NameDialog` with inline validation, the `groups` and `ui` stores, an empty `GroupView` placeholder, and `lib/ipc/messages.ts` mapping error codes to the exact spec strings. Add component tests for the validation messages. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run `pnpm lint`, `pnpm typecheck`, and `pnpm test:unit`.
    - Build and launch the app and create "Storefront", confirming it appears in the sidebar.
    - Confirm an empty name shows "Group name is required.", a 61-character name shows "Group name must be 60 characters or fewer.", and "storefront" shows "A group with this name already exists.".
    - Relaunch with the same user-data folder and confirm "Storefront" is still listed.
    - Stop the app by PID and delete the script, screenshots, and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Rename and delete groups**

  > The user can rename a group and delete it after a confirmation that says project folders are untouched.
  - [x] Add `groups:rename` and `groups:delete` (no export yet). Delete runs in a transaction, then removes the app-managed folder only when the path equals `<appData>/groups/<id>/`. Add unit tests for the rename rules and the delete path-safety guard. **[Agent: electron-main]**
  - [x] Add a row menu in `GroupSidebar` (Rename, Delete Group), a rename `NameDialog`, and a `ConfirmDelete` group variant stating that project folders won't be touched. Cancel leaves everything unchanged. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Rename "Storefront" to "Shop" and confirm the sidebar updates.
    - Open delete, cancel, and confirm the group remains.
    - Delete and confirm the group is gone and its app-managed folder was removed.
    - Run the unit tests for the delete guard.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: Built-in and custom sections**

  > Opening a group shows Projects, Notes, Docs, Playbooks, and Links. The user can add, rename, and delete custom sections.
  - [x] Add `sections` and `knowledge_storage` tables and their migration: `name_key` unique per group, a partial unique index on built-in `kind`, a CHECK for `linked_path`, and cascades. Creating a group now seeds the 5 built-in sections and an `app` storage row in one transaction (a backfill migration covers groups that already exist). Add repositories. **[Agent: sqlite-database]**
  - [x] Add `knowledge/section-service.ts` (create/rename/delete custom sections and their folders, built-ins can't be changed, case-only rename through a temporary name), `knowledge/meta-store.ts` (atomic `.arc/meta.json`, recovery from corruption), `knowledge/atomic-write.ts`, `knowledge/knowledge-paths.ts` (`resolveInRoot`, sanitizing, `uniqueName`), and the `sections:*` channels with `itemCount`. Add unit tests, including path-traversal cases. **[Agent: electron-main]**
  - [x] Add `SectionNav` (built-in tabs with no menu, custom tabs with a Rename/Delete menu, "Add Section"), section `NameDialog` validation (1–40 characters, duplicates including built-in names), a `ConfirmDelete` section variant ("Delete 'X' and its N items?" when N > 0), the `groupDetail` store, and empty section panes. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Open a new group and confirm the 5 built-in sections are shown, and that built-in tabs have no rename/delete.
    - Add "Runbooks" and confirm it appears after the built-ins and that its folder exists on disk.
    - Confirm adding "runbooks" or "Docs" shows "A section with this name already exists in this group.".
    - Rename it, then delete it.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Add and remove project folders**

  > The user can add folders through the picker or drag and drop. Each folder shows its git status. Duplicates and dropped files are rejected, and the same folder can be in several groups.
  - [x] Add `projects` and `group_projects` tables and their migration (`path` UNIQUE, composite PK, project removed when it has no memberships left), plus repositories. **[Agent: sqlite-database]**
  - [x] Add `groups/project-service.ts`:
    - Canonical paths (realpath, trailing slash stripped, NFC).
    - Git detection (`.git` folder or file, else `git rev-parse` with a 2 s timeout).
    - Rejection of files (`PROJECT_NOT_DIRECTORY`) and duplicates (`PROJECT_DUPLICATE`).
    - Channels `projects:pick`, `projects:add`, `projects:list`, and `projects:remove`, with `{added, skipped}` results.
    - Unit tests covering a git repo, a worktree, a subfolder of a repo, and a non-git folder.

    **[Agent: electron-main]**
  - [x] Add `ProjectsSection` and `ProjectRow` (name, path, the "Not a git repository — read-only in sessions" label), an "Add Project" button, `DropZone` for folders using preload `getPathForFile` read synchronously, a window-level guard against navigating to dropped files, and toasts for skipped paths. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Add three temp folders with the stubbed picker (two git, one plain) and confirm the names, paths, and git label.
    - Drop a folder and confirm it's added.
    - Drop a file and confirm "Only folders can be added as projects.".
    - Add a duplicate and confirm "This folder is already in the group.".
    - Add the same folder to a second group and confirm it's in both.
    - Remove a project and confirm the folder is still on disk.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Missing project folders — Locate… and Remove**

  > A project whose folder was moved shows "Folder not found" and can be located again or removed.
  - [x] Add `knowledge/availability-service.ts` (checks on start, on focus, when a group opens, and every 30 s for the open group; emits only on change), the `availability:changed` push event, and `projects:relocate`. Relocating updates `projects.path` for every group and merges memberships if the new path already belongs to another project row. Add unit tests. **[Agent: electron-main]**
  - [x] Add the `ProjectRow` missing state with "Locate…" and "Remove", and patch the store in place when `availability:changed` arrives. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Add a temp folder, rename it on disk, refocus the window, and confirm "Folder not found" appears.
    - Choose Locate… (stubbed picker pointing at the new path) and confirm it shows as available again.
    - Repeat and choose Remove.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 6: Notes, playbooks, and custom-section items with autosave**

  > The user can write Markdown items with a title, optional description, preview, and autosave, and can rename and delete them.
  - [x] Add the `knowledge_items` cache table and its migration (UNIQUE `group_id`+`rel_path`, upsert by `rel_path`). **[Agent: sqlite-database]**
  - [x] Add `knowledge/knowledge-service.ts` and `knowledge/knowledge-index.ts` for text items:
    - Create (sanitized `<title>.md`, front-matter `title` when characters are lost), read, and save with a `baseRevision` check that returns `EXTERNAL_MODIFIED`.
    - Rename, delete, and `setDescription` (stored in meta.json).
    - Reconciling the index against disk on group open, and the item count used by section delete.
    - Channels `items:list/read/create/save/rename/setDescription/delete`.
    - Unit tests.

    **[Agent: electron-main]**
  - [x] Add `ItemSection`, `ItemList` (title + description), `ItemDetail`, a `MarkdownEditor` (CodeMirror 6 Svelte action), `MarkdownPreview` (markdown-it `html:false` + DOMPurify, links through `shell:openLink`), an Edit/Preview toggle, the `itemDraft` store with a 600 ms debounce plus flushes on blur, item switch, and window close, `SaveIndicator`, and "Title is required." validation. Add component tests for the debounce (fake timers). **[Agent: svelte-frontend]**
  - [x] Verify:
    - Create the note "Service map", type a body, and confirm "Saved" appears within 2 s.
    - Toggle preview and confirm headings, lists, and code blocks are formatted.
    - Add a description and confirm it shows in the list.
    - Confirm an empty title shows "Title is required.".
    - Relaunch and confirm the text persisted.
    - Create an item in a custom section, delete that section, and confirm the dialog reads "Delete 'Runbooks' and its 1 items?".
    - Delete a note.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Import text documents into Docs**

  > The user can import text files such as schema dumps, with type and size checks, partial success, and Replace / Keep Both / Cancel when a name is taken. Imported text docs can be edited.
  - [x] Add import to `knowledge-service.ts`:
    - Extension allowlist plus a 4 KB content sniff (UTF-8, no NUL bytes).
    - 20 MB limit.
    - Each file handled independently via `allSettled`.
    - Name conflicts returned without writing, then applied through `onConflict` (replace / keepBoth via case-insensitive `uniqueName` / skip).
    - Copy to a temp file, then rename; the original is never touched.
    - Channels `items:pickImport` and `items:import`.
    - Unit tests for every outcome.

    **[Agent: electron-main]**
  - [x] Add `DocsSection` with an import button and file `DropZone`, `TextDocEditor` (CodeMirror, language loaded lazily by extension), `ImportConflictDialog` (Replace / Keep Both / Cancel with "apply to all"), and a summary toast listing skipped files with the spec messages. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Drop `orders_schema.sql` and confirm it's listed, viewable, and editable, and that the original is unchanged.
    - Import 5 files where one is over 20 MB and confirm 4 are added and "'big_dump.sql' is larger than 20 MB and was not added." is shown.
    - Import a `.exe` and confirm "'setup.exe' isn't a supported file type.".
    - Re-import `orders_schema.sql`, choose Keep Both, and confirm `orders_schema (2).sql`.
    - Stop the app by PID and delete the artifacts and temp files.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: View PDFs and images**

  > Imported PDFs and images open read-only in the app.
  - [x] Add `protocol/knowledge-protocol.ts`:
    - The `harness-knowledge` scheme registered as privileged before `ready`.
    - GET only.
    - Item lookup through the database and `resolveInRoot`.
    - Binary allowlist and `nosniff`; SVG served with a sandbox CSP; anything else returns 404.
    - Extend the import allowlist and magic-byte sniffing to pdf/png/jpg/jpeg/gif/webp/svg.
    - Return a `binary` result from `items:read`.
    - Unit tests for path refusal and type checks.

    **[Agent: electron-main]**
  - [x] Add `PdfViewer` (pdfjs-dist, worker bundled by Vite, pages rendered lazily to canvas) and `ImageViewer` (`<img>` with fit/zoom, `?rev=` cache-busting), with no edit controls for binary items, and update the CSP for `harness-knowledge:`. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Import `api-spec.pdf` and `services.png`.
    - Open each and confirm the PDF pages and the image render with no edit option.
    - Confirm a crafted `harness-knowledge://` URL pointing outside the root returns 404.
    - Stop the app by PID and delete the artifacts and fixtures.

    **[Agent: svelte-frontend]**

- [x] **Slice 9: Links**

  > The user can save, edit, and delete web links and open them in the default browser.
  - [x] Add `links:upsert`: one `.md` file per link, with front-matter `url`/`title` and the description in the body. Validate with `new URL` (http/https only, `LINK_URL_INVALID`) and default the title to the address. Add `platform/shell-service.ts` `openLink` (revalidates the URL read from disk) with the `HARNESS_E2E` call recorder. Add unit tests. **[Agent: electron-main]**
  - [x] Add `LinksSection` and `LinkForm` (address, optional title and description, inline validation) and make the address open the link on click. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Add "https://wiki.example.com/orders" titled "Orders wiki" and confirm it's listed.
    - Add a link with no title and confirm the address is shown as the title.
    - Confirm "wiki.example.com" shows "Enter a full web address starting with http:// or https://.".
    - Click the address and confirm the recorded `openExternal` call has that URL.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 10: Pick up outside changes and Show in Finder**

  > Edits made to knowledge files outside the app appear within 5 s. An open editor with unsaved changes is never overwritten. The user can reveal knowledge in Finder.
  - [x] Add `knowledge/knowledge-watcher.ts`:
    - Chokidar v4 per knowledge root, depth 2, `awaitWriteFinish`, ignoring temp/`.DS_Store`/dot-folders except `.arc`.
    - Events coalesced over 300 ms, the index reconciled, then `knowledge:changed` emitted.
    - Echo suppression for the app's own writes through `atomic-write`.
    - A rescan on focus, a pause hook for bulk operations, and a 5,000-file cap with a warning.
    - Subfolders that appear on disk are adopted as custom sections.
    - `shell:reveal` for paths main resolved itself.
    - Unit tests for debounce and echo suppression.

    **[Agent: electron-main]**
  - [x] Add store refresh on `knowledge:changed` (150 ms debounce, late responses ignored), the reconcile logic for the open item as a pure function (own echo → ignore, clean → replace, dirty → `ChangedOnDiskBanner` with Reload / Keep mine and autosave paused, deleted → "Save as new" / "Close"), and a "Show in Finder" action. Add component tests for the reconcile function. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Edit a note's file on disk with the editor clean and confirm the app shows the new text within 5 s.
    - Add a `.md` file to `Docs/` on disk and confirm it appears within 5 s.
    - Type in a note without pausing, change its file on disk, and confirm the banner appears and the typed text is kept.
    - Click Show in Finder and confirm the recorded reveal path.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 11: Link a group's knowledge to a folder**

  > In group settings the user can link a folder. For a group that already has knowledge, they choose "Move existing knowledge here" (merge without overwriting) or "Use the folder's contents only" (the in-app knowledge is kept aside).
  - [x] Add `pending_op` and `kept_aside` handling to the `knowledge_storage` repository, with any migration needed. **[Agent: sqlite-database]**
  - [x] Add `knowledge/knowledge-storage-service.ts` for link:
    - A lock per group.
    - Preflight: writable target, no nesting with app storage or another group's root, and a warning flag when the folder is inside one of the group's project repos.
    - move-merge: `COPYFILE_EXCL` + `uniqueName`, meta.json merge, verify, database flip, then delete the source.
    - folder-only: rename to `knowledge.kept/`.
    - EXDEV fallback, a rollback manifest, the watcher paused and restarted, `storage:progress`, and `storage:get`/`storage:link`.
    - Unit tests covering name collisions, rollback after an injected failure, and folder-only.

    **[Agent: electron-main]**
  - [x] Add `KnowledgeStorageSettings` ("Stored in app" or the linked path, "Link folder…", "Show in Finder"), `LinkFolderDialog` (shown only when the group has knowledge, with a one-line consequence for each option, and the repo warning when flagged), and a progress display. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Confirm a new group shows "Stored in app".
    - With 2 notes, link an empty temp folder using Move and confirm `Notes/` holds 2 files and the app shows 2 notes.
    - In a group with "Service map", link a folder that already has `Notes/Service map.md` and confirm both "Service map" and "Service map (2)" exist with their text intact.
    - With 2 in-app notes, link a folder holding 5 different notes using "Use the folder's contents only" and confirm only the 5 are shown.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 12: Unlink, missing knowledge folder, and crash recovery**

  > The user can unlink a folder (copy back, or restore the knowledge kept aside). A missing linked folder shows "Knowledge folder not found" with Locate… and "Use app storage". Interrupted storage operations recover at startup.
  - [x] Extend `knowledge-storage-service.ts` with:
    - `storage:unlink` (copy-back staged in `knowledge.tmp/`; restore kept-aside by renaming; the linked folder never modified).
    - `storage:locate` and `storage:useAppStorage`.
    - Linked-root availability through `availability:changed` with `knowledgeRoot: true`.
    - Startup recovery for `pending_op`, `knowledge.tmp/`, and `knowledge.kept/` leftovers.
    - Unit tests, including a simulated crash.

    **[Agent: electron-main]**
  - [x] Add `UnlinkDialog` (with "Keep current knowledge" / "Restore earlier in-app knowledge" when knowledge was kept aside) and `StorageMissingBanner` with Locate… and "Use app storage" (section nav disabled while it shows). **[Agent: svelte-frontend]**
  - [x] Verify:
    - Unlink a linked group and confirm "Stored in app", the same items, and that the folder still exists with its files.
    - In a folder-only group, unlink with Restore and confirm the original 2 notes return.
    - Rename a linked folder on disk and confirm the banner with Locate… and "Use app storage"; Locate it and confirm recovery.
    - Run the crash-recovery unit tests.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 13: Export knowledge before deleting a group**

  > The group delete confirmation offers "Export knowledge first", which saves the group's knowledge to a chosen folder before deleting.
  - [x] Add `storage:export` (copy the root including `.arc/` to `<chosen>/<group name>-knowledge/` with a unique name, verify the file count) and `groups:delete` with `exportTo`, which aborts the delete if the export fails. Make sure deleting a linked group never touches the linked folder. Add unit tests. **[Agent: electron-main]**
  - [x] Add an "Export knowledge first" button to the `ConfirmDelete` group variant (stubbed save/folder picker, progress, then return to the confirm step). **[Agent: svelte-frontend]**
  - [x] Verify:
    - In a group with notes, docs, a link, and a custom section, choose "Export knowledge first" with a temp folder and confirm the exported folder contains all of them as files and the group is then deleted.
    - Delete a linked group and confirm the linked folder is untouched.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 14: Installable macOS build**

  > The app is packaged as an ad hoc signed arm64 `.app`/`.dmg` that launches and opens its database.
  - [x] Configure `electron-builder.yml`:
    - mac arm64 only; `codesign -s -` ad hoc signing.
    - `asarUnpack` for `**/*.node`, better-sqlite3 external in the main bundle, migrations as an extraResource resolved from `process.resourcesPath`.
    - The `package` script and a `--smoke` flag that opens the database and exits 0.
    - A README with install steps and the `xattr` quarantine note.

    **[Agent: electron-release]**
  - [x] Verify:
    - Run `pnpm package`.
    - Launch the packaged app with `--smoke` and confirm exit code 0.
    - Launch it normally, create a group, and quit.
    - Stop any app process by PID and delete the built artifacts' temp user-data folder.

    **[Agent: electron-release]**

- [x] **Slice 15: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 001-groups-and-knowledge-sections` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

---

## Open Questions

- Real Finder drag-and-drop (2.2 "drags a folder from Finder onto the Projects section" and "drags a file ... Only folders can be added as projects."; 2.5 "drag orders_schema.sql into the section") cannot be automated. Covered by substitute: renderer tests for the drop handler (`tests/renderer/projects-ui.test.ts`, `docs-import.test.ts`), e2e tests that call the same IPC (`projects:add`, `items:import`) and the picker path with a file, and a synthetic drop event proving the window never navigates (`tests/e2e/acceptance-projects.spec.ts`). Needs a one-time manual check in Finder.
- "Finder opens at that location" (2.7 Show in Finder) is verified only up to the recorded `shell.showItemInFolder` path (`tests/e2e/outside-changes.spec.ts`), not by observing Finder.
- "Default browser opens" (2.6) is verified only up to the recorded `shell.openExternal` call (`tests/e2e/links.spec.ts`).
- The "Saved within 2 seconds" and "within 5 seconds" outside-change timings are asserted with those bounds in e2e; no load/slow-disk variation was tested.
