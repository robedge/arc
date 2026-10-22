# Functional Specification: Groups & Knowledge Sections

- **Topic:** Creating and managing groups of project folders, and the knowledge sections (Notes, Docs, Playbooks, Links, custom) attached to each group.
- **Status:** In Review
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today, an AI coding agent only sees the one folder it was started in. When a product is split across several repositories and depends on a database, the user has to re-explain how the pieces fit together and paste database structures into every conversation. That context is lost when the conversation ends.

Groups fix this. The user gathers related project folders into a named group and attaches lasting knowledge to it: notes on how the services talk to each other, schema-only database dumps, team playbooks, and useful links. Every session started on that group later gets all of this automatically. This feature covers building and maintaining groups and their knowledge. Using a group in a session is covered by a separate spec.

**Success looks like:**
- The user can set up a group with several projects and a database schema in under 5 minutes.
- The user never pastes a schema or a "how our services connect" explanation into a conversation by hand again.

---

## 2. Functional Requirements (The "What")

### 2.1. Creating, renaming, and deleting groups

- **As a** user, **I want to** create named groups, **so that** I can organize my projects by the product or system they belong to.
- A group needs a name of 1-60 characters. Group names must be unique (letter case ignored).
- All groups are listed in a sidebar, and selecting one opens it.
- A group can be renamed with the same name rules.
- Deleting a group asks for confirmation first. It never deletes, moves, or changes the user's project folders, and never deletes a knowledge folder the user linked. Knowledge stored in the app for that group is deleted along with the group, but the confirmation offers "Export knowledge first", which saves all of the group's knowledge to a folder the user picks before deleting.
  - **Acceptance Criteria:**
    - [ ] When the user clicks "New Group", enters "Storefront", and confirms, then "Storefront" appears in the sidebar and opens with its empty sections.
    - [ ] When the user tries to create a group with an empty name, then they see "Group name is required." and the group is not created.
    - [ ] Given a group named "Storefront" exists, when the user tries to create another group named "storefront", then they see "A group with this name already exists." and the group is not created.
    - [ ] When the user enters a name longer than 60 characters, then they see "Group name must be 60 characters or fewer."
    - [ ] Given a group named "Storefront", when the user renames it to "Shop" and confirms, then the sidebar shows "Shop" and the group's projects and knowledge are unchanged.
    - [ ] When the user chooses "Delete Group" on "Shop", then a confirmation appears saying the project folders will not be touched, and the group disappears from the sidebar only after the user confirms.
    - [ ] Given "Shop" stores its knowledge in the app, when the user chooses "Export knowledge first" in the delete confirmation and picks a folder, then that folder contains the group's notes, docs, playbooks, links, and custom sections as files, and the group is then deleted.
    - [ ] Given a deleted group had project folders, when the user checks those folders in Finder afterwards, then every file is still there unchanged.
    - [ ] When the user cancels the delete confirmation, then the group stays exactly as it was.

### 2.2. Adding and removing project folders

- **As a** user, **I want to** add several local project folders to a group, **so that** sessions on that group can work across all of them.
- The user adds projects through the standard macOS folder picker, which allows selecting more than one folder at once. Folders can also be dragged into the Projects section.
- Each project shows its folder name, full path, and whether it's a git repository.
- Folders that aren't git repositories can be added. They're labeled "Not a git repository — read-only in sessions", meaning agents can read them during sessions but won't change them.
- The same folder can't be added to the same group twice, but it can belong to more than one group (e.g. a shared library used by two products).
- If a project folder is later moved or deleted outside the app, the project is shown as "Folder not found" with options to locate it again or remove it.
- Removing a project from a group never changes the folder on disk.
  - **Acceptance Criteria:**
    - [ ] Given the user is viewing a group, when they click "Add Project", select three folders in the picker, and confirm, then all three appear in the Projects section with their name and path.
    - [ ] When the user drags a folder from Finder onto the Projects section, then it is added to the group.
    - [ ] When the user adds a folder that isn't a git repository, then it is added with a visible "Not a git repository — read-only in sessions" label.
    - [ ] Given a folder is already in the group, when the user adds it again, then they see "This folder is already in the group." and no duplicate appears.
    - [ ] Given a folder is in the "Storefront" group, when the user adds the same folder to the "Admin" group, then it is added to "Admin" and still appears in "Storefront".
    - [ ] When the user drags a file (not a folder) onto the Projects section, then they see "Only folders can be added as projects." and nothing is added.
    - [ ] Given a project's folder was moved in Finder, when the user opens the group, then that project shows "Folder not found" with "Locate…" and "Remove" options.
    - [ ] Given a project shows "Folder not found", when the user clicks "Locate…" and picks the folder's new location, then the project shows as available again.
    - [ ] When the user removes a project from the group, then it disappears from the list and the folder still exists on disk unchanged.

