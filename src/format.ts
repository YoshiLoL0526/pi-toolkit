import type { AskDetails, AskOutcome, AskRequest, AskResponse } from "./types.js";

export const CANCELLED_TEXT =
	"User dismissed the question without answering. Do not re-ask the same question: continue with your best judgment, or ask in plain text at the end of your turn.";

export const CANCELLED_BATCH_TEXT =
	"User cancelled the questions before submitting. Do not re-ask the same questions: continue with your best judgment, or ask in plain text at the end of your turn.";

export const HEADLESS_TEXT =
	"There is no interactive UI in this mode, so the user was not asked. Ask the question in plain text in your final message and end your turn.";

export function emptyOutcome(request: AskRequest): AskOutcome {
	return { responses: request.questions.map(() => null), cancelled: true };
}

/** Compact human/model readable answer used by the review page and renderers. */
export function summarizeResponse(response: AskResponse | null): string {
	if (!response) return "not answered";
	if (response.kind === "freeform") return response.text;

	const labels = response.labels.map((label, i) => {
		const index = response.indexes[i];
		return index ? `${index}. ${label}` : label;
	});
	const base = labels.join(", ");
	return response.text ? `${base} — also wrote: ${response.text}` : base;
}

/** Model-facing summary for one question. Explicit index + label beats a bare value. */
export function formatResponse(response: AskResponse): string {
	if (response.kind === "freeform") {
		return `User wrote: ${response.text}`;
	}

	const parts = response.labels.map((label, i) => {
		const index = response.indexes[i];
		return index ? `${index}. ${label}` : label;
	});
	const selected = `User selected: ${parts.join(", ")}`;
	return response.text ? `${selected}\nUser also wrote: ${response.text}` : selected;
}

export function formatOutcome(request: AskRequest, outcome: AskOutcome): string {
	if (outcome.cancelled) {
		return request.questions.length > 1 ? CANCELLED_BATCH_TEXT : CANCELLED_TEXT;
	}

	if (request.questions.length === 1) {
		const response = outcome.responses[0] ?? null;
		return response ? formatResponse(response) : "User did not answer the question.";
	}

	return request.questions
		.map((question, i) => {
			const label = question.label ?? `Q${i + 1}`;
			const response = outcome.responses[i] ?? null;
			return `${label}. ${question.question}\nAnswer: ${response ? formatResponse(response) : "skipped"}`;
		})
		.join("\n\n");
}

export function toDetails(request: AskRequest, outcome: AskOutcome): AskDetails {
	if (request.questions.length > 1) {
		return {
			kind: "batch",
			...(request.heading ? { heading: request.heading } : {}),
			questions: request.questions.map((question, i) => ({
				label: question.label ?? `Q${i + 1}`,
				question: question.question,
				...(question.context ? { context: question.context } : {}),
				options: question.options,
				allowMultiple: question.allowMultiple,
				allowFreeform: question.allowFreeform,
			})),
			answers: outcome.responses,
			cancelled: outcome.cancelled,
		};
	}

	const question = request.questions[0]!;
	return {
		kind: "single",
		question: question.question,
		...(question.context ? { context: question.context } : {}),
		options: question.options,
		allowMultiple: question.allowMultiple,
		allowFreeform: question.allowFreeform,
		response: outcome.responses[0] ?? null,
		cancelled: outcome.cancelled,
	};
}
