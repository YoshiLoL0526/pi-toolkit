# Changelog

## 1.2.0 - 2026-11-11

Adds `lively`: the TUI shows the present, not just the result.

- New extension `extensions/lively.ts` with no tool and no transcript entries. While the agent works, one line above the editor follows the real assistant stream (`thinking`, `responding`, `preparing tools`, `waiting for the model`) and then the concrete action (`⠹ editing src/schema.ts · 3s`). It turns into `? waiting for you` when a prompt blocks the run and summarizes parallel tools as `+N`.
- While that line is visible, Pi's built-in working text and spinner are emptied, so the same state is not repeated in three places. `/lively off` or `activity: false` restores Pi's working row.
- When the run settles, the line becomes `✓ Done in 14s · 4 tools` (or `✗ Failed after …` / `■ Stopped after …`) and stays for `celebrateMs` before clearing.
- The footer is replaced by an animated one that keeps the native information: cwd/branch/session, input/output/cache tokens, cache hit rate, cost, context window with the `(auto)` marker, model and thinking level, plus statuses set by other extensions. It adds the pulse and run clock without repeating the state word.
- `lively` settings in `pi-toolkit.json`: `enabled`, `footer`, `activity`, `celebrate`, `celebrateMs` (0-15000) and `spinner` (`braille`, `dots`, `pulse`). They are read on session and turn boundaries; a malformed file is reported once and disables the extension.
- `/lively [on|off|status]` toggles every lively surface for the session and reports whether the switches come from the file or the session.
- The activity state machine is pure and the animation timer stops on settle and shutdown. Token totals are cached per invalidation, never scanned on every frame, and nothing is installed outside `tui` mode.
- 6 new smoke checks (42-47) cover the state machine, stream phases, target extraction, footer width, settings clamping, event wiring and the non-TUI guard.

Nothing to do on upgrade. To keep the native footer, set `"lively": { "footer": false }` in `~/.pi/agent/pi-toolkit.json`; to turn the whole feature off, use `/lively off` or `"lively": { "enabled": false }`.

## 1.1.0 - 2026-11-11

Adds `notify`: the agent tells your terminal when it needs you.

- New extension `extensions/notify.ts` with no tool. It announces **done** (only after a run settles, so retries and compactions do not notify twice), **error** (with the provider message) and **waiting** (a prompt blocked a running agent). An aborted run and a dialog you opened yourself are never announced.
- Channels: Windows toast, Kitty `OSC 99`, `OSC 9`, `OSC 777`, `bell` and `off`. `auto` detects from `KITTY_WINDOW_ID`, `TERM_PROGRAM`, `WT_SESSION` and the platform; inside tmux every sequence is wrapped in a DCS passthrough.
- Escape payloads are sanitized (control characters, semicolons in `OSC 777`) and truncated. The Windows toast passes title and body through environment variables instead of interpolating them into PowerShell.
- Nothing is written outside `tui` mode: in `rpc`, `json` and `print` an escape sequence would corrupt the protocol or the answer.
- `notify` settings in `pi-toolkit.json`: `enabled`, `channel`, `minDurationMs` (default 20s) and `events`. A malformed file is reported once per session instead of on every event.
- `/notify` command (`on`, `off`, `test`, `status`) to toggle for the session and to check which channel your terminal actually resolves to.
- `ask_user` announces its question on the shared event bus, so the waiting notification can name it. Both extensions work alone; without `ask_user` the text is generic.
- 11 new smoke checks (31-41) for the detection matrix, payload encoding, tmux wrapping, toast safety, settings clamping, thresholds, abort/error handling, the idle guard, the command and the non-TUI guard.

Nothing to do on upgrade unless you want notifications off by default: add `"notify": { "enabled": false }` to `~/.pi/agent/pi-toolkit.json`.

## 1.0.0 - 2026-11-11

First public release, distributed as a pack of extensions.

- One package, one version, one changelog: every feature is a file under `extensions/`, discovered through the `./extensions/*.ts` glob. `ask_user` lives in `extensions/ask.ts`.
- Extensions can be filtered per install (`"extensions": ["extensions/ask.ts"]` in settings, or `pi config`), so the pack is not all-or-nothing.
- `ask_user` tool registered through `pi.registerTool`, built on `ctx.ui.custom()`.
- Options list with an inline editor for free-form answers; open questions start in the editor.
- Multi-select (`allowMultiple`) with `space` toggling, free text alongside the checked set, and a guard against empty submissions.
- Batches (`questions`) for 2-4 independent decisions: tab navigation, automatic advance to the next unanswered question, review page, and skipped answers.
- In-place filtering with `/`, matching label and description while preserving original option numbers and the checked set.
- Optional `timeout` (1000-600000 ms) with a live countdown and a distinct timeout message.
- Dialog fallback for RPC mode (select/input, a toggle loop for multi-select, one deadline for the whole call) and a plain-text message for `print`/`json` modes.
- Cancellation via `esc` or the abort signal, with instructions that keep the model from re-asking the same question.
- Stable `details` for transcript rendering and resumed sessions; v1 single details still render.
- Prompt integration via `promptSnippet` and `promptGuidelines`.
- Optional `~/.pi/agent/pi-toolkit.json` with `timeout` and `filterThreshold` defaults.
- Packaged `ask-user` skill: when to ask versus decide, the decision handshake, option and batch rules.
- 30-check smoke test that loads the extension with jiti and drives the UI with raw key sequences.
