# Claude skip-approvals spike K5 (spec 015, Slice 4)

Run once on 2026-11-15 with Claude Code 2.1.325, model `haiku` (resolved to `claude-haiku-5-5`), on the logged-in subscription.
`scripts/spike-015-claude.mjs --confirm-real-run` (no dry run was made, to keep to one run).

Two processes in one throwaway directory, the same cwd (`<TMP>/work`) and `--add-dir <TMP>/other`, stream-json on stdin, argv as
`buildClaudeArgs` builds it for a worker minus the MCP bridge, hooks file and permission prompt tool (`k5-process*.jsonl` line 1 is
the argv):

1. `k5-process1-create.jsonl`: `--session-id <id> --permission-mode acceptEdits --allowedTools Read Grep Glob --disallowedTools
Edit(/<TMP>/other/**) Write(/<TMP>/other/**) NotebookEdit(/<TMP>/other/**)`; one tiny turn ("Reply with the single word: ok").
   Result `success`, text `ok`. This is the "just-created session".
2. `k5-process2-resume.jsonl`: `--resume <id>` with the same flags and **no** `--disallowedTools`. The prompt asked for `Read` of
   `<other>/notes.txt` (content `status: old`) then the `Edit` tool (not Bash, not Write) to change `old` to `new`.

`k5-summary.json`: the compact verdict. Result of process 2: `Read` ok, then `Edit` on `<TMP>/other/notes.txt` with
`is_error: false`, "The file ... has been updated successfully."; `permission_denials: []`; `permissionMode: acceptEdits`;
`additional_directories: ["<TMP>/other"]`; the session id was the resumed one; the file read `status: new` afterwards.

Scrubbing: scratch path `<TMP>`, scratch project slug `<SCRATCH-SLUG>`, home `/Users/<user>`, session id `<SESSION>`; the init event's
skills, plugins, agents, slash commands and MCP server lists are replaced by counts, and its `messaging_socket_path`, `apiKeySource`
are redacted. Two streamed `partial_json` fragments of the temp path stay split (`/private/var` and `private/var/folders/m`).
Claude Code keeps its own transcript of both turns under `~/.claude/projects/` for the scratch folder; the script wrote nothing there.
