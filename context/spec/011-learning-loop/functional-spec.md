# Functional Specification: Learning Loop

- **Topic:** The brain suggests new or updated knowledge for a group from what it learned in a session, and the user accepts, edits or discards each suggestion.
- **Status:** Draft
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

A group's knowledge (Notes, Docs, Playbooks, Links and custom sections) is what saves the user from explaining their system again in every session. Today that knowledge only grows when the user stops and writes it down. Meanwhile each session discovers things worth keeping: "the orders table is partitioned by month", "the api repo's tests need the local queue running", "checkout calls the pricing service twice". When the session is over, those facts are lost, and the next session finds them again the slow way.

This spec closes that loop. When work in a session finishes, the brain may suggest a few additions or corrections to the group's knowledge, each with a short reason. The user looks at each one, sees exactly what would change, and accepts it, edits it first, or discards it. Nothing reaches a group's knowledge unless the user accepted it.

**Success looks like this:**

- After a session that discovered something lasting, the user is offered it as a suggestion without asking.
- Accepting a suggestion takes one click, and the knowledge is there for the next session on that group.
- The user is never surprised by a change to their knowledge: every change was shown to them first.
- Suggestions stay few and useful. A session that learned nothing lasting suggests nothing.

---

## 2. Functional Requirements (The "What")

### 2.1. When the brain suggests

- **As a** user, **I want** the brain to offer what it learned when the work is done, **so that** I don't have to remember to write it down.
- The brain makes suggestions when it finishes a request: it has given its answer and no worker is still running.
- The user can also ask at any time, in plain words (for example "what should we add to the knowledge?"), and the brain answers with suggestions or says it has none.
- A suggestion is something lasting about the user's system or how they work: how parts fit together, a fact about the data, a convention, a step that is easy to get wrong. The brain does not suggest a summary of the session, a list of the changes it made, or anything the group's knowledge already says.
- The brain makes at most 5 suggestions per finished request. When it has nothing worth keeping, it makes none and says nothing about it.
- The brain does not suggest the same thing twice in a session. A suggestion the user discarded is not offered again in that session.
- **Acceptance Criteria:**
  - [ ] Given a session in which the brain learned a lasting fact that the group's knowledge does not contain, when the brain finishes the request, then at least one suggestion appears for that session.
  - [ ] Given a session in which the brain only answered from the group's existing knowledge, when the brain finishes the request, then no suggestion appears and the conversation shows no message about suggestions.
  - [ ] When the user asks the brain what should be added to the knowledge and the brain has nothing, then the brain replies that it has no suggestions.
  - [ ] When the brain finishes a request, then no more than 5 new suggestions appear for it.
  - [ ] Given the user discarded a suggestion, when the brain finishes a later request in the same session, then that suggestion is not offered again.

### 2.2. What a suggestion contains

- **As a** user, **I want to** see exactly what a suggestion would change and why, **so that** I can decide quickly.
- Each suggestion shows:
  - a one-line title, for example "Orders table is partitioned by month";
  - the reason, in one or two sentences: where in the session the brain learned it;
  - where it would go: the section and the note or document, for example "Docs › Database schema" or "Notes › New note: Service map";
  - the text itself.
- A suggestion is one of two kinds:
  - **New:** a new note or document in a section. The full text is shown.
  - **Update:** a change to an existing note or document. The suggestion shows the lines to be added and the lines to be removed, marked as in change review, with a few unchanged lines around them.
- The brain may suggest into these sections: Notes, Docs, Playbooks and custom sections. It does not suggest into Projects.
- Suggestions are text. The brain does not suggest changes to PDFs or other files Arc cannot edit as text.
- **Acceptance Criteria:**
  - [ ] When a suggestion appears, then it shows a title, a reason, the section and note or document it would go to, and its text.
  - [ ] When a suggestion is for a new note, then its destination reads "New note:" followed by the proposed name, and the full text is shown.
  - [ ] When a suggestion is for an existing note, then the added lines and the removed lines are each marked, and unchanged lines around them are shown for context.
  - [ ] Given a group whose Docs section contains a PDF, when the brain makes suggestions, then none of them targets the PDF.

