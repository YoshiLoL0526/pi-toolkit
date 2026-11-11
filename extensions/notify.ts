import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveChannel, usesTmuxPassthrough } from "../src/notify/channel.js";
import { buildNotification, type NotifyKind } from "../src/notify/messages.js";
import { formatDuration } from "../src/notify/payload.js";
import { sendNotification } from "../src/notify/send.js";
import { defaultNotifySettings, loadNotifySettings, type NotifySettings } from "../src/notify/settings.js";
import { spawnWindowsToast } from "../src/notify/toast.js";

/** ask_user announces its question here so the notification can name it. */
const ASK_WAITING = "pi-toolkit:ask:waiting";
const ASK_SETTLED = "pi-toolkit:ask:settled";

const COMMANDS = ["on", "off", "test", "status"] as const;

/** Only the fields we need from an assistant message, to stay version tolerant. */
interface RunMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** The last assistant message decides whether the run failed; a retry overwrites it. */
function findRunError(messages: readonly RunMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return message.errorMessage ?? "The model request failed";
	}
	return undefined;
}

/**
 * Terminal notifications for the moments the user is looking somewhere else:
 * the run finished, the run failed, or the agent is blocked on an answer.
 *
 * No tool is registered: this extension is user-facing only. It listens to
 * lifecycle events and writes to the terminal directly, which is why the mode
 * guard below matters more than anything else in the file.
 */
export default function notifyExtension(pi: ExtensionAPI) {
	let runStartedAt: number | undefined;
	let runError: string | undefined;
	let waiting: string | undefined;
	/** `/notify on|off` override for the rest of the session. */
	let sessionEnabled: boolean | undefined;
	let settingsWarned = false;

	const readSettings = (ctx: ExtensionContext): NotifySettings => {
		try {
			return loadNotifySettings();
		} catch (error) {
			// One notification per session, not one per event: a broken file must be
			// visible without turning every run into a stream of errors.
			if (!settingsWarned) {
				settingsWarned = true;
				ctx.ui.notify(`${(error as Error).message} (notifications disabled)`, "error");
			}
			return { ...defaultNotifySettings(), enabled: false, channel: "off" };
		}
	};

	const enabled = (settings: NotifySettings): boolean => sessionEnabled ?? settings.enabled;

	const deliver = (channel: ReturnType<typeof resolveChannel>, notification: { title: string; body: string }) => {
		sendNotification(channel, notification, {
			write: (text) => process.stdout.write(text),
			toast: spawnWindowsToast,
			tmux: usesTmuxPassthrough(process.env),
		});
	};

	const send = (ctx: ExtensionContext, kind: NotifyKind, extra: { error?: string; detail?: string } = {}) => {
		// Raw escape codes would corrupt the JSON stream in `rpc`/`json` mode and the
		// answer text in `print` mode. Those modes get no terminal notification.
		if (ctx.mode !== "tui") return;

		const settings = readSettings(ctx);
		if (!enabled(settings) || !settings.events.includes(kind)) return;

		const durationMs = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
		// Short runs mean the user was most likely still watching; a blocked agent or
		// a failure is always worth a notification.
		if (kind === "done" && durationMs < settings.minDurationMs) return;

		const channel = resolveChannel(settings.channel, process.env, process.platform);
		if (channel === "off") return;

		deliver(
			channel,
			buildNotification(kind, {
				project: basename(ctx.cwd),
				durationMs,
				...(extra.error ? { error: extra.error } : {}),
				...(extra.detail ? { detail: extra.detail } : {}),
			}),
		);
	};

	// Soft coupling to ask_user through the shared bus: notify works alone and
	// simply has no question text when ask_user is not loaded.
	pi.events.on(ASK_WAITING, (data) => {
		const question = (data as { question?: unknown } | undefined)?.question;
		waiting = typeof question === "string" && question.trim() ? question : undefined;
	});
	pi.events.on(ASK_SETTLED, () => {
		waiting = undefined;
	});

	pi.on("agent_start", () => {
		runStartedAt = Date.now();
		runError = undefined;
	});

	pi.on("agent_end", (event) => {
		runError = findRunError(event.messages as readonly RunMessage[]);
	});

	pi.on("agent_settled", (event, ctx) => {
		// Escape is the user acting, not something to be told about.
		if (event.aborted) return;
		const error = runError;
		runError = undefined;
		send(ctx, error ? "error" : "done", error ? { error } : {});
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		// Idle means the user opened the dialog themselves (model picker, settings);
		// only a prompt that interrupts a running agent is "the agent is stuck on you".
		if (ctx.isIdle()) return;
		const detail = waiting ?? event.title;
		send(ctx, "input", detail ? { detail } : {});
	});

	pi.registerCommand("notify", {
		description: "Terminal notifications: on, off, test, status",
		getArgumentCompletions: (prefix: string) =>
			COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
			})),
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const action = (args ?? "").trim().toLowerCase() || "status";

			if (action === "on" || action === "off") {
				sessionEnabled = action === "on";
				ctx.ui.notify(`notifications ${action}`, "info");
				return;
			}

			const settings = readSettings(ctx);
			const channel = resolveChannel(settings.channel, process.env, process.platform);

			if (action === "test") {
				// Same guard as the event paths: this command is reachable from RPC, and
				// an escape sequence there would corrupt the JSON stream.
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`test notifications need tui mode (current: ${ctx.mode})`, "warning");
					return;
				}
				if (channel === "off") {
					ctx.ui.notify("notifications are off; set notify.enabled or pick a channel", "warning");
					return;
				}
				deliver(channel, { title: "Pi · test", body: "Notifications are working" });
				ctx.ui.notify(`sent a test notification via ${channel}`, "info");
				return;
			}

			if (action !== "status") {
				ctx.ui.notify(`unknown action: ${action} (on, off, test, status)`, "warning");
				return;
			}

			const state = enabled(settings) ? "on" : "off";
			const events = settings.events.length > 0 ? settings.events.join(", ") : "none";
			ctx.ui.notify(
				`notifications ${state} · ${channel}${usesTmuxPassthrough(process.env) ? " (tmux)" : ""} · ` +
					`${events} · min ${formatDuration(settings.minDurationMs)}`,
				"info",
			);
		},
	});
}
