import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AskDetails, AskResponse } from "./types.js";
import type { AskUserParams } from "./schema.js";

function answerText(response: AskResponse | null, theme: Theme): string {
	if (!response) return theme.fg("warning", "— not answered");
	if (response.kind === "freeform") {
		return `${theme.fg("success", "✓")} ${theme.fg("muted", "(wrote) ")}${theme.fg("accent", response.text)}`;
	}
	const labels = response.labels.map((label, i) => {
		const index = response.indexes[i];
		return index ? `${index}. ${label}` : label;
	});
	const base = `${theme.fg("success", "✓")} ${theme.fg("accent", labels.join(", "))}`;
	return response.text ? `${base} ${theme.fg("muted", `— also wrote: ${response.text}`)}` : base;
}

/** Renders stored tool-call arguments; defensive because resumed sessions may hold older shapes. */
export function renderCall(args: AskUserParams, theme: Theme): Component {
	const questions = Array.isArray(args?.questions) ? args.questions : [];
	if (questions.length > 0) {
		const heading = typeof args?.question === "string" ? args.question.trim() : "";
		const lines = [
			theme.fg("toolTitle", theme.bold("ask_user ")) +
				theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`) +
				(heading ? theme.fg("dim", ` — ${heading}`) : ""),
		];
		questions.forEach((question, i) => {
			const label = typeof question?.label === "string" && question.label.trim() ? question.label.trim() : `Q${i + 1}`;
			const text = typeof question?.question === "string" ? question.question.trim() : "";
			if (text) lines.push(theme.fg("muted", `  ${label}. `) + theme.fg("dim", text));
		});
		return new Text(lines.join("\n"), 0, 0);
	}

	const question = typeof args?.question === "string" ? args.question.trim() : "";
	const lines = [theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", question)];

	const context = typeof args?.context === "string" ? args.context.trim() : "";
	if (context) lines.push(theme.fg("dim", `  ${context}`));

	const options = Array.isArray(args?.options) ? args.options : [];
	const multiple = args?.allowMultiple === true;
	options.forEach((option, i) => {
		const label = typeof option?.label === "string" ? option.label.trim() : "";
		if (!label) return;
		const box = multiple ? "[ ] " : "";
		const description = typeof option?.description === "string" ? option.description.trim() : "";
		const suffix = description ? theme.fg("dim", ` — ${description}`) : "";
		lines.push(theme.fg("muted", `  ${box}${i + 1}. ${label}`) + suffix);
	});

	return new Text(lines.join("\n"), 0, 0);
}

/** Renders the stored answer. Accepts v1 single details that have no `kind`. */
export function renderResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	_options: unknown,
	theme: Theme,
): Component {
	const details = result.details as AskDetails | undefined;

	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" && text.text ? text.text : "", 0, 0);
	}

	if (details.kind === "batch") {
		if (details.cancelled) {
			return new Text(theme.fg("warning", "Cancelled — no answers"), 0, 0);
		}
		const lines = details.questions.map((question, i) => {
			const label = theme.fg("accent", `${question.label}:`);
			const answer = answerText(details.answers[i] ?? null, theme);
			return `${label} ${answer}`;
		});
		return new Text(lines.join("\n"), 0, 0);
	}

	if (details.cancelled || !details.response) {
		return new Text(theme.fg("warning", "Cancelled — no answer"), 0, 0);
	}

	return new Text(answerText(details.response, theme), 0, 0);
}