### 2.3. Where the user sees suggestions

- **As a** user, **I want** suggestions to be easy to find but not in my way, **so that** I can deal with them when I'm ready.
- When a session has suggestions waiting, its header shows a **Suggestions** chip with the count, for example "Suggestions 3". It is cyan, not amber: suggestions never block the session and are not part of Needs attention.
- Clicking the chip opens a **Knowledge suggestions** dialog that lists the waiting suggestions, newest first, each as a card with its title, reason, destination and text, and the buttons Accept, Edit and Discard.
- The brain's answer ends with one line when it made suggestions, for example "I have 2 suggestions for this group's knowledge." Clicking it opens the same dialog.
- Suggestions do not raise a macOS notification and do not add to the Needs attention count.
- Waiting suggestions are kept with the session. After closing and reopening Arc, or resuming the session later, they are still there.
- **Acceptance Criteria:**
  - [ ] Given a session with 3 waiting suggestions, when the user looks at the session header, then a chip reads "Suggestions 3".
  - [ ] Given a session with no waiting suggestions, when the user looks at the session header, then there is no Suggestions chip.
  - [ ] When the user clicks the Suggestions chip, then a dialog titled "Knowledge suggestions" opens and lists each waiting suggestion with Accept, Edit and Discard.
  - [ ] When suggestions appear while Arc is not in front, then no macOS notification is sent and the Needs attention count does not change.
  - [ ] Given a session with waiting suggestions, when the user quits Arc, reopens it and opens that session, then the same suggestions are listed.
  - [ ] When the dialog is open, then the user can move between suggestions and reach Accept, Edit and Discard with the keyboard alone, and Escape closes the dialog.

### 2.4. Accepting, editing and discarding

- **As a** user, **I want to** accept, change or throw away each suggestion on its own, **so that** only what I agree with ends up in my knowledge.
- **Accept** applies the suggestion as shown: a new note or document is created in its section, or the existing one is changed. The card leaves the list, and a short confirmation names what changed, for example "Added to Docs › Database schema", with an **Open** link that goes to it in the group's knowledge.
- **Edit** lets the user change the text, the name of a new note, and the section it goes to, before accepting. The edited suggestion is applied with **Accept**; **Cancel** returns to the suggestion unchanged.
- **Discard** removes the suggestion. It is not applied and is not offered again in this session. No confirmation is asked.
- The dialog also offers **Accept all** and **Discard all** when more than one suggestion is waiting. Discard all asks once for confirmation.
- Accepted knowledge is available to the next session on the group. Agents already running in the current session are not restarted for it.
- Accepting writes to where the group's knowledge lives: Arc's own folder, or the folder the user linked. Arc does not commit or push anything in a linked folder.
- When a suggestion can no longer be applied as shown, Arc says so and applies nothing:
  - the note or document it would change was edited since the suggestion was made: "This note has changed since the suggestion was made." with **Show current** and **Discard**;
  - the note or document was deleted: "This note no longer exists." with **Add as a new note** and **Discard**;
  - a new note's name is already taken in that section: "A note with this name already exists." and the name field opens for editing;
  - the file could not be written: "Couldn't save to [location]." with **Try again**; the suggestion stays in the list.
