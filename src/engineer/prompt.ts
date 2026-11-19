/**
 * Pure prompt transforms for the `engineer` extension.
 *
 * `role` mode swaps identity without rebuilding Pi's prompt: the rendered
 * prompt is preamble + `<tools>` + `<rules>` + `<docs>` + context + skills +
 * cwd, so replacing the head keeps every section, including the guidelines
 * other extensions contribute, byte-for-byte. Rebuilding the prompt would drop
 * them, and a user's own SYSTEM.md must never be overwritten.
 */

import type { EngineerCapabilities } from "./charter.js";

/** The sentence Pi's default preamble starts with; the only head we replace. */
export const DEFAULT_PREAMBLE_MARKER = "You are a coding assistant running inside pi";

/** Marks the fallback shape, so a second pass over the same prompt is a no-op. */
const APPENDED_SECTION = "<engineer_role>";

/** A section is a standalone line like `<tools>`; the preamble has none. */
const SECTION_LINE = /^<[a-z][a-z0-9_-]*>$/m;

/** Only the fields of `systemPromptOptions` this extension reads. */
export interface EngineerToolState {
	selectedTools?: readonly string[];
	hiddenTools?: readonly string[];
}

/** Which optional capabilities the current loadout really exposes. */
export function detectCapabilities(options: EngineerToolState | undefined): EngineerCapabilities {
	const hidden = new Set(options?.hiddenTools ?? []);
	const active = new Set((options?.selectedTools ?? []).filter((name) => !hidden.has(name)));
	const subagents = [...active].some(
		(name) => name === "subagent" || name === "subagents_enable" || name.startsWith("subagent"),
	);
	return { askUser: active.has("ask_user"), subagents };
}

/** Splits the rendered prompt into the identity head and Pi's generated tail. */
export function splitPreamble(prompt: string): { head: string; tail: string } {
	const match = SECTION_LINE.exec(prompt);
	if (!match) return { head: prompt.trimEnd(), tail: "" };
	if (match.index === 0) return { head: "", tail: prompt };
	return { head: prompt.slice(0, match.index).trimEnd(), tail: prompt.slice(match.index) };
}

export type RoleApplication = "replaced" | "appended" | "unchanged";

export interface ApplyRoleOptions {
	/**
	 * True when the user supplied their own SYSTEM.md. Their identity is
	 * intentional, so the charter is appended instead of replacing it.
	 */
	userPrompt?: boolean;
}

/**
 * Applies the charter to a rendered system prompt.
 *
 * `replaced` swaps the known default preamble and keeps the tail intact;
 * `appended` is the safe path for an unknown or user-owned head, which is never
 * destroyed. The same charter over the same prompt yields `unchanged`, so a
 * double invocation cannot duplicate the role block.
 */
export function applyRole(
	prompt: string,
	charter: string,
	options: ApplyRoleOptions = {},
): { prompt: string; applied: RoleApplication } {
	const text = charter.trim();
	if (!text) return { prompt, applied: "unchanged" };
	if (prompt.startsWith(text) || prompt.includes(APPENDED_SECTION)) {
		return { prompt, applied: "unchanged" };
	}

	const { head, tail } = splitPreamble(prompt);
	if (!options.userPrompt && head.includes(DEFAULT_PREAMBLE_MARKER)) {
		return { prompt: tail ? `${text}\n\n${tail}` : text, applied: "replaced" };
	}

	const body = prompt.trimEnd();
	return {
		prompt: body ? `${body}\n\n${APPENDED_SECTION}\n${text}\n</engineer_role>` : text,
		applied: "appended",
	};
}
