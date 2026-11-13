# Functional Specification: Session Branches on Demand

- **Topic:** A repository gets its session branch only when a worker first needs to work in it, instead of every repository in the group getting one when the session starts.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today, starting a session creates a session branch (for example "arc/fix-order-sync") in every repository of the group and switches the user's own copy of each repository to it. A group with nine repositories gets nine new branches and nine switched folders, even when the session only asks a question or changes one repository.

This costs the user in three ways:

- **Switched folders:** repositories the session never touches are moved off the branch the user was working on.
- **Needless questions:** the user is asked what to do with unsaved changes in repositories the session will never change.
- **Clutter:** every session leaves a branch behind in every repository, most of them with nothing on them.

This spec makes the session branch appear only where work happens. Starting a session changes nothing in any repository. A repository gets its session branch the first time a worker is about to work in it. Repositories the session never works in stay exactly as they were.

**Success looks like this:**

- Starting a session in a group with nine repositories, and asking only a question, leaves all nine repositories on the branch they were on, with no new branch in any of them.
- A session that changes one repository creates one session branch, in that repository only.
- The user is asked about unsaved changes only for a repository a worker is about to work in.

---

## 2. Functional Requirements (The "What")

### 2.1. Starting a session leaves the repositories alone

- **As a** user, **I want** starting a session to leave my repositories as they are, **so that** a session I only talk to doesn't move my folders or leave branches behind.
- Starting a session creates no session branch and switches no repository. The user's own copy of every repository stays on the branch it was on.
- Starting a session never asks about unsaved changes.
- The session still gets its name from the brain as before, and that name still decides what its session branch will be called (for example "arc/fix-order-sync") when one is needed.
- The brain can read every repository of the group from the start, as today.
- **Acceptance Criteria:**
  - [x] Given a group with three repositories on the branches "main", "develop" and "dev", when the user starts a session and sends a message, then the brain answers and each repository is still on the same branch, with no branch starting with "arc/" added to any of them.
  - [x] Given a repository in the group has unsaved changes, when the user starts a session, then the session starts with no dialog about unsaved changes and the changes are still in place.
  - [x] Given a new session, when the user asks the brain a question about code in one of the repositories, then the brain answers from that repository's files and no session branch is created.

### 2.2. A repository gets its session branch when a worker first needs it

- **As a** user, **I want** the session branch to appear in a repository when work starts there, **so that** I get the same combined view of the work as today, only where it matters.
- The first time a worker is about to start in a repository, Arc creates the session branch there and switches the user's own copy of that repository to it. The branch starts from "dev", or from the repository's main branch if it has no "dev" branch, as today.
- All repositories of one session use the same branch name. The one exception: if that name has been taken in a repository by the time a worker first starts there, that repository gets the name with a number added (for example "arc/fix-order-sync-2"), and the event log says so.
- A worker that works in several repositories gives each of them its session branch before it starts. If any of them has unsaved changes, none of them gets a branch until the user has answered.
- Once a repository has its session branch, everything else works as today: later workers there start from the session branch, finished work is merged into it, and it shows in Review changes.
- The event log records when a repository gets its session branch, for example "Created arc/fix-order-sync in api (from dev)".
- In Plan-first mode, approving a plan does not create branches by itself. Each repository gets its branch when the first worker for it starts.
- **Acceptance Criteria:**
  - [x] Given a session in a group with the repositories api, web and infra, when the brain starts a worker in api, then api is on "arc/<session name>" and web and infra are still on the branches they were on, with no "arc/" branch.
  - [x] Given api already has its session branch, when the brain later starts a worker in web, then web gets a session branch with the same name and infra is still untouched.
  - [x] Given a session with no session branches yet, when the brain starts one worker that works in both api and web, then both repositories get the session branch before the worker shows Working.
  - [x] Given a repository has no "dev" branch, when a worker first starts there, then its session branch starts from the repository's main branch.
  - [x] Given api gets its session branch, when the user opens the event log, then it shows "Created arc/<session name> in api (from dev)".
  - [x] Given a plan with a worker in api is waiting for approval, when the user approves it, then api gets its session branch when that worker starts, and repositories not in the plan get none.

### 2.3. Unsaved changes are asked about when the repository is needed

- **As a** user, **I want to** be asked about unsaved changes only in a repository that is about to be worked in, **so that** I'm not asked about repositories that don't matter to this session.
- When a worker is about to start in a repository that has unsaved changes and no session branch yet, Arc asks the user what to do before the worker starts. The question names the repository and lists the changed files, as today's dialog does.
- The question appears as a card in Needs attention, not as a dialog, so it does not interrupt what the user is doing. It is kept when Arc is closed and shows again when the session is reopened.
- The choices are:
  - **Set aside:** put the changes away, so they can be brought back later.
  - **Commit them first:** save them as a commit on the current branch.
  - **Bring them along:** keep them on the session branch.
  - **Don't start:** the worker is not started and the repository is left as it is, with no session branch. The worker's card shows Failed with the reason "Not started: you chose to leave web as it is". The brain is told, so it can tell the user or change its approach. If a later worker needs the same repository and it still has unsaved changes, the question is asked again.