### 2.3. Built-in and custom knowledge sections

- **As a** user, **I want to** organize a group's knowledge into sections, **so that** I and the agent can find the right material quickly.
- Every group has five built-in sections: **Projects**, **Notes**, **Docs**, **Playbooks**, and **Links**. Built-in sections can't be renamed or deleted.
- The user can add custom sections with a name of 1-40 characters, unique within the group, and can rename and delete them.
- Deleting a custom section that contains items asks for confirmation and states how many items will be removed.
  - **Acceptance Criteria:**
    - [ ] When the user opens a newly created group, then they see the Projects, Notes, Docs, Playbooks, and Links sections, all empty.
    - [ ] When the user opens the options for a built-in section, then there are no rename or delete options.
    - [ ] When the user clicks "Add Section", enters "Runbooks", and confirms, then a "Runbooks" section appears after the built-in sections.
    - [ ] Given the group has a "Runbooks" section, when the user tries to add another section named "runbooks", then they see "A section with this name already exists in this group."
    - [ ] When the user tries to add a custom section named "Docs", then they see "A section with this name already exists in this group."
    - [ ] Given "Runbooks" contains 3 items, when the user chooses to delete it, then a confirmation says "Delete 'Runbooks' and its 3 items?", and the section is removed only after confirming.

### 2.4. Writing and editing notes and playbooks

- **As a** user, **I want to** write notes and playbooks inside the app, **so that** I can record how my system works without leaving the app.
- In Notes, Playbooks, or a custom section, the user can create an item with a title (1-100 characters) and a body written in Markdown, with a preview.
- Each item can have an optional one-line description (up to 200 characters) explaining what it's for. The agent sees this description when deciding what to read.
- Changes save automatically while the user types, and a "Saved" indicator confirms it.
- The user can rename, edit, and delete items. Deleting asks for confirmation.
  - **Acceptance Criteria:**
    - [ ] Given the user is in the Notes section, when they click "New Note", enter the title "Service map", and type a body, then the note appears in the Notes list and "Saved" is shown within 2 seconds of the user stopping typing.
    - [ ] When the user switches the editor to preview, then headings, lists, and code blocks are displayed formatted.
    - [ ] When the user tries to save an item with an empty title, then they see "Title is required."
    - [ ] When the user adds the description "How web, api and infra talk to each other", then the description appears under the title in the list.
    - [ ] Given the user edited a note, when they quit the app and reopen it, then the note shows the latest text.
    - [ ] When the user deletes a note and confirms, then it disappears from the list.

### 2.5. Adding documents such as schemas

- **As a** user, **I want to** add reference files like database schema dumps and API specs to Docs, **so that** the agent knows my table structures and interfaces without access to real data.
- The user can import files into Docs (or a custom section) with a file picker or by dragging them in. Several files can be imported at once.
- Imported files are copied into the group's knowledge. The original file is left where it was.
- Accepted file types:
  - **Text files** (Markdown, plain text, SQL, JSON, YAML, CSV, GraphQL, Protocol Buffer) - can be viewed and edited in the app.
  - **PDFs and images** (PNG, JPG, GIF, WebP, SVG) - can be viewed in the app but not edited.
- Each file can be at most 20 MB.
- Any imported file can have a description.
- If a file with the same name already exists in that section, the user chooses whether to replace it, keep both (the new one gets a numbered name), or cancel.
  - **Acceptance Criteria:**
    - [ ] Given the user is in Docs, when they drag "orders_schema.sql" into the section, then it appears in the Docs list and its contents can be viewed in the app.
    - [ ] Given a file was imported, when the user checks its original location in Finder, then the original is still there unchanged.
    - [ ] When the user imports a file larger than 20 MB, then they see "'big_dump.sql' is larger than 20 MB and was not added." and the file is not added.
    - [ ] When the user imports "api-spec.pdf" and an architecture diagram "services.png", then both appear in Docs, and opening each shows the PDF pages or the image, with no edit option.
    - [ ] When the user imports an unsupported file such as a ".exe", then they see "'setup.exe' isn't a supported file type." and it is not added.
    - [ ] Given the user imports five files, of which one is too large, when the import finishes, then the four valid files are added and one message names the file that was skipped.
    - [ ] Given "orders_schema.sql" already exists in Docs, when the user imports another file with that name, then they are asked to "Replace", "Keep Both", or "Cancel", and "Keep Both" adds "orders_schema (2).sql".

### 2.6. Links

