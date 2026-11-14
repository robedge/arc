# Real turns (spec 014, Slice 8)

Run on 2026-11-14, one run per provider, with `scripts/surface-turn.ts`. The prompt asked for a small release panel (heading, a 15-line `CodeBlock` limited to 5 lines, a `KeyValue` list of three entries with one list value, a radio `ChoicePicker` with three described options bound to a path, and a Button that requires the choice and sends it). It contained no Express syntax, so the tool description alone had to be enough. Cursor ran on Auto.

## Claude

| Check | Result |
| --- | --- |
| `show_surface` called | Yes (after one `ToolSearch` to load it) |
| First call accepted | Yes |
| Refusals | None |
| Attempts | 1 |
| Time | 7 s (turn 5.9 s) |
| `CodeBlock` with `maxLines` | Yes, `maxLines: 5` |
| `KeyValue`, one list value | Yes |
| `ChoicePicker` radio with option descriptions | Yes |
| Button with `requires` | Yes, `[/choice]` |
| `surfaceProblem` | null |

## Codex

| Check | Result |
| --- | --- |
| `show_surface` called | Yes |
| First call accepted | Yes |
| Refusals | None |
| Attempts | 1 |
| Time | 19 s |
| `CodeBlock` with `maxLines` | Yes, `maxLines: 5` |
| `KeyValue`, one list value | Yes |
| `ChoicePicker` radio with option descriptions | Yes |
| Button with `requires` | Yes, `[/release/choice]` |
| `surfaceProblem` | null |

## Cursor (Auto)

| Check | Result |
| --- | --- |
| `show_surface` called | Yes, 3 attempts, all rejected by Cursor before reaching the tool; Cursor also read the tool schema once (`getMcpToolsToolCall`) |
| First call accepted | No, not by the tool: Cursor print mode rejected the MCP call itself |
| Refusal text (all three attempts, verbatim) | `User rejected MCP: arc-show_surface` |
| Attempts | 3 (the model's own correction limit) |
| Time | 83 s (turn 79 s) |
| Surfaces accepted by the bridge | 0 |
| Express compiled offline with `compileExpress` | All three attempts accepted, `surfaceProblem` null |
| Contents of the Express | `CodeBlock(..., 5)`, `KeyValue` with a list value, radio `ChoicePicker` with descriptions, Button with `[$/choice]` as `requires` (attempt 1 and 2 had all of these; attempt 3 too) |

The rejection is the known Cursor print-mode limit (no approval path for MCP calls despite `--approve-mcps`), not a problem with the tool or the Express. The model's Express would have been accepted on the first call.

## Conclusion

The tool description alone was enough for all three providers: 3 of 3 wrote valid Express using the new parts on the first attempt, with no refusal text to learn from. No wording change is suggested.

Observation (not a tool problem): Claude, Codex and Cursor each initialised the radio's data path as `[]` (Claude and Codex's accepted `dataModel` holds `choice: []`), which suggests the radio value is a list for `mutuallyExclusive`. The renderer must treat an empty list as "no choice" for `requires`; this was already the case in the Slice 2 e2e.
