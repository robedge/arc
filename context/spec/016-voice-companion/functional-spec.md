# Functional Specification: Voice Companion

- **Topic:** Nova, a companion panel with an animated face that lets the user talk to a session's brain out loud and hear its answers spoken back, so a back-and-forth conversation feels like talking to someone rather than typing into a chat.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today the only way to talk to the brain is to type in the session chat and read the answer. That works at the desk with hands on the keyboard. It is slow for quick back-and-forth questions ("what's left on this task?", "why did the API worker stop?", "summarise what changed"), and it does not work at all when the user steps back from the keyboard, is reading code on another screen, or wants to think out loud.

Arc's look is already built around the feeling of a capable assistant on a heads-up display. This spec gives that assistant a face and a voice, under the name **Nova**. A panel shows Nova's portrait (a photorealistic face with dark armour plating and cyan accent lights, supplied by the user). The user speaks, Nova listens, thinks, and answers out loud. While Nova talks, the face animates so it looks like it is speaking. While the brain is working on an answer, Nova looks like it is thinking.

Nova is the session's brain, not a separate assistant. What the user says goes to the same brain as typed messages, with the same group knowledge, workers and history. Spoken exchanges also appear in the session chat as text, so nothing said out loud is lost.

Voice must cost nothing extra. Listening and speaking use free, open-source tools that run on the user's Mac, with no extra account, subscription or paid service, in line with Arc's rule that all AI use runs through the user's existing subscriptions.

**Success looks like this:**

- The user can hold a spoken back-and-forth of at least five turns with the brain without touching the keyboard after starting it.
- Nova starts speaking within 2 seconds of the brain's answer arriving.
- The user reports that the panel feels like talking to someone: the face is visibly listening, thinking and speaking at the right moments.
- No new account, subscription, or paid service is needed to use it.

---

## 2. Functional Requirements (The "What")

### 2.1. Opening and closing Nova

- The user opens Nova from an open session. Nova talks to that session's brain.
- Nova appears as a collapsible panel docked on the right side of the session screen, next to the chat and workers. The rest of the session screen stays usable while it is open.
- While Nova is open, the chat keeps a comfortable width. When the window is too narrow for the chat, Nova and the Brain and workers column together, the Brain and workers column folds away until Nova is closed or the window is made wider.
- The panel shows Nova's portrait large and centred on Arc's dark background, the name "Nova", its current state ("Idle", "Listening", "Thinking", "Speaking"), and controls to start or end the conversation, mute Nova's voice, and close the panel.
- Switching to another session closes the panel and stops any speech.
  - **Acceptance Criteria:**
    - [x] Given a session is open, when the user clicks the Nova button in the session header, then the Nova panel opens on the right of the session screen showing the portrait, the name "Nova", and the state "Idle".
    - [x] Given the Nova panel is open, when the user types in the chat or opens a worker, then those parts of the session screen still work.
    - [x] Given the Nova panel is open, when the user clicks Close, then the panel closes, any speech stops, and the session screen returns to its normal layout.
    - [x] Given the Nova panel is open and the window is narrow, when there is not enough room for the chat, Nova and the Brain and workers column, then the chat stays at a comfortable width and the Brain and workers column is hidden until Nova is closed or the window is wider.
    - [x] Given no session is open, when the user looks for the Nova button, then it is not available.
    - [x] Given the Nova panel is open and Nova is speaking, when the user switches to a different session, then the panel closes and the speech stops.

### 2.2. Talking to Nova (hands-free conversation)

