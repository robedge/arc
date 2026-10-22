# Functional Specification: Arc HUD Design System and Restyle

- **Topic:** Giving Arc its heads-up-display look: a shared visual language (colors, type, panels, controls, dialogs, alerts, motion) and the restyling of every existing screen to use it.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Arc is meant to feel like talking to a capable assistant in a sci-fi heads-up display: a dark command surface where the important things glow and anything waiting on the user is impossible to miss. Today the groups and knowledge screens use a plain default look, so the app feels like a generic utility. The coming session screens (the brain, its workers, and their approval and question alerts) also need a consistent visual language from the start, so they aren't restyled later.

This change gives Arc that look, based on the mockup the user approved ("Arc HUD Mockup"). It applies it to every screen that exists today, and adds the shared building blocks the session screens will use, including the agreed "needs attention" alert pattern.

**Success looks like:**

- Every existing screen uses the HUD look, with no screen left in the old default style.
- Meaning is told by color consistently everywhere: cyan for active or information, amber for "waiting on you", green for done, red for errors.
- Nothing that worked before stops working. Every action, message, and keyboard shortcut from the groups and knowledge feature behaves exactly as before.
- Text stays easy to read, and the app is fully usable by keyboard.

---

## 2. Functional Requirements (The "What")

### 2.1. Overall look

- The app uses a near-black navy background with a faint grid pattern across the whole window.
- **Colors by meaning:**
  - Cyan is the main accent: active items, selected items, primary actions, and information.
  - Amber means something is waiting on the user: needs attention, warnings, conflicts.
  - Green means done or saved.
  - Red means an error or a destructive action (such as Delete).
- **Type:**
  - Headings and section labels are uppercase with wide letter spacing in a geometric display font.
  - Body text uses a clean, slightly condensed sans-serif.
  - Data uses a monospace font: file names, paths, code, and times.
  - Heading font: Orbitron for the Arc wordmark and screen titles, Rajdhani for labels and body text, as in the approved mockup.
- The Arc wordmark and its ring logo appear at the top of the sidebar.
- The app keeps its dark HUD look whether macOS is set to Light or Dark appearance.
- The app shows no Marvel names, characters, or branding anywhere. The look is inspired by a HUD style, not a copy of any film's interface.
  - **Acceptance Criteria:**
    - [x] When the user opens Arc, then the window shows the dark navy background with a faint grid and the Arc wordmark with its ring logo at the top of the sidebar. _(Verified: see docs/screenshots/002-arc-hud-design-system-launch.png)_
    - [x] Given macOS is set to Light appearance, when the user opens Arc, then Arc still shows its dark HUD look. _(Verified: simulated via nativeTheme light, see docs/screenshots/002-arc-hud-design-system-light-appearance.png; user confirmed on real Light setting)_
    - [x] When the user views any screen, then headings and section labels are uppercase with wide letter spacing, and file names and paths are shown in a monospace font. _(Verified: dialog titles uppercase Orbitron 3.96px tracking, item filenames JetBrains Mono; see docs/screenshots/002-arc-hud-design-system-delete-confirm.png, docs/screenshots/002-arc-hud-design-system-viewer-text.png)_
    - [x] When the user looks through every screen, menu, and dialog, then no Marvel name, character, or logo appears anywhere. _(Verified: name-denylist unit test 3/3; nothing seen in any captured screen)_

### 2.2. Panels and controls

- **Panels:** the content areas (sidebar, section list, item list, editor, settings) are framed panels with a thin cyan outline and bright corner brackets on two opposite corners.
- **Buttons come in four kinds:**
  - **Primary:** solid cyan glow, for the main action in a place.
  - **Secondary:** outlined.
  - **Destructive:** red, used for Delete.
  - **Attention:** amber, used for actions answering something that waits on the user.
