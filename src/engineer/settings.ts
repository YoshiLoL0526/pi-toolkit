/**
 * The `engineer` block of `<agent-dir>/pi-toolkit.json`.
 *
 * Same file and same rules as the other extensions: read on every turn so an
 * edit applies without restarting Pi, and a malformed file reported with its
 * path instead of being ignored.
 */

import { isAbsolute, join, resolve } from "node:path";
import { readSettingsData, settingsPath } from "../config.js";

/** Name of the optional user charter inside the agent directory. */
export const DEFAULT_PROMPT_FILE = "engineer.md";

export interface EngineerSettings {
	/** `role` mode is the only mode: replace the identity, keep Pi's scaffolding. */
	enabled: boolean;
	/** Charter override; relative paths resolve against the agent directory. */
	promptFile?: string;
}

/** Fresh object per call: callers must not share a mutable default. */
export function defaultEngineerSettings(): EngineerSettings {
	return { enabled: true };
}

/** Parses the `engineer` key; a missing or non-object block means "all defaults". */
export function loadEngineerSettings(path: string = settingsPath()): EngineerSettings {
	const settings = defaultEngineerSettings();
	const block = readSettingsData(path).engineer;

	if (!block || typeof block !== "object" || Array.isArray(block)) return settings;
	const data = block as Record<string, unknown>;

	if (typeof data.enabled === "boolean") settings.enabled = data.enabled;
	if (typeof data.promptFile === "string" && data.promptFile.trim()) {
		settings.promptFile = data.promptFile.trim();
	}

	return settings;
}

/**
 * Where the charter override lives. An absolute `promptFile` is used as given;
 * a relative one is resolved against the agent directory, never the cwd, so the
 * same settings work from any project.
 */
export function resolvePromptFile(settings: EngineerSettings, agentDir: string): string {
	const file = settings.promptFile ?? DEFAULT_PROMPT_FILE;
	return isAbsolute(file) ? resolve(file) : join(agentDir, file);
}
