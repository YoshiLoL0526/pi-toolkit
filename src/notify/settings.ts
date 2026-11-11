/**
 * The `notify` block of `<agent-dir>/pi-toolkit.json`.
 *
 * Same file and same rules as the ask_user settings: read on every event (so an
 * edit applies without restarting Pi), values clamped, and a malformed file
 * reported with its path instead of ignored.
 */

import { clamp, readSettingsData, settingsPath } from "../config.js";
import { NOTIFY_CHANNELS, type NotifyChannel } from "./channel.js";

export type NotifyEvent = "done" | "input" | "error";

export const NOTIFY_EVENTS: readonly NotifyEvent[] = ["done", "input", "error"];

export const DEFAULT_MIN_DURATION_MS = 20_000;
export const MIN_DURATION_MIN = 0;
export const MIN_DURATION_MAX = 3_600_000;

export interface NotifySettings {
	enabled: boolean;
	channel: NotifyChannel;
	/** Runs shorter than this only notify for `input` and `error`. */
	minDurationMs: number;
	events: NotifyEvent[];
}

/** Fresh arrays per call: callers must not share mutable defaults. */
export function defaultNotifySettings(): NotifySettings {
	return {
		enabled: true,
		channel: "auto",
		minDurationMs: DEFAULT_MIN_DURATION_MS,
		events: [...NOTIFY_EVENTS],
	};
}

function isChannel(value: unknown): value is NotifyChannel {
	return typeof value === "string" && (NOTIFY_CHANNELS as readonly string[]).includes(value);
}

function isNotifyEvent(value: unknown): value is NotifyEvent {
	return typeof value === "string" && (NOTIFY_EVENTS as readonly string[]).includes(value);
}

/** Parses the `notify` key; a missing or non-object block means "all defaults". */
export function loadNotifySettings(path: string = settingsPath()): NotifySettings {
	const settings = defaultNotifySettings();
	const block = readSettingsData(path).notify;

	if (!block || typeof block !== "object" || Array.isArray(block)) return settings;
	const data = block as Record<string, unknown>;

	if (typeof data.enabled === "boolean") settings.enabled = data.enabled;
	if (isChannel(data.channel)) settings.channel = data.channel;

	if (typeof data.minDurationMs === "number" && Number.isFinite(data.minDurationMs)) {
		settings.minDurationMs = clamp(Math.round(data.minDurationMs), MIN_DURATION_MIN, MIN_DURATION_MAX);
	}

	// An explicit but entirely invalid list falls back to every event rather than
	// silently disabling notifications by typo.
	if (Array.isArray(data.events)) {
		const events = data.events.filter(isNotifyEvent);
		if (events.length > 0) settings.events = [...new Set(events)];
	}

	return settings;
}
