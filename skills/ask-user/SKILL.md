---
name: ask-user
description: Gate high-impact or ambiguous decisions on an explicit user answer with the ask_user tool. Use when requirements conflict, when a choice changes architecture, scope, dependencies, or data, or before destructive or irreversible actions.
---

# Ask before committing to a decision

`ask_user` blocks the turn until the user answers. Use it as a decision gate, not as a conversation device: every call must change what you do next.

## Use it when

- Two or more approaches are valid and the choice changes architecture, dependencies, data layout, or user-visible behavior.
- The request is ambiguous or contradicts earlier instructions, and guessing wrong would waste significant work.
- The next action is destructive or hard to reverse (deleting data, rewriting history, changing a public interface, spending money).
- You are about to make an assumption that materially changes the result.

## Do not use it when

- The answer is in the repository, the docs, or the conversation. Read first.
- You are confirming a step the user already asked for, or asking permission for routine work.
- The question is cosmetic and any answer is fine. Pick one and move on.
- You already asked it. A cancelled prompt is a "no" to asking again; proceed with your best judgment.

## Decision handshake

1. Gather the evidence first: read the files, run the command, understand the trade-off.
2. Summarize the decision in `context`, in one or two sentences with the facts that matter.
3. Ask one focused question with 2-5 concrete options; each `description` states the consequence, not the definition.
4. Wait for the answer. Do not call other tools after `ask_user` in the same turn.
5. State the decision in one line, then continue with the work.

## Writing the call

```json
{
  "context": "The service is single-region and the ORM supports both; managed Postgres costs more but removes backups from our plate.",
  "question": "Which database should the service use?",
  "options": [
    { "label": "Postgres", "description": "Managed backups and JSONB; monthly cost" },
    { "label": "SQLite", "description": "No infrastructure; single writer" }
  ]
}
```

- `question`: one sentence, self-contained, no options to choose from inside it.
- `options`: 2-5. More than 5 means the decision is not well framed yet; split it.
- `allowMultiple: true` only when several options can be true together (features to include, platforms to target).
- Leave `options` out only for genuinely open questions (a name, a URL, a value you cannot enumerate).
- `timeout` only for unattended runs. When it fires, continue with your best judgment instead of asking again.

## Batches

Use `questions: [...]` for 2-4 decisions that are independent and whose prerequisites are already settled. Never batch questions that depend on each other: ask the first, then ask the second with the answer in its `context`. Give each entry a short `label`; it becomes the tab and the answer prefix.

## After the answer

- Restate the decision briefly: "Going with SQLite, single-writer SQLite."
- If the user wrote a free-form answer that contradicts the options, the free-form answer wins.
- If the answer reveals a new decision, ask again only if that decision is equally high-impact; otherwise decide and note the assumption.
