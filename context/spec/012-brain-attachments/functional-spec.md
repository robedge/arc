# Functional Specification: Attachments for the Brain

- **Topic:** The user can paste images or attach files to the first message of a session and to any later message sent to the brain.
- **Status:** Draft
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today a message to the brain is text only. Much of what a developer wants to show is not text: a screenshot of a broken page, an error dialog, a design mock-up, a log file, an exported report. The user has to describe the picture in words, or save the file somewhere inside a project and tell the brain where to look. Both are slow, and a description of a screenshot loses the detail that mattered.

This spec lets the user put images and files straight into a message. They paste a screenshot, drop a file onto the message box or pick one with a button, see it attached, and send. The brain receives the attachment with the message and can use it in its answer and in the work it hands to workers.

**Success looks like this:**

- Showing the brain a screenshot takes one paste and one send.
- The user can always see what is attached before sending, and what was attached afterwards.
- An attachment that can't be used is refused before sending, with a reason, and never silently dropped.

---

## 2. Functional Requirements (The "What")

### 2.1. Adding attachments to a message

- **As a** user, **I want to** add images and files to the message I'm writing, **so that** I can show the brain what I mean.
- Attachments can be added in the message box of the new session screen (the first message) and in the message box of an open session (any later message). Both behave the same.
- There are three ways to add one:
  - **Paste:** pasting an image from the clipboard (for example a screenshot) attaches it. Pasting a file copied in Finder attaches that file. Pasting plain text still pastes text.
  - **Drop:** dragging one or more files from Finder onto the message box attaches them. While files are dragged over it, the message box shows "Drop to attach".
  - **Pick:** an **Attach** button (paperclip) beside the message box opens the macOS file picker, where one or more files can be chosen.
- A pasted image with no file name is named "Pasted image 1", "Pasted image 2" and so on within the message.
- **Acceptance Criteria:**
  - [ ] Given a screenshot is on the clipboard, when the user pastes into the message box of the new session screen, then the image appears as an attachment under the message box and no text is inserted.
  - [ ] Given a screenshot is on the clipboard, when the user pastes into the message box of an open session, then the image appears as an attachment under the message box.
  - [ ] Given text is on the clipboard, when the user pastes into the message box, then the text is inserted and no attachment is added.
  - [ ] When the user drags two files from Finder over the message box, then it shows "Drop to attach", and when they drop them, then both files appear as attachments.
  - [ ] When the user clicks Attach and chooses a file in the file picker, then that file appears as an attachment.
  - [ ] When the user pastes two images with no file names into one message, then they are listed as "Pasted image 1" and "Pasted image 2".

### 2.2. What can be attached

- **As a** user, **I want to** know what I can attach, **so that** I'm not surprised when something is refused.
- Allowed: images (PNG, JPEG, GIF, WebP), PDFs, and text files of any kind (for example logs, source files, Markdown, JSON, CSV).
- Limits: at most 10 attachments per message, and each at most 20 MB.
- An attachment that is not allowed is refused when it is added, the rest are kept, and a message under the message box says why:
  - wrong type: "[name] can't be attached. Arc accepts images, PDFs and text files."
  - too large: "[name] is too large. The limit is 20 MB."
  - too many: "A message can have at most 10 attachments."
  - a folder: "Folders can't be attached."
  - can't be opened: "[name] couldn't be read."
- **Acceptance Criteria:**
  - [ ] When the user attaches a PNG, a PDF and a log file, then all three appear as attachments.
  - [ ] When the user attaches a ZIP file, then it is not attached and they see "[name] can't be attached. Arc accepts images, PDFs and text files."
  - [ ] When the user attaches a 25 MB image, then it is not attached and they see "[name] is too large. The limit is 20 MB."
  - [ ] Given a message already has 10 attachments, when the user adds another, then it is not attached and they see "A message can have at most 10 attachments."
  - [ ] When the user drops a folder onto the message box, then nothing is attached and they see "Folders can't be attached."
  - [ ] When the user attaches a file that can't be opened, then it is not attached and they see "[name] couldn't be read."
  - [ ] When the user drops one allowed file and one that is not allowed, then the allowed file is attached and the message names only the refused one.

### 2.3. Seeing and removing attachments before sending

- **As a** user, **I want to** check what is attached before I send, **so that** I don't send the wrong thing.
- Attachments waiting to be sent are listed in a row under the message box. An image shows a small thumbnail; any other file shows a file icon, its name and its size.
- Each attachment has a remove button (×). Removing it does not ask for confirmation.
- Clicking an image thumbnail opens it at full size in a preview; Escape closes the preview.
- A message can be sent with attachments and no text.
- If the user leaves the message without sending and comes back to it in the same session, the text and the attachments are still there.
- Cancelling the new session screen clears its attachments along with its text.
- **Acceptance Criteria:**
  - [ ] When an image is attached, then a thumbnail of it is shown under the message box, and when a PDF is attached, then a file icon with its name and size is shown.
  - [ ] When the user clicks × on an attachment, then it leaves the row without a confirmation and the other attachments stay.
  - [ ] When the user clicks an image thumbnail, then the image opens at full size, and when they press Escape, then the preview closes and the message is unchanged.
  - [ ] Given a message has one attachment and no text, when the user looks at the Send button, then it is enabled, and when they send, then the message is sent.
  - [ ] Given a message has an attachment waiting, when the user opens another session and then returns, then the attachment is still listed under the message box.
  - [ ] Given the new session screen has an attachment waiting, when the user cancels it and opens it again, then no attachment is listed.
  - [ ] When the row of attachments has focus, then the user can move between attachments and remove one with the keyboard alone.