- **Button states:** a disabled button looks clearly dimmed and doesn't respond. A button that is working (for example during an export) shows that it is busy.
- **Text fields, dropdowns, and toggles** share the panel style. An invalid field shows its error message in red directly under it, with the same wording as today.
- **Click and tap targets** are at least 44 by 44 points.
- **Keyboard focus:** every control shows a clearly visible cyan focus ring when reached with the keyboard.
  - **Acceptance Criteria:**
    - [x] When the user opens a group, then the sidebar, section list, item list, and editor each appear as framed panels with corner brackets. _(Verified: all five panels carry tl/br brackets; see docs/screenshots/002-arc-hud-design-system-group-panels.png)_
    - [x] When the user opens the delete confirmation for a group, then the Delete button is red and the Cancel button is outlined. _(Verified: Delete rgb(255,107,107), Cancel outlined; see docs/screenshots/002-arc-hud-design-system-delete-confirm.png)_
    - [x] When the user presses Tab repeatedly through any screen, then each control in turn shows a visible cyan focus ring, and no control is skipped or receives focus while invisible. _(Verified: 18/18 Tab stops show cyan ring; see docs/screenshots/002-arc-hud-design-system-focus-ring.png)_
    - [x] When the user submits the new-group dialog with an empty name, then the field is outlined in red and "Group name is required." appears in red under it. _(Verified: see docs/screenshots/002-arc-hud-design-system-new-group-empty-name.png)_
    - [x] Given an export is running in the delete confirmation, when the user looks at the buttons, then Delete and Cancel are visibly dimmed and do nothing when clicked. _(Verified: buttons disabled at opacity 0.5, clicks inert; see docs/screenshots/002-arc-hud-design-system-export-running.png)_

### 2.3. Dialogs

- **Look:** every dialog opens as a framed panel in the center of the window. The rest of the window is dimmed and slightly blurred behind it. This covers new group, rename, delete confirmations, import conflicts, link folder, unlink, and use app storage.
- **Keyboard:** pressing Escape closes a dialog the same way Cancel does, except while an operation in it is running. While a dialog is open, keyboard focus stays inside it.
- **Opening and closing:** a dialog draws in when it opens, using the motion rules in 2.6.
  - **Acceptance Criteria:**
    - [x] When the user opens the rename dialog, then it appears centered over a dimmed, blurred window, framed with corner brackets. _(Verified: centered dx/dy 0, blur(8px) backdrop; see docs/screenshots/002-arc-hud-design-system-rename-dialog.png)_
    - [x] Given a dialog is open, when the user presses Tab repeatedly, then focus cycles through the dialog's controls only and never reaches the screen behind it. _(Verified: focus sequence stayed inside rename and delete dialogs (driven in real app))_
    - [x] Given the delete confirmation is open and no export is running, when the user presses Escape, then the dialog closes and nothing is deleted. _(Verified: Escape closed dialog, group list unchanged (driven in real app))_

### 2.4. Messages: toasts and banners

- **Toasts** are short messages that appear in a corner and fade on their own. A toast's color matches its meaning (information, success, warning, error), and it carries a small icon so the meaning doesn't rely on color alone.
- **Banners** stay at the top of a panel until they are resolved. "Changed on disk" uses amber, and "Knowledge folder not found" and "Folder not found" use red or amber. Banners keep their current wording and buttons.
  - **Acceptance Criteria:**
    - [x] When the user adds a link with the address "wiki.example.com" and saves, then the error appears in red with an error icon, worded "Enter a full web address starting with http:// or https://.". _(Verified: exact text, red, error icon; see docs/screenshots/002-arc-hud-design-system-link-error.png)_
    - [x] Given a note has unsaved typing, when its file changes on disk, then an amber banner appears at the top of the editor with Reload and Keep mine. _(Verified: see docs/screenshots/002-arc-hud-design-system-changed-on-disk.png)_
    - [x] Given a group's linked knowledge folder was renamed, when the user opens the group, then the "Knowledge folder not found" banner appears with Locate… and Use app storage, styled as a warning. _(Verified: see docs/screenshots/002-arc-hud-design-system-knowledge-folder-missing.png)_

### 2.5. Needs-attention badge and attention dialog

These are the building blocks for the coming session screens, where workers ask for approval or ask questions. They are built and shown now, so the session screens can use them as they are.

- **Needs-attention badge:** an amber button showing a count and the words "Needs attention". It softly pulses while there are items waiting.
- **Opening it:** clicking the badge opens the attention dialog. The badge and dialog match the approved mockup.
- **Two kinds of cards in the dialog:**
  - **Permission card (amber):** a label naming who is asking, the exact action requested shown in monospace (for example a command), a one-line reason, and Approve and Deny buttons.
  - **Question card (cyan):** who is asking, the question, an answer box, and a Send button.
