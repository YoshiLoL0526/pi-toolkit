import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AskRequest } from "./types.js";

export const SETTINGS_FILE_NAME = "pi-toolkit.json";

export const DEFAULT_FILTER_THRESHOLD = 6;
export const FILTER_THRESHOLD_MIN = 2;
export const FILTER_THRESHOLD_MAX = 20;
export const TIMEOUT_MIN = 1000;
export const TIMEOUT_MAX = 600_000;

/** User defaults. Never required: every key falls back to the tool call or a constant. */
export interface AskUserSettings {
	timeout?: number;
	filterThreshold?: number;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function settingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, SETTINGS_FILE_NAME);
}

function readNumber(data: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
	const value = data[key];
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return clamp(Math.round(value), min, max);
}

/**
 * Reads the settings file on every call so edits apply without a restart.
 * A missing file is normal; a malformed one throws with its path so a config
 * mistake is visible instead of silently ignored.
 */
export function loadSettings(path: string = settingsPath()): AskUserSettings {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`pi-toolkit: cannot read ${path}: ${(error as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`pi-toolkit: ${path} is not valid JSON`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const data = parsed as Record<string, unknown>;

	const settings: AskUserSettings = {};
	const timeout = readNumber(data, "timeout", TIMEOUT_MIN, TIMEOUT_MAX);
	if (timeout !== undefined) settings.timeout = timeout;
	const filterThreshold = readNumber(data, "filterThreshold", FILTER_THRESHOLD_MIN, FILTER_THRESHOLD_MAX);
	if (filterThreshold !== undefined) settings.filterThreshold = filterThreshold;

	return settings;
}

/** A per-call `timeout` wins over the user default. */
export function applySettings(request: AskRequest, settings: AskUserSettings): AskRequest {
	const timeout = request.timeout ?? settings.timeout;
	return { ...request, ...(timeout ? { timeout } : {}) };
}
