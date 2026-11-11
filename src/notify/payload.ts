/**
 * Encoding of a notification for the terminal, and the Windows toast script.
 *
 * Everything here is pure and returns strings. A title or body can contain
 * anything the agent produced (`\x1b`, newlines, `;`, `$`), so every field is
 * sanitized before it reaches a control sequence or a shell.
 */

export interface Notification {
	title: string;
	body: string;
}

export const TITLE_MAX = 64;
export const BODY_MAX = 180;

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

/**
 * Flattens a field into one line of printable text.
 *
 * Control characters are the dangerous part: a stray BEL ends an OSC early and
 * a stray ESC can start a new one, so both are replaced rather than escaped.
 */
export function sanitize(text: string, max: number): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact, human-readable duration: `42s`, `3m 07s`, `1h 12m`. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/**
 * `OSC 777` is delimited by `;`, so a semicolon inside the title or body would
 * shift the remaining fields. Commas read the same and cannot break the frame.
 */
function oscField(text: string, max: number): string {
	return sanitize(text, max).replace(/;/g, ",");
}

/**
 * Builds the terminal sequence for a channel.
 *
 * `id` is only used by Kitty's `OSC 99`, which uses it to update or replace an
 * earlier notification; callers pass an increasing value.
 */
export function encodeOsc(
	channel: "osc9" | "osc99" | "osc777" | "bell",
	notification: Notification,
	id = 1,
): string {
	switch (channel) {
		case "bell":
			return BEL;
		case "osc9":
			// iTerm2 and friends accept a message only, so the title is a prefix.
			return `${ESC}]9;${sanitize(notification.title, TITLE_MAX)}: ${sanitize(
				notification.body,
				BODY_MAX,
			)}${BEL}`;
		case "osc99":
			// Two chunks with the same id: the title first, the body attached to it.
			return (
				`${ESC}]99;i=${id}:d=0;${sanitize(notification.title, TITLE_MAX)}${ST}` +
				`${ESC}]99;i=${id}:p=body;${sanitize(notification.body, BODY_MAX)}${ST}`
			);
		case "osc777":
			return `${ESC}]777;notify;${oscField(notification.title, TITLE_MAX)};${oscField(
				notification.body,
				BODY_MAX,
			)}${BEL}`;
	}
}

/**
 * Wraps a sequence in tmux's DCS passthrough. Every ESC inside the wrapped
 * sequence has to be doubled, which is why this cannot be done by concatenation
 * at the call site.
 */
export function wrapTmux(sequence: string): string {
	return `${ESC}Ptmux;${ESC}${sequence.replace(/\x1b/g, "\x1b\x1b")}${ST}`;
}

/**
 * Toast body and title travel through the environment, never through the
 * script: interpolating model-generated text into PowerShell is a command
 * injection hole. The script only reads `$env:` and uses a DOM text node, which
 * also takes care of XML escaping.
 */
export function toastEnv(notification: Notification): Record<string, string> {
	return {
		PI_NOTIFY_TITLE: sanitize(notification.title, TITLE_MAX),
		PI_NOTIFY_BODY: sanitize(notification.body, BODY_MAX),
	};
}

export const TOAST_SCRIPT = [
	"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
	"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
	// `GetElementsByTagName` returns a live view; materializing it is required
	// because appending a child while indexing the view throws "collection was
	// modified" on Windows PowerShell 5.1.
	"$texts = @($xml.GetElementsByTagName('text'))",
	"$texts[0].AppendChild($xml.CreateTextNode($env:PI_NOTIFY_TITLE)) > $null",
	"$texts[1].AppendChild($xml.CreateTextNode($env:PI_NOTIFY_BODY)) > $null",
	"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
	"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)",
].join("; ");
