/**
 * Smoke test without a model or a real terminal: loads the extension through
 * jiti, captures the registered tool and drives the custom component by feeding
 * raw key sequences.
 *
 * Run with: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

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

	// The version Pi reports comes from package.json; the newest changelog heading
	// has to match it or the update is not announced.
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	assert.equal(manifest.version, changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1]);
}

// ---- notify ----------------------------------------------------------------

// The notify extension registers no tool: it listens to lifecycle events and
// writes to the terminal, so the harness drives the handlers directly.
const notifyModule = await jiti.import("../extensions/notify.ts");
const notifyHandlers = new Map();
const notifyCommands = new Map();
const notifyBus = new Map();
notifyModule.default({
	on: (name, handler) => notifyHandlers.set(name, handler),
	events: {
		on: (channel, handler) => notifyBus.set(channel, handler),
		emit: (channel, data) => notifyBus.get(channel)?.(data),
	},
	registerCommand: (name, options) => notifyCommands.set(name, options),
});

const { resolveChannel } = await jiti.import("../src/notify/channel.ts");
const { encodeOsc, wrapTmux, sanitize, formatDuration, TOAST_SCRIPT, toastEnv } = await jiti.import(
	"../src/notify/payload.ts",
);
const { loadNotifySettings, NOTIFY_EVENTS } = await jiti.import("../src/notify/settings.ts");

const notices = [];
const notifyCtx = (overrides = {}) => ({
	mode: "tui",
	cwd: "/tmp/pi-toolkit-project",
	isIdle: () => true,
	ui: { notify: (message) => notices.push(message) },
	...overrides,
});

/** Runs `fn` with stdout captured, so its escape codes can be asserted. */
async function captured(fn) {
	const writes = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return writes.join("");
}

const fire = (name, event, ctx) => captured(() => notifyHandlers.get(name)(event, ctx));

// 31. Channel detection follows the terminal, and an explicit setting wins.
{
	const auto = "auto";
	assert.equal(resolveChannel(auto, {}, "win32"), "toast");
	assert.equal(resolveChannel(auto, { WT_SESSION: "1" }, "linux"), "osc9");
	assert.equal(resolveChannel(auto, { KITTY_WINDOW_ID: "1" }, "linux"), "osc99");
	assert.equal(resolveChannel(auto, { TERM_PROGRAM: "iTerm.app" }, "darwin"), "osc9");
	assert.equal(resolveChannel(auto, { TERM_PROGRAM: "WezTerm" }, "linux"), "osc777");
	assert.equal(resolveChannel(auto, { TERM: "xterm-ghostty" }, "linux"), "osc777");
	assert.equal(resolveChannel(auto, {}, "linux"), "osc777");
	// Forced toast on a non-Windows host degrades instead of going silent.
	assert.equal(resolveChannel("toast", {}, "linux"), "osc777");
	assert.equal(resolveChannel("bell", {}, "win32"), "bell");
	assert.equal(resolveChannel("off", {}, "tui"), "off");
}

// 32. Payloads are one line of printable text: control characters cannot end a
// sequence early, and `;` cannot shift the fields of OSC 777.
{
	const notification = { title: "Pi · demo", body: "Done in 3m 07s" };
	assert.equal(encodeOsc("osc777", notification), "\x1b]777;notify;Pi · demo;Done in 3m 07s\x07");
	assert.equal(encodeOsc("bell", notification), "\x07");

	const hostile = { title: "a;b\x1b]99;x\x07", body: "line1\nline2\ttab\u0007" };
	const encoded = encodeOsc("osc777", hostile);
	assert.equal(encoded, "\x1b]777;notify;a,b ]99,x;line1 line2 tab\x07");
	assert.equal(encoded.split("\x1b").length, 2, "exactly one ESC opens the sequence");

	const kitty = encodeOsc("osc99", notification, 7);
	assert.ok(kitty.startsWith("\x1b]99;i=7:d=0;Pi · demo\x1b\\"));
	assert.ok(kitty.endsWith("\x1b]99;i=7:p=body;Done in 3m 07s\x1b\\"));

	assert.ok(encodeOsc("osc777", { title: "t", body: "x".repeat(500) }).includes("…"));
	assert.equal(sanitize("a\nb", 10), "a b");
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(67_000), "1m 07s");
	assert.equal(formatDuration(3_600_000), "1h 00m");
}

// 33. Inside tmux every escape is doubled and wrapped in a DCS passthrough.
{
	const wrapped = wrapTmux("\x1b]777;notify;Pi;Done\x07");
	assert.ok(wrapped.startsWith("\x1bPtmux;\x1b\x1b\x1b]777"));
	assert.ok(wrapped.endsWith("\x1b\\"));
	const body = wrapped.slice("\x1bPtmux;\x1b".length, -2);
	assert.equal(body.replaceAll("\x1b\x1b", "").includes("\x1b"), false, "every ESC is doubled");
}

// 34. Windows toast text travels through the environment, never through the
// script: model output cannot inject PowerShell.
{
	const hostile = { title: "Pi", body: "$(calc.exe) '); Remove-Item C:\\ -Recurse" };
	assert.equal(toastEnv(hostile).PI_NOTIFY_BODY, hostile.body);
	assert.ok(!TOAST_SCRIPT.includes("calc.exe"), "script never contains user text");
	assert.ok(TOAST_SCRIPT.includes("$env:PI_NOTIFY_BODY"));
	assert.ok(TOAST_SCRIPT.includes("CreateTextNode"));
}

