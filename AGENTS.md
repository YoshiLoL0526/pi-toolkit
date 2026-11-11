# AGENTS.md

Instructions for agents working in `pi-toolkit`. Read this before changing code.

## What this repo is

A **pack of Pi extensions shipped as one npm package**. One version, one CHANGELOG,
one peer-dependency set. Every feature is a separate extension file under `extensions/`,
so a new feature never creates a new repo or a new package — but a user can still load
just the parts they want (`pi config`, or a `"extensions": [...]` filter in settings).

The first and so far only extension is `ask_user`, which blocks the turn so the model
can ask the user a question (single, multi-select, batch, free-form).

## Layout

```
extensions/ask.ts   extension entrypoint: registers the tool, wires modes, no UI logic
src/schema.ts       typebox params + normalizeParams(): validation, defaults, hard caps
src/types.ts        shared shapes (AskRequest / AskOutcome / AskDetails)
src/config.ts       settings file (<agent-dir>/pi-toolkit.json) and per-call defaults
src/format.ts       model-facing result text and persisted details
src/render.ts       transcript rendering of call args and stored details
src/prompt.ts       promptSnippet + promptGuidelines
src/ui/question.ts  TUI custom component (the real UI)
src/ui/fallback.ts  RPC dialog fallback (select/input loops)
skills/ask-user/    shipped decision-gate skill
test/smoke.mjs      the contract: 30 checks driving the extension without a model
```

Data flows one way: `schema` → `AskRequest` → (`ui/question` | `ui/fallback`) → `AskOutcome`
→ `format`/`render`. Nothing downstream re-validates; nothing upstream renders.

## Adding an extension

1. Create `extensions/<name>.ts` with `export default function (pi: ExtensionAPI) { … }`.
   The `pi.extensions` glob `./extensions/*.ts` picks it up — do not edit the manifest.
2. Put feature logic in `src/<name>/`; reuse `src/types.ts`, `src/format.ts` and `src/ui/`
   instead of copying them. If a helper is shared by two features, move it up to `src/`.
3. Tool names are global across packages: pick one that cannot collide (`ask_user`,
   not `ask`). A second tool file that registers `ask_user` breaks both extensions.
4. Load heavy dependencies with `await import()` inside `execute`, never at module top
   level, so installing the pack stays cheap.
5. Add the extension to the table in `README.md` and a `CHANGELOG.md` entry.
6. Add smoke checks (see Testing), and assert the manifest contract if the new extension
   changes `package.json` (`pi.extensions`, `files`).
7. New top-level directories must be added to `files` in `package.json` or they are not
   published.

Each extension stays independent: it may assume Pi's host packages, nothing else.

## Hard constraints (do not "fix" these)

- **Flat tool schema, no `anyOf`.** Some provider proxies strip or reject unions, so an
  open question and a batch are expressed by omitting fields. Keep it flat.
- **`details` is persisted** in the session and replayed when a session is resumed.
  Renderers must stay defensive about older shapes: v1 details have no `kind`, fields may
  be missing. Never remove or repurpose a stored field; add optional ones.
- **Every exit path terminates.** `tui`, `rpc`, `print` and `json` modes plus cancel,
  timeout and abort all have to resolve. Timers and abort listeners are detached on
  every path — a prompt that hangs blocks the whole agent turn.
- **No UI in headless modes.** `ctx.hasUI === false` returns `HEADLESS_TEXT` immediately.
- **One prompt at a time.** The tool is `executionMode: "sequential"` because two prompts
  would fight for input focus.
- **Indexes refer to the original option list.** Filtering and multi-select index by
  original position, so `User selected: 3. SQLite` always matches the full list. Never
  renumber after filtering, and never let a filter rewrite the checked set.
- **Model-facing text is explicit.** `User selected: 2. SQLite` / `User wrote: …`, never a
  bare value. Cancellation, timeout and headless messages also tell the model **not** to
  re-ask the same question, which is what stops the loop.
- **Host packages are `peerDependencies` with `"*"`**, never `dependencies`: Pi supplies
  `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and `typebox`.
  A bundled copy breaks module identity (duplicate classes/registries).
- **No runtime dependencies** unless there is no way around it. The package currently has
  zero; the smoke test is plain `node`.
- **Settings are read on every call** (edits apply without a restart), clamped to their
  range, and a malformed file fails the call with its path instead of being ignored.

## Conventions

- Tabs in TS, 2 spaces in JSON/Markdown/YAML, LF endings, final newline (`.editorconfig`).
- Double quotes, semicolons, `type`-only imports (`import type`), relative imports with
  the `.js` extension (NodeNext). Single file = single responsibility; the codebase
  prefers small exported functions over classes.
- TypeScript is `strict` with `noUncheckedIndexedAccess`: `questions[0]!` is a deliberate
  assertion at a point already proven by a length check.
- Build optional fields with conditional spread: `...(context ? { context } : {})`. Do not
  emit `undefined` keys into details or JSON.
- Error prefixes: `ask_user:` for input that cannot produce a usable question (Pi reports
  it as a failed tool call), `pi-toolkit:` for package/config problems.
- Comments explain *why* an invariant exists ("anyOf is stripped by some proxies"), not
  what the line does. JSDoc on every exported symbol and on each tricky invariant.
- Doc comments and code are English; talk to the user in Spanish if they write Spanish.
- Caps are intentional: `MAX_OPTIONS = 8` / `MAX_QUESTIONS = 6` are hard limits, while the
  descriptions advise 2-5 options and 2-4 questions. Changing one means changing the
  other, plus the tests.

## Testing

`npm run check` = `tsc --noEmit` + `node test/smoke.mjs`. It must be green before any
commit; CI runs exactly this.

The smoke test is the specification, not a smoke alarm. It loads the extension with
`jiti`, captures the registered tool and drives the component with raw key sequences —
no model, no terminal, no network, and `PI_CODING_AGENT_DIR` points at a temp directory
so a developer's real settings never leak in.

Rules for adding checks:

- One numbered block per behavior, with a comment stating the invariant it proves.
- `runTui(params, drive)` for the custom component, `runDialogs(params, ui)` for RPC,
  `tool.execute(...)` directly for headless and error cases.
- Assert user-visible outcomes (rendered text, result content, `details`), not internals.
- Cover the sad paths: cancel, timeout, abort, invalid input, malformed settings.

## Docs, versioning, releases

- `README.md` documents behavior a user can observe: parameters, keys, modes, config,
  install. Update the extensions table and the parameter tables when adding a feature.
- `CHANGELOG.md` gets one entry per released version (`## x.y.z - YYYY-MM-DD`), written
  for users: what changed and what they must do. The version in `package.json` and the
  newest changelog heading must match, or Pi does not show the update.
- Publishing is manual (`npm publish` from `main`, tag `vX.Y.Z`). Do not add publish steps
  to CI, and do not bump the version for changes that only touch docs or tests.
- `AGENTS.md` is developer documentation: it is intentionally **not** in `files`, so it
  is not published.

## Commits

Conventional prefix in the imperative (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
`chore:`), one concern per commit, body explaining the trade-off when it is not obvious.
Never commit a red `npm run check`, and never push a tag that CI has not verified.

## Known limitations (document, do not paper over)

- RPC multi-select is a select loop because RPC has no custom-component support.
- The skill is only advertised when Pi has a tool to read it; `--no-builtin-tools` hides
  it, and the model may still call `ask_user` from the tool schema alone.
- Filtering is in-place: every whitespace-separated term must match label + description
  case-insensitively. There is no fuzzy ranking and no scrolling window for long lists.
