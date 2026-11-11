/** Shapes shared by the tool, the UI, the fallback dialogs and the renderers. */

export interface AskOption {
	label: string;
	description?: string;
}

/** Normalized, validated question. */
export interface AskConfig {
	/** Short tab label; only used in a batch. */
	label?: string;
	question: string;
	context?: string;
	options: AskOption[];
	allowMultiple: boolean;
	allowFreeform: boolean;
}

/** One tool call: a single question or a batch of independent ones. */
export interface AskRequest {
	heading?: string;
	questions: AskConfig[];
}

export type AskResponse =
	| { kind: "selection"; labels: string[]; indexes: number[]; text?: string }
	| { kind: "freeform"; text: string };

/** What the UI (custom component or dialogs) resolves with. */
export interface AskOutcome {
	/** Index-aligned with the request questions; null means unanswered. */
	responses: (AskResponse | null)[];
	cancelled: boolean;
}

/** Persisted in the tool result. `kind` was added in v2; v1 stored single details without it. */
export type AskDetails =
	| {
			kind: "single";
			question: string;
			context?: string;
			options: AskOption[];
			allowMultiple: boolean;
			allowFreeform: boolean;
			response: AskResponse | null;
			cancelled: boolean;
	  }
	| {
			kind: "batch";
			heading?: string;
			questions: Array<{
				label: string;
				question: string;
				context?: string;
				options: AskOption[];
				allowMultiple: boolean;
				allowFreeform: boolean;
			}>;
			answers: (AskResponse | null)[];
			cancelled: boolean;
	  };