// 35. notify settings: defaults, clamping, filtering, and a loud malformed file.
{
	assert.deepEqual(loadNotifySettings().events, [...NOTIFY_EVENTS]);
	writeFileSync(
		settingsFile,
		JSON.stringify({ notify: { enabled: false, channel: "osc99", minDurationMs: -5, events: ["done", "bogus"] } }),
	);
	const parsed = loadNotifySettings();
	assert.equal(parsed.enabled, false);
	assert.equal(parsed.channel, "osc99");
	assert.equal(parsed.minDurationMs, 0, "negative durations clamp to zero");
	assert.deepEqual(parsed.events, ["done"]);

	writeFileSync(settingsFile, JSON.stringify({ notify: { channel: "nope", minDurationMs: 9e12 } }));
	const clamped = loadNotifySettings();
	assert.equal(clamped.channel, "auto", "an unknown channel falls back to auto");
	assert.equal(clamped.minDurationMs, 3_600_000);

	writeFileSync(settingsFile, "{ not json");
	assert.throws(() => loadNotifySettings(), /pi-toolkit\.json is not valid JSON/);
	rmSync(settingsFile);
}

// 36. A finished run notifies only after the configured minimum duration.
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 0, channel: "osc777" } }));
	notifyHandlers.get("agent_start")({}, notifyCtx());
	assert.match(await fire("agent_settled", { aborted: false }, notifyCtx()), /Done in/);

	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 60000, channel: "osc777" } }));
	notifyHandlers.get("agent_start")({}, notifyCtx());
	assert.equal(await fire("agent_settled", { aborted: false }, notifyCtx()), "");
	rmSync(settingsFile);
}

// 37. Escape is the user acting: an aborted run never notifies.
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 0, channel: "osc777" } }));
	notifyHandlers.get("agent_start")({}, notifyCtx());
	assert.equal(await fire("agent_settled", { aborted: true }, notifyCtx()), "");
	rmSync(settingsFile);
}

// 38. A failed run is reported with the provider message, not as "done".
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 600000, channel: "osc777" } }));
	notifyHandlers.get("agent_start")({}, notifyCtx());
	notifyHandlers.get("agent_end")({
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }],
	});
	assert.match(
		await fire("agent_settled", { aborted: false }, notifyCtx()),
		/Stopped with an error: 429 rate limited/,
	);
	rmSync(settingsFile);
}

// 39. A prompt that interrupts a running agent means "blocked on you"; a dialog
// the user opened while idle is not worth a notification.
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { channel: "osc777" } }));
	const busy = () => notifyCtx({ isIdle: () => false });

	notifyBus.get("pi-toolkit:ask:waiting")({ question: "Which database?" });
	assert.match(await fire("ui_prompt_start", { kind: "custom" }, busy()), /Waiting for you: Which database\?/);

	notifyBus.get("pi-toolkit:ask:settled")(undefined);
	const unnamed = await fire("ui_prompt_start", { kind: "custom" }, busy());
	assert.match(unnamed, /Waiting for your answer/);
	assert.ok(!unnamed.includes("Which database?"), "the question text is cleared once the prompt closes");

	// The user's own picker: no agent is blocked.
	assert.equal(await fire("ui_prompt_start", { kind: "select", title: "Pick a model" }, notifyCtx()), "");
	rmSync(settingsFile);
}

// 40. /notify off mutes the session and /notify test bypasses both the switch
// and the minimum duration; status names the resolved channel.
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 0, channel: "osc777" } }));
	const ctx = notifyCtx();
	const command = notifyCommands.get("notify");
	assert.ok(command.getArgumentCompletions("t").some((item) => item.value === "test"));

	await command.handler("off", ctx);
	notifyHandlers.get("agent_start")({}, ctx);
	assert.equal(await fire("agent_settled", { aborted: false }, ctx), "");

	assert.match(await captured(() => command.handler("test", ctx)), /Notifications are working/);
	assert.ok(notices.some((message) => message.includes("sent a test notification via osc777")));

	await command.handler("status", ctx);
	assert.ok(notices.some((message) => message.includes("notifications off · osc777")));

	await command.handler("on", ctx);
	notifyHandlers.get("agent_start")({}, ctx);
	assert.match(await fire("agent_settled", { aborted: false }, ctx), /Done in/);
	rmSync(settingsFile);
}

// 41. Non-TUI modes never receive escape codes: they would corrupt the JSON
// stream and the printed answer, `/notify test` included.
{
	writeFileSync(settingsFile, JSON.stringify({ notify: { minDurationMs: 0, channel: "osc777" } }));
	for (const mode of ["rpc", "json", "print"]) {
		const ctx = notifyCtx({ mode });
		notifyHandlers.get("agent_start")({}, ctx);
		assert.equal(await fire("agent_settled", { aborted: false }, ctx), "");
		assert.equal(await fire("ui_prompt_start", { kind: "custom" }, notifyCtx({ mode, isIdle: () => false })), "");
		assert.equal(await captured(() => notifyCommands.get("notify").handler("test", ctx)), "");
	}
	rmSync(settingsFile);
}

