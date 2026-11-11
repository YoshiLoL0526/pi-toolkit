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

rmSync(agentDir, { recursive: true, force: true });

console.log("smoke: all checks passed");
