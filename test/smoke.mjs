/**
 * Smoke test without a model or a real terminal: loads the extension through
 * jiti, captures the registered tool and drives the custom component by feeding
 * raw key sequences.
 *
 * Run with: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Keep the user's real settings out of the test and give each run a clean dir.
const agentDir = mkdtempSync(join(tmpdir(), "pi-toolkit-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const settingsFile = join(agentDir, "pi-toolkit.json");

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("../extensions/ask.ts");

const tools = [];
extension.default({ registerTool: (definition) => tools.push(definition) });
const tool = tools[0];

assert.equal(tools.length, 1, "registers exactly one tool");
assert.equal(tool.name, "ask_user");
assert.equal(tool.executionMode, "sequential");
assert.ok(tool.promptSnippet.length > 0);
assert.ok(tool.promptGuidelines.some((line) => line.includes("ask_user")));
assert.ok(tool.renderCall && tool.renderResult);

const theme = {
	fg: (_token, text) => text,
	bold: (text) => text,
	bg: (_token, text) => text,
};

const tuiStub = { requestRender() {}, terminal: { rows: 40, columns: 100 } };

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	space: " ",
};

const singleParams = {
	question: "Which database should the service use?",
	context: "Both are supported by the ORM; the service is single-region.",
	options: [
		{ label: "Postgres", description: "Managed, JSONB support" },
		{ label: "SQLite", description: "No extra infrastructure" },
	],
};

/** Runs a TUI tool call and lets the caller drive the component. */
async function runTui(inputParams, drive) {
	let factory;
	let resolve;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (f) => {
				factory = f;
				return new Promise((r) => {
					resolve = r;
				});
			},
		},
	};

	const pending = tool.execute("call-1", inputParams, undefined, undefined, ctx);
	const component = factory(tuiStub, theme, {}, resolve);
	component.render(64);
	const render = () => component.render(64).join("\n");
	drive(component, render);
	return pending;
}

async function runDialogs(inputParams, ui) {
	const ctx = { hasUI: true, mode: "rpc", ui };
	return tool.execute("call-rpc", inputParams, undefined, undefined, ctx);
}

// 1. Arrow navigation + Enter selects an option.
{
	const result = await runTui(singleParams, (component) => {
		component.handleInput(KEYS.down);
		component.handleInput(KEYS.enter);
	});
	assert.equal(result.content[0].text, "User selected: 2. SQLite");
	assert.equal(result.details.kind, "single");
	assert.deepEqual(result.details.response.labels, ["SQLite"]);
	assert.deepEqual(result.details.response.indexes, [2]);
	assert.equal(result.details.cancelled, false);
}

// 2. Digit quick-pick.
{
	const result = await runTui(singleParams, (component) => {
		component.handleInput("1");
	});
	assert.equal(result.content[0].text, "User selected: 1. Postgres");
}

// 3. Freeform: pick "Type something." (row 3), type, submit with Enter.
{
	const result = await runTui(singleParams, (component) => {
		component.handleInput("3");
		for (const char of "use duckdb") component.handleInput(char);
		component.handleInput(KEYS.enter);
	});
	assert.equal(result.content[0].text, "User wrote: use duckdb");
	assert.equal(result.details.response.kind, "freeform");
}

// 4. Escape in the list cancels without re-asking the user.
{
	const result = await runTui(singleParams, (component) => {
		component.handleInput(KEYS.escape);
	});
	assert.match(result.content[0].text, /dismissed the question/);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.response, null);
}

// 5. Open question with no options starts in the editor.
{
	const result = await runTui({ question: "What should the endpoint be called?" }, (component) => {
		for (const char of "/v2/orders") component.handleInput(char);
		component.handleInput(KEYS.enter);
	});
	assert.equal(result.content[0].text, "User wrote: /v2/orders");
}

// 6. Headless modes do not hang: the model is told to ask in plain text.
{
	const result = await tool.execute("call-2", singleParams, undefined, undefined, {
		hasUI: false,
		mode: "print",
		ui: {},
	});
	assert.match(result.content[0].text, /no interactive UI/);
	assert.equal(result.details.cancelled, true);
}