// 42. The activity state machine has one coherent lifecycle: parallel tools are
// tracked independently, elapsed time freezes on settle, and the last summary
// survives the closing line so the idle footer can show it.
{
	const {
		initialState,
		startRun,
		startTool,
		endTool,
		endRun,
		finishFlourish,
		currentTool,
		isWaiting,
		elapsedMs,
		setModelPhase,
	} = await jiti.import("../src/lively/state.ts");

	let state = initialState();
	assert.equal(state.phase, "idle");

	state = startRun(state, 1000);
	assert.equal(state.phase, "working");
	assert.equal(state.modelPhase, "waiting");
	state = setModelPhase(state, "thinking");
	assert.equal(state.modelPhase, "thinking");
	assert.equal(setModelPhase(state, "thinking"), state, "an unchanged phase keeps the snapshot");

	state = startTool(state, { id: "a", name: "edit", target: "src/schema.ts" }, 1000);
	state = startTool(state, { id: "b", name: "bash", target: "npm test" }, 1100);
	assert.equal(state.tools, 2);
	assert.equal(state.active.length, 2);
	assert.equal(currentTool(state).name, "bash");

	state = endTool(state, "b");
	assert.equal(state.active.length, 1);
	assert.equal(currentTool(state).name, "edit");

	state = endRun(state, "done", 1500);
	assert.equal(state.phase, "settled");
	assert.equal(state.outcome, "done");
	assert.equal(state.lastRun.durationMs, 500);
	assert.equal(state.lastRun.tools, 2);
	assert.equal(elapsedMs(state, 9999), 500, "elapsed time stops at settle");

	state = finishFlourish(state);
	assert.equal(state.phase, "idle");
	assert.equal(state.active.length, 0);
	assert.equal(state.lastRun.tools, 2, "the idle footer remembers the last run");

	state = startRun(state, 2000);
	state = startTool(state, { id: "q", name: "ask_user" }, 2000);
	assert.equal(isWaiting(state), true, "a pending ask_user means the user is the blocker");
	state = endRun(state, "aborted", 3000);
	assert.equal(state.outcome, "aborted");
	assert.equal(isWaiting(state), false);
}

// 43. Tool args become one short noun, and the activity line stays inside the
// terminal width even when the target is long.
{
	const { describeTarget } = await jiti.import("../src/lively/target.ts");
	const { renderActivityLine, formatElapsed } = await jiti.import("../src/lively/format.ts");

	assert.equal(describeTarget("read", { file_path: "/home/me/proj/src/schema.ts" }), "src/schema.ts");
	assert.equal(describeTarget("bash", { command: "npm run check\n--watch" }), "npm run check");
	assert.equal(describeTarget("grep", { pattern: "activeTui" }), "activeTui");
	assert.equal(describeTarget("grep", { pattern: "activeTui", path: "src" }), "activeTui");
	assert.equal(describeTarget("glob", { pattern: "**/*.ts", path: "src" }), "**/*.ts");
	assert.equal(describeTarget("bash", { command: "npm test", path: "/tmp" }), "npm test");
	assert.equal(describeTarget("fetch_content", { url: "https://pi.dev/docs/tui" }), "pi.dev");
	assert.equal(describeTarget("ask_user", { question: "Which database?" }), "Which database?");
	assert.equal(describeTarget("read", {}), undefined);
	assert.equal(describeTarget("bash", { command: "x".repeat(100) }).length, 60);

	assert.equal(formatElapsed(800), "<1s");
	assert.equal(formatElapsed(65_000), "1m 05s");

	const working = {
		phase: "working",
		frame: 0,
		modelPhase: "responding",
		runStartedAt: 0,
		tools: 1,
		active: [{ id: "a", name: "edit", target: "src/schema.ts", startedAt: 0 }],
		prompting: false,
	};
	const line = renderActivityLine(working, theme, 80, 12_000, "braille");
	assert.match(line, /⠋ editing src\/schema\.ts/);
	assert.match(line, /12s/);

	const narrow = renderActivityLine(working, theme, 10, 12_000, "braille");
	assert.ok(visibleWidth(narrow) <= 10, "the activity line never exceeds the terminal width");
	const medium = renderActivityLine(working, theme, 20, 12_000, "braille");
	assert.ok(!medium.includes("· <"), "the clock is dropped before it is cut in half");

	const toolClock = renderActivityLine(
		{ ...working, active: [{ id: "a", name: "bash", target: "npm test", startedAt: 10_000 }] },
		theme,
		80,
		12_000,
		"braille",
	);
	assert.match(toolClock, /running npm test · 2s/, "the activity clock measures the current tool");

	// The label follows the real stream phase, not a guess from the tool activity.
	const idleTools = { ...working, active: [] };
	assert.match(renderActivityLine({ ...idleTools, modelPhase: "thinking" }, theme, 80, 2000, "braille"), /thinking/);
	assert.match(renderActivityLine({ ...idleTools, modelPhase: "responding" }, theme, 80, 2000, "braille"), /responding/);
	assert.match(renderActivityLine({ ...idleTools, modelPhase: "tools" }, theme, 80, 2000, "braille"), /preparing tools/);
	assert.match(
		renderActivityLine({ ...idleTools, modelPhase: "waiting" }, theme, 80, 2000, "braille"),
		/waiting for the model/,
	);

	const { endRun } = await jiti.import("../src/lively/state.ts");
	const failed = endRun({ ...working, runStartedAt: 1000, active: [] }, "error", 7000);
	assert.match(renderActivityLine(failed, theme, 80, 8000, "braille"), /✗ Failed after 6s · 1 tool/);
}

