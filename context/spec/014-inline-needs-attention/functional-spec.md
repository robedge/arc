# Functional Specification: Inline Needs Attention

- **Topic:** Requests that wait for the user (permissions, questions and unsaved-changes choices) appear as panels docked above the message box in the conversation, instead of behind a "Needs attention" button in the session header.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today, when a worker needs a permission, when the brain or a worker asks a question, or when Arc needs to know what to do with unsaved changes, the session header shows an amber "Needs attention" button with a count. The user has to notice the button in the top right corner, click it, and deal with the requests in a dialog that covers the conversation.

This costs the user in three ways:

- **Easy to miss:** the button sits far from where the user reads and types. Work stops until the user happens to look up.
- **An extra step:** every request takes a click to open the dialog before the user can even read it.
- **Lost context:** the dialog covers the conversation, so the user cannot read what the brain just said while deciding.

Arc can now show interactive panels inside the conversation (the panels introduced by the earlier trial of A2UI). This spec uses the same kind of panel for requests. Waiting requests sit directly above the message box, where the user is already looking, with their buttons ready. Once answered, a request leaves a one-line record in the conversation, so the history shows what was decided.

**Success looks like this:**

- A user who is reading the conversation sees a new request without looking anywhere else, and can answer it with one click.
- The user can read the conversation while deciding.
- Scrolling back through a session shows what was approved, denied and answered, and when.
- The session header no longer has a "Needs attention" button, and no dialog opens for requests.

---

## 2. Functional Requirements (The "What")

### 2.1. Waiting requests are docked above the message box

- **As a** user, **I want** requests that wait for me to appear right above the message box, **so that** I see them where I am already looking and can answer without opening anything.
- When the session has at least one waiting request, a "Needs attention" area appears between the conversation and the message box. It has a heading with the count, for example "Needs attention · 2", and one panel per request.
- The area stays in place while the conversation scrolls and while new messages arrive. It is not part of the scrolling message list.
- Requests are listed oldest first. A new request is added at the end and does not move the ones already shown.
- The oldest waiting request is always shown in full, with its buttons in view, without scrolling inside the area. For this the area may grow up to four fifths of the conversation's height.
- Further requests are shown below it while the area is no taller than half the height of the conversation. When the panels need more room than that, the area scrolls on its own.
- The message box stays usable while requests wait: the user can still type and send a message to the brain.
- When the last request is answered or goes away, the area disappears and the conversation takes the space back.
- Each session shows only its own requests.
- The user can fold the area down to its heading line by clicking the heading, and unfold it the same way. Folded, it shows only "Needs attention · <count>". It unfolds by itself when a new request arrives. What the user typed or picked in a panel is kept while the area is folded.
- **Acceptance Criteria:**
  - [x] Given a session with no waiting requests, when a worker asks for a permission, then a "Needs attention · 1" area with one permission panel appears directly above the message box without the user clicking anything.
  - [x] Given one request is waiting, when a second request arrives, then the heading reads "Needs attention · 2" and the second panel is shown below the first.
  - [x] Given a request is waiting, when the user scrolls the conversation up to older messages, then the request panel is still visible above the message box.
  - [x] Given a request is waiting, when the user types a message and sends it, then the message is sent to the brain and the request is still waiting.
  - [x] Given a window 1200 wide and 800 high and one waiting permission request, when the request appears, then its "Approve" and "Deny" buttons are visible without scrolling.
  - [x] Given five requests are waiting, when the user looks at the session, then the first request is shown in full, the area is no taller than the larger of half the conversation and that first request, and the user can scroll inside the area to reach every request.
  - [x] Given one request is waiting, when the user answers it, then the "Needs attention" area disappears.
  - [x] Given two sessions each with one waiting request, when the user opens the first session, then only the first session's request is shown.
  - [x] Given two requests are waiting, when the user clicks the heading "Needs attention · 2", then the panels are hidden and only the heading line remains, and when they click it again, then both panels are shown.
  - [x] Given the area is folded, when a new request arrives, then the area unfolds and shows all waiting requests.

### 2.2. Every kind of request can be answered in its panel

- **As a** user, **I want** each request to show everything I need to decide, with the same choices as today, **so that** moving requests into the conversation loses nothing.
- Every panel shows what kind of request it is and who is asking, for example "W2 api-retry · via brain", "Brain" or "Arc".
- **Permission:** shows what is requested and the buttons "Approve", "Deny" and "Always allow this in this session".
  - A command is shown as code, exactly as it would run.
  - A tool from one of the user's connected tool servers shows the server name, the tool name and its arguments. Arguments longer than 10 lines or 400 characters are cut short with a "Show more" button; "Show less" cuts them short again.
  - A request for more access than the worker normally has shows the reason and the folders it wants to read, the folders it wants to write, and whether it wants network access. This kind has no "Always allow this in this session" button.
  - A note explaining why the request was passed to the user is shown when there is one.
