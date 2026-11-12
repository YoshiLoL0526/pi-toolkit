/**
 * The `lively` block of `<agent-dir>/pi-toolkit.json`.
 *
 * Same file and same rules as the other extensions: read on every use so an
 * edit applies without restarting Pi, clamped, and a malformed file reported
 * with its path instead of ignored.
 */

import { clamp, readSettingsData, settingsPath } from "../config.js";

export const SPINNER_STYLES = ["braille", "dots", "pulse"] as const;
export type SpinnerStyle = (typeof SPINNER_STYLES)[number];

export const DEFAULT_CELEBRATE_MS = 4_000;
export const CELEBRATE_MS_MIN = 0;
export const CELEBRATE_MS_MAX = 15_000;

export interface LivelySettings {
	/** Master switch for every lively surface. */
	enabled: boolean;
	/** Replace the built-in footer with the animated telemetry footer. */
	footer: boolean;
	/** Show the live activity line above the editor while the agent works. */
	activity: boolean;
	/** Keep the closing line visible for `celebrateMs` before clearing it. */
	celebrate: boolean;
	/** How long the closing line stays on screen; 0 clears it immediately. */
	celebrateMs: number;
	spinner: SpinnerStyle;
}

/** Fresh object per call: callers must not share a mutable default. */
export function defaultLivelySettings(): LivelySettings {
	return {
		enabled: true,
		footer: true,
		activity: true,
		celebrate: true,
		celebrateMs: DEFAULT_CELEBRATE_MS,
		spinner: "braille",
	};
}

function isSpinnerStyle(value: unknown): value is SpinnerStyle {
	return typeof value === "string" && (SPINNER_STYLES as readonly string[]).includes(value);
}

/** Parses the `lively` key; a missing or non-object block means "all defaults". */
export function loadLivelySettings(path: string = settingsPath()): LivelySettings {
	const settings = defaultLivelySettings();
	const block = readSettingsData(path).lively;

	if (!block || typeof block !== "object" || Array.isArray(block)) return settings;
	const data = block as Record<string, unknown>;

	for (const key of ["enabled", "footer", "activity", "celebrate"] as const) {
		if (typeof data[key] === "boolean") settings[key] = data[key];
	}

	if (typeof data.celebrateMs === "number" && Number.isFinite(data.celebrateMs)) {
		settings.celebrateMs = clamp(Math.round(data.celebrateMs), CELEBRATE_MS_MIN, CELEBRATE_MS_MAX);
	}

	if (isSpinnerStyle(data.spinner)) settings.spinner = data.spinner;

	return settings;
}
