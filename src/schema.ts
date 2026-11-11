import { type Static, Type } from "typebox";
import type { AskConfig, AskOption, AskRequest } from "./types.js";

const MAX_OPTIONS = 8;
const MAX_QUESTIONS = 6;

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label shown in the option list" }),
	description: Type.Optional(
		Type.String({ description: "One line explaining what picking this option implies" }),
	),
});

const QuestionSchema = Type.Object({
	label: Type.Optional(
		Type.String({ description: "Short tab label, e.g. 'Scope' or 'Priority'. Defaults to Q1, Q2, ..." }),
	),
	question: Type.String({ description: "The question to ask. One concrete, self-contained sentence." }),
	context: Type.Optional(
		Type.String({ description: "Supporting evidence or trade-off for this question, shown above it." }),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: MAX_OPTIONS,
			description: "2-5 concrete choices. Omit for an open-ended question.",
		}),
	),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Let the user pick several options (default: false)." })),
	allowFreeform: Type.Optional(
		Type.Boolean({ description: "Offer an 'Other' free-text answer (default: true)." }),
	),
});

/**
 * Flat object on purpose: `anyOf` is stripped or rejected by some provider
 * proxies, so "open question" and "batch" are expressed by omitting fields
 * instead of union types.
 */
export const askUserParameters = Type.Object({
	question: Type.Optional(
		Type.String({
			description:
				"The question to ask. One concrete, self-contained sentence. When `questions` is also set, this becomes the batch heading.",
		}),
	),
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
	allowMultiple: Type.Optional(
		Type.Boolean({ description: "Let the user pick several options from this list (default: false)." }),
	),
	allowFreeform: Type.Optional(
		Type.Boolean({
			description: "Offer an 'Other' free-text answer next to the options (default: true).",
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 600000,
			description:
				"Auto-dismiss the prompt after this many milliseconds without an answer and return a timeout. Only use when the user may be away.",
		}),
	),
	questions: Type.Optional(
		Type.Array(QuestionSchema, {
			maxItems: MAX_QUESTIONS,
			description:
				"2-4 independent questions shown together with tabs and a review page. Use for decisions whose prerequisites are already settled; anything that depends on another answer belongs in a later call.",
		}),
	),
});

export type AskUserParams = Static<typeof askUserParameters>;

function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeOptions(rawOptions: readonly { label?: string; description?: string }[] | undefined): AskOption[] {
	const options: AskOption[] = [];
	for (const raw of rawOptions ?? []) {
		const label = clean(raw.label);
		if (!label) continue;
		const description = clean(raw.description);
		options.push(description ? { label, description } : { label });
		if (options.length === MAX_OPTIONS) break;
	}
	return options;
}

interface RawQuestion {
	label?: string;
	question?: string;
	context?: string;
	options?: readonly { label?: string; description?: string }[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
}

function normalizeQuestion(raw: RawQuestion, index: number, isBatch: boolean): AskConfig {
	const question = clean(raw.question);
	if (!question) {
		throw new Error(
			isBatch ? `ask_user: question ${index + 1} needs a non-empty \`question\`.` : "ask_user needs a non-empty `question`.",
		);
	}

	const options = normalizeOptions(raw.options);
	const allowMultiple = raw.allowMultiple === true;
	const allowFreeform = raw.allowFreeform !== false;

	if (options.length === 0 && !allowFreeform) {
		throw new Error(
			`ask_user: question ${index + 1} needs at least one option, or allowFreeform: true.`,
		);
	}
	if (allowMultiple && options.length < 2) {
		throw new Error(`ask_user: question ${index + 1} needs at least two options when allowMultiple is true.`);
	}

	const context = clean(raw.context);
	const label = clean(raw.label);

	return {
		...(isBatch ? { label: label || `Q${index + 1}` } : label ? { label } : {}),
		question,
		...(context ? { context } : {}),
		options,
		allowMultiple,
		allowFreeform,
	};
}

/**
 * Accepts the validated schema and returns the shape the extension uses.
 * Throws on input that cannot produce a usable question; Pi reports the throw
 * as a failed tool call instead of inventing an answer.
 */
export function normalizeParams(params: AskUserParams): AskRequest {
	const heading = clean(params.question);
	const rawQuestions = params.questions ?? [];

	const timeout =
		typeof params.timeout === "number" && Number.isFinite(params.timeout)
			? Math.min(600_000, Math.max(1000, Math.round(params.timeout)))
			: undefined;

	if (rawQuestions.length > 0) {
		const questions = rawQuestions.map((raw, i) => normalizeQuestion(raw, i, rawQuestions.length > 1));
		return {
			...(heading ? { heading } : {}),
			...(timeout ? { timeout } : {}),
			questions,
		};
	}

	if (!heading) {
		throw new Error("ask_user needs either a `question` or a non-empty `questions` array.");
	}

	const single = normalizeQuestion(
		{
			question: heading,
			context: params.context,
			options: params.options,
			allowMultiple: params.allowMultiple,
			allowFreeform: params.allowFreeform,
		},
		0,
		false,
	);

	return { ...(timeout ? { timeout } : {}), questions: [single] };
}