- The user clicks Start conversation once. From then on the conversation is hands-free: Nova listens, notices when the user has finished speaking (a short pause), sends what was said to the brain, answers out loud, then listens again, until the user clicks End conversation or closes the panel.
- What the user says is sent to the session's brain as a message, exactly as if they had typed it, and appears in the session chat marked as spoken.
- While the user speaks, the panel shows "Listening", a live indicator that moves with the user's voice, and the words as they are recognised. The live words appear in lowercase and are replaced by the final words, with capitals and punctuation, when the user stops speaking.
- While listening, a Cancel button discards what has been said so far without sending it, and ends the conversation, so the panel shows "Idle" until the user clicks Start conversation again. Recognised words can't be edited before sending.
- If the user says nothing for 10 seconds after Nova starts listening, Nova stops listening and returns to "Idle". The conversation can be resumed with Start conversation.
- A pause to think does not end the turn. When the words so far sound unfinished (for example they stop on "and", "because" or "um"), Nova waits about 3 seconds before answering; when they sound like a finished sentence, it waits about 1 second. If the user starts talking again within that wait, the words join the same message. Settings > Voice has "Pause before Nova answers" (Short, Normal, Long), which lengthens or shortens both waits.
- Speech recognition happens on the user's Mac and needs no extra account or paid service.
  - **Acceptance Criteria:**
    - [x] Given Nova is idle, when the user clicks Start conversation and says "What are the workers doing right now?", then the panel shows "Listening" and the recognised words appear in the panel as they are spoken.
    - [x] Given the user is speaking, when they pause for a moment at the end of their sentence, then the recognised words appear in the session chat as a message from the user marked as spoken, and the panel shows "Thinking".
    - [x] Given the user is speaking, when they stop mid-sentence after "I want to" and carry on talking within 3 seconds, then nothing is sent until they finish, and the whole sentence arrives as one spoken message.
    - [x] Given the user changes "Pause before Nova answers" to Long, when they finish a sentence and pause, then Nova waits longer before sending than with Normal.
    - [x] Given Nova has finished speaking an answer, when the user starts talking again without clicking anything, then Nova is listening and the next turn is sent.
    - [x] Given Nova is listening, when the user says nothing for 10 seconds, then the panel returns to "Idle" and no message is sent.
    - [x] Given Nova is listening and words have been recognised, when the user clicks Cancel, then nothing is sent to the brain, the conversation ends, and the panel shows "Idle".
    - [x] Given Nova is listening and the user is speaking, when the words appear in the panel, then they are shown in lowercase, and when the user stops speaking they are replaced by the final words.
    - [x] Given a conversation is running, when the user clicks End conversation, then Nova stops listening and speaking and the panel shows "Idle".

### 2.3. Nova answering out loud

- When the brain answers, Nova speaks the answer in a natural-sounding voice and the full answer appears in the session chat as usual.
- Nova speaks a short spoken version of the answer: a few sentences, skipping code, file contents, tables and diffs. When something was left out, Nova ends with "The details are in the chat."
- By default, while the panel is open and not muted, Nova speaks every brain answer, including answers to messages the user typed. A setting lets the user choose "Only answers to spoken questions" instead.
- The user can interrupt Nova by starting to talk: Nova stops speaking and starts listening. Nova's own voice coming out of the speakers does not count as the user interrupting.
- Settings let the user choose Nova's voice from a few voices and set the speaking speed. A Preview button plays a sample sentence.
- Speech is generated on the user's Mac with a free, open-source voice and needs no extra account or paid service.
  - **Acceptance Criteria:**
    - [x] Given the user asked a question by voice, when the brain's answer arrives, then within 2 seconds the panel shows "Speaking", Nova speaks the answer, and the full answer appears in the session chat.
    - [x] Given the brain's answer contains a code block, when Nova speaks it, then Nova does not read the code aloud and ends with "The details are in the chat."
    - [x] Given Nova is speaking, when the user clicks Stop, then speech stops within half a second and the panel shows "Listening" if a conversation is running, or "Idle" otherwise.
    - [x] Given Nova is speaking, when the user starts talking, then Nova stops speaking within half a second and the panel shows "Listening".
    - [x] Given Nova is speaking through the speakers with no one talking, when the answer plays to the end, then Nova does not stop itself early or send its own words as a message.
    - [x] Given Nova is speaking, when the user clicks Mute, then speech stops, later answers appear in the chat without being spoken, and the Mute control shows it is on until the user turns it off.
    - [x] Given the panel is open with the default setting, when the user types a message in the chat and the brain answers, then Nova speaks the answer.
    - [x] Given the setting is "Only answers to spoken questions", when the user types a message and the brain answers, then Nova does not speak it.
    - [x] Given the user is in Settings, when they pick a different voice and speed and click Preview, then a sample sentence plays in that voice at that speed, and Nova uses them from the next answer.

### 2.4. The face: listening, thinking and speaking

- The portrait animates to match what Nova is doing, so the user can tell its state at a glance:
  - **Idle:** the face is still apart from occasional blinking and very slight movement, so it looks alive but calm.
  - **Listening:** the cyan ring on the side of the head and the cyan lines on the face and neck brighten and pulse with the user's voice.
  - **Thinking:** the eyes glance away as if considering, and the cyan ring turns slowly, for as long as the brain is working.
  - **Speaking:** the mouth and jaw move with the sound of Nova's speech, opening more on louder sounds and closing in pauses, and the cyan lights pulse with it. Matching mouth shapes to each word is not required.
