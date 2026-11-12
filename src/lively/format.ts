/**
 * All lively text lives here: the activity line and the footer lines.
 *
 * Renderers receive the current snapshot and never mutate it, so a test can
 * assert exactly what the user sees without a terminal or a clock.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SpinnerStyle } from "./settings.js";
import type { TokenTotals } from "./stats.js";
import type { LivelyState, RunOutcome } from "./state.js";
import { currentTool, activeElapsedMs, elapsedMs, isWaiting } from "./state.js";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOT_FRAMES = ["·", "•", "●", "•"];
const PULSE_FRAMES = ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"];

const VERBS: Record<string, string> = {
	read: "reading",
	edit: "editing",
	write: "writing",
	bash: "running",
	powershell: "running",
	grep: "searching",
	glob: "finding",
	ls: "listing",
	find: "finding",
	web_search: "searching the web",
	fetch_content: "fetching",
	source_check: "checking sources",
	ask_user: "waiting for you",
	task: "delegating",
	todo: "planning",
};

export function spinnerFrame(style: SpinnerStyle, index: number): string {
	const frames = style === "dots" ? DOT_FRAMES : style === "pulse" ? PULSE_FRAMES : BRAILLE_FRAMES;
	return frames[((index % frames.length) + frames.length) % frames.length]!;
}

export function verbFor(toolName: string): string {
	return VERBS[toolName] ?? "using";
}

/** `0.8s` is noise on screen; anything under a second is simply `<1s`. */
export function formatElapsed(ms: number): string {
	if (ms < 1000) return "<1s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Compact token counts, matching the built-in footer's formatting. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** `~` instead of the home prefix, without assuming a POSIX separator. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const normalizedCwd = cwd.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedCwd === normalizedHome) return "~";
	if (normalizedCwd.startsWith(`${normalizedHome}/`)) {
		return `~/${normalizedCwd.slice(normalizedHome.length + 1)}`;
	}
	return cwd;
}

function outcomeGlyph(outcome: RunOutcome): string {
	if (outcome === "done") return "✓";
	if (outcome === "error") return "✗";
	return "■";
}

function outcomeWord(outcome: RunOutcome): string {
	if (outcome === "done") return "Done";
	if (outcome === "error") return "Failed";
	return "Stopped";
}

function outcomePhrase(outcome: RunOutcome, duration: string): string {
	const preposition = outcome === "done" ? "in" : "after";
	return `${outcomeWord(outcome)} ${preposition} ${duration}`;
}

function outcomeToken(outcome: RunOutcome): "success" | "error" | "warning" {
	if (outcome === "done") return "success";
	if (outcome === "error") return "error";
	return "warning";
}

function toolCount(tools: number): string {
	return `${tools} tool${tools === 1 ? "" : "s"}`;
}

function modelLabel(state: LivelyState): string {
	switch (state.modelPhase) {
		case "thinking":
			return "thinking";
		case "responding":
			return "responding";
		case "tools":
			return "preparing tools";
		default:
			return "waiting for the model";
	}
}

function stateGlyph(state: LivelyState, theme: Theme, style: SpinnerStyle, frameDivisor = 1): string {
	if (isWaiting(state)) return theme.fg("warning", "?");
	return theme.fg("accent", spinnerFrame(style, Math.floor(state.frame / frameDivisor)));
}

/** Drop the clock before cutting it in half; a truncated `<…` is worse than no clock. */
function fitActivity(withTime: string, withoutTime: string, width: number, theme: Theme): string {
	if (visibleWidth(withTime) <= width) return withTime;
	if (visibleWidth(withoutTime) <= width) return withoutTime;
	return truncateToWidth(withoutTime, width, theme.fg("dim", "…"));
}

/** The one line above the editor. Empty means the widget should not be shown. */
export function renderActivityLine(
	state: LivelyState,
	theme: Theme,
	width: number,
	now: number,
	style: SpinnerStyle,
): string {
	if (width <= 0 || state.phase === "idle") return "";

	if (state.phase === "settled") {
		const outcome = state.outcome ?? "done";
		const token = outcomeToken(outcome);
		const duration = formatElapsed(elapsedMs(state, now));
		const tools = state.tools > 0 ? ` ${theme.fg("dim", `· ${toolCount(state.tools)}`)}` : "";
		const text = `${theme.fg(token, outcomeGlyph(outcome))} ${theme.fg(token, outcomePhrase(outcome, duration))}${tools}`;
		return truncateToWidth(text, width, theme.fg("dim", "…"));
	}

	const elapsed = formatElapsed(activeElapsedMs(state, now));
	const glyph = stateGlyph(state, theme, style);
	const active = currentTool(state);
	const more = state.active.length > 1 ? ` ${theme.fg("dim", `+${state.active.length - 1}`)}` : "";
	const time = theme.fg("dim", `· ${elapsed}`);

	if (isWaiting(state)) {
		const base = `${glyph} ${theme.fg("warning", "waiting for you")}${more}`;
		return fitActivity(`${base} ${time}`, base, width, theme);
	}

	if (active) {
		const verb = theme.fg("muted", verbFor(active.name));
		const target = active.target ? ` ${theme.fg("text", active.target)}` : "";
		const base = `${glyph} ${verb}${target}${more}`;
		return fitActivity(`${base} ${time}`, base, width, theme);
	}

	const base = `${glyph} ${theme.fg("muted", modelLabel(state))}`;
	return fitActivity(`${base} ${time}`, base, width, theme);
}