// 44. The footer keeps the information the native footer shows (tokens, cost,
// context, auto-compact, model, branch, statuses) and yields on narrow widths.
{
	const { renderFooterLines } = await jiti.import("../src/lively/format.ts");
	const { startRun, startTool, endRun } = await jiti.import("../src/lively/state.ts");

	let state = startRun({ phase: "idle", frame: 0, tools: 0, active: [], prompting: false }, 0);
	state = startTool(state, { id: "a", name: "edit", target: "src/schema.ts" }, 0);

	const snapshot = {
		state,
		now: 12_000,
		theme,
		style: "braille",
		totals: {
			input: 1200,
			output: 340,
			cacheRead: 5000,
			cacheWrite: 0,
			cost: 0.042,
			latestCacheHitRate: 80.645,
		},
		context: { percent: 45, contextWindow: 200_000 },
		cwd: "/home/me/proj",
		home: "/home/me",
		branch: "main",
		sessionName: "refactor",
		model: { id: "gpt-5", provider: "openai", reasoning: true, contextWindow: 200_000 },
		thinking: "high",
		providerCount: 2,
		autoCompact: true,
		activity: true,
		statuses: new Map([
			["notify", "notifications on"],
			["ask", "waiting"],
			["colored", "\x1b[31mred\x1b[0m"],
		]),
	};

	const lines = renderFooterLines(snapshot, 100);
	assert.equal(lines.length, 3);
	assert.match(lines[0], /⠋ 12s · 1 tool/);
	assert.match(lines[0], /~\/proj \(main\) • refactor/);
	assert.match(lines[1], /↑1\.2k ↓340 R5\.0k CH80\.6% \$0\.042 ctx 45%\/200k \(auto\)/);
	assert.match(lines[1], /\(openai\) gpt-5 • high/);
	assert.match(lines[2], /waiting  .*red.*  notifications on/);
	assert.ok(lines[2].includes("\x1b[31mred\x1b[0m"), "colored statuses keep their ANSI");

	for (const line of lines) assert.ok(visibleWidth(line) <= 100, "footer lines fit the width");
	for (const line of renderFooterLines(snapshot, 30)) {
		assert.ok(visibleWidth(line) <= 30, "a narrow terminal truncates instead of overflowing");
	}

	// Without the activity line, the footer is still only a pulse: Pi's own working
	// row supplies the word, so neither configuration repeats it.
	const noActivity = renderFooterLines({ ...snapshot, activity: false }, 100);
	assert.match(noActivity[0], /⠋ 12s · 1 tool/);

	const settled = endRun(state, "done", 12_000);
	assert.match(renderFooterLines({ ...snapshot, state: settled }, 100)[0], /✓ 12s · 1 tool/);
	assert.match(
		renderFooterLines({ ...snapshot, state: settled, activity: false }, 100)[0],
		/✓ done in 12s · 1 tool/,
	);
}

// 45. The lively block is clamped and a malformed file fails with its path.
{
	const { loadLivelySettings, DEFAULT_CELEBRATE_MS, CELEBRATE_MS_MAX } = await jiti.import(
		"../src/lively/settings.ts",
	);

	writeFileSync(
		settingsFile,
		JSON.stringify({
			lively: {
				enabled: false,
				footer: false,
				activity: false,
				celebrate: false,
				celebrateMs: 999_999,
				spinner: "dots",
			},
		}),
	);
	let settings = loadLivelySettings(settingsFile);
	assert.equal(settings.enabled, false);
	assert.equal(settings.footer, false);
	assert.equal(settings.activity, false);
	assert.equal(settings.celebrate, false);
	assert.equal(settings.celebrateMs, CELEBRATE_MS_MAX);
	assert.equal(settings.spinner, "dots");

	writeFileSync(settingsFile, JSON.stringify({ lively: { celebrateMs: -5, spinner: "nope" } }));
	settings = loadLivelySettings(settingsFile);
	assert.equal(settings.celebrateMs, 0);
	assert.equal(settings.spinner, "braille");
	assert.equal(settings.celebrateMs === DEFAULT_CELEBRATE_MS, false, "the file overrides the default");

	writeFileSync(settingsFile, "{ nope");
	assert.throws(() => loadLivelySettings(settingsFile), /not valid JSON/);
	rmSync(settingsFile);
}