- The face moves naturally enough that it does not look like a flat picture with a moving cut-out mouth: the mouth movement blends into the face, and there is small, natural head movement.
- When the user's Mac is set to reduce motion, the face stays still and states are shown by the cyan lights and the state label only.
  - **Acceptance Criteria:**
    - [x] Given Nova is idle, when the user watches the panel for 10 seconds, then the face blinks at least once and otherwise stays calm.
    - [x] Given the user is speaking, when the user watches the panel, then the cyan lights brighten and pulse in time with their voice.
    - [x] Given the brain is working on an answer, when the user watches the panel, then the face shows the thinking animation until Nova starts speaking.
    - [x] Given Nova is speaking, when the user watches the panel, then the mouth moves while there is sound and closes during pauses and when speech ends.
    - [x] Given "Reduce motion" is on in macOS, when Nova listens, thinks or speaks, then the face does not move and the state label and cyan lights still change.

### 2.5. Alerts and when something goes wrong

- When a new item arrives in Needs attention while the panel is open and not muted, Nova says "I need your attention on something." once. If other items are already waiting in Needs attention, a new one does not repeat it; once Needs attention is empty again, the next new item is announced. The Needs attention badge works as usual. Approvals and questions are answered on screen, not by voice.
- If Arc does not have permission to use the microphone, the panel says so and shows how to allow it.
- If no microphone is found, the panel says so. The user can still type in the chat and hear answers spoken.
- If the speech could not be understood, Nova says so and listens again.
  - **Acceptance Criteria:**
    - [x] Given the Nova panel is open and not muted, when a worker asks for an approval, then Nova says "I need your attention on something." once and the Needs attention badge appears as usual.
    - [x] Given an item is already waiting in Needs attention, when more items arrive, then Nova does not say the line again, and the badge count goes up as usual.
    - [x] Given Nova is muted, when a new item arrives in Needs attention, then Nova says nothing and the badge appears as usual.
    - [x] Given Arc has been denied microphone access, when the user clicks Start conversation, then the panel shows "Arc can't hear you. Allow microphone access in System Settings > Privacy & Security > Microphone." with a button that opens that settings page.
    - [x] Given no microphone is connected, when the user clicks Start conversation, then the panel shows "No microphone found." and the panel stays open.
    - [x] Given the user mumbled or there was only background noise, when the turn ends, then nothing is sent to the brain and Nova says "Sorry, I didn't catch that." and listens again.
    - [x] Given the brain hits an error while answering, when the error appears in the chat, then Nova says "Something went wrong. The details are in the chat." and returns to listening if a conversation is running, or "Idle" otherwise.

### 2.6. Getting the voice files (first use)

- Nova needs voice files on the Mac (about 520 MB in total) before it can listen or speak. They are not part of Arc and are downloaded once, on first use.
- The first time the user opens Nova, or Settings > Voice, without the voice files, a "Download voice models (about 520 MB)" button is shown. Clicking it asks the user to confirm before anything is downloaded.
- While the download runs, the user sees its progress as a bar and a percentage. A download that was interrupted carries on from where it stopped when started again.
- If the download fails because the Mac is offline, the user sees "Couldn't download the voice models. Check your connection and try again." with a Retry button. If a downloaded file is damaged, the user sees "A voice model didn't download correctly. Try again."
- Typing in the chat and everything else in Arc keeps working while the voice files are missing or downloading.
- In Settings > Voice the user can see the state of the voice files and delete them with Delete voice models, after a confirmation. They can be downloaded again at any time.
  - **Acceptance Criteria:**
    - [x] Given the voice files are not on the Mac, when the user opens the Nova panel or Settings > Voice, then a "Download voice models (about 520 MB)" button is shown and nothing is downloaded yet.
    - [x] Given the "Download voice models" button is shown, when the user clicks it, then Arc asks the user to confirm and only starts downloading after they confirm.
    - [x] Given the user cancelled the confirmation, when the dialog closes, then nothing is downloaded and the button is still shown.
    - [x] Given a download is running, when the user watches the panel or Settings > Voice, then a progress bar with a percentage is shown until the download ends.
    - [x] Given a download is running, when the user types a message in the chat, then the message is sent as usual.
    - [x] Given the Mac is offline, when the download fails, then the user sees "Couldn't download the voice models. Check your connection and try again." with a Retry button.
    - [x] Given the download failed because the Mac is offline, when the user clicks Retry with the connection back, then the download starts again and carries on from where it stopped.
    - [x] Given a downloaded voice file is damaged, when the download ends, then the user sees "A voice model didn't download correctly. Try again."
    - [x] Given the voice files are on the Mac, when the user clicks Delete voice models in Settings > Voice and confirms, then the files are removed and the "Download voice models (about 520 MB)" button is shown again.

---

## 3. Scope and Boundaries

### In-Scope

