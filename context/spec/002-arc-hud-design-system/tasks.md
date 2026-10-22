# Tasks: Arc HUD Design System and Restyle

Verify tasks drive the built app with throwaway Playwright `_electron` scripts that launch `out/main/index.js` with `HARNESS_USER_DATA=<temp dir>` and `HARNESS_E2E=1`. Screenshots go to the session scratchpad, never the repo. Every Verify task ends by stopping the app by its recorded PID and deleting its scripts, screenshots and temp dirs.

- [x] **Slice 1: HUD foundation: dark grid window, fonts, wordmark, fixed-height shell**

  > Arc opens on the navy grid with the Arc wordmark and ring logo in the sidebar, HUD fonts, panels with corner brackets and a fixed-height layout. The window has a hidden title bar, a 1100×720 minimum and a dark native theme. Every screen already uses token colors, with the full restyle coming in later slices.
  - [x] Add `styles/tokens.css`, `styles/fonts.css` and `styles/markdown-preview.css`, imported by `app.css`:
    - Tailwind `@theme` palette reset and the semantic tokens from the tech spec §2.1.
    - `color-scheme: dark`, the grid background and `assetsInlineLimit: 0`.
    - Pinned `@fontsource` Orbitron 500/700, Rajdhani 400/500/600 and JetBrains Mono 400/600, latin woff2 only.
    - The `.fonts-ready` class.

    **[Agent: svelte-frontend]**
  - [x] Add `ui/Panel`, `ui/Icon` with `icons.ts`, `ui/Wordmark`, `ui/RingLogo`, `ui/kinds.ts` and the `motion` store, which mirrors `prefers-reduced-motion` and sets `data-motion`. Rebuild the `App.svelte` shell as a fixed-height grid with `Panel scroll` regions and no whole-window scroll. Add the sidebar header inset and drag regions (`no-drag` on interactive children). Add component tests for Panel, the motion store and Wordmark. **[Agent: svelte-frontend]**
  - [x] Sweep every renderer component, one folder at a time, replacing the literal `neutral-`, `sky-`, `red-`, `amber-` and `green-` classes with token classes, without changing any text, role or label. Add the unit guard test that fails on any default palette class in `src/renderer`. **[Agent: svelte-frontend]**
  - [x] Add the pure `src/main/app/window-options.ts` with minWidth 1100, minHeight 720, background `#03080F`, `hiddenInset` with `trafficLightPosition`, and the existing hardened `webPreferences`. Use it in `createWindow`. Set `nativeTheme.themeSource = 'dark'` before any window opens. Add a unit test and an e2e check of the minimum size, the background and `shouldUseDarkColors`. **[Agent: electron-main]**
  - [x] Verify:
    - Run `pnpm build` and the full e2e suite. All spec 001 specs must pass unmodified.
    - Launch the built app and screenshot the group view.
    - Confirm the navy grid, the wordmark and ring in the sidebar, the traffic lights sitting clear of the sidebar content, and the panels with brackets.
    - Confirm `document.fonts.check` passes for Orbitron, Rajdhani and JetBrains Mono.
    - Confirm `document.scrollingElement` doesn't scroll in a group with 60 notes while the item list does.
    - Confirm the window can't be resized below 1100×720.
    - Confirm a click on the first sidebar control works, so no drag region is swallowing it.
    - Stop the app by PID and delete the screenshots, scripts and temp dirs.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: HUD controls: buttons, fields and focus ring**

  > All buttons and form controls use the HUD style: four button kinds, a busy state, fields with red errors, 44px targets and a visible cyan focus ring on every control.
  - [x] Restyle `Button` with the primary, secondary, danger and attention variants, a `busy` state (`aria-busy`) and a 44px minimum. Add `IconButton` with a required `label`. Restyle `TextField`, and add `TextArea`, `Select`, `Toggle`, `Checkbox` and `Radio` with native inputs kept, `aria-invalid` and `aria-describedby`. Add the global `:focus-visible` ring using `--shadow-focus`. Add component tests for the variants, busy, disabled and keyboard use, plus the table-driven focus-ring contract. **[Agent: svelte-frontend]**
  - [x] Replace the raw elements with the new controls:
    - `SectionNav` tabs (`.hud-tab`, keeping `role="tab"` and `aria-selected`).
    - `GroupSidebar`, `ItemList` and `ProjectRow` rows (`.hud-row`), with `IconButton` for row actions.
    - The `LinksSection` controls.
    - The `ItemDetail` inputs and the `ItemSection` textarea.
    - The `UnlinkDialog` and `LinkFolderDialog` radios, and the `ImportConflictDialog` checkbox.

    Text that tests match stays in a single text node. **[Agent: svelte-frontend]**
  - [x] Add `ui/TitleBar`: a full-width 40px drag bar across the top of the window with a faint fill and hairline bottom border. Move the shell grid below it, remove the sidebar's top inset, and set `trafficLightPosition` so the lights are vertically centered in the bar. Keep `no-drag` on any interactive child. Update the window-options unit test and add an e2e check that the bar spans the window width, sits above every panel, and that the first sidebar control is still clickable. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full renderer and e2e suites.
    - In the built app, press Tab through the group view and confirm each control shows the cyan ring and none is skipped.
    - Submit the new-group dialog with an empty name and confirm the red outline and the red "Group name is required.".
    - Confirm Delete is red and Cancel is outlined in the group delete confirmation.
    - Measure that buttons and rows are at least 44px tall.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: HUD dialogs**

  > Every dialog opens centered over a dimmed, blurred window, framed with corner brackets. Focus stays inside, and Escape acts as Cancel except while something is running.
  - [x] Restyle `Modal`, keeping its API:
    - Scrim with `backdrop-blur`, a `Panel` frame and the `hudDraw` entrance.
    - Sizes `sm`, `md` and `lg`, plus `busy` (Escape ignored) and `closeable`.
    - The focus trap and Escape logic are reused, not rewritten.
    - Focus moves on mount, with no input blocked during the entrance.

    Add component tests: focus trap, Escape, Escape ignored while busy, and Tab plus Enter working immediately after opening. **[Agent: svelte-frontend]**
  - [x] Move the 8 dialogs in `DialogHost` onto the restyled `Modal` and controls one at a time, changing only markup and classes:
    - NameDialog
    - ConfirmDelete (all variants, including export progress)
    - ImportConflictDialog
    - LinkFolderDialog
    - UnlinkDialog
    - UseAppStorageDialog
    - LeaveConflictDialog
    - LinkForm

    **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full renderer and e2e suites.
    - In the built app, open rename, the group delete confirmation and link folder, and screenshot each one centered over a dimmed, blurred window.
    - Press Tab repeatedly and confirm focus never leaves the dialog.
    - Press Escape in the delete confirmation and confirm nothing is deleted.
    - Start an export and confirm Escape, Delete and Cancel do nothing while it runs.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Toasts, banners and the saved state**

  > Toasts and banners take their color from their meaning and always carry an icon or word, with the same wording as today.
  - [x] Add the optional `kind` to the toast store and set it at every call site (info, success, warning or error). Restyle `Toaster` so each toast shows an icon and its text. Add `ui/Banner` and move ChangedOnDisk and StorageMissing onto it with the same text and buttons. Restyle `SaveIndicator` with the "Saved" word plus a check icon and a red error state. Add component tests showing each kind renders an icon and text. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full suites.
    - In the built app, save "wiki.example.com" as a link address and confirm the red error with its icon and exact wording.
    - Type in a note, change its file on disk, and confirm the amber banner with Reload and Keep mine.
    - Rename a linked folder on disk and confirm the "Knowledge folder not found" banner.
    - Confirm the note shows "Saved" with its icon.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Editors, Markdown preview and viewers**

  > Notes, Playbooks, Docs, Links and custom sections use the HUD look. The editor has a dark HUD theme, the preview uses HUD type, and PDFs show white pages in a HUD frame.
  - [x] Add `lib/editor/hud-theme.ts`: an `EditorView.theme` (dark) plus a `HighlightStyle` reading token variables. Use it through one shared extension factory in `MarkdownEditor` and `TextDocEditor`. Keep `.cm-content`, make `.cm-scroller` the only scroller, and put the focus ring on the container with `:focus-within`. Restyle the Markdown preview CSS: display-font headings, mono code on `surface-code`, and cyan underlined links. **[Agent: svelte-frontend]**
  - [x] Restyle the viewers and item views:
    - **PdfViewer:** white pages on a framed `surface-raised` backdrop, no fixed 720px or `max-h-[70vh]`, `IconButton` controls.
    - **ImageViewer:** `object-contain`, filling the panel.
    - **Text viewer:** mono on `surface-code`.
    - **Item views:** ItemDetail, ItemList, ItemSection, DocsSection, LinksSection, LinkForm and DropZone.

    Add the highlight colors to the contrast pair list. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full suites.
    - In the built app, open a note containing a heading, a code block and a link. Confirm the editor is dark with HUD colors, and that the preview shows a display-font heading, a mono code block on a darker panel and a cyan link.
    - Open a `.sql` doc, a PDF and a PNG, and screenshot each.
    - Confirm a long note scrolls only inside the editor.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 6: Projects, storage settings and remaining screens**

  > The Projects section, the knowledge storage settings and progress, and every remaining screen use the HUD look. No screen keeps the old style.
  - [x] Restyle the remaining screens:
    - ProjectsSection and ProjectRow, including the "Not a git repository" and "Folder not found" states.
    - KnowledgeStorageSettings and StorageProgress.
    - GroupView header, GroupSidebar, SectionNav and SectionPane empty states.

    Audit the whole renderer for any component still using unstyled markup and fix it. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full suites.
    - In the built app, go through every screen listed in functional spec §2.8 and screenshot each one. Include a project marked "Not a git repository", a missing project folder, storage linked and unlinked, and export progress.
    - Confirm none shows the old default style.
    - Stop the app by PID and delete the artifacts and temp folders.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Needs-attention badge, attention dialog and Help › Design Preview**

  > Help › Design Preview opens a window showing every building block with sample content, including an amber "Needs attention" badge (count 2) that opens the attention dialog with a permission card and a question card.
  - [x] Add `ui/AttentionBadge` and `ui/attention/AttentionDialog`, `PermissionCard` and `QuestionCard`, with the `AttentionRequest` type:
    - The badge pulses unless motion is reduced.
    - Escape and Close only call `onClose`, and the close button is labeled "Close".
    - The action is shown in a mono box.
    - The Approve and Deny buttons are at least 44px tall.
    - Send is disabled while the answer is empty.

    Add component tests for these behaviors. **[Agent: svelte-frontend]**
  - [x] Add the second renderer entry:
    - `src/renderer/preview.html`, plus `src/preview.ts` mounting `lib/preview/DesignPreview.svelte`.
    - The `electron.vite.config.ts` input map `{ index, preview }`, so the CSP meta is injected into both.
    - DesignPreview content per tech spec §2.7. It uses only `ui/` components with local state, labels every item "Sample", and calls no IPC.

    **[Agent: svelte-frontend]**
  - [x] Add three pure main-process modules, install the menu in `bootstrap.ts`, and fix `activate` to check `getMainWindow()`:
    - `src/main/app/lockdown.ts` (`lockDownWindow`, extracted from `createWindow`, with a full-URL navigation lock for the preview).
    - `src/main/app/app-menu.ts`, building these menus:
      - App: about, hide and quit, still routed through the close gate.
      - File: close.
      - Edit: all clipboard roles.
      - View: reload and dev tools in dev builds only, full screen, no zoom.
      - Window.
      - Help: "Design Preview" (`help-design-preview`).
    - `src/main/app/preview-window.ts`: a single instance that refocuses on repeat, 1000×760 (minimum 720×520), no preload, no parent, no close-gate listener, never registered as the main window, loading `preview.html` in dev and in production.

    Make sure the e2e fixtures pick the main window by URL. Add unit tests for the menu template, the preview window and lockdown, and e2e tests:
    - The menu opens the preview, and a second click still leaves two windows.
    - `window.harness` is undefined in the preview.
    - Closing the preview keeps the app running, and quitting with both open exits promptly.
    - Select-all, cut and paste work through the Edit roles.

    **[Agent: electron-main]**
  - [x] Verify:
    - Run the full suites.
    - In the built app, open Help › Design Preview and confirm the badge shows "Needs attention" with the count 2. Click it and confirm one amber permission card (Approve and Deny, action in a mono box) and one cyan question card (answer box and Send).
    - Press Escape and confirm the dialog closes with the count still 2.
    - Measure the Approve and Deny buttons at 44px or taller.
    - Emulate reduced motion and confirm the badge doesn't animate (`getAnimations()` is empty) and a dialog appears at once.
    - Confirm the preview page has no `window.harness`.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: Arc app icon and HUD installer**

  > The packaged Arc shows its ring icon in the Dock, Finder and the installer. The installer window has the HUD background, and the font licenses ship with the app.
  - [x] Build the icon assets and wire them into packaging:
    - Add `resources/icon/arc-icon.svg` and `arc-icon-small.svg`, following the constraints in tech spec §2.9.
    - Add `resources/dmg/background.svg`.
    - Add `scripts/build-icons.mjs` (`pnpm icons`), using the pinned `@resvg/resvg-js` with `iconutil` for `.icns` and `tiffutil` for the 1x/2x DMG background TIFF. Commit the outputs `resources/icon.icns`, `resources/icon.png` and `resources/dmg/background.tiff`.
    - Update `electron-builder.yml`: `buildResources`, `mac.icon`, and a `dmg` block with the icon, background, window size, icon size, positions and the title "Arc".
    - Add a dev-only `app.dock.setIcon` in main.
    - Add `resources/licenses/FONTS-OFL.txt`, copied from the packages' `LICENSE` files, plus its `extraResources` entry and a README "Third-party fonts" section.

    **[Agent: electron-release]**
  - [x] Verify:
    - Run `pnpm icons` and confirm the iconset sizes with `iconutil -c iconset` and `sips`. Review the 16, 32 and 128px PNGs visually: the ring must still read as a ring.
    - Run `pnpm package`.
    - Confirm `CFBundleIconFile` is `icon.icns`, `codesign --verify --deep --strict` passes, the woff2 fonts are in the asar, and `licenses/FONTS-OFL.txt` is present.
    - Mount the DMG with `hdiutil attach`, screenshot the window showing the icon and HUD background, then run `hdiutil detach`.
    - Launch the packaged app with a temp `HARNESS_USER_DATA`. Confirm the Dock icon and that `document.fonts.check` passes for all three families.
    - Stop the app by PID and delete the temp folders and screenshots. Leave `release/` in place.

    **[Agent: electron-release]**