// 46. Wiring: the footer appears on session start, the activity line on run
// start, a failed run flashes its closing line, and the command removes both.
{
	const lively = await jiti.import("../extensions/lively.ts");
	const { default: livelyExtension } = lively;

	function livelyHost() {
		const handlers = new Map();
		const commands = new Map();
		const pi = {
			on(event, handler) {
				handlers.set(event, handler);
				return () => {};
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
			getThinkingLevel: () => "high",
			getSessionName: () => "refactor",
			getSettings: () => ({ compaction: { enabled: true } }),
		};
		return { pi, handlers, commands };
	}

	writeFileSync(settingsFile, JSON.stringify({ lively: { celebrateMs: 40 } }));

	const host = livelyHost();
	const notices = [];
	const workingCalls = [];
	let footer;
	let widget;
	let renders = 0;
	const tui = { requestRender: () => (renders += 1) };
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["notify", "notifications on"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const ui = {
		setFooter(factory) {
			footer = factory ? factory(tui, theme, footerData) : undefined;
		},
		setWidget(_key, content) {
			widget = typeof content === "function" ? content(tui, theme) : undefined;
		},
		notify(message, type) {
			notices.push({ message, type });
		},
		setWorkingMessage(message) {
			workingCalls.push({ kind: "message", message });
		},
		setWorkingIndicator(options) {
			workingCalls.push({ kind: "indicator", options });
		},
		setStatus() {},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/home/me/proj",
		thinkingLevel: "high",
		model: { id: "gpt-5", provider: "openai", reasoning: true, contextWindow: 200_000 },
		ui,
		sessionManager: {
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 1200,
							output: 340,
							cacheRead: 5000,
							cacheWrite: 0,
							cost: { total: 0.042 },
						},
					},
				},
			],
		},
		getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
		isIdle: () => false,
	};

	livelyExtension(host.pi);
	await host.handlers.get("session_start")({}, ctx);
	assert.ok(footer, "session start installs the lively footer");
	assert.match(footer.render(100).join("\n"), /ready/);
	assert.match(footer.render(100).join("\n"), /notifications on/);
	assert.deepEqual(
		workingCalls,
		[
			{ kind: "message", message: "" },
			{ kind: "indicator", options: { frames: [] } },
		],
		"the native working row is emptied while the activity line is on",
	);

	await host.handlers.get("agent_start")({}, ctx);
	assert.ok(widget, "run start installs the activity line");
	assert.match(widget.render(100).join("\n"), /waiting for the model/);

	await host.handlers.get("message_update")(
		{ message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
		ctx,
	);
	assert.match(widget.render(100).join("\n"), /thinking/);

	await host.handlers.get("message_update")(
		{ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "Here" } },
		ctx,
	);
	assert.match(widget.render(100).join("\n"), /responding/);

	await host.handlers.get("message_update")(
		{ message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_start" } },
		ctx,
	);
	assert.match(widget.render(100).join("\n"), /preparing tools/);

	await host.handlers.get("tool_execution_start")(
		{ toolCallId: "1", toolName: "edit", args: { file_path: "/home/me/proj/src/schema.ts" } },
		ctx,
	);
	assert.match(widget.render(100).join("\n"), /editing src\/schema\.ts/);
	assert.ok(!footer.render(100).join("\n").includes("working"), "the footer does not repeat the activity label");

	await host.handlers.get("tool_execution_end")({ toolCallId: "1", toolName: "edit", isError: false }, ctx);
	await host.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
	await host.handlers.get("agent_settled")({ aborted: false }, ctx);
	assert.ok(widget, "the closing line lingers for celebrateMs");
	assert.match(widget.render(100).join("\n"), /✗ Failed after/);
	assert.match(footer.render(100).join("\n"), /✗/);
	assert.ok(!footer.render(100).join("\n").includes("failed"), "the footer does not repeat the closing phrase");

	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(widget, undefined, "the closing line is cleared after celebrateMs");
	assert.match(footer.render(100).join("\n"), /ready/);
	assert.ok(renders > 0, "the animation asks the host to redraw");

	const command = host.commands.get("lively");
	assert.ok(command, "registers /lively");
	await command.handler("off", ctx);
	assert.equal(footer, undefined, "off restores the native footer");
	assert.equal(widget, undefined);
	assert.ok(notices.some(({ message }) => message.includes("lively off")));
	assert.deepEqual(
		workingCalls.slice(-2),
		[
			{ kind: "message", message: undefined },
			{ kind: "indicator", options: undefined },
		],
		"off restores Pi's working row",
	);

	await command.handler("on", ctx);
	assert.ok(footer, "on installs the footer again");
	await command.handler("status", ctx);
	assert.ok(notices.some(({ message }) => message.includes("lively on (session)")));

	await host.handlers.get("session_shutdown")();
	rmSync(settingsFile);
}

