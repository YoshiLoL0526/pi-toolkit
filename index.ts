import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserParameters, normalizeParams } from "./src/schema.js";
import { promptGuidelines, promptSnippet } from "./src/prompt.js";
import { CANCELLED_TEXT, HEADLESS_TEXT, formatResponse, toDetails } from "./src/format.js";
import { askInTui } from "./src/ui/question.js";
import { askWithDialogs } from "./src/ui/fallback.js";
import { renderCall, renderResult } from "./src/render.js";
import type { AskDetails, AskResponse } from "./src/types.js";

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof askUserParameters, AskDetails>({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user a question and wait for their answer before continuing. Use it when a decision needs their input: offer concrete options, or omit them to collect a written answer.",
		promptSnippet,
		promptGuidelines,
		parameters: askUserParameters,
		// One prompt at a time: a second overlapping question would steal input focus.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = normalizeParams(params);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: HEADLESS_TEXT }],
					details: toDetails(config, null),
				};
			}

			const result =
				ctx.mode === "tui"
					? await askInTui(config, ctx, signal)
					: await askWithDialogs(config, ctx, signal);

			if (!result) {
				return {
					content: [{ type: "text", text: CANCELLED_TEXT }],
					details: toDetails(config, null),
				};
			}

			const response: AskResponse =
				result.kind === "selection"
					? { kind: "selection", labels: [result.label], indexes: [result.index] }
					: { kind: "freeform", text: result.text };

			return {
				content: [{ type: "text", text: formatResponse(config, response) }],
				details: toDetails(config, response),
			};
		},

		renderCall,
		renderResult,
	});
}
