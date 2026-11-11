/**
 * Smoke test without a model or a real terminal: loads the extension through
 * jiti, captures the registered tool and drives the custom component by feeding
 * raw key sequences.
 *
 * Run with: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("../index.ts");

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

const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", shiftTab: "\x1b[Z" };
const params = {
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
	const lines = component.render(64);
	assert.ok(lines.length > 0);
	drive(component, lines);
	return pending;
}

// 1. Arrow navigation + Enter selects an option.
{
	const result = await runTui(params, (component) => {
		component.handleInput(KEYS.down);
		component.handleInput(KEYS.enter);
	});
	assert.equal(result.content[0].text, "User selected: 2. SQLite");
	assert.equal(result.details.response.kind, "selection");
	assert.deepEqual(result.details.response.labels, ["SQLite"]);
	assert.deepEqual(result.details.response.indexes, [2]);
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.question, params.question);
}

// 2. Digit quick-pick.
{
	const result = await runTui(params, (component) => {
		component.handleInput("1");
	});
	assert.equal(result.content[0].text, "User selected: 1. Postgres");
}

// 3. Freeform: pick "Type something." (index 3), type, submit with Enter.
{
	const result = await runTui(params, (component) => {
		component.handleInput("3");
		for (const char of "use duckdb") component.handleInput(char);
		component.handleInput(KEYS.enter);
	});
	assert.equal(result.content[0].text, "User wrote: use duckdb");
	assert.equal(result.details.response.kind, "freeform");
}

// 4. Escape in the list cancels without re-asking the user.
{
	const result = await runTui(params, (component) => {
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
	const result = await tool.execute("call-2", params, undefined, undefined, { hasUI: false, mode: "print", ui: {} });
	assert.match(result.content[0].text, /no interactive UI/);
	assert.equal(result.details.cancelled, true);
}

// 7. RPC fallback uses select and maps the choice back to the label.
{
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: { select: async () => "2. SQLite — No extra infrastructure" },
	};
	const result = await tool.execute("call-3", params, undefined, undefined, ctx);
	assert.equal(result.content[0].text, "User selected: 2. SQLite");
}

// 8. RPC fallback for freeform cancels when the dialog is dismissed.
{
	const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined } };
	const result = await tool.execute("call-3", params, undefined, undefined, ctx);
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
	const pending = tool.execute("call-6", params, controller.signal, undefined, ctx);
	factory(tuiStub, theme, {}, resolvePrompt);
	controller.abort();
	const result = await pending;
	assert.equal(result.details.cancelled, true);
}

console.log("smoke: all checks passed");
