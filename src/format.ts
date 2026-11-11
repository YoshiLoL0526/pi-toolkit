import type { AskConfig, AskDetails, AskResponse } from "./types.js";

export const CANCELLED_TEXT =
	"User dismissed the question without answering. Do not re-ask the same question: continue with your best judgment, or ask in plain text at the end of your turn.";

export const HEADLESS_TEXT =
	"There is no interactive UI in this mode, so the user was not asked. Ask the question in plain text in your final message and end your turn.";

/** Model-facing summary. Explicit index + label beats a bare value. */
export function formatResponse(config: AskConfig, response: AskResponse): string {
	if (response.kind === "freeform") {
		return `User wrote: ${response.text}`;
	}

	const parts = response.labels.map((label, i) => {
		const index = response.indexes[i];
		return index ? `${index}. ${label}` : label;
	});
	return `User selected: ${parts.join(", ")}`;
}

export function toDetails(
	config: AskConfig,
	response: AskResponse | null,
): AskDetails {
	return {
		question: config.question,
		...(config.context ? { context: config.context } : {}),
		options: config.options,
		allowFreeform: config.allowFreeform,
		response,
		cancelled: response === null,
	};
}