- Given the note a suggestion changes is open in Arc's editor with unsaved edits, accepting is refused with "Save or discard your edits to this note first."
- **Acceptance Criteria:**
  - [ ] Given a suggestion for a new note in Notes, when the user clicks Accept, then the note appears in the group's Notes section with the suggested name and text, the card leaves the list, and the Suggestions count drops by one.
  - [ ] Given a suggestion that updates an existing document, when the user clicks Accept, then the document shows the added lines and no longer shows the removed lines, and the rest of the document is unchanged.
  - [ ] When the user accepts a suggestion, then a confirmation names the section and note that changed, and its Open link shows that note in the group's knowledge.
  - [ ] When the user clicks Edit, changes the text and clicks Accept, then the note is saved with the user's text, not the brain's.
  - [ ] When the user clicks Edit and then Cancel, then the suggestion is shown again with the brain's original text and nothing is saved.
  - [ ] When the user clicks Discard, then the card leaves the list without a confirmation, and the group's knowledge is unchanged.
  - [ ] Given 3 waiting suggestions, when the user clicks Accept all, then all three are applied and the Suggestions chip disappears.
  - [ ] Given 3 waiting suggestions, when the user clicks Discard all and confirms, then the list is empty and the group's knowledge is unchanged.
  - [ ] Given the user edited a note after a suggestion to update it was made, when the user clicks Accept on that suggestion, then they see "This note has changed since the suggestion was made." and the note is not changed.
  - [ ] Given the note a suggestion would update was deleted, when the user clicks Accept, then they see "This note no longer exists." with the choices Add as a new note and Discard.
  - [ ] Given a note named "Service map" already exists in Notes, when the user accepts a suggestion for a new note with that name, then they see "A note with this name already exists." and can change the name.
  - [ ] Given the group's linked folder is not reachable, when the user clicks Accept, then they see "Couldn't save to" followed by the folder, with Try again, and the suggestion is still in the list.
  - [ ] Given a note is open in the editor with unsaved edits, when the user accepts a suggestion that changes that note, then they see "Save or discard your edits to this note first." and the note is not changed.
  - [ ] Given a group whose knowledge is in a linked folder under version control, when the user accepts a suggestion, then the file in that folder changes and no commit is made.

### 2.5. Turning suggestions off

- **As a** user, **I want to** switch suggestions off, **so that** sessions where I don't want them stay quiet.
- Settings has a switch **Suggest knowledge updates**, on by default. When it is off, the brain makes no suggestions on its own. Asking the brain for suggestions in plain words still works.
- Switching it off does not remove suggestions that are already waiting.
- **Acceptance Criteria:**
  - [ ] Given "Suggest knowledge updates" is off, when the brain finishes a request, then no suggestion appears.
  - [ ] Given "Suggest knowledge updates" is off, when the user asks the brain what should be added to the knowledge, then the brain's suggestions appear as usual.
  - [ ] Given a session with 2 waiting suggestions, when the user switches "Suggest knowledge updates" off, then the session still shows "Suggestions 2".

### 2.6. The session record

- Each suggestion the brain made, and what the user did with it (accepted, accepted after editing, discarded), is listed in the session's event history with its title and destination.
- **Acceptance Criteria:**
  - [ ] When the user accepts a suggestion and opens the session's event history, then an entry shows the suggestion's title, its destination and "Accepted".
  - [ ] When the user discards a suggestion and opens the session's event history, then an entry shows the suggestion's title and "Discarded".

---

## 3. Scope and Boundaries

### In-Scope

- The brain making suggestions when it finishes a request, and when the user asks.
- Suggestions for new notes and documents, and for changes to existing text ones.
- The Suggestions chip, the Knowledge suggestions dialog, and Accept, Edit, Discard, Accept all and Discard all.
- Messages for suggestions that can no longer be applied.
- The Settings switch.
- Suggestions and their outcomes in the session's event history.

### Out-of-Scope

- Workers making suggestions directly. Only the brain suggests; it may draw on what workers reported.
- Changing knowledge without the user accepting it.
- Undoing an accepted suggestion from Arc. The user edits or deletes the note in the knowledge screen as usual.
- Suggestions for Projects, PDFs and other files Arc cannot edit as text.
- Suggesting changes to the project repositories' own files (README, CLAUDE.md and similar). Those are code changes and go through workers and change review.
- Committing or pushing accepted knowledge in a linked folder.
- A list of suggestions across all sessions or groups.
- Restarting running agents so they pick up accepted knowledge at once.

---

## Change Log

_Dated amendments made after the spec was first written._