// 47. Non-TUI modes never install a footer or a widget, and a broken settings
// file is reported once instead of on every turn.
{
	const lively = await jiti.import("../extensions/lively.ts");
	const { default: livelyExtension } = lively;

	const plainCalls = [];
	const plainHandlers = new Map();
	const plainPi = {
		on(event, handler) {
			plainHandlers.set(event, handler);
			return () => {};
		},
		registerCommand() {},
		getThinkingLevel: () => "high",
		getSessionName: () => undefined,
		getSettings: () => ({}),
	};
	const plainCtx = {
		mode: "print",
		hasUI: false,
		cwd: "/home/me/proj",
		ui: {
			setFooter: () => plainCalls.push("footer"),
			setWidget: () => plainCalls.push("widget"),
			notify: () => plainCalls.push("notify"),
			setStatus: () => plainCalls.push("status"),
		},
	};

	livelyExtension(plainPi);
	await plainHandlers.get("session_start")({}, plainCtx);
	await plainHandlers.get("agent_start")({}, plainCtx);
	await plainHandlers.get("agent_settled")({ aborted: false }, plainCtx);
	assert.deepEqual(plainCalls, [], "headless modes get no UI surface");
	await plainHandlers.get("session_shutdown")();

	writeFileSync(settingsFile, "{ nope");
	const badNotices = [];
	const badHandlers = new Map();
	const badPi = {
		on(event, handler) {
			badHandlers.set(event, handler);
			return () => {};
		},
		registerCommand() {},
		getThinkingLevel: () => "high",
		getSessionName: () => undefined,
		getSettings: () => ({}),
	};
	const badCtx = {
		mode: "tui",
		hasUI: true,
		cwd: "/home/me/proj",
		ui: {
			setFooter() {},
			setWidget() {},
			notify: (message) => badNotices.push(message),
			setWorkingMessage() {},
			setWorkingIndicator() {},
			setStatus() {},
		},
	};

	livelyExtension(badPi);
	await badHandlers.get("session_start")({}, badCtx);
	await badHandlers.get("agent_start")({}, badCtx);
	await badHandlers.get("turn_start")({}, badCtx);
	assert.equal(badNotices.length, 1, "a broken settings file is reported once per session");
	assert.match(badNotices[0], /not valid JSON/);
	await badHandlers.get("session_shutdown")();
	rmSync(settingsFile);
}

// ---- engineer -------------------------------------------------------------

const engineerModule = await jiti.import("../extensions/engineer.ts");
const engineerHandlers = new Map();
const engineerCommands = new Map();
engineerModule.default({
	on: (name, handler) => {
		engineerHandlers.set(name, handler);
	},
	registerCommand: (name, options) => {
		engineerCommands.set(name, options);
	},
});

const { buildCharter, CHARTER_SIGNATURE } = await jiti.import("../src/engineer/charter.ts");
const { applyRole, detectCapabilities } = await jiti.import("../src/engineer/prompt.ts");
const { defaultEngineerSettings, loadEngineerSettings, resolvePromptFile } = await jiti.import(
	"../src/engineer/settings.ts",
);

const piPreamble =
	"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const piTail = [
	"<tools>",
	"- read: Read file contents",
	"- bash: Execute bash commands",
	"- ask_user: Ask the user a question with selectable options",
	"</tools>",
	"",
	"<rules>",
	"- Use bash for file operations like ls, rg, find",
	"- Use ask_user when a decision changes what you build",
	"</rules>",
	"",
	"<docs>",
	"Pi documentation: /pi/docs",
	"</docs>",
	"",
	"<project_context>",
	"<project_instructions path=\"AGENTS.md\">tabs in TS</project_instructions>",
	"</project_context>",
	"",
	"<cwd>",
	"/home/me/proj",
	"</cwd>",
].join("\n");
const piPrompt = `${piPreamble}\n\n${piTail}`;

function engineerCtx({ mode = "tui", options = {}, withoutOptions = false } = {}) {
	const notices = [];
	const statuses = [];
	const ctx = {
		mode,
		hasUI: mode !== "print",
		cwd: "/home/me/proj",
		ui: {
			notify: (message, level) => notices.push({ message, level: level ?? "info" }),
			setStatus: (id, value) => statuses.push({ id, value }),
		},
		...(withoutOptions
			? {}
			: {
					getSystemPromptOptions: () => ({
						selectedTools: ["read", "bash", "ask_user", "subagent"],
						hiddenTools: [],
						cwd: "/home/me/proj",
						...options,
					}),
				}),
	};
	return { ctx, notices, statuses };
}

function engineerEvent(prompt, options = {}) {
	return {
		type: "before_agent_start",
		messageType: "user",
		prompt: "do it",
		images: [],
		systemPrompt: prompt,
		systemPromptOptions: {
			selectedTools: ["read", "bash", "ask_user", "subagent"],
			hiddenTools: [],
			toolSnippets: { read: "Read file contents" },
			toolGuidelines: {},
			promptGuidelines: [],
			sections: {},
			appendSystemPrompt: "",
			cwd: "/home/me/proj",
			contextFiles: [],
			skills: [],
			...options,
		},
	};
}

// 48. The charter is a pure function of capabilities: identical text on every
// render (a prompt that changes between turns is a cache miss on every request),
// with no cwd or date leaking into it, and no block naming a tool that is absent.
{
	const both = buildCharter({ askUser: true, subagents: true });
	assert.equal(both, buildCharter({ askUser: true, subagents: true }), "byte-stable");
	assert.ok(both.startsWith(CHARTER_SIGNATURE));
	assert.match(both, /ask_user/);
	assert.match(both, /explicit authorization for delegation/);
	assert.match(both, /0-2 act/);
	assert.ok(!/\/home\/|\d{4}-\d{2}-\d{2}/.test(both), "no cwd or date leaks into the prompt");

	const neither = buildCharter({ askUser: false, subagents: false });
	assert.match(neither, /ask directly and stop/);
	assert.ok(!neither.includes("ask_user"), "a missing tool is never promised");
	assert.match(neither, /No delegation tool is active/);
	assert.match(neither, /never claim to/);
}

