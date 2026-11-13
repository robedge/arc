# Codex attachments spike (spec 012, S2)

Recorded 2026-11-12 with ONE real model turn. Files here:

- `turn.jsonl`: every JSON-RPC line sent and received during the turn (scrubbed).
- `no-model-checks.jsonl`: a separate no-model session (`command/exec` under the read-only policy, then `thread/read` of the recorded thread).
- `schema-localImage.json`: the `UserInput` fragment of the generated schema.
- `cli-version.txt`: `codex-cli 0.163.0`.

Scrubbing: the scratch folder is `<SCRATCH>`, the home folder `<HOME>`; email, account, installation and server-name fields are replaced. The `mcpServer/startupStatus/updated` notifications were dropped because they list the user's own MCP servers. Thread and turn ids are kept.

## Version

The task named 0.162.1, the version Arc is pinned and recorded against (`CODEX_PROTOCOL_VERSION`, `tests/fixtures/codex/0.162.1/`). **0.162.1 is not available on this Mac.** Only `codex-cli 0.163.0` is installed (`@openai/codex@0.163.0`, global npm). Nothing was installed, so everything here is 0.163.0 and is stored under `0.163.0/`. The schema fragment is the one to diff against 0.162.1 when a 0.162.1 copy is at hand.

## Setup

A scratch `cwd/` (empty) and a sibling `attachments/` (outside the cwd) holding `error.png` (480x160 PNG showing "Error 4012") and `notes.log` (`retry budget is 9`). A throwaway driver spoke JSON-RPC over stdio to `codex app-server` with the user's real `CODEX_HOME` and no Arc bridge. `thread/start`: `cwd`, `model: gpt-6-luna` (the smallest tier in the account's `model/list`; all eight models list `inputModalities: ["text","image"]`), `modelProvider: openai`, `approvalPolicy: untrusted`, `approvalsReviewer: user`, `sandbox: read-only`. The server echoed `sandboxPolicy {"type":"readOnly","networkAccess":false}`. One `turn/start` (effort `low`) with input: a text item (two questions, then the Layer 1 block from tech spec 2.8) and `{"type":"localImage","path":"<SCRATCH>/attachments/error.png"}`.

## Findings

### 1. Is `localImage` in the schema, and its shape?

Yes, in 0.163.0, in both the stable and the `--experimental` schema (`v2/TurnStartParams.json`, `definitions.UserInput`):

```json
{
  "title": "LocalImageUserInput",
  "type": "object",
  "required": ["path", "type"],
  "properties": {
    "type": { "enum": ["localImage"] },
    "path": { "type": "string" },
    "detail": {
      "anyOf": [{ "$ref": "#/definitions/ImageDetail" }, { "type": "null" }],
      "default": null
    }
  }
}
```

There is also a remote variant, `ImageUserInput`: `{type: "image", detail?, and either url: string or fileId: string}`. The text variant is `{type: "text", text, text_elements: []}`. Other variants: `audio`, `localAudio`, `skill`, `mention`. No inline base64 field; `url` could carry a data URL but that was not tried. 0.162.1 was not available (see Version).

### 2. Did the model state 4012?

Yes. Final answer: `"1. Error 4012.\n2. Retry budget: 3 attempts."` The image was outside the cwd and was read by the model.

### 3. Could the read-only sandbox read `notes.log`? Did it get 9?

Not proven by the model turn, and the model did not get 9. It answered "3 attempts", which is wrong and was a guess: it ran no command and used no tool (the turn holds only `userMessage` and `agentMessage` items), and the server sent **no approval request and no denial** (`server requests:` was empty). So the model never tried to read the path it was given.

What the no-model check (`no-model-checks.jsonl`) shows: `command/exec` with `sandboxPolicy {"type":"readOnly","networkAccess":false}` and `cwd` = the empty folder:

- `cat <SCRATCH>/attachments/notes.log` returned exit 0, stdout `retry budget is 9\n`.
- `ls <SCRATCH>/attachments` returned exit 0.
- A write there (`echo x > .../w.txt`) failed with `Operation not permitted` (so the policy was really applied).

So the read-only sandbox allows reading a sibling folder outside the cwd; reads are not limited to the cwd. This is the sandbox policy, not a model-run tool call, so it is strong but indirect evidence. The one model turn was spent; whether the model will open a path from the Layer 1 block on its own with this wording is **open**. This run suggests a small model on `low` effort may answer without looking, so the brain prompt (spec 2.9, `BRAIN_PROMPT_VERSION` 8) should tell the brain to open listed files when a question depends on them.

### 4. How the user input is echoed, and what a resumed thread holds

`item/started` and `item/completed` for the `userMessage` item carry `content` as given: the text item and `{"type":"localImage","detail":null,"path":"<path>"}`. Path only, no bytes, no thumbnail. `thread/read` (includeTurns) returns the same two content items, and the thread `preview` is the text only. `thread/settings/updated` echoes `sandboxPolicy`, `approvalPolicy`, `approvalsReviewer`, `model`, `effort`. Token usage for the turn: 24,237 input tokens (8,064 cached), 20 output. A resumed thread therefore holds the path, not the image: if the file is deleted the old turn keeps a dangling path (the stored session folder lives as long as the session, so this is fine). `codex-parser.ts` lists `userMessage` among its non-tool items, so a `localImage` entry inside one should be skipped, but that was not tested here.

### 5. Recommendation for tech spec 2.8 and 2.9

- `localImage`: **yes** for Codex images. The model read the image outside the cwd from its path alone. Pass the stored absolute path, `detail` omitted. Keep the Layer 1 text block as well.
- Reading in place: **yes**, no copy into `codex-brain/<id>/` needed. The read-only policy lets a command read the attachments folder outside the cwd (no-model check), and the image path outside the cwd worked in the model turn. Keep the folder in the brain's launch as the spec says. Caveat: a model-run read of `notes.log` was not observed, so S2 does not prove an approval-free read through the model's own tool. Under `approvalPolicy: untrusted` a `cat` may ask the user for approval (Arc's classifier treats a read of an attachment path as read-only; check that in the Slice 2 e2e with the fake).
- PDFs: keep Codex PDF at **no**. There is no PDF input variant in the schema (only text, image, localImage, audio, localAudio, skill, mention), and no PDF reader was tried.
- Workers (2.9): the same reading-in-place assumption holds for `workspace-write`, which is wider than `read-only`; no fallback needed on this evidence.
