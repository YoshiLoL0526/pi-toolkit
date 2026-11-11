# pi-ask

A Pi extension that registers an interactive `ask_user` tool, so the model can stop mid-task and ask you a question: pick from a list of options or write a free-form answer.

Built on Pi's `ctx.ui.custom()` TUI component model, with a dialog fallback for RPC mode and a clear message for non-interactive modes.

## Install

From this folder:

```bash
pi install ./
```

Or try it for one run:

```bash
pi -e ./index.ts
```

Once published, `pi install npm:pi-ask`.

## Tool

Name: `ask_user`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `question` | `string` | required | One concrete, self-contained sentence |
| `context` | `string?` | — | Supporting evidence or the trade-off, shown above the question |
| `options` | `{ label, description? }[]?` | `[]` | 2-5 concrete choices. Omit for an open-ended question |
| `allowFreeform` | `boolean?` | `true` | Adds a "Type something." row next to the options |

Result content is explicit so small models do not have to infer anything:

```
User selected: 2. SQLite
User wrote: use duckdb
```

A cancelled prompt returns `User dismissed the question without answering...` plus an instruction not to re-ask the same question, which is what keeps the model from looping.

## Interaction

| Key | Action |
|---|---|
| `↑` / `↓`, `tab` / `shift+tab` | Move through the options |
| `1`-`9` | Select an option directly (or open the editor for the free-form row) |
| `enter` | Select the highlighted option, or submit the written answer |
| `esc` | Cancel; inside the editor it goes back to the options |

When the question has no options, the editor opens immediately and `esc` cancels.

While the prompt is open, the extension reports `blocked: { kind: "question" }` so terminals that support program status show Pi as waiting for input.

## Modes

| Mode | Behavior |
|---|---|
| `tui` | Custom component (list + inline editor) |
| `rpc` | `ctx.ui.select()` / `ctx.ui.input()` dialogs; free text degrades to one extra dialog |
| `print` / `json` | No UI: the tool returns a message telling the model to ask in plain text and end its turn |

Aborting the agent turn (`esc`) or the tool call dismisses the prompt and returns a cancellation; it never hangs.

## Prompt integration

The extension ships a `promptSnippet` (one line in the tools section) and `promptGuidelines` that spell out when to use `ask_user` and, more importantly, when not to:

- decisions that change what gets built and cannot be answered from the repository,
- ambiguous or contradictory requirements,
- not for confirming obvious steps or asking for information the model can find itself,
- not for repeating something already answered.

## Design notes

- The schema is a flat object with `allowFreeform`, not a union: some provider proxies strip `anyOf`.
- `executionMode: "sequential"` because two overlapping prompts would fight for input focus.
- `details` is stable and persisted, so the transcript renders correctly when a session is resumed:

```ts
interface AskDetails {
  question: string;
  context?: string;
  options: { label: string; description?: string }[];
  allowFreeform: boolean;
  response:
    | { kind: "selection"; labels: string[]; indexes: number[] }
    | { kind: "freeform"; text: string }
    | null;
  cancelled: boolean;
}
```

`labels`/`indexes` are arrays so multi-select can be added later without breaking stored results.

## Development

```bash
npm install --min-release-age=0   # peer packages pinned for typechecking
npm run check                     # tsc --noEmit + smoke test
node test/smoke.mjs               # loads the extension with jiti and drives the UI with raw keys
```

The smoke test covers option selection, digit quick-pick, free-form, cancellation, open questions, headless mode, the RPC fallback and abort handling, without a model or a terminal.

Real end-to-end check in a non-interactive shell:

```bash
pi -e ./index.ts --no-builtin-tools --model opencode-go/claude-haiku-5-5 \
  -p "Call ask_user once with question 'Which color do you prefer?' and options Red and Blue."
```

## Known limitations

- Single question per call and single select; batches and multi-select are the next step.
- `pi-ask-user` is already taken on npm by a different, much larger implementation. `pi-ask` is the placeholder package name; the tool name `ask_user` is independent of it.
