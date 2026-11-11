import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskConfig, AskUiResult } from "../types.js";

const OTHER_LABEL = "Other (type your own)";

/**
 * RPC (and any non-TUI surface with dialogs) fallback. `ctx.ui.custom()` is not
 * available there, so the same question is asked through select/input.
 */
export async function askWithDialogs(
	config: AskConfig,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskUiResult> {
	if (signal?.aborted) return null;

	if (config.options.length === 0) {
		const text = await ctx.ui.input(config.question, config.context ?? "Type your answer", { signal });
		return text?.trim() ? { kind: "freeform", text: text.trim() } : null;
	}

	const labels = config.options.map((option, i) =>
		option.description ? `${i + 1}. ${option.label} — ${option.description}` : `${i + 1}. ${option.label}`,
	);
	const choices = config.allowFreeform ? [...labels, OTHER_LABEL] : labels;

	const picked = await ctx.ui.select(config.question, choices, { signal });
	if (picked === undefined) return null;

	const index = choices.indexOf(picked);
	if (index < 0) return null;

	if (config.allowFreeform && index === labels.length) {
		const text = await ctx.ui.input("Your answer", config.context ?? "", { signal });
		return text?.trim() ? { kind: "freeform", text: text.trim() } : null;
	}

	const option = config.options[index];
	if (!option) return null;
	return { kind: "selection", label: option.label, index: index + 1 };
}
