/**
 * Delivers an already-built notification.
 *
 * IO is injected so the test can assert exactly what would be written without a
 * terminal, and so the extension decides where stdout goes (it must not write
 * escape codes in `rpc`, `json` or `print` mode).
 */

import type { ResolvedChannel } from "./channel.js";
import { encodeOsc, wrapTmux, type Notification } from "./payload.js";

let nextId = 1;

export interface SendDeps {
	/** Writes to the terminal. */
	write(text: string): void;
	/** Windows toast, fire and forget. */
	toast(notification: Notification): void;
	/** Inside tmux, raw OSC sequences have to be wrapped in a passthrough. */
	tmux: boolean;
}

export function sendNotification(
	channel: ResolvedChannel,
	notification: Notification,
	deps: SendDeps,
): void {
	if (channel === "off") return;

	if (channel === "toast") {
		deps.toast(notification);
		return;
	}

	// Kitty replaces a notification with the same id, so each one gets a new id.
	const sequence = encodeOsc(channel, notification, nextId++);
	deps.write(deps.tmux ? wrapTmux(sequence) : sequence);
}