- A Nova panel docked on the right of the session screen, talking to that session's brain.
- Hands-free conversation: speaking to the brain, with recognised words sent as a normal message and shown in the chat as spoken, and Cancel while listening.
- Hearing the brain's answers spoken back as a short spoken version, with Stop, Mute, and interrupting by talking.
- Speaking answers to typed messages by default, with a setting to speak only answers to spoken questions.
- A choice of voice and speaking speed in Settings, with Preview.
- An animated portrait, using the user's supplied image, showing idle, listening, thinking and speaking states, with a still version for "Reduce motion".
- Nova announcing new Needs attention items out loud.
- Speech recognition and speech output that run on the user's Mac using free, open-source tools, with no extra account or cost.
- Clear messages for missing microphone permission, no microphone, unclear speech and brain errors.
- A one-time download of the voice files (about 520 MB) on first use, with a confirmation, progress, a Retry after a failure and a way to delete the files in Settings.

### Out-of-Scope

- Answering approvals or questions in Needs attention by voice.
- Nova working without an open session, or talking to workers directly.
- A wake word ("Hey Nova") that listens all the time in the background.
- Changing Nova's portrait or creating new faces inside Arc.
- Word-by-word lip-sync.
- Voices from paid services or cloud speech providers.
- Languages other than English.

---

## Verification

Verified 2026-11-18 by /awos:verify. All 45 criteria are met.

- **On-screen criteria (2.1 to 2.6)** were checked in the real Electron app with fake CLIs, fake voice models, the fake speech engine, Chromium's fake microphone and muted audio, in an isolated data folder. The walkthrough passed 14 of 14 checks, the retakes passed, and the existing Nova and voice-model end-to-end specs passed 31 of 31. The full unit suite passed 5679 tests after the fixes below. The user confirmed the look from the screenshots in `docs/screenshots/016-voice-companion-*.png`, among them `panel-idle`, `listening-live-words`, `thinking`, `speaking`, `spoken-marker`, `narrow-window`, `pause-setting`, `muted`, `reduced-motion`, `attention-badge`, `attention-multiple`, `mic-denied`, `no-mic`, `didnt-catch`, `error-spoken`, `download-button`, `download-confirm-real`, `download-progress`, `download-offline`, `download-corrupt`, `delete-confirm`, `settings-voice` and `settings-voice-missing`.
- **Real audio** (Nova starting to speak within about 2 seconds with the real voice, not cutting herself off on the speakers, Preview in the chosen voice and speed, and the thinking-pause wait) rests on spikes N2 to N4 and the user's own use in the app, which the user confirmed works.
- **Fixed during verification:** a brain crash now adds "The brain stopped unexpectedly" (with a short reason) to the chat, so Nova's "The details are in the chat." is true; the download progress bar is hidden once a download fails; and Nova announces Needs attention only when it was empty before.

## Change Log

_Dated amendments made after the spec was first written._

- **2026-11-18**
  - Added section 2.6, getting the voice files on first use: a "Download voice models (about 520 MB)" button with a confirmation, progress while downloading, "Couldn't download the voice models. Check your connection and try again." with Retry when the Mac is offline, "A voice model didn't download correctly. Try again." for a damaged download, and Delete voice models in Settings. Why: the voice tools run on the Mac and need their files, and the spec did not say how they arrive. The size is about 520 MB, not the roughly 300 MB first expected, because the speech voice that sounds right is the larger version of the file.
  - Section 2.1: while Nova is open the chat keeps a comfortable width, and the Brain and workers column folds away on a narrow window. Why: with three panels side by side the chat became too narrow to read on small windows.
  - Section 2.2: the live words appear in lowercase and are replaced by the final words. Why: the live words come from a fast recogniser that does not add capitals or punctuation, and the final words come from a slower, more accurate one.
  - Section 2.2: Cancel also ends the conversation, so Nova returns to "Idle" and does not start listening again until the user clicks Start conversation. Why: Cancel means the user does not want Nova listening right now.
  - Section 2.3 and the scope list already describe the Settings > Voice choices (voice, speaking speed, Preview, and speaking every answer or only answers to spoken questions); no change was needed there.
  - Section 2.2: a pause to think no longer ends the turn. Nova waits about 3 seconds when the words so far sound unfinished and about 1 second when they sound finished, and Settings > Voice gains "Pause before Nova answers" (Short, Normal, Long). Why: the user found a single short pause cut them off while they were thinking, but did not want Nova to wait without limit once they were done.
  - Section 2.5: Nova announces Needs attention only when it was empty before; more items arriving while some are still waiting are not announced again. Why: with several approvals arriving one after another, Nova repeated the line for each.
