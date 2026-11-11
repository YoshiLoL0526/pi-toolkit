import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AskDetails } from "./types.js";
import type { AskUserParams } from "./schema.js";

/** Renders stored tool-call arguments; defensive because resumed sessions may hold older shapes. */
export function renderCall(args: AskUserParams, theme: Theme): Component {
	const question = typeof args?.question === "string" ? args.question.trim() : "";
	const lines = [theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", question)];

	const context = typeof args?.context === "string" ? args.context.trim() : "";
	if (context) lines.push(theme.fg("dim", `  ${context}`));

	const options = Array.isArray(args?.options) ? args.options : [];
	options.forEach((option, i) => {
		const label = typeof option?.label === "string" ? option.label.trim() : "";
		if (!label) return;
		const description = typeof option?.description === "string" ? option.description.trim() : "";
		const suffix = description ? theme.fg("dim", ` — ${description}`) : "";
		lines.push(theme.fg("muted", `  ${i + 1}. ${label}`) + suffix);
	});

	return new Text(lines.join("\n"), 0, 0);
}

/** Renders the stored answer. Falls back to the model-facing text when details are missing. */
export function renderResult(result: { content: { type: string; text?: string }[]; details?: unknown }, _options: unknown, theme: Theme): Component {
	const details = result.details as AskDetails | undefined;

	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" && text.text ? text.text : "", 0, 0);
	}

	if (!details.response) {
		return new Text(theme.fg("warning", "Cancelled — no answer"), 0, 0);
	}

	if (details.response.kind === "freeform") {
		return new Text(
			theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.response.text),
			0,
			0,
		);
	}

	const labels = details.response.labels;
	const indexes = details.response.indexes;
	const display = labels.map((label, i) => {
		const index = indexes[i];
		return index ? `${index}. ${label}` : label;
	});
	return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display.join(", ")), 0, 0);
}
