import { type Static, Type } from "typebox";
import type { AskConfig, AskOption } from "./types.js";

const MAX_OPTIONS = 8;

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label shown in the option list" }),
	description: Type.Optional(
		Type.String({ description: "One line explaining what picking this option implies" }),
	),
});

/**
 * Flat object on purpose: `anyOf` is stripped or rejected by some provider
 * proxies, so "open question" is expressed by omitting `options` instead of a
 * union type.
 */
export const askUserParameters = Type.Object({
	question: Type.String({
		description: "The question to ask. One concrete, self-contained sentence.",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"Supporting evidence or the trade-off being decided. Shown above the question, not repeated in it.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: MAX_OPTIONS,
			description:
				"2-5 concrete choices. Omit entirely for an open-ended question that needs a written answer.",
		}),
	),
	allowFreeform: Type.Optional(
		Type.Boolean({
			description: "Offer an 'Other' free-text answer next to the options (default: true).",
		}),
	),
});

export type AskUserParams = Static<typeof askUserParameters>;

function cleanLabel(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Accepts the validated schema and returns the shape the rest of the extension
 * uses. Throws on input that cannot produce a usable question; Pi reports the
 * throw as a failed tool call instead of a bogus answer.
 */
export function normalizeParams(params: AskUserParams): AskConfig {
	const question = cleanLabel(params.question);
	if (!question) {
		throw new Error("ask_user needs a non-empty `question`.");
	}

	const options: AskOption[] = [];
	for (const raw of params.options ?? []) {
		const label = cleanLabel(raw.label);
		if (!label) continue;
		const description = cleanLabel(raw.description);
		options.push(description ? { label, description } : { label });
		if (options.length === MAX_OPTIONS) break;
	}

	const context = cleanLabel(params.context);
	const allowFreeform = params.allowFreeform !== false;

	if (options.length === 0 && !allowFreeform) {
		throw new Error("ask_user needs at least one option, or allowFreeform: true.");
	}

	return {
		question,
		...(context ? { context } : {}),
		options,
		allowFreeform,
	};
}
