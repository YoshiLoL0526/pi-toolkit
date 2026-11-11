# Changelog

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