// 49. role mode swaps only the identity head: every generated section survives
// byte-for-byte. A user-owned identity (SYSTEM.md) or an unknown head is never
// destroyed, and a second pass cannot duplicate the role block.
{
	const charter = buildCharter({ askUser: true, subagents: true });
	const replaced = applyRole(piPrompt, charter);
	assert.equal(replaced.applied, "replaced");
	assert.ok(replaced.prompt.startsWith(CHARTER_SIGNATURE));
	assert.ok(replaced.prompt.endsWith(piTail), "tools, rules, docs, context and cwd survive intact");
	assert.ok(!replaced.prompt.includes("You are a coding assistant"));
	assert.match(replaced.prompt, /<rules>\n- Use bash/);
	assert.match(replaced.prompt, /<cwd>\n\/home\/me\/proj/);

	const userOwned = applyRole(piPrompt, charter, { userPrompt: true });
	assert.equal(userOwned.applied, "appended");
	assert.ok(userOwned.prompt.startsWith(piPrompt), "the user's head is untouched");
	assert.ok(userOwned.prompt.includes("<engineer_role>"));
	assert.equal(applyRole(userOwned.prompt, charter).applied, "unchanged", "idempotent");

	const foreign = piPrompt.replace(
		"You are a coding assistant running inside pi, a coding agent harness.",
		"You are a pirate.",
	);
	const appended = applyRole(foreign, charter);
	assert.equal(appended.applied, "appended", "an unknown identity is never destroyed");
	assert.ok(appended.prompt.includes("You are a pirate."));

	const noSections = applyRole(piPreamble, charter);
	assert.equal(noSections.applied, "replaced");
	assert.equal(noSections.prompt, charter.trim(), "a bare preamble is fully replaced");
}

// 50. Capabilities come from the active loadout, not from what is installed: a
// hidden tool is not callable, and the subagent loader counts as delegation.
{
	assert.deepEqual(detectCapabilities(undefined), { askUser: false, subagents: false });
	assert.deepEqual(detectCapabilities({ selectedTools: ["read", "ask_user", "subagent"] }), {
		askUser: true,
		subagents: true,
	});
	assert.deepEqual(
		detectCapabilities({ selectedTools: ["ask_user", "subagent"], hiddenTools: ["ask_user", "subagent"] }),
		{ askUser: false, subagents: false },
		"hidden declarations are not callable",
	);
	assert.equal(detectCapabilities({ selectedTools: ["subagents_enable"] }).subagents, true);
	assert.equal(detectCapabilities({ selectedTools: ["subagent_supervisor"] }).subagents, true);
	assert.equal(detectCapabilities({ selectedTools: ["read", "bash"] }).askUser, false);
}

// 51. Settings: role mode is on by default, the prompt file resolves against the
// agent directory (never the cwd), and a malformed file throws with its path so
// the extension can report it instead of silently ignoring it.
{
	rmSync(settingsFile, { force: true });
	assert.deepEqual(loadEngineerSettings(settingsFile), defaultEngineerSettings());
	assert.equal(defaultEngineerSettings().enabled, true, "role mode is on by default");

	writeFileSync(settingsFile, JSON.stringify({ engineer: { enabled: false, promptFile: " team/engineer.md " } }));
	const settings = loadEngineerSettings(settingsFile);
	assert.equal(settings.enabled, false);
	assert.equal(resolvePromptFile(settings, agentDir), join(agentDir, "team/engineer.md"));
	assert.equal(resolvePromptFile({ enabled: true }, agentDir), join(agentDir, "engineer.md"));

	const absolute = join(agentDir, "absolute.md");
	assert.equal(resolvePromptFile({ enabled: true, promptFile: absolute }, agentDir), absolute);
	rmSync(settingsFile);

	writeFileSync(settingsFile, "{ nope");
	assert.throws(() => loadEngineerSettings(settingsFile), /not valid JSON/);
	rmSync(settingsFile);
}