### 2.4. Sending, and attachments in the conversation

- **As a** user, **I want** attachments to stay with the message I sent, **so that** I can see later what the brain was shown.
- Sending a message sends its attachments with it. The message box and the attachment row are then empty.
- In the conversation, the user's message shows its attachments: images as thumbnails that open at full size, other files as a name and size.
- Attachments are kept with the session. After closing and reopening Arc, or resuming the session later, the message still shows them.
- The brain can use what it was shown in its answer, and can pass an attachment on to a worker when the work needs it.
- Arc takes its own copy of a file when it is attached. Changing or deleting the original afterwards, before or after sending, does not change what is sent, what the message shows or what the brain received.
- If Arc's copy of an attachment can't be read at the moment of sending, the message is not sent, and the user sees "[name] could no longer be read. Remove it or attach it again."
- A message with attachments is not sent when it is a command (it starts with "/"): "Attachments can't be sent with a command." The same applies while a plan is waiting for approval and the message would be taken as feedback on it: "Attachments can't be added to plan feedback." In both cases the text and the attachments stay in the message box.
- **Acceptance Criteria:**
  - [ ] Given a message with a screenshot attached, when the user sends it, then the message appears in the conversation with the screenshot's thumbnail, and the attachment row under the message box is empty.
  - [ ] Given a screenshot that shows the text "Error 4012", when the user sends it and asks what the error number is, then the brain's answer includes "4012".
  - [ ] Given a sent message with a text file attached, when the user asks the brain about a line in that file, then the brain's answer quotes it.
  - [ ] Given a sent message with a design image attached, when the brain starts a worker and passes the image on, then the worker's task lists the image and the worker's report describes what the image shows.
  - [ ] Given a sent message with attachments, when the user quits Arc, reopens it and opens that session, then the message still shows the same attachments and the image opens at full size.
  - [ ] Given a file was attached and sent, when the user deletes the original file in Finder and reopens the session, then the message still shows the attachment.
  - [ ] Given a file was attached but not yet sent, when the user deletes the original in Finder and clicks Send, then the message is sent and shows the attachment.
  - [ ] Given a message with an attachment waiting, when Arc's copy of it can't be read and the user clicks Send, then the message is not sent and they see "[name] could no longer be read. Remove it or attach it again."
  - [ ] Given a message that starts with "/" and has an attachment, when the user clicks Send, then the message is not sent, they see "Attachments can't be sent with a command.", and the text and attachment are still in the message box.
  - [ ] Given a plan is waiting for approval and the message has an attachment, when the user clicks Send, then the message is not sent, they see "Attachments can't be added to plan feedback.", and the text and attachment are still in the message box.

### 2.5. Brains that can't read an attachment

- **As a** user, **I want to** be told when the brain I chose can't read what I attached, **so that** I don't get an answer that ignores it.
- Arc works with Claude, Codex and Cursor brains, and they do not all read the same kinds of file. When the session's brain can't read an attachment of a certain kind, Arc says so when it is added: "[brain name] can't read [kind]. It will be sent as a file the brain may not be able to open." and the user can still send.
- **Acceptance Criteria:**
  - [ ] Given a session whose brain can't read images, when the user attaches an image, then they see a warning that names the brain and says it can't read images.
  - [ ] Given a session whose brain can read images, when the user attaches an image, then no warning is shown.

---

## 3. Scope and Boundaries

### In-Scope

- Attaching images, PDFs and text files to the first message of a session and to later messages to the brain.
- Paste, drag and drop, and the Attach button.
- The attachment row, thumbnails, full-size image preview and removing attachments before sending.
- Limits and refusal messages.
- Attachments shown on sent messages and kept with the session.
- The brain passing an attachment on to a worker.
- A warning when the session's brain can't read an attachment.

### Out-of-Scope

- Attachments when stepping in on a worker and messaging it directly.
- Attachments in answers to the brain's questions, plan feedback, or permission prompts.
- Adding an attachment to the group's knowledge from the conversation.
- Editing or annotating an image inside Arc before sending.
- Taking a screenshot from inside Arc.
- Audio, video, archives and folders.
- The brain or workers sending images or files back to the user in the conversation.
- Removing an attachment from a message after it was sent.
- Deleting attachments automatically after a period of time. Attachments are kept until their session is deleted. Flagged as a follow-up.

---

## Change Log

- 2026-11-12 — technical design (`technical-considerations.md`) — Files are copied when attached, so deleting the original before sending no longer blocks the send. Added the "couldn't be read" refusal, the refusals for commands and plan feedback, and clearing attachments when the new session screen is cancelled.
