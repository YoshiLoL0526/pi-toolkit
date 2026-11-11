import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserParameters, normalizeParams } from "../src/schema.js";
import { promptGuidelines, promptSnippet } from "../src/prompt.js";
import { HEADLESS_TEXT, emptyOutcome, formatOutcome, toDetails } from "../src/format.js";
import { DEFAULT_FILTER_THRESHOLD, applySettings, loadSettings } from "../src/config.js";
import { askInTui } from "../src/ui/question.js";
import { askWithDialogs } from "../src/ui/fallback.js";
import { renderCall, renderResult } from "../src/render.js";

/** Announced on the shared bus so a notification extension can name the question. */
const ASK_WAITING = "pi-toolkit:ask:waiting";
const ASK_SETTLED = "pi-toolkit:ask:settled";

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
			const settings = loadSettings();
			const request = applySettings(normalizeParams(params), settings);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: HEADLESS_TEXT }],
					details: toDetails(request, emptyOutcome(request)),
				};
			}

			// Emitted around the wait, not around the answer: a listener needs the
			// question text while the prompt is blocked on the user.
			pi.events?.emit(ASK_WAITING, {
				question: request.heading ?? request.questions[0]?.question ?? "",
			});

			let outcome;
			try {
				outcome =
					ctx.mode === "tui"
						? await askInTui(request, ctx, signal, {
								filterThreshold: settings.filterThreshold ?? DEFAULT_FILTER_THRESHOLD,
						  })
						: await askWithDialogs(request, ctx, signal);
			} finally {
				pi.events?.emit(ASK_SETTLED, undefined);
			}

			return {
				content: [{ type: "text", text: formatOutcome(request, outcome) }],
				details: toDetails(request, outcome),
			};
		},

		renderCall,
		renderResult,
	});
}