// 52. The lifecycle wiring: the handler replaces the head, honours the file
// switch and the session override, uses a user charter verbatim, falls back on
// an empty one with a single notice, and appends when SYSTEM.md owns the identity.
{
	rmSync(settingsFile, { force: true });
	rmSync(join(agentDir, "engineer.md"), { force: true });
	const { ctx, notices, statuses } = engineerCtx();
	await engineerHandlers.get("session_start")({}, ctx);
	assert.equal(statuses.at(-1).value, "engineer: role");

	const on = await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx);
	assert.ok(on.systemPrompt.startsWith(CHARTER_SIGNATURE));
	assert.ok(on.systemPrompt.endsWith(piTail));

	writeFileSync(settingsFile, JSON.stringify({ engineer: { enabled: false } }));
	assert.equal(await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx), undefined);

	await engineerCommands.get("engineer").handler("on", ctx);
	assert.ok((await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx)).systemPrompt);
	await engineerCommands.get("engineer").handler("off", ctx);
	assert.equal(await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx), undefined);

	rmSync(settingsFile);
	await engineerHandlers.get("session_start")({}, ctx);

	writeFileSync(join(agentDir, "engineer.md"), "MY CHARTER\n");
	const custom = await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx);
	assert.ok(custom.systemPrompt.startsWith("MY CHARTER"));
	assert.ok(!notices.some((notice) => notice.level === "error"), "a missing settings file is not an error");

	writeFileSync(join(agentDir, "engineer.md"), "   \n");
	const fallback = await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx);
	assert.ok(fallback.systemPrompt.startsWith(CHARTER_SIGNATURE));
	assert.equal(
		notices.filter((notice) => notice.level === "error" && /is empty/.test(notice.message)).length,
		1,
		"an empty charter is reported once",
	);
	rmSync(join(agentDir, "engineer.md"), { force: true });

	const appended = await engineerHandlers.get("before_agent_start")(
		engineerEvent(piPrompt, { customPrompt: "You are a custom agent." }),
		ctx,
	);
	assert.ok(appended.systemPrompt.startsWith(piPrompt), "SYSTEM.md keeps its identity");
	assert.match(appended.systemPrompt, /<engineer_role>/);
}

// 53. A malformed settings file disables the role and is reported once, not on
// every turn: a broken config must be visible without flooding the transcript.
{
	writeFileSync(settingsFile, "{ nope");
	const { ctx, notices } = engineerCtx();
	await engineerHandlers.get("session_start")({}, ctx);
	assert.equal(await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx), undefined);
	assert.equal(await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx), undefined);
	assert.equal(notices.filter((notice) => notice.level === "error").length, 1);
	assert.match(notices[0].message, /not valid JSON/);
	rmSync(settingsFile);
}

// 54. The command surface: status names the source and the detected tools, the
// session override wins over the file, show previews the effective charter, and
// an unknown action is an error instead of a silent no-op.
{
	rmSync(settingsFile, { force: true });
	rmSync(join(agentDir, "engineer.md"), { force: true });
	const { ctx, notices, statuses } = engineerCtx();
	const command = engineerCommands.get("engineer");
	assert.deepEqual(command.getArgumentCompletions("o").map((item) => item.value), ["on", "off"]);
	assert.equal(command.getArgumentCompletions("").length, 5);

	await engineerHandlers.get("session_start")({}, ctx);
	await command.handler("status", ctx);
	assert.match(notices.at(-1).message, /engineer role on \(settings\)/);
	assert.match(notices.at(-1).message, /tools: ask_user, subagent/);

	await command.handler("off", ctx);
	assert.equal(statuses.at(-1).value, "engineer: off");
	assert.match(notices.at(-1).message, /off for this session/);
	await command.handler("on", ctx);
	assert.equal(statuses.at(-1).value, "engineer: role");

	await command.handler("show", ctx);
	assert.match(notices.at(-1).message, /built-in:/);
	assert.ok(notices.at(-1).message.includes(CHARTER_SIGNATURE));

	await command.handler("", ctx);
	assert.match(notices.at(-1).message, /engineer role on/);

	const withSystem = engineerCtx({ options: { customPrompt: "custom" } });
	await command.handler("status", withSystem.ctx);
	assert.match(withSystem.notices.at(-1).message, /SYSTEM\.md is set/);

	await command.handler("nonsense", ctx);
	assert.match(notices.at(-1).message, /unknown action: nonsense/);
}

// 55. `/engineer init` writes the effective charter, refuses to overwrite it
// without --force, and the next turn uses the file verbatim. Nothing writes a
// status line outside tui mode, and a host without prompt options still works.
{
	rmSync(settingsFile, { force: true });
	const file = join(agentDir, "engineer.md");
	rmSync(file, { force: true });
	const { ctx, notices } = engineerCtx();
	const command = engineerCommands.get("engineer");

	await command.handler("init", ctx);
	assert.ok(existsSync(file));
	const written = readFileSync(file, "utf8");
	assert.match(written, /ask_user/);
	assert.match(written, /explicit authorization for delegation/);
	assert.match(notices.at(-1).message, /wrote .*engineer\.md/);

	await command.handler("init", ctx);
	assert.match(notices.at(-1).message, /already exists/);

	writeFileSync(file, "OLD\n");
	await command.handler("init --force", ctx);
	assert.ok(readFileSync(file, "utf8").startsWith(CHARTER_SIGNATURE));

	writeFileSync(file, "TEAM CHARTER\n");
	const result = await engineerHandlers.get("before_agent_start")(engineerEvent(piPrompt), ctx);
	assert.ok(result.systemPrompt.startsWith("TEAM CHARTER"));
	rmSync(file, { force: true });

	const rpc = engineerCtx({ mode: "rpc" });
	await engineerHandlers.get("session_start")({}, rpc.ctx);
	assert.equal(rpc.statuses.length, 0, "no status writes outside tui");

	const bare = { mode: "print", hasUI: false, cwd: "/x", ui: { notify: () => {}, setStatus: () => {} } };
	await engineerHandlers.get("session_start")({}, bare);
	assert.equal(await command.handler("status", bare), undefined, "a host without prompt options still reports");
}

rmSync(agentDir, { recursive: true, force: true });

console.log("smoke: all checks passed");