- **Leaving the dialog:** the dialog can be closed with its close button or Escape, and nothing is approved or denied by closing it.
- **Where the user sees it before sessions exist:** a "Design Preview" window, opened from the Help menu. It shows the badge, the attention dialog with one card of each kind, and every button, field, banner, and toast kind, filled with clearly labeled sample content.
  - **Acceptance Criteria:**
    - [x] When the user opens Help › Design Preview, then a window shows an amber "Needs attention" badge with the count 2. _(Verified: see docs/screenshots/002-arc-hud-design-system-design-preview-full.png)_
    - [x] Given the Design Preview is open, when the user clicks the badge, then the attention dialog opens with one amber permission card (Approve and Deny) and one cyan question card (answer box and Send). _(Verified: see docs/screenshots/002-arc-hud-design-system-attention-dialog.png)_
    - [x] Given the attention dialog is open, when the user presses Escape, then the dialog closes and the badge still shows 2. _(Verified: Escape closed dialog, count still 2 (driven in real app))_
    - [x] When the user views the permission card, then the requested action is shown in a monospace box, and the Approve and Deny buttons are each at least 44 points tall. _(Verified: action in JetBrains Mono box, Approve/Deny 44px; see docs/screenshots/002-arc-hud-design-system-attention-dialog.png)_

### 2.6. Motion

- **When motion is on:**
  - Panels and dialogs "draw in" when they appear, with the outline and corner brackets tracing in briefly.
  - The needs-attention badge pulses softly.
  - The Arc ring logo idles with a slow rotation.
- **Limits:** no single entrance takes longer than 300 milliseconds, and nothing flashes more than three times per second.
- **Reduce Motion:** when macOS "Reduce motion" is turned on, all of this motion is off. Panels and dialogs simply appear, the badge glows steadily without pulsing, and the logo is still.
- **Motion never delays the user:** controls can be used immediately, even while something is drawing in.
  - **Acceptance Criteria:**
    - [x] Given macOS "Reduce motion" is on, when the user opens a dialog, then it appears at once with no drawing-in or movement. _(Verified: emulated reduced motion: 0 animations; see docs/screenshots/002-arc-hud-design-system-reduced-motion-dialog.png; user confirmed with real OS toggle)_
    - [x] Given macOS "Reduce motion" is on, when the user opens the Design Preview, then the needs-attention badge shows a steady amber glow and does not pulse. _(Verified: see docs/screenshots/002-arc-hud-design-system-design-preview-reduced-motion.png; user confirmed with real OS toggle)_
    - [x] Given "Reduce motion" is off, when the user opens a dialog and immediately presses Tab and Enter on its first button, then the button responds without waiting for the animation to finish. _(Verified: Tab+Enter closed dialog 6ms after open during draw-in (driven in real app))_

### 2.7. Fixed-height layout

- **The window never scrolls as a whole.** Each panel scrolls on its own when its content is longer than the panel: a long item list, a long note, a long project list.
- **Headers stay put:** the group header and section navigation stay in place while the panel below them scrolls.
- **Minimum window size:** the window can't be made smaller than 1100 by 720 points.
- **Title bar:** a thin bar runs across the full width of the top of the window. The macOS window buttons sit inside it, nothing else crowds them, and the user can drag the window anywhere on the bar.
  - **Acceptance Criteria:**
    - [x] When the app opens, then a title bar spans the full window width above every panel, the window buttons sit inside it, and no panel, bracket, or text overlaps them. _(Verified: bar 1200x40 at 0,0, nothing in window-button zone; see docs/screenshots/002-arc-hud-design-system-native-titlebar.png)_
    - [x] When the user drags on any empty part of the title bar, then the window moves, and every button below the bar still responds to clicks. _(Verified: bar is app-region drag, buttons no-drag and clickable; user confirmed physical drag)_
    - [x] Given a section with 60 notes, when the user scrolls the item list, then only the item list scrolls, and the group header, section navigation, and sidebar stay in place. _(Verified: list scrollTop 0->1500, header/nav/sidebar unchanged; see docs/screenshots/002-arc-hud-design-system-scroll-60-notes.png)_
    - [x] Given a note longer than the editor, when the user scrolls in the editor, then only the editor scrolls. _(Verified: see docs/screenshots/002-arc-hud-design-system-long-note-scroll.png)_
    - [x] When the user tries to resize the window smaller than 1100 by 720 points, then it stops at that size. _(Verified: setSize(900,600) stayed at 1100x720)_

### 2.8. Restyled screens with unchanged behavior

- **Every existing screen uses the new look:**
  - the group sidebar and group view
  - section navigation
  - Projects (including "Not a git repository" and "Folder not found")
  - Notes, Playbooks, Docs, Links, and custom sections
  - the Markdown editor and preview, and the text, PDF, and image viewers
  - the knowledge storage settings and progress
  - all dialogs, banners, and toasts