- [x] **Slice 9: Accessibility and readability audit**

  > Every text pair meets the contrast rules, meaning never relies on color alone, every control is reachable by keyboard, icon-only buttons have spoken labels, and no Marvel name appears anywhere.
  - [x] Add the guard tests:
    - Finalize `tests/unit/contrast.test.ts`: parse `tokens.css`, alpha-composite the panel surfaces, and cover the declared pair list (text at 4.5:1; large text and functional borders at 3:1; highlight colors). Fix any failing token.
    - Add the motion-cap test: no entrance over 300ms, with ambient effects exempt.
    - Add the Marvel-name denylist test over `src/renderer`, menu labels and `resources`.

    **[Agent: svelte-frontend]**
  - [x] Sweep every screen and the Design Preview:
    - Tab order: no hidden focus and no skipped controls.
    - Every `IconButton` has a label.
    - Meaning never relies on color alone (the "Saved" word, error icons, "Needs attention").
    - The display-font heading sizes meet the contrast rule.

    Fix any issue found. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Run the full unit, renderer and e2e suites, plus lint and typecheck.
    - In the built app, press Tab through each screen and the Design Preview, and confirm the focus ring is visible on every stop.
    - Check the accessible name of the attention dialog's close button: it must be "Close".
    - Record the manual checks in the report: macOS Light appearance still shows the dark HUD, and toggling Reduce Motion while the app runs updates it live.
    - Stop the app by PID and delete the artifacts.

    **[Agent: svelte-frontend]**

