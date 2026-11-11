/** The user-facing text of each notification. Pure, so the wording is testable. */

import { formatDuration, type Notification } from "./payload.js";

export type NotifyKind = "done" | "error" | "input";

export interface NotifyRun {
	/** Basename of the working directory; tells two open sessions apart in a toast. */
	project: string;
	durationMs?: number;
	error?: string;
	/** Question or dialog title when the agent is blocked on the user. */
	detail?: string;
}

/** `Pi · name`, or plain `Pi` when the project name is unavailable. */
function title(project: string): string {
	return project ? `Pi · ${project}` : "Pi";
}

export function buildNotification(kind: NotifyKind, run: NotifyRun): Notification {
	switch (kind) {
		case "done":
			return {
				title: title(run.project),
				body: `Done in ${formatDuration(run.durationMs ?? 0)}`,
			};
		case "error":
			return {
				title: title(run.project),
				body: `Stopped with an error: ${run.error ?? "unknown error"}`,
			};
		case "input":
			return {
				title: title(run.project),
				body: run.detail ? `Waiting for you: ${run.detail}` : "Waiting for your answer",
			};
	}
}
