/** Shapes shared by the tool, the UI, the fallback dialogs and the renderers. */

export interface AskOption {
	label: string;
	description?: string;
}

/** Normalized, validated input. Built once per tool call. */
export interface AskConfig {
	question: string;
	context?: string;
	options: AskOption[];
	allowFreeform: boolean;
}

export type AskResponse =
	| { kind: "selection"; labels: string[]; indexes: number[] }
	| { kind: "freeform"; text: string };

/**
 * Persisted in the tool result. Kept stable on purpose: the UI rebuilds the
 * transcript from it when a session is resumed.
 */
export interface AskDetails {
	question: string;
	context?: string;
	options: AskOption[];
	allowFreeform: boolean;
	response: AskResponse | null;
	cancelled: boolean;
}

/** What the interactive UI resolves with before it is turned into details. */
export type AskUiResult =
	| { kind: "selection"; label: string; index: number }
	| { kind: "freeform"; text: string }
	| null;