- **Question:** shows the question, a "Your answer" box and a "Send" button. "Send" is unavailable while the box is empty. Pressing Enter in the box sends the answer.
- **Question with choices:** shows each question with its choices, an "Other" box for the user's own answer, and the buttons "Decline" and "Submit". Choices are buttons when one may be picked and checkboxes when several may be picked. Text typed in "Other" replaces the picked choices for that question. "Submit" is unavailable until every question has an answer.
- **Unsaved changes:** shows "Unsaved changes in <repository>", the workers waiting to start, the first changed files (at most 10, then "and N more"), the choices "Set aside", "Commit them first", "Bring them along" and "Don't start" with their explanations, and a "Continue" button. No choice is picked in advance, and "Continue" is unavailable until the user picks one. If "Bring them along" did not work, the panel shows why and offers the other three choices again.
- While an answer is being sent, the panel's buttons are unavailable, so one request cannot be answered twice.
- If an answer cannot be sent, the panel stays, keeps what the user entered, and shows "Could not send the answer. Try again." or the specific reason when Arc has one.
- What the user has typed or picked in a panel is kept when other requests arrive or are answered.
- **Acceptance Criteria:**
  - [x] Given a worker asks to run a command, when the panel appears, then it shows the label "Permission", who is asking, the command as code, and the buttons "Approve", "Deny" and "Always allow this in this session".
  - [x] Given a permission panel, when the user clicks "Approve", then the panel leaves the area and the worker carries on.
  - [x] Given a permission panel, when the user clicks "Deny", then the panel leaves the area and the worker is told the action was denied.
  - [x] Given a permission panel, when the user clicks "Always allow this in this session", then the panel leaves the area and the same action from that session is not asked about again.
  - [x] Given a permission for a tool with arguments 30 lines long, when the panel appears, then the first 10 lines are shown with a "Show more" button, and when the user clicks it, then all 30 lines are shown with a "Show less" button.
  - [x] Given a request for more access, when the panel appears, then it lists the folders and network access asked for and has no "Always allow this in this session" button.
  - [x] Given a question panel with an empty answer box, when the user looks at "Send", then it is unavailable, and when they type "use the staging database" and press Enter, then the panel leaves the area and the brain receives that answer.
  - [x] Given a question with the choices "api", "web" and "infra", when the user clicks "web" and then "Submit", then the panel leaves the area and the answer "web" is delivered.
  - [x] Given a question with choices, when the user types "both of them" in "Other" and clicks "Submit", then "both of them" is delivered as the answer instead of any picked choice.
  - [x] Given a question with choices, when the user clicks "Decline", then the panel leaves the area and whoever asked is told the user declined.
  - [x] Given an unsaved-changes panel, when it appears, then no choice is picked and "Continue" is unavailable, and when the user picks "Set aside" and clicks "Continue", then the panel leaves the area and the waiting worker starts.
  - [x] Given the user chose "Bring them along" and it did not work, when the panel comes back, then it shows the reason and offers only "Set aside", "Commit them first" and "Don't start".
  - [x] Given an answer cannot be sent, when the user clicks the panel's button, then the panel stays with the user's input in place and shows "Could not send the answer. Try again."
  - [x] Given the user has typed half an answer in a question panel, when another request arrives, then the half-typed answer is still in its box.

### 2.3. An answered request leaves a record in the conversation

- **As a** user, **I want** each decision I make to stay in the conversation, **so that** I can scroll back and see what I approved, denied and answered.
- When the user answers a request in its panel, a one-line record is added to the conversation at that moment, in order with the other messages. It says what was decided, about what, and who asked. Examples:
  - "Approved: git push origin arc/fix-order-sync (W2 api-retry)"
  - "Denied: rm -rf build (W1 cleanup)"
  - "Always allowed in this session: npm install -g typescript (W3 web-fix)"
  - "Answered: Which repository? → web (Brain)"
  - "Declined: Which repository? (Brain)"
  - "Unsaved changes in api: Set aside (Arc)"
