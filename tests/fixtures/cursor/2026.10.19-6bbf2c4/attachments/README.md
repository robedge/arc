# Spec 012 spike S3: Cursor, image block and a text file outside the cwd

One real ACP turn, recorded 2026-11-12 on `agent` 2026.10.19-6bbf2c4 (Free tier, model Auto = `default[]`),
approved once for spec 012 slice 1. Files:

- `s3-image-and-path-turn.jsonl`: every JSON-RPC line sent (`c2s`) and received (`s2c`), with `t` in ms.
  The image bytes are replaced by `<base64 omitted, 6132 bytes>`. Email, home path, user name and the scratch
  path (`/tmp/arc-s3`) are scrubbed; session ids are kept. The command list in `available_commands_update` is
  trimmed to three entries (it lists the user's own skills).
- `cli-version.txt`: `agent --version`.

Setup (a throwaway driver, not in the repo): `initialize` with `clientCapabilities: {}`, `authenticate
cursor_login`, `session/new {cwd: <empty folder>, mcpServers: []}` (no Arc bridge), `session/set_mode ask` (the
brain's mode), `session/set_model default[]`, then ONE `session/prompt` with three blocks: a text block asking
two questions, the Layer 1 `[Attachments for this message]` list (same text block), and
`{type:'image', data, mimeType:'image/png'}`. The PNG (480x160) shows "Error 4012"; `notes.log` holds
"retry budget is 9" and lives in a folder next to, not inside, the cwd. The turn ended `end_turn` in about 14 s.

## Findings

1. **`promptCapabilities` as advertised:** `{"audio":false,"embeddedContext":false,"image":true}`. The full
   `agentCapabilities` is `loadSession: true`, `mcpCapabilities {http, sse}`, `sessionCapabilities {list}`.
   So an `image` block is allowed; `embeddedContext` is false, so a `resource` block (and with it any
   embedded PDF or file contents) is not.
2. **Image seen: yes.** The final answer was "(1) **4012**". The model's thought chunk before any file read
   says "The image shows error 4012". Cursor does not keep the block inline: it writes the image to its own
   store (`~/.cursor/projects/<slug>/assets/<uuid>.png`) and the model reads it with its `Read` tool
   (`tool_call` kind `read`, status `completed`, no permission request). That folder was not on disk when
   checked after the process exited. The model then also read the path from the Layer 1 list.
3. **Absolute path outside the cwd: readable, no permission request.** `tool_call` "Read
   /tmp/arc-s3/attachments/notes.log" (kind `read`, `locations` carries the path) went `pending`,
   `in_progress`, `completed` with `rawOutput {"content":"retry budget is 9\n"}`, with no
   `session/request_permission` and no denial, in `ask` mode with the sandbox off. The answer was "(2) **9**".
   It also read `/tmp/arc-s3/attachments/error.png` by path (`completed`, no `rawOutput`).
4. **Image echoed back with bytes: no.** No `session/update` carries `data` or base64 (the only `image`
   block in the file is the one Arc sent, which the recorder shortened). The path it echoes is the
   `Read .../assets/<uuid>.png` title and `rawInput.path`, which is a path, not bytes. The server never
   replays the user's blocks. Logs of the Arc side must still strip the image from the outgoing prompt.
5. **Recommendation for tech spec 2.8 and 2.9:**
   - Cursor image block: **yes**, send it when `promptCapabilities.image` is true. Keep the Layer 1 text
     block with the path as well; the model used both. Parse `promptCapabilities` from the `initialize`
     reply, as the table already says.
   - Reading in place: **yes**. Cursor's `Read` opened a text file at an absolute path outside the cwd with no
     prompt, so the session attachments folder can stay outside the worktree and the copy-into-cwd fallback is
     not needed for Cursor. This was observed in `ask` mode, the brain's. A worker in `agent` mode uses the
     same read tool, but that was not run. Arc's deny file only denies `Write(...)`, so it does not block reads.
   - PDFs: keep **no** for Cursor. `embeddedContext` is false and no PDF was tried, so the warning should show.
     Only an image block and plain text paths are proven.
   - Side effect worth a line in the spec: sending an image block makes Cursor write a copy under
     `~/.cursor/projects/<slug>/assets/`; Arc does not control that.
