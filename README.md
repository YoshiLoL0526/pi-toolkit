# pi-toolkit

[![npm](https://img.shields.io/npm/v/pi-toolkit.svg)](https://www.npmjs.com/package/pi-toolkit)
[![CI](https://github.com/YoshiLoL0526/pi-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/YoshiLoL0526/pi-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-toolkit.svg)](LICENSE)

A pack of Pi extensions distributed as one package. Every feature is a separate file under `extensions/`, so the whole pack installs with one command and each extension can still be filtered out by whoever does not want it.

## Extensions

| Extension | Tool | What it does |
|---|---|---|
| [`extensions/ask.ts`](extensions/ask.ts) | `ask_user` | Stops mid-task to ask you a question: pick from a list of options, select several, or write a free-form answer. Several independent questions can be asked together with tabs and a review page |

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

## Configuration

Optional defaults live in `~/.pi/agent/pi-toolkit.json`, or `<agent-dir>/pi-toolkit.json` when `PI_CODING_AGENT_DIR` is set. The file is read on every tool call, so edits apply without restarting Pi.

```json
{
  "timeout": 120000,
  "filterThreshold": 8
}
```

| Key | Default | Description |
|---|---|---|
| `timeout` | — | Fallback timeout (1000-600000 ms) when the tool call does not set one. A per-call `timeout` wins |
| `filterThreshold` | `6` | Option count at which the `/ to filter` hint appears (2-20) |

Values outside the range are clamped; unknown keys and wrong types are ignored. A file that exists but is not valid JSON fails the tool call with its path, so a typo is visible instead of silently ignored.

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

The smoke test covers option selection, digit quick-pick, free-form, multi-select, filtering, batches with review and skip, cancellation, timeouts, settings-file defaults and errors, the packaged skill, open questions, headless mode, the RPC fallback and abort handling, without a model or a terminal. It points `PI_CODING_AGENT_DIR` at a temp directory so your real settings never leak into the run.

Real end-to-end check in a non-interactive shell:

```bash
pi -e ./extensions/ask.ts --no-builtin-tools --model opencode-go/claude-haiku-5-5 \
  -p "Call ask_user once with question 'Which color do you prefer?' and options Red and Blue."
```

## Known limitations

- RPC multi-select is functional but clunky (a select loop) because RPC has no custom component support.
