import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { AskConfig, AskOutcome, AskRequest, AskResponse } from "../types.js";

/**
 * Dialog fallback for RPC and other non-TUI surfaces. `ctx.ui.custom()` is not
 * available there, so every question becomes one or more select/input dialogs.
 *
 * Multi-select degrades to a loop: pick an option to toggle it, then "Done".
 * A batch is asked sequentially and has no review page; cancelling any
 * question cancels the whole batch. A `timeout` is one deadline for the whole
 * call, passed down to each dialog as its remaining time.
 */
export async function askWithDialogs(
	request: AskRequest,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskOutcome> {
	const nullResponses = () => request.questions.map(() => null);
	const deadline = request.timeout ? Date.now() + request.timeout : undefined;
	const expired = () => deadline !== undefined && Date.now() >= deadline;

	const responses: (AskResponse | null)[] = [];

	for (const question of request.questions) {
		if (signal?.aborted || expired()) {
			return { responses: nullResponses(), cancelled: true, ...(expired() ? { timedOut: true } : {}) };
		}
		const response = await askOne(question, ctx, signal, deadline);
		if (!response) {
			return { responses: nullResponses(), cancelled: true, ...(expired() ? { timedOut: true } : {}) };
		}
		responses.push(response);
	}

	return { responses, cancelled: false };
}

function dialogOptions(signal: AbortSignal | undefined, deadline: number | undefined): ExtensionUIDialogOptions {
	const options: ExtensionUIDialogOptions = signal ? { signal } : {};
	if (deadline) options.timeout = Math.max(1, deadline - Date.now());
	return options;
}

function dialogTitle(question: AskConfig): string {
	return question.context ? `${question.question}\n\n${question.context}` : question.question;
}

async function askOne(
	question: AskConfig,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	deadline: number | undefined,
): Promise<AskResponse | null> {
	if (signal?.aborted) return null;

	if (question.options.length === 0) {
		const text = await ctx.ui.input(
			question.question,
			question.context ?? "Type your answer",
			dialogOptions(signal, deadline),
		);
		const trimmed = text?.trim();
		return trimmed ? { kind: "freeform", text: trimmed } : null;
	}

	if (question.allowMultiple) {
		return askMultiple(question, ctx, signal, deadline);
	}

	const labels = question.options.map((option, i) => `${i + 1}. ${option.label}`);
	const choices = question.allowFreeform ? [...labels, "Other (type your own)"] : labels;
	const picked = await ctx.ui.select(dialogTitle(question), choices, dialogOptions(signal, deadline));
	if (picked === undefined) return null;

	const index = choices.indexOf(picked);
	if (index < 0) return null;

	if (question.allowFreeform && index === labels.length) {
		return inputAnswer(question, ctx, signal, deadline);
	}

	const option = question.options[index];
	if (!option) return null;
	return { kind: "selection", labels: [option.label], indexes: [index + 1] };
}

async function inputAnswer(
	question: AskConfig,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	deadline: number | undefined,
): Promise<AskResponse | null> {
	const text = await ctx.ui.input("Your answer", question.context ?? "", dialogOptions(signal, deadline));
	const trimmed = text?.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : null;
}

async function askMultiple(
	question: AskConfig,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	deadline: number | undefined,
): Promise<AskResponse | null> {
	const chosen = new Set<number>();
	let text: string | undefined;

	while (!signal?.aborted && !(deadline !== undefined && Date.now() >= deadline)) {
		const labels = question.options.map(
			(option, i) => `${chosen.has(i) ? "✓ " : ""}${i + 1}. ${option.label}`,
		);
		const doneIndex = labels.length;
		const otherIndex = question.allowFreeform ? labels.length + 1 : -1;
		const done = chosen.size > 0 ? `Done (${chosen.size} selected)` : "Done";
		const choices = [...labels, done, ...(question.allowFreeform ? ["Other (type your own)"] : [])];

		const status =
			chosen.size > 0 || text ? "Toggle options, then choose Done." : "Select one or more options.";
		const picked = await ctx.ui.select(
			`${dialogTitle(question)}\n\n${status}`,
			choices,
			dialogOptions(signal, deadline),
		);
		if (picked === undefined) return null;

		const index = choices.indexOf(picked);
		if (index < 0) return null;

		if (index < labels.length) {
			if (chosen.has(index)) chosen.delete(index);
			else chosen.add(index);
			continue;
		}

		if (index === otherIndex) {
			const written = await ctx.ui.input("Your answer", question.context ?? "", dialogOptions(signal, deadline));
			if (written === undefined) return null;
			if (written.trim()) text = written.trim();
			continue;
		}

		if (index === doneIndex) {
			const indexes = [...chosen].sort((a, b) => a - b).filter((i) => question.options[i]);
			const selectedLabels = indexes.map((i) => question.options[i]?.label ?? "");
			if (selectedLabels.length === 0 && !text) return null;
			return selectedLabels.length > 0
				? {
						kind: "selection",
						labels: selectedLabels,
						indexes: indexes.map((i) => i + 1),
						...(text ? { text } : {}),
				  }
				: { kind: "freeform", text: text ?? "" };
		}
	}

	return null;
}