// 7. RPC fallback uses select and maps the choice back to the label.
{
	const result = await runDialogs(singleParams, {
		select: async () => "2. SQLite",
	});
	assert.equal(result.content[0].text, "User selected: 2. SQLite");
}

// 8. RPC fallback cancels when the dialog is dismissed.
{
	const result = await runDialogs(singleParams, { select: async () => undefined });
	assert.equal(result.details.cancelled, true);
}

// 9. Invalid input fails the tool call instead of inventing an answer.
{
	await assert.rejects(
		tool.execute("call-4", { question: "   " }, undefined, undefined, { hasUI: false }),
		/non-empty/,
	);
	await assert.rejects(
		tool.execute("call-5", { question: "Pick one", options: [], allowFreeform: false }, undefined, undefined, {
			hasUI: false,
		}),
		/at least one option/,
	);
}

// 10. AbortSignal cancels an open prompt.
{
	const controller = new AbortController();
	let factory;
	let resolvePrompt;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (f) => {
				factory = f;
				return new Promise((r) => {
					resolvePrompt = r;
				});
			},
		},
	};
	const pending = tool.execute("call-6", singleParams, controller.signal, undefined, ctx);
	factory(tuiStub, theme, {}, resolvePrompt);
	controller.abort();
	const result = await pending;
	assert.equal(result.details.cancelled, true);
}

