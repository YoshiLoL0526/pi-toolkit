import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserParameters, normalizeParams } from "./src/schema.js";
import { promptGuidelines, promptSnippet } from "./src/prompt.js";
import { HEADLESS_TEXT, emptyOutcome, formatOutcome, toDetails } from "./src/format.js";
import { askInTui } from "./src/ui/question.js";
import { askWithDialogs } from "./src/ui/fallback.js";
import { renderCall, renderResult } from "./src/render.js";

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user a question and wait for their answer before continuing. Offer options (single or multi-select) or omit them to collect a written answer. Use `questions` to ask 2-4 independent questions together with a review page.",
		promptSnippet,
		promptGuidelines,
		parameters: askUserParameters,
		// One prompt at a time: a second overlapping question would steal input focus.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = normalizeParams(params);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: HEADLESS_TEXT }],
					details: toDetails(request, emptyOutcome(request)),
				};
			}

			const outcome =
				ctx.mode === "tui"
					? await askInTui(request, ctx, signal)
					: await askWithDialogs(request, ctx, signal);

			return {
				content: [{ type: "text", text: formatOutcome(request, outcome) }],
				details: toDetails(request, outcome),
			};
		},

		renderCall,
		renderResult,
	});
}