- If Bring them along doesn't work because the changes clash with the branch the session branch starts from, the card says so and offers the other three choices again.
- The worker waits until the user answers. Other workers in other repositories are not held up.
- Arc never throws the user's changes away.
- A repository that is clean gets its session branch with no question.
- **Acceptance Criteria:**
  - [x] Given web has unsaved changes and no session branch, when the brain starts a worker in web, then the user is asked what to do with the changes in web, and the worker does not start until they answer.
  - [x] Given that question is waiting, when the brain starts another worker in api, which is clean, then the api worker starts without waiting.
  - [x] Given that question is waiting, when the user chooses Set aside, then web is switched to the session branch, the worker starts, and the changes can be brought back later.
  - [x] Given that question is waiting, when the user chooses Bring them along, then web is switched to the session branch with the changes still in place, and the worker starts.
  - [x] Given that question is waiting, when the user quits and reopens Arc and opens the session, then the question is still waiting.
  - [x] Given that question is waiting, when the user chooses Don't start, then the worker's card shows Failed with "Not started: you chose to leave web as it is", web stays on its branch with the changes in place and no "arc/" branch, and the brain tells the user the worker in web was not started.
  - [x] Given that question is waiting, when the user looks at the session, then the question is a card in Needs attention that names web and lists its changed files, and no dialog covers the session.

### 2.4. The session header shows where work is happening

- **As a** user, **I want** the session header to show which repositories have a session branch, **so that** I can see at a glance where this session has worked.
- A repository with a session branch is shown as today: its name, the session branch and the branch it started from.
- Repositories with no session branch are not listed one by one. After the listed repositories the header shows a count, for example "8 more projects". Opening it lists their names.
- A new session, where no repository has a session branch yet, shows only the count, for example "9 projects".
- Projects that are not git repositories still show as "Read only", as today.
- The header updates as soon as a repository gets its session branch, without reopening the session.
- **Acceptance Criteria:**
  - [x] Given a session where only api has a session branch, when the user looks at the session header, then api shows "arc/<session name> ← dev".
  - [x] Given a session is open, when a worker starts in web for the first time, then web's session branch appears in the header without the user reopening the session.
  - [x] Given a group with nine repositories and a session where only api has a session branch, when the user looks at the session header, then it lists api and shows "8 more projects", and when they open that, then the other eight names are listed.
  - [x] Given a new session in a group with nine repositories, when the user looks at the session header before any worker has started, then it shows "9 projects" and no session branch.

### 2.5. Reopening, reviewing and deleting a session

- **As a** user, **I want** the rest of a session to follow the same rule, **so that** only repositories with work in them are ever switched or listed.
- Reopening a session switches back only the repositories that have a session branch, with the same check for unsaved changes as today. Other repositories are left alone.
- Review changes lists only repositories that have a session branch. A session with none shows no changes.
- Push branch offers only repositories that have a session branch.
- The brain's final summary lists only repositories that were changed.
- Deleting a session keeps its session branches, as today. The confirmation is unchanged.
- A project added to the group while a session is open no longer gets a session branch straight away. It joins the session, the brain is told it can read it and start workers in it, and it gets its branch when a worker first needs it.
- Sessions that were started before this change keep the branches they already have and keep working.
- **Acceptance Criteria:**
  - [x] Given a session where only api has a session branch, and the user has since moved api and web to other branches, when they reopen the session, then api is switched back to the session branch and web stays where it is.
  - [x] Given a session where only api has a session branch, when the user opens Review changes, then only api is listed.
  - [x] Given a session where no repository has a session branch, when the user opens Review changes, then it shows that there are no changes.
  - [x] Given an open session, when the user adds the infra repository to the group, then infra joins the session with no session branch and no dialog, and when the brain later starts a worker in infra, then infra gets the session branch.
  - [x] Given a session started before this change with a session branch in every repository, when the user reopens it, then it opens and works as before.

---

## 3. Scope and Boundaries

### In-Scope

- Starting a session without creating or switching to a session branch in any repository.
- Creating the session branch in a repository when a worker first starts there, and switching the user's copy of that repository to it.
- Asking about unsaved changes at that moment instead of at session start.
- The session header, reopening, Review changes, Push branch and the final summary following only the repositories that have a session branch.
- Projects added to an open session getting their branch on first use.

### Out-of-Scope

- How workers get their own working copies. Those are already created only when a worker starts, and only for the repositories it works in.
- Removing empty session branches left behind by sessions started before this change.
- Deleting session branches when a session is deleted.
- Changing which branch a session branch starts from.
- Leaving the user's own copy on its current branch once a repository has a session branch. The user's copy is still switched, as today.

---

## Change Log

- 2026-11-12 — technical design (`technical-considerations.md`) — A worker that is not started after "Don't start" shows as Failed with a reason, and the question is asked again if a later worker needs the same repository. A repository whose session branch name is already taken gets the name with a number added. A worker in several repositories creates no branch in any of them until every unsaved-changes question for it is answered.
- 2026-11-13 — verified — all 25 criteria. Evidence: a walk-through of the built app on temporary repositories with the fake brain (13 runs, all passed), the git state of each repository read before and after each step, and the screenshots `docs/screenshots/013-session-branches-on-demand-*.png` (look-and-feel confirmed by the user). The 2.1 run used repositories on "main", "develop" and "dev", and the 2.5 run added infra, as the criteria say. "Review changes shows that there are no changes" is met by the disabled "Review changes · 0" button with the tooltip "No changes yet", accepted by the user. "The brain tells the user" and "the brain answers from the repository's files" were shown with the fake brain; no real provider turn was run. The older-session criterion also rests on `tests/unit/sessions/older-sessions.test.ts` (2 passed).