- **The rendered Markdown preview** uses the HUD type and colors. Headings use the display style, code blocks are monospace on a darker panel, and links are cyan.
- **Behavior doesn't change:** every button, message text, keyboard shortcut, and workflow behaves exactly as described in the Groups & Knowledge Sections specification.
  - **Acceptance Criteria:**
    - [x] When the user goes through each screen listed above, then each one uses the HUD look and none shows the old default style. _(Verified: see docs/screenshots/002-arc-hud-design-system-screen-*.png, viewer-*.png, dialog-*.png; user confirmed look)_
    - [x] When the user previews a note containing a heading, a code block, and a link, then the heading is in the display style, the code block is monospace on a darker panel, and the link is cyan. _(Verified: h1 Orbitron, code JetBrains Mono on rgb(2,6,9), link rgb(0,229,255); see docs/screenshots/002-arc-hud-design-system-markdown-preview.png)_
    - [x] When the user repeats every acceptance check from the Groups & Knowledge Sections specification, then every one still passes with the same messages. _(Verified: full e2e suite incl. spec 001 acceptance specs: 73/73 passed)_

### 2.9. Readability and accessibility

- **Contrast:**
  - All text has a contrast of at least 4.5 to 1 against its background.
  - Large headings (24 points and up) have at least 3 to 1.
  - Disabled controls are exempt, but must still be legible.
- **Meaning never relies on color alone:** amber, red, and green states also carry a word or an icon (for example "Needs attention", an error icon, "Saved").
- **VoiceOver and buttons:** every control is reachable and usable with the keyboard alone, and icon-only buttons have spoken labels for VoiceOver.
  - **Acceptance Criteria:**
    - [x] When the user checks the text and background colors of every text style on every screen with a contrast checker, then normal text measures at least 4.5 to 1, and headings of 24 points and up measure at least 3 to 1. _(Verified: contrast unit test 102/102 passed)_
    - [x] Given VoiceOver is on, when the user moves to the attention dialog's close button, then VoiceOver reads "Close". _(Verified: accessible name "Close" in real app; user confirmed with VoiceOver)_
    - [x] When the user views a saved note, a failed import, and the needs-attention badge, then each shows a word or icon alongside its color ("Saved", an error icon, "Needs attention"). _(Verified: see docs/screenshots/002-arc-hud-design-system-note-saved.png, docs/screenshots/002-arc-hud-design-system-failed-import-toast.png, docs/screenshots/002-arc-hud-design-system-design-preview-full.png)_

### 2.10. App icon

- Arc gets its own app icon: the glowing cyan Arc ring on a dark navy rounded square, in the macOS icon shape.
- **Where it appears:** in the Dock, the app switcher, Finder, Launchpad, and the installer window.
- **Small sizes:** the icon stays recognizable at the smallest sizes macOS uses.
  - **Acceptance Criteria:**
    - [x] Given Arc is installed from the installer, when the user opens it, then the Dock shows the cyan ring on a dark navy rounded square instead of a default icon. _(Verified: DMG icns byte-identical to resources/icon.icns; user confirmed Dock icon)_
    - [x] When the user views Arc in Finder's list view at the smallest icon size, then the ring shape is still recognizable. _(Verified: see docs/screenshots/002-arc-hud-design-system-icon-16px.png; user confirmed in Finder)_
    - [x] When the user opens the Arc installer, then the installer window shows the Arc icon. _(Verified: DMG volume icon is the Arc icns; user confirmed installer window)_

---

## 3. Scope and Boundaries

### In-Scope

- The HUD visual language: background and grid, colors by meaning, type, the Arc wordmark and ring logo, panels, buttons, fields, toggles, dialogs, toasts, banners, the needs-attention badge, and the attention dialog with permission and question cards.
- Motion with a full Reduce Motion fallback.
- A fixed-height window layout with panels that scroll on their own, and a minimum window size.
- Restyling every screen from the Groups & Knowledge Sections feature without changing its behavior.
- A Design Preview window (Help menu) showing every building block with sample content.
- Readability and keyboard and VoiceOver accessibility for all of the above.
- A new Arc app icon for the Dock, Finder, and the installer.

### Out-of-Scope

- The session screens themselves: the chat with the brain, the reactor-style brain visual, the orbiting worker cards, and usage gauges. These come in the sessions specification and will use these building blocks.
- Real approvals and questions from workers. The attention dialog only shows sample content until sessions exist.
- A light theme.
- New features or changes to how the groups and knowledge screens behave.
- Any Marvel names, characters, or branding.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