export interface FooterSnapshot {
	state: LivelyState;
	now: number;
	theme: Theme;
	style: SpinnerStyle;
	totals: TokenTotals;
	context: { percent: number | null; contextWindow: number } | undefined;
	cwd: string;
	home: string | undefined;
	branch: string | null;
	sessionName: string | undefined;
	model: { id: string; provider?: string; reasoning?: boolean; contextWindow?: number } | undefined;
	thinking: string | undefined;
	providerCount: number;
	autoCompact: boolean;
	/** Whether the activity line is on; it chooses the settled phrase and never repeats the working word. */
	activity: boolean;
	statuses: ReadonlyMap<string, string>;
}

/** Two aligned sides, with the right one yielding first on a narrow terminal. */
function fitLine(left: string, right: string, width: number, theme: Theme): string {
	if (width <= 0) return "";
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = 2;

	if (leftWidth + gap + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const availableForRight = width - leftWidth - gap;
	if (availableForRight > 0 && rightWidth > 0) {
		const truncatedRight = truncateToWidth(right, availableForRight, "");
		const padding = Math.max(gap, width - leftWidth - visibleWidth(truncatedRight));
		return left + " ".repeat(padding) + truncatedRight;
	}

	return truncateToWidth(left, width, theme.fg("dim", "…"));
}

function phaseText(snapshot: FooterSnapshot): string {
	const { state, theme, style, now } = snapshot;

	if (state.phase === "settled") {
		const outcome = state.outcome ?? "done";
		const token = outcomeToken(outcome);
		const duration = formatElapsed(elapsedMs(state, now));
		const tools = state.tools > 0 ? theme.fg("dim", ` · ${toolCount(state.tools)}`) : "";
		if (snapshot.activity) {
			return `${theme.fg(token, outcomeGlyph(outcome))} ${theme.fg(token, duration)}${tools}`;
		}
		return `${theme.fg(token, outcomeGlyph(outcome))} ${theme.fg(token, outcomePhrase(outcome, duration).toLowerCase())}${tools}`;
	}

	if (state.phase === "working") {
		// The word comes from the activity line, or from Pi's working row when the
		// activity line is off. The footer adds only the pulse, the clock and the count;
		// a slower frame keeps it from looking like a second copy of the inline spinner.
		const glyph = stateGlyph(state, theme, style, 4);
		const time = theme.fg("dim", ` ${formatElapsed(elapsedMs(state, now))}`);
		const tools = state.tools > 0 ? theme.fg("dim", ` · ${toolCount(state.tools)}`) : "";
		return `${glyph}${time}${tools}`;
	}

	const last = state.lastRun;
	const suffix = last
		? theme.fg(
				"dim",
				` · last ${formatElapsed(last.durationMs)}${last.tools > 0 ? ` · ${toolCount(last.tools)}` : ""}`,
			)
		: "";
	return `${theme.fg("dim", "○ ready")}${suffix}`;
}

function locationText(snapshot: FooterSnapshot): string {
	const path = formatCwd(snapshot.cwd, snapshot.home);
	const branch = snapshot.branch ? ` (${snapshot.branch})` : "";
	const name = snapshot.sessionName ? ` • ${snapshot.sessionName}` : "";
	return `${path}${branch}${name}`;
}

function contextText(snapshot: FooterSnapshot): string {
	const context = snapshot.context;
	const window = context?.contextWindow ?? snapshot.model?.contextWindow ?? 0;
	const percent = context?.percent ?? null;

	if (percent === null) {
		const auto = snapshot.autoCompact ? " (auto)" : "";
		return snapshot.theme.fg("dim", window > 0 ? `ctx ?/${formatTokens(window)}${auto}` : `ctx ?${auto}`);
	}

	const rounded = Math.round(percent);
	const auto = snapshot.autoCompact ? " (auto)" : "";
	const text =
		window > 0 ? `ctx ${rounded}%/${formatTokens(window)}${auto}` : `ctx ${rounded}%${auto}`;
	if (percent > 90) return snapshot.theme.fg("error", text);
	if (percent > 70) return snapshot.theme.fg("warning", text);
	return snapshot.theme.fg("dim", text);
}

function statsText(snapshot: FooterSnapshot): string {
	const parts: string[] = [];
	const totals = snapshot.totals;
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead || totals.cacheWrite) && totals.latestCacheHitRate !== undefined) {
		parts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

	const usage = parts.map((part) => snapshot.theme.fg("dim", part)).join(" ");
	const context = contextText(snapshot);
	return usage ? `${usage} ${context}` : context;
}

function modelText(snapshot: FooterSnapshot): string {
	const model = snapshot.model;
	if (!model) return "no model";

	let text = model.id;
	if (model.reasoning) {
		text += ` • ${snapshot.thinking && snapshot.thinking !== "off" ? snapshot.thinking : "thinking off"}`;
	}
	if (snapshot.providerCount > 1 && model.provider) {
		text = `(${model.provider}) ${text}`;
	}
	return text;
}

/** Same sanitizing rule as the built-in footer: statuses are single-line, colors preserved. */
export function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function renderFooterLines(snapshot: FooterSnapshot, width: number): string[] {
	if (width <= 0) return [];
	const { theme } = snapshot;

	const lines = [
		fitLine(phaseText(snapshot), theme.fg("dim", locationText(snapshot)), width, theme),
		fitLine(statsText(snapshot), theme.fg("dim", modelText(snapshot)), width, theme),
	];

	if (snapshot.statuses.size > 0) {
		const statuses = Array.from(snapshot.statuses.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, text]) => sanitizeStatus(text))
			.filter(Boolean)
			.join("  ");
		if (statuses) lines.push(truncateToWidth(statuses, width, theme.fg("dim", "…")));
	}

	return lines;
}