- A record is a single quiet line, visibly different from messages by the user and the brain. Text longer than one line is cut with "…"; hovering shows the full text.
- Records have no buttons. A decision cannot be changed from its record.
- Records are part of the session's history: they are still there after the session is closed and opened again, and after Arc restarts.
- For unsaved changes the record is added at the moment the user clicks "Continue", so later messages always appear below it. If the choice then does not work (for example "Bring them along" clashes), the same line changes to say so, for example "Unsaved changes in api: Bring them along did not work (Arc)", and the next choice gets its own record.
- A request that goes away without the user answering it (for example because its worker was stopped) leaves no record.
- Records are for the user only. They do not change what the brain or the workers are told.
- **Acceptance Criteria:**
  - [x] Given a permission panel for "git push origin arc/fix-order-sync" from W2 api-retry, when the user clicks "Approve", then the line "Approved: git push origin arc/fix-order-sync (W2 api-retry)" appears at the end of the conversation.
  - [x] Given a question "Which repository?" from the brain, when the user answers "web", then the line "Answered: Which repository? → web (Brain)" appears at the end of the conversation.
  - [x] Given the user approved a request and the brain then sent two more messages, when the user scrolls up, then the record sits between the messages from before and after the approval.
  - [x] Given a session with three records, when the user quits Arc, starts it again and opens the session, then the three records are in the conversation in the same places.
  - [x] Given a waiting request, when its worker is stopped before the user answers, then the panel leaves the area and no record is added.
  - [x] Given an unsaved-changes request, when the user picks "Set aside", clicks "Continue" and at once sends a message, then the record "Unsaved changes in <repository>: Set aside (Arc)" is above that message and above the brain's reply.
  - [x] Given the user chose "Bring them along" and it did not work, when they look at the conversation, then the record reads "Unsaved changes in <repository>: Bring them along did not work (Arc)", and when they then choose "Set aside", then a second record "Unsaved changes in <repository>: Set aside (Arc)" is added below it.
  - [x] Given a record for a command 300 characters long, when the user looks at it, then it is one line ending in "…", and when they hover over it, then the full command is shown.

### 2.4. The header button and dialog are removed, and everything else leads to the panel

- **As a** user, **I want** one place to deal with requests, **so that** I am never sent to a dialog for something that is already in front of me.
- The "Needs attention" button in the session header and the dialog it opened are removed.
- These stay as they are today: the count next to the group in the sidebar, the "Needs attention" status of the session in the session list, the amber worker card, and the desktop notification.
- Clicking a desktop notification opens the session, as today, and then brings the request's panel into view and highlights it for about two seconds.
- Clicking an amber worker card brings that worker's request panel into view and highlights it in the same way, instead of opening the dialog.
- When the user has stepped in on a worker, that worker's requests are answered in its terminal as today and are not shown in the area. When the user hands the worker back, requests still waiting appear in the area.
- While the user is looking at a worker's terminal tab, the area is out of sight. The Brain tab then shows an amber count of the waiting requests. Clicking the Brain tab goes to the conversation with the area in view and unfolded. The count is not shown when nothing is waiting.
- **Acceptance Criteria:**
  - [x] Given a session with waiting requests, when the user looks at the session header, then there is no "Needs attention" button.
  - [x] Given a request arrives while Arc is in the background, when the user clicks the desktop notification, then Arc opens that session with the request's panel visible and briefly highlighted, and no dialog opens.
  - [x] Given a worker card is amber because the worker waits for a permission, when the user clicks the card, then that permission's panel is brought into view and briefly highlighted, and no dialog opens.
  - [x] Given a request is waiting in a session, when the user looks at the sidebar and the session list, then the group shows its count and the session shows "Needs attention", as before this change.
  - [x] Given the user has stepped in on a worker that asks for a permission, when the request arrives, then it is shown in the worker's terminal and not in the area above the message box.
  - [x] Given a stepped-in worker has an unanswered request, when the user hands the worker back, then the request appears in the area above the message box.
  - [x] Given the user is looking at a worker's terminal tab, when a request arrives, then the Brain tab shows an amber "1", and when the user clicks the Brain tab, then the conversation is shown with the request's panel visible and the count is gone from the tab.

### 2.5. Arc's request panels cannot be imitated by the brain

- **As a** user, **I want** to be sure a permission panel really comes from Arc, **so that** a panel drawn by the brain can never trick me into approving something.
- Request panels appear only in the "Needs attention" area above the message box. Panels the brain draws appear only inside the conversation, as messages. The brain cannot put anything in the area.
- Request panels have an amber frame (permissions) or an accent frame (questions and unsaved changes) with a kind label and a "from" line. Panels the brain draws do not have this frame and cannot be given it.
- Clicking a button on a panel the brain drew only sends the brain a message. It never approves, denies or answers a request.
- **Acceptance Criteria:**
  - [x] Given the brain draws a panel titled "Permission" with a button labelled "Approve", when it appears, then it is shown inside the conversation as a message, without the request frame, and not in the "Needs attention" area.
  - [x] Given a real permission request is waiting and the brain has drawn a panel with an "Approve" button, when the user clicks the brain's button, then the real request is still waiting and the worker has not carried on.