- [x] **Slice 10: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 002-arc-hud-design-system` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

---

## Open Questions

Acceptance criteria that cannot be fully automated. Each has partial automated or recorded manual evidence.

- 2.1 "Given macOS is set to Light appearance, Arc still shows its dark HUD look": the real system Light appearance cannot be switched from a test. Partly covered: `tests/e2e/acceptance-hud.spec.ts` emulates `prefers-color-scheme: light` and asserts the body ground and `color-scheme: dark` hold, `tests/e2e/foundation.spec.ts` asserts `nativeTheme.shouldUseDarkColors` is true, and the Slice 9 verify run saw the emulated Light scheme keep the dark HUD.
- 2.6 "Given macOS Reduce motion is on ...": the real system toggle cannot be flipped from a test. Partly covered: the e2e spec emulates `reducedMotion: 'reduce'` and asserts the badge has no running animations and a dialog opens with none, and the Slice 9 verify run saw `data-motion` and the badge animations toggle live.
- 2.9 "Given VoiceOver is on, the close button reads Close": VoiceOver speech cannot be asserted. Partly covered: the e2e spec checks the attention dialog close button's accessible name is "Close", and `tests/renderer/a11y-sweep.test.ts` requires a non-empty label on every `IconButton`.
- 2.9 "check every text style on every screen with a contrast checker": a human contrast review of rendered pixels is not automated. Partly covered: `tests/unit/contrast.test.ts` checks the declared token pairs and editor highlight colors against the WCAG ratios.
- 2.10 Dock icon, Finder list view at the smallest icon size, and the installer window: Finder and Dock rendering are not automatable. Partly covered: `tests/renderer/icon.test.ts` and the Slice 8 verify run (packaged app Dock icon and the mounted DMG were screenshot-checked, iconset sizes confirmed with `iconutil` and `sips`).
- 2.8 "repeats every acceptance check from the Groups & Knowledge Sections specification": covered by the unchanged spec 001 suites (`tests/e2e/acceptance-*.spec.ts` and the renderer and unit suites) passing against the restyled UI, not by a separate spec 002 test.