- **As a** user, **I want to** save links to wikis and external docs, **so that** the agent can look them up when they're relevant.
- In the Links section, the user adds a link with a web address (required, starting with http:// or https://), a title (optional; the address is used if blank), and an optional description.
- The user can edit and delete links, and clicking a link's address opens it in the default browser.
  - **Acceptance Criteria:**
    - [ ] When the user adds a link with the address "https://wiki.example.com/orders" and the title "Orders wiki", then it appears in the Links list with that title.
    - [ ] When the user adds a link without a title, then the address is shown as the title.
    - [ ] When the user enters "wiki.example.com" without http:// or https://, then they see "Enter a full web address starting with http:// or https://."
    - [ ] When the user clicks a saved link's address, then it opens in their default browser.

### 2.7. Where a group's knowledge is stored

- **As a** user, **I want to** choose whether a group's knowledge lives in the app or in a folder I pick, **so that** I can keep it in version control or share it between machines if I want.
- By default, a new group's knowledge is stored in the app's own folder, and the user doesn't need to do anything.
- In a group's settings, the user can link the group's knowledge to a folder they choose. Each section appears as a subfolder there, with every note, doc, playbook, and link stored as a normal file the user can open in any editor.
- If the group already has knowledge when the user links a folder, they choose one of two options:
  - **Move existing knowledge here** - the group's knowledge is moved into the folder and merged with anything already there. A file whose name already exists in the same section is kept alongside the existing one with a numbered name, so nothing is overwritten.
  - **Use the folder's contents only** - the group shows only what's in the folder. The previous in-app knowledge is kept aside and offered back when the folder is unlinked.
- The user can unlink a folder, which copies its current knowledge back into app storage and leaves the folder itself untouched. If earlier in-app knowledge was kept aside, the user can choose to restore that instead.
- Changes made to files in a linked folder outside the app (e.g. in an editor or after a git pull) show up in the app within 5 seconds, without restarting.
- A "Show in Finder" option opens the group's knowledge location.
- If a linked folder becomes unavailable, the group shows "Knowledge folder not found" with options to locate it again or switch back to app storage.
  - **Acceptance Criteria:**
    - [ ] When the user creates a new group, then its settings show knowledge storage as "Stored in app".
    - [ ] Given a group stored in the app with 2 notes, when the user links a folder and chooses "Move existing knowledge here", then the folder contains a Notes subfolder with 2 files, and the app shows the same 2 notes.
    - [ ] Given a group in the app has a note "Service map" and the chosen folder's Notes subfolder already has "Service map.md", when the user links the folder and chooses "Move existing knowledge here", then the app shows both "Service map" and "Service map (2)", and neither has lost any text.
    - [ ] Given a group in the app has 2 notes and the chosen folder has 5 different notes, when the user links the folder and chooses "Use the folder's contents only", then the app shows only the folder's 5 notes.
    - [ ] Given a group with a linked folder, when the user edits a note's file in another editor and saves it, then the app shows the new text within 5 seconds.
    - [ ] Given a group with a linked folder, when the user adds a new Markdown file to its Docs subfolder in Finder, then the file appears in the app's Docs section within 5 seconds.
    - [ ] When the user clicks "Show in Finder" for a group's knowledge, then Finder opens at that location.
    - [ ] Given a group with a linked folder, when the user chooses "Unlink folder" and confirms, then settings show "Stored in app", the same items are still visible, and the folder still exists with its files.
    - [ ] Given a group's linked folder was renamed outside the app, when the user opens the group, then they see "Knowledge folder not found" with "Locate…" and "Use app storage" options.

---

## 3. Scope and Boundaries

### In-Scope

- Creating, renaming, deleting, and browsing groups.
- Adding, removing, and re-locating project folders in a group.
- Built-in sections (Projects, Notes, Docs, Playbooks, Links) and custom sections.
- Writing and editing Markdown notes and playbooks in the app.
- Importing reference files such as schema dumps (editable text), PDFs, and images (view only).
- Saving and opening links.
- Optional one-line descriptions on knowledge items.
- Choosing app storage or a linked folder for a group's knowledge, including picking up outside edits.

### Out-of-Scope

- Starting sessions on a group, and how the agent uses the group's projects and knowledge (separate spec: Group chat session).
- The brain suggesting new or updated notes at the end of a session (covered with sessions).
- Session branches, worktrees, and any git actions on project folders (separate spec).
- Fetching or previewing link contents inside the app.
- Connecting to live databases or extracting schemas automatically.

---

## Change Log

- 2026-10-18 — user report from real use — Large linked knowledge folders (more than 5,000 files or nested deeper than two levels) keep showing changes made outside Arc: instead of turning live updates off, Arc re-checks them every few seconds, so new or edited files appear within 10 seconds without switching away from Arc.
- 2026-10-19 — bug fixes after linking a repository folder — items in subfolders of a section (up to six levels deep) are listed, grouped under collapsible folder headers; dependency and build folders such as node_modules and out are never turned into sections; restoring earlier in-app knowledge on unlink also restores its section list.