// 11. Multi-select: space toggles, Enter submits the checked set.
{
	const result = await runTui(
		{
			question: "Which features should ship?",
			allowMultiple: true,
			options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
		},
		(component) => {
			component.handleInput(KEYS.space);
			component.handleInput(KEYS.down);
			component.handleInput(KEYS.down);
			component.handleInput(KEYS.space);
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.content[0].text, "User selected: 1. Auth, 3. Search");
	assert.deepEqual(result.details.response.indexes, [1, 3]);
}

// 12. Multi-select with a free-form addition.
{
	const result = await runTui(
		{
			question: "Which features should ship?",
			allowMultiple: true,
			options: [{ label: "Auth" }, { label: "Billing" }],
		},
		(component) => {
			component.handleInput(KEYS.space);
			component.handleInput("3");
			for (const char of "ci") component.handleInput(char);
			component.handleInput(KEYS.enter);
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.content[0].text, "User selected: 1. Auth\nUser also wrote: ci");
	assert.equal(result.details.response.text, "ci");
}

// 13. Multi-select refuses to submit an empty answer and says so.
{
	const result = await runTui(
		{
			question: "Which features should ship?",
			allowMultiple: true,
			options: [{ label: "Auth" }, { label: "Billing" }],
		},
		(component, render) => {
			component.handleInput(KEYS.enter);
			assert.match(render(), /Select at least one option/);
			component.handleInput(KEYS.space);
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.content[0].text, "User selected: 1. Auth");
}

// 14. Batch: answer both questions, land on review, submit.
{
	const result = await runTui(
		{
			question: "Deploy setup",
			questions: [
				{ label: "DB", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
				{ label: "Target", question: "Which target?", options: [{ label: "Fly.io" }, { label: "Cloudflare" }] },
			],
		},
		(component) => {
			component.handleInput(KEYS.enter);
			component.handleInput("2");
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.details.kind, "batch");
	assert.equal(result.details.answers.length, 2);
	assert.match(result.content[0].text, /DB\. Which database\?\nAnswer: User selected: 1\. Postgres/);
	assert.match(result.content[0].text, /Target\. Which target\?\nAnswer: User selected: 2\. Cloudflare/);
}

// 15. Batch: Enter on review warns once, then submits with the unanswered question skipped.
{
	const result = await runTui(
		{
			questions: [
				{ label: "DB", question: "Which database?", options: [{ label: "Postgres" }] },
				{ label: "Target", question: "Which target?", options: [{ label: "Fly.io" }] },
			],
		},
		(component, render) => {
			component.handleInput(KEYS.enter);
			component.handleInput(KEYS.tab);
			assert.match(render(), /Review your answers/);
			component.handleInput(KEYS.enter);
			assert.match(render(), /will be\s+skipped/);
			component.handleInput(KEYS.enter);
		},
	);
	assert.match(result.content[0].text, /Target\. Which target\?\nAnswer: skipped/);
	assert.equal(result.details.cancelled, false);
}

// 16. Batch: Esc cancels every question.
{
	const result = await runTui(
		{
			questions: [
				{ question: "Which database?", options: [{ label: "Postgres" }] },
				{ question: "Which target?", options: [{ label: "Fly.io" }] },
			],
		},
		(component) => {
			component.handleInput(KEYS.enter);
			component.handleInput(KEYS.escape);
		},
	);
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.answers, [null, null]);
}

// 17. Review page digits jump back to a question.
{
	const result = await runTui(
		{
			questions: [
				{ label: "DB", question: "Which database?", options: [{ label: "Postgres" }] },
				{ label: "Target", question: "Which target?", options: [{ label: "Fly.io" }] },
			],
		},
		(component, render) => {
			component.handleInput(KEYS.enter);
			component.handleInput(KEYS.tab);
			component.handleInput("1");
			assert.match(render(), /Which database\?/);
			component.handleInput(KEYS.escape);
		},
	);
	assert.equal(result.details.cancelled, true);
}

// 18. RPC multi-select loops until "Done".
{
	const answers = ["1. Auth", "Done (1 selected)"];
	const result = await runDialogs(
		{ question: "Which features?", allowMultiple: true, options: [{ label: "Auth" }, { label: "Billing" }] },
		{ select: async () => answers.shift() },
	);
	assert.equal(result.content[0].text, "User selected: 1. Auth");
}

// 19. RPC batch asks every question in order.
{
	const answers = ["1. Postgres", "2. Cloudflare"];
	const result = await runDialogs(
		{
			questions: [
				{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
				{ question: "Which target?", options: [{ label: "Fly.io" }, { label: "Cloudflare" }] },
			],
		},
		{ select: async () => answers.shift() },
	);
	assert.match(result.content[0].text, /Answer: User selected: 1\. Postgres/);
	assert.match(result.content[0].text, /Answer: User selected: 2\. Cloudflare/);
}

// 20. Renderers work for both detail shapes, including v1 details without `kind`.
{
	const text = { fg: (_t, s) => s, bold: (s) => s, bg: (_t, s) => s };
	assert.ok(tool.renderCall(singleParams, theme).render(80).length);
	assert.ok(tool.renderCall({ question: "Head", questions: [{ question: "Q?" }] }, theme).render(80).length);

	const single = tool.renderResult(
		{ content: [{ type: "text", text: "x" }], details: { question: "q", options: [], response: null, cancelled: true } },
		{},
		text,
	);
	assert.match(single.render(80).join("\n"), /Cancelled/);

	const batch = tool.renderResult(
		{
			content: [{ type: "text", text: "x" }],
			details: {
				kind: "batch",
				questions: [{ label: "Q1", question: "q", options: [], allowMultiple: false, allowFreeform: true }],
				answers: [null],
				cancelled: false,
			},
		},
		{},
		text,
	);
	assert.match(batch.render(80).join("\n"), /not answered/);
}

// 21. Filter: "/" narrows the list, Enter applies, selection keeps the original option number.
{
	const result = await runTui(
		{
			question: "Which database?",
			options: [
				{ label: "Postgres" },
				{ label: "MongoDB" },
				{ label: "SQLite" },
				{ label: "DuckDB" },
				{ label: "ClickHouse" },
				{ label: "CockroachDB" },
			],
		},
		(component, render) => {
			component.handleInput("/");
			for (const char of "sql") component.handleInput(char);
			assert.match(render(), /sql/);
			component.handleInput(KEYS.enter);
			assert.match(render(), /Filter: sql/);
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.content[0].text, "User selected: 3. SQLite");
}

// 22. Filter with no matches shows an empty state; Esc clears the filter before cancelling.
{
	const result = await runTui(
		{
			question: "Which database?",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
		(component, render) => {
			component.handleInput("/");
			for (const char of "zzz") component.handleInput(char);
			assert.match(render(), /No options match "zzz"/);
			component.handleInput(KEYS.escape);
			assert.match(render(), /Postgres/);
			component.handleInput(KEYS.escape);
		},
	);
	assert.equal(result.details.cancelled, true);
}

// 23. Filtering never rewrites the checked set: multi-select keeps the original index.
{
	const result = await runTui(
		{
			question: "Which features?",
			allowMultiple: true,
			options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
		},
		(component) => {
			component.handleInput("/");
			for (const char of "sea") component.handleInput(char);
			component.handleInput(KEYS.enter);
			component.handleInput(KEYS.space);
			component.handleInput(KEYS.enter);
		},
	);
	assert.equal(result.content[0].text, "User selected: 3. Search");
	assert.deepEqual(result.details.response.indexes, [3]);
}

// 24. Timeout auto-dismisses the prompt and is reported as a timeout, not a cancel.
{
	const result = await runTui(
		{ question: "Are you still there?", timeout: 1000, options: [{ label: "Yes" }, { label: "No" }] },
		(component, render) => {
			assert.match(render(), /⏱/);
		},
	);
	assert.equal(result.details.timedOut, true);
	assert.match(result.content[0].text, /timed out/);
}

// 25. RPC timeout is passed to the dialogs as remaining time.
{
	let seenOptions;
	const result = await runDialogs(
		{
			question: "Which database?",
			timeout: 5000,
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
		{
			select: async (_title, _choices, opts) => {
				seenOptions = opts;
				return "1. Postgres";
			},
		},
	);
	assert.equal(seenOptions.timeout > 0 && seenOptions.timeout <= 5000, true);
	assert.equal(result.content[0].text, "User selected: 1. Postgres");
}

// 26. RPC dismissal before the deadline is a cancel, not a timeout.
{
	const result = await runDialogs(
		{ question: "Which database?", timeout: 5000, options: [{ label: "Postgres" }] },
		{ select: async () => undefined },
	);
	assert.equal(result.details.cancelled, true);
	assert.ok(!result.details.timedOut);
}

// 27. A settings-file timeout applies when the tool call has none.
{
	writeFileSync(settingsFile, JSON.stringify({ timeout: 1000 }));
	const result = await runTui({ question: "Still there?", options: [{ label: "Yes" }] }, () => {});
	assert.equal(result.details.timedOut, true);
	rmSync(settingsFile);
}

// 28. filterThreshold from settings controls when the `/` hint appears.
{
	writeFileSync(settingsFile, JSON.stringify({ filterThreshold: 3 }));
	const result = await runTui(
		{ question: "Pick one", options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
		(component, render) => {
			assert.match(render(), /\/\s+to filter/);
			component.handleInput("2");
		},
	);
	assert.equal(result.content[0].text, "User selected: 2. B");
	rmSync(settingsFile);
}

// 29. A malformed settings file fails loudly with its path instead of being ignored.
{
	writeFileSync(settingsFile, "{ not json");
	await assert.rejects(
		tool.execute("call-cfg", { question: "Hi" }, undefined, undefined, { hasUI: false, mode: "print", ui: {} }),
		/pi-toolkit\.json is not valid JSON/,
	);
	rmSync(settingsFile);
}

// 30. The packaged skill ships valid frontmatter and names the tool.
{
	const skill = readFileSync(new URL("../skills/ask-user/SKILL.md", import.meta.url), "utf8");
	assert.match(skill, /^---\nname: ask-user\n/);
	const description = skill.match(/^---[\s\S]*?description: (.+)$/m)?.[1] ?? "";
	assert.ok(description.length > 60, "skill description should route clearly");
	assert.match(skill, /ask_user/);

	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.deepEqual(manifest.pi.extensions, ["./extensions/*.ts"]);
	assert.ok(manifest.files.includes("extensions"));
	assert.ok(manifest.files.includes("skills"));
}

rmSync(agentDir, { recursive: true, force: true });

console.log("smoke: all checks passed");
