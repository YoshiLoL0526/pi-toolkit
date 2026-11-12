# pi-toolkit

[![npm](https://img.shields.io/npm/v/pi-toolkit.svg)](https://www.npmjs.com/package/pi-toolkit)
[![CI](https://github.com/YoshiLoL0526/pi-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/YoshiLoL0526/pi-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-toolkit.svg)](LICENSE)

A pack of Pi extensions distributed as one package. Every feature is a separate file under `extensions/`, so the whole pack installs with one command and each extension can still be filtered out by whoever does not want it.

## Extensions

| Extension | Tool | What it does |
|---|---|---|
| [`extensions/ask.ts`](extensions/ask.ts) | `ask_user` | Stops mid-task to ask you a question: pick from a list of options, select several, or write a free-form answer. Several independent questions can be asked together with tabs and a review page |
| [`extensions/notify.ts`](extensions/notify.ts) | — | Tells you when the agent finished, failed, or is blocked on your answer, using your terminal's own notification protocol, without touching the transcript |
| [`extensions/lively.ts`](extensions/lively.ts) | — | Gives the TUI a pulse: a live activity line while the agent works, a closing line when it stops, and a footer that animates instead of sitting still |

### Load only some extensions

Omit an extension from the package in settings (personal or project), or toggle it off with `pi config`:

```json
{
  "packages": [
    { "source": "npm:pi-toolkit", "extensions": ["extensions/ask.ts"] }
  ]
}
```

## Install

```bash
pi install npm:pi-toolkit
```

Or try it for one run without installing:

```bash
pi -e npm:pi-toolkit
```

From a local checkout, `pi install ./` loads every extension, while `pi -e ./extensions/ask.ts` loads just one.

## `ask_user`

The first extension in the pack registers an interactive `ask_user` tool, so the model can stop mid-task and ask you a question. Built on Pi's `ctx.ui.custom()` TUI component model, with a dialog fallback for RPC mode and a clear message for non-interactive modes.

Name: `ask_user`.

### Single question

| Parameter | Type | Default | Description |
|---|---|---|---|
| `question` | `string` | required | One concrete, self-contained sentence. Becomes the heading when `questions` is also set |
| `context` | `string?` | — | Supporting evidence or the trade-off, shown above the question |
| `options` | `{ label, description? }[]?` | `[]` | 2-5 concrete choices. Omit for an open-ended question |
| `allowMultiple` | `boolean?` | `false` | Let the user pick several options |
| `allowFreeform` | `boolean?` | `true` | Adds a "Type something." row next to the options |
| `timeout` | `number?` | — | Auto-dismiss after N ms (1000-600000) without an answer; reported as a timeout |

### Batch of questions

| Parameter | Type | Default | Description |
|---|---|---|---|
| `questions` | `{ label?, question, context?, options?, allowMultiple?, allowFreeform? }[]?` | — | 2-4 independent questions. Each entry takes its own fields; top-level ones do not apply |
| `question` | `string?` | — | Batch heading shown above the tabs |

Use a batch only for decisions that do not depend on each other. Each question gets a page; a review page submits them all.

Result content is explicit so small models do not have to infer anything:

```
User selected: 2. SQLite
User selected: 1. Auth, 3. Search
User wrote: use duckdb
User selected: 1. Auth
User also wrote: ci
```

For batches:

```
DB. Which database should the service use?
Answer: User selected: 1. Postgres

Target. Where should it deploy?
Answer: skipped
```

A cancelled prompt returns `User dismissed the question without answering...` plus an instruction not to re-ask the same question, which is what keeps the model from looping.

## Interaction

| Key | Action |
|---|---|
| `↑` / `↓` | Move through the options |
| `1`-`9` | Single-select: pick directly. Multi-select: toggle. Free-form row: open the editor |
| `space` | Multi-select: toggle the highlighted option |
| `enter` | Select, submit the checked set, or submit the written answer |
| `tab` / `shift+tab`, `←` / `→` | Batch: switch question tabs (including review) |
| `/` | Filter the option list by label and description; `enter` applies, `esc` clears |
| `1`-`6` (review page) | Jump back to that question |
| `esc` | Cancel; inside the editor it goes back to the list; with an active filter it clears the filter first |

When a question has no options, the editor opens immediately and `esc` cancels. In a batch, the next unanswered question is opened automatically, and the review page warns once before submitting with skipped questions.

Filtering keeps the original option numbers, so `User selected: 3. SQLite` always refers to the full list; the hint mentions `/` once a question has six or more options. A `timeout` shows a live countdown and returns a timeout (not a cancel) when it expires.

While the prompt is open, the extension reports `blocked: { kind: "question" }` so terminals that support program status show Pi as waiting for input.

## Modes

| Mode | Behavior |
|---|---|
| `tui` | Custom component: list, inline editor, tabs and review page |
| `rpc` | `ctx.ui.select()` / `ctx.ui.input()` dialogs. Multi-select becomes a toggle loop ending in "Done"; a batch is asked sequentially with no review page. `timeout` is one deadline for the whole call, passed to each dialog as its remaining time |
| `print` / `json` | No UI: the tool returns a message telling the model to ask in plain text and end its turn |

Aborting the agent turn (`esc`) or the tool call dismisses the prompt and returns a cancellation; it never hangs. Cancelling any question in an RPC batch cancels the whole batch.

## `notify`

No tool, no transcript entries: this extension only listens and tells your terminal when your attention is needed. It exists because the interesting moment of a long agent run is the one where you left the window.

| Notification | When |
|---|---|
| Done | The full run settled: no more retries, compactions or queued follow-ups. Suppressed for runs shorter than `minDurationMs` |
| Error | The run settled after the last model request failed, with the provider message |
| Waiting | A prompt blocked a running agent. `ask_user` adds the question text; any extension dialog counts |

An aborted run (`esc`) is never announced: you were there. A dialog you open yourself while the agent is idle (model picker, settings) is not announced either.

### Channels

| Channel | Protocol | Used for |
|---|---|---|
| `toast` | Windows toast via `powershell.exe` | Any Windows terminal |
| `osc99` | Kitty's `OSC 99` | Kitty |
| `osc9` | `OSC 9 ; message` | iTerm2, Apple Terminal, Windows Terminal (WSL) |
| `osc777` | `OSC 777 ; notify ; title ; body` | WezTerm, Ghostty, and the safe fallback |
| `bell` | `BEL` | Terminals with no notification support |
| `off` | — | Disable |

`auto` (the default) picks from the environment: `KITTY_WINDOW_ID`, `TERM_PROGRAM`, `WT_SESSION`, and the platform. Inside tmux every sequence is wrapped in a DCS passthrough, because tmux drops raw escape codes. A `channel` in settings overrides the guess for terminals that lie about their environment.

Text is sanitized before it reaches a control sequence: control characters are replaced, `OSC 777` fields lose their semicolons, and everything is truncated. The Windows toast never interpolates model output into PowerShell — title and body travel through environment variables and are rendered as DOM text nodes, so a body containing `$(…)` is inert text.

Notifications are written only in `tui` mode. `rpc`, `json` and `print` get nothing: an escape sequence would corrupt the JSON stream or the printed answer.

### Command

| Command | Action |
|---|---|
| `/notify` or `/notify status` | Show state, resolved channel, enabled events and the duration threshold |
| `/notify on` / `/notify off` | Toggle for the rest of the session, without touching the settings file |
| `/notify test` | Send one notification through the resolved channel, ignoring the switch and the threshold |

## `lively`

No tool and no transcript entries: one line above the editor and an animated footer, so a long run does not look frozen.

| Surface | Where | What it shows |
|---|---|---|
| Activity line | One row above the editor, only during a run | `⠹ thinking`, `⠹ responding`, `⠹ preparing tools` or `⠹ waiting for the model`, then the concrete action: `⠹ editing src/schema.ts · 3s`; `? waiting for you` while a prompt is open; `+N` when parallel tools overlap |
| Closing line | The same row, for `celebrateMs` after the run | `✓ Done in 14s · 4 tools`, `✗ Failed after 6s` or `■ Stopped after 3s`, then cleared |
| Footer | Replaces the built-in footer | Animated glyph and run clock, `cwd (branch) • session`, tokens/cache hit rate/cost/context, model and thinking level, plus any `setStatus` text from other extensions. It does not repeat the state word |

The timer only runs while the agent works; an idle session redraws nothing. The label follows the real assistant stream: `thinking` only while a thinking block arrives, `responding` for text, `preparing tools` for tool-call deltas, `waiting for the model` before the first delta. Tool names then become verbs (`reading`, `editing`, `running`, `searching`, `fetching`, `waiting for you`) and the target is taken from the call arguments.

While the activity line is visible, `lively` empties Pi's built-in working text and spinner so the same state is not shown twice. `/lively off` or `lively.activity: false` restores Pi's working row; the footer still shows only the pulse, clock and tool count, so exactly one place names the state.

### Command

| Command | Action |
|---|---|
| `/lively` or `/lively status` | Show the effective switches and whether they come from the file or the session |
| `/lively on` / `/lively off` | Toggle every lively surface for the rest of the session |

Settings are read on session and turn boundaries, so editing the file applies without restarting Pi.

## Configuration

Optional defaults live in `~/.pi/agent/pi-toolkit.json`, or `<agent-dir>/pi-toolkit.json` when `PI_CODING_AGENT_DIR` is set. The file is read on every tool call, on every notification, and on lively's session and turn boundaries, so edits apply without restarting Pi.

```json
{
  "timeout": 120000,
  "filterThreshold": 8,
  "notify": {
    "enabled": true,
    "channel": "auto",
    "minDurationMs": 20000,
    "events": ["done", "input", "error"]
  },
  "lively": {
    "enabled": true,
    "footer": true,
    "activity": true,
    "celebrate": true,
    "celebrateMs": 4000,
    "spinner": "braille"
  }
}
```

| Key | Default | Description |
|---|---|---|
| `timeout` | — | Fallback timeout (1000-600000 ms) when the tool call does not set one. A per-call `timeout` wins |
| `filterThreshold` | `6` | Option count at which the `/ to filter` hint appears (2-20) |
| `notify.enabled` | `true` | Master switch for notifications |
| `notify.channel` | `auto` | `auto`, `osc9`, `osc99`, `osc777`, `toast`, `bell` or `off` |
| `notify.minDurationMs` | `20000` | Runs shorter than this only notify for `input` and `error` (0-3600000). `/notify test` ignores it |
| `notify.events` | `["done", "input", "error"]` | Which notifications to send. An unknown name is dropped; an all-invalid list falls back to every event |
| `lively.enabled` | `true` | Master switch for the activity line, the closing line and the footer |
| `lively.footer` | `true` | Replace the built-in footer with the animated telemetry footer |
| `lively.activity` | `true` | Show the live activity line above the editor during a run |
| `lively.celebrate` | `true` | Keep the closing line visible for `celebrateMs` instead of clearing it immediately |
| `lively.celebrateMs` | `4000` | Closing-line duration (0-15000 ms); `0` clears immediately |
| `lively.spinner` | `braille` | `braille`, `dots` or `pulse` |

Values outside the range are clamped; unknown keys and wrong types are ignored. A file that exists but is not valid JSON fails the tool call with its path, so a typo is visible instead of silently ignored. The notify and lively extensions report the same error once per session and stay quiet.

## Skill

The package ships `skills/ask-user/SKILL.md`, registered through `pi.skills`. It is a decision-gate skill: when to ask versus decide, the decision handshake, how to write options, and when batches are valid. It complements the tool's `promptGuidelines` with the reasoning that would otherwise bloat every system prompt.

Skills are only advertised when Pi has a tool to read them, so running with `--no-builtin-tools` hides the skill (and the model may still call `ask_user` from the tool schema alone).

## Prompt integration

The extension ships a `promptSnippet` (one line in the tools section) and `promptGuidelines` that spell out when to use `ask_user` and, more importantly, when not to:

- decisions that change what gets built and cannot be answered from the repository,
- ambiguous or contradictory requirements,
- batches only for independent decisions whose prerequisites are settled,
- multi-select only when several answers are valid together,
- not for confirming obvious steps, asking for information the model can find itself, or repeating something already answered.

## Design notes

- The schema is a flat object with `allowFreeform` / `allowMultiple` / `questions`, not a union: some provider proxies strip `anyOf`.
- `executionMode: "sequential"` because two overlapping prompts would fight for input focus.
- Filtering and multi-select both index by original option position, so checking options, changing the filter and switching tabs never rewrites an answer.
- The timeout timer and the abort listener are detached on every exit path, including cancel, timeout, submit and component disposal.
- `details` is stable and persisted, so the transcript renders correctly when a session is resumed. v1 single details (without `kind`) still render.
- The activity state machine is pure and lives in `src/lively/state.ts`; the extension only wires events and owns one timer. Token totals are cached per invalidation, never scanned on every animated frame.
- Every lively surface is guarded by `ctx.mode === "tui"`; the timer stops on settle and shutdown, so an idle session has no background redraw.

```ts
type AskDetails =
  | {
      kind: "single";
      question: string;
      context?: string;
      options: { label: string; description?: string }[];
      allowMultiple: boolean;
      allowFreeform: boolean;
      response:
        | { kind: "selection"; labels: string[]; indexes: number[]; text?: string }
        | { kind: "freeform"; text: string }
        | null;
      cancelled: boolean;
    }
  | {
      kind: "batch";
      heading?: string;
      questions: { label: string; question: string; context?: string; options: …[]; allowMultiple: boolean; allowFreeform: boolean }[];
      answers: (AskResponse | null)[];
      cancelled: boolean;
    };
```

`labels`/`indexes` are arrays in single-select too, so both modes share one response shape.

## Development

```bash
npm install --min-release-age=0   # peer packages pinned for typechecking
npm run check                     # tsc --noEmit + smoke test
node test/smoke.mjs               # loads the extension with jiti and drives the UI with raw keys
```

Adding an extension: create `extensions/<name>.ts` with a default `export default function (pi: ExtensionAPI)`, give its tools globally unique names, and put feature-specific logic in `src/<name>/`, importing the shared `src/ui`, `src/config.ts` and `src/format.ts`. The `pi.extensions` glob picks it up with no manifest change. Keep heavy dependencies behind `await import()` inside `execute` so the pack stays cheap to load.

Project conventions, invariants and the testing contract live in [`AGENTS.md`](AGENTS.md).

The smoke test covers option selection, digit quick-pick, free-form, multi-select, filtering, batches with review and skip, cancellation, timeouts, settings-file defaults and errors, the packaged skill, open questions, headless mode, the RPC fallback and abort handling, plus notification channel detection, payload sanitization, tmux passthrough, toast injection safety, settings clamping and the non-TUI guard, and the lively state machine, target extraction, footer width, settings clamping and event wiring, without a model or a terminal. It points `PI_CODING_AGENT_DIR` at a temp directory so your real settings never leak into the run.

Real end-to-end check in a non-interactive shell:

```bash
pi -e ./extensions/ask.ts --no-builtin-tools --model opencode-go/claude-haiku-5-5 \
  -p "Call ask_user once with question 'Which color do you prefer?' and options Red and Blue."
```

## Known limitations

- RPC multi-select is functional but clunky (a select loop) because RPC has no custom component support.
- Notifications are `tui`-only. In `--mode rpc` the client owns its notification UX, and writing escape codes there would corrupt the protocol.
- Windows toasts need Windows PowerShell 5.1 (`pwsh` has no WinRT projection) and are best effort: a system that blocks the app id fails silently by design. `/notify test` is the way to find out.
- Detection is a guess from environment variables. A terminal we do not recognise gets `OSC 777`, which unsupported terminals ignore; set `notify.channel` if yours needs something else.
- The lively footer reproduces the native footer's information but not the `(sub)` subscription cost marker, the experimental-feature marker, or the virtual-model routing arrow. `/lively off` restores the native footer when you need those.
- A custom footer is a single slot: if another extension also installs one, the last one to run wins. Set `lively.footer` to `false` to leave another footer alone.
- While `activity` is on, `lively` empties Pi's built-in working message and spinner so there is one state signal. Another extension that customizes that row will be overridden until `lively` is off or `activity` is disabled.
- The activity line is one row and does not scroll: long targets are truncated in place, and parallel tools are summarized as `+N` rather than listed.
