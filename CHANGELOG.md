# Changelog

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