### 2.6. Panels in the conversation become a permanent part of Arc

- **As a** user, **I want** the panels the brain draws to keep working as they do now, **so that** the trial becomes a dependable feature rather than something that may break.
- Request panels and the panels the brain draws are built from the same parts and look alike in type, spacing and controls, apart from the request frame of section 2.5.
- The brain can still draw panels with text, inputs, buttons, tiles, tables and charts, as in the trial. Nothing the trial could show is lost.
- The parts needed for requests are also available to the brain for its own panels: a block of code, a list of names and values, and long text that can be shown in full or cut short.
- **Acceptance Criteria:**
  - [x] Given the user asks the brain for a panel with a bar chart and a button, when the brain draws it, then it appears in the conversation and the button works, as in the trial.
  - [x] Given the user asks the brain to show a command in a panel, when the brain draws it, then the command appears as a block of code inside the panel.

---

## 3. Scope and Boundaries

### In-Scope

- The "Needs attention" area above the message box, with its heading, count, ordering, height limit and folding.
- The amber count on the Brain tab while a worker's terminal tab is in front.
- Panels for the four kinds of request: permission, question, question with choices, and unsaved changes, with the same choices and wording as the current dialog.
- One-line records in the conversation for requests the user answered in a panel, kept with the session's history.
- Removing the "Needs attention" button from the session header and the dialog it opened.
- Notification clicks and amber worker cards leading to the request's panel.
- Making sure the brain's panels cannot be mistaken for, or act as, Arc's request panels.
- Turning the trial panels in the conversation into a permanent feature, with the added parts for code, names and values, and long text.

### Out-of-Scope

- Changing which actions need the user's permission, or what "Always allow this in this session" covers.
- Changing how the brain or the workers ask questions, or what they are told when a request is answered.
- Changing how requests are answered in a worker's terminal after the user steps in. Requests answered there leave no record in the conversation.
- Plan approval cards and the "Continue workers" prompt, which already appear in the conversation.
- Knowledge suggestions and their button in the session header.
- Changes to the sidebar count, the session list status, and when desktop notifications are sent.
- Undoing or changing a decision after it was made.
- Records for requests that were answered before this change.
- Further improvements to the brain's own panels: updating a panel in place, keeping what the user entered in a brain panel after a restart, and panels that make the brain wait for an answer.

---

## Change Log

- 2026-11-14 — review during implementation (user decision) — Section 2.1: the oldest waiting request is now always shown in full (the area may grow to four fifths of the conversation for it), because at a 1200×800 window the half-height limit hid the "Approve" button of a single request. Section 2.3: the record for unsaved changes is now added when the user clicks "Continue" and changes to "did not work" if the choice fails, because a record added only after the worker had started could land below later messages. This replaces the earlier rule that a failed "Bring them along" leaves no record.

---

## Verification (2026-11-14)

All acceptance criteria were checked against the real app, run with throwaway data and the fake providers.

- **Behaviour:** the full end-to-end suite passed (381 tests), including `attention-dock.spec.ts` (2.1, 2.2, 2.4), `attention-records.spec.ts` and `attention-stop.spec.ts` (2.3), `branch-questions.spec.ts` and `commands-attention.spec.ts` (2.2), `worker-step-in.spec.ts` and `sessions-attention.spec.ts` (2.4), `surface.spec.ts` (2.6) and `spec-014-acceptance.spec.ts` (2.1, 2.2, 2.5, 2.6). The notification-click test failed once in four full runs under load; see Open Questions in `tasks.md`.
- **Look and feel:** a walk-through of each state was captured to `docs/screenshots/014-inline-needs-attention-*.png` and confirmed by the user:
  - 2.1: `permission-panel`, `two-requests`, `folded`, `five-requests`
  - 2.2: `question-empty`, `question-typed`, `choices-none-picked`, `choices-picked`, `tool-args-cut`, `tool-args-full`, `more-access`, `unsaved-changes`, `unsaved-changes-carry-failed`
  - 2.3: `approved-record`, `long-record`, `unsaved-changes-records`
  - 2.4: `permission-panel` (no header button), `card-click-highlight`, `brain-tab-count`, `brain-tab-clicked`
  - 2.5: `brain-lookalike`, `brain-lookalike-dock-folded`
  - 2.6: `brain-chart-and-code`
