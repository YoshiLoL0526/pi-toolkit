import type {
	ExtensionAPI,
	ExtensionContext,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createActivityWidget, createFooter } from "../src/lively/ui.js";
import {
	defaultLivelySettings,
	loadLivelySettings,
	type LivelySettings,
} from "../src/lively/settings.js";
import { createStatsCache } from "../src/lively/stats.js";
import {
	endRun,
	endTool,
	finishFlourish,
	initialState,
	setModelPhase,
	setPrompting,
	startRun,
	startTool,
	tickFrame,
	type LivelyState,
	type ModelPhase,
	type RunOutcome,
} from "../src/lively/state.js";
import { describeTarget } from "../src/lively/target.js";

/** Fast enough to feel alive; 120ms keeps the 10-frame cycle off integer-second boundaries. */
const TICK_MS = 120;

/** The assistant stream is the only truthful source for thinking vs responding. */
function phaseFromAssistantEvent(event: MessageUpdateEvent["assistantMessageEvent"]): ModelPhase {
	switch (event.type) {
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
			return "thinking";
		case "text_start":
		case "text_delta":
		case "text_end":
			return "responding";
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return "tools";
		case "done":
			return event.reason === "toolUse" ? "tools" : "responding";
		case "start":
		case "error":
			return "waiting";
		default:
			// A newer host event type must not break the activity line.
			return "waiting";
	}
}

/** The last assistant message decides whether the run failed; a retry overwrites it. */
function runFailed(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const data = message as { role?: string; stopReason?: string };
		if (data.role !== "assistant") continue;
		return data.stopReason === "error";
	}
	return false;
}

/**
 * Ambient life for the TUI: a live activity line above the editor, a closing
 * line that lingers for a moment, and a footer that animates while the agent
 * works instead of sitting still.
 *
 * No tool and no transcript entries: this extension only decorates surfaces Pi
 * already owns. Every timer is stopped on settle and shutdown, and nothing is
 * installed outside `tui` mode.
 */
export default function livelyExtension(pi: ExtensionAPI) {
	let state: LivelyState = initialState();
	let settings: LivelySettings = defaultLivelySettings();
	/** `/lively on|off` override for the rest of the session. */
	let sessionEnabled: boolean | undefined;
	const stats = createStatsCache();

	let activeTui: TUI | undefined;
	/** The session context owns the footer; later events only refresh its snapshot. */
	let sessionCtx: ExtensionContext | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let flourishTimer: ReturnType<typeof setTimeout> | undefined;
	let footerInstalled = false;
	let widgetInstalled = false;
	let settingsWarned = false;
	let failed = false;
	let autoCompact = true;
	/** Pi's own working row is emptied while the activity line is the single indicator. */
	let nativeWorkingHidden = false;

	const enabled = (): boolean => sessionEnabled ?? settings.enabled;
	const footerOn = (): boolean => enabled() && settings.footer;
	const activityOn = (): boolean => enabled() && settings.activity;
	const refresh = (): void => activeTui?.requestRender();

	const stopTick = (): void => {
		if (!tickTimer) return;
		clearInterval(tickTimer);
		tickTimer = undefined;
	};

	const startTick = (): void => {
		if (tickTimer || !(footerOn() || activityOn())) return;
		tickTimer = setInterval(() => {
			state = tickFrame(state);
			refresh();
		}, TICK_MS);
	};

	const clearFlourish = (): void => {
		if (!flourishTimer) return;
		clearTimeout(flourishTimer);
		flourishTimer = undefined;
	};

	const readSettings = (ctx: ExtensionContext): void => {
		try {
			settings = loadLivelySettings();
		} catch (error) {
			// Once per session: a broken file must be visible without turning every
			// turn into another notification.
			if (!settingsWarned) {
				settingsWarned = true;
				ctx.ui.notify(`${(error as Error).message} (lively disabled)`, "error");
			}
			settings = { ...defaultLivelySettings(), enabled: false };
		}

		// Preserve the native footer's auto-compact marker; the setting can change
		// with /compact and is cheap to read at turn boundaries.
		try {
			autoCompact = pi.getSettings().compaction?.enabled ?? true;
		} catch {
			autoCompact = true;
		}
	};

	const clearWidget = (ctx: ExtensionContext): void => {
		if (!widgetInstalled) return;
		ctx.ui.setWidget("lively", undefined);
		widgetInstalled = false;
	};

	const installFooter = (ctx: ExtensionContext): void => {
		if (footerInstalled || !footerOn()) return;
		const hostCtx = sessionCtx ?? ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			return createFooter(theme, footerData, {
				getState: () => state,
				getSettings: () => settings,
				ctx: hostCtx,
				pi,
				stats,
				getAutoCompact: () => autoCompact,
				getActivityVisible: () => activityOn(),
			});
		});
		footerInstalled = true;
	};

	const removeFooter = (ctx: ExtensionContext): void => {
		if (!footerInstalled) return;
		ctx.ui.setFooter(undefined);
		footerInstalled = false;
	};

	const ensureWidget = (ctx: ExtensionContext): void => {
		if (!activityOn() || widgetInstalled || state.phase === "idle") return;
		ctx.ui.setWidget("lively", (tui, theme) => {
			activeTui = tui;
			return createActivityWidget(theme, {
				getState: () => state,
				getSettings: () => settings,
			});
		});
		widgetInstalled = true;
	};

	/**
	 * The inline line is the single status signal while it is visible. Pi's built-in
	 * working row would otherwise say "Working" next to it; emptying the message and
	 * the frames removes both its text and its spinner without hiding retry/compaction.
	 */
	const applyNativeWorking = (ctx: ExtensionContext): void => {
		const hide = activityOn();
		if (hide === nativeWorkingHidden) return;

		if (hide) {
			ctx.ui.setWorkingMessage("");
			ctx.ui.setWorkingIndicator({ frames: [] });
		} else {
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
		}
		nativeWorkingHidden = hide;
	};

	/** Applies the current settings without rebuilding surfaces that did not change. */
	const applyUi = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		if (footerOn()) installFooter(ctx);
		else removeFooter(ctx);

		if (!activityOn()) clearWidget(ctx);
		else if (state.phase !== "idle") ensureWidget(ctx);

		if (!footerOn() && !activityOn()) stopTick();
		applyNativeWorking(ctx);
	};

	const settleIdle = (ctx: ExtensionContext): void => {
		state = finishFlourish(state);
		clearWidget(ctx);
		refresh();
	};

	const scheduleFlourish = (ctx: ExtensionContext): void => {
		clearFlourish();
		if (!enabled() || (!footerOn() && !activityOn())) {
			settleIdle(ctx);
			return;
		}

		const delay = settings.celebrate ? settings.celebrateMs : 0;
		if (delay <= 0) {
			settleIdle(ctx);
			return;
		}
		flourishTimer = setTimeout(() => {
			flourishTimer = undefined;
			settleIdle(ctx);
		}, delay);
	};

	pi.on("session_start", (_event, ctx) => {
		const hadFooter = footerInstalled;
		const hadWidget = widgetInstalled;

		stopTick();
		clearFlourish();
		state = initialState();
		stats.invalidate();
		sessionEnabled = undefined;
		settingsWarned = false;
		footerInstalled = false;
		widgetInstalled = false;
		activeTui = undefined;
		sessionCtx = undefined;
		nativeWorkingHidden = false;

		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		// Clear only the surfaces this extension owned before the switch; another
		// extension's footer must survive our session start.
		if (hadFooter) ctx.ui.setFooter(undefined);
		if (hadWidget) ctx.ui.setWidget("lively", undefined);
		sessionCtx = ctx;
		readSettings(ctx);
		applyUi(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTick();
		clearFlourish();
		state = initialState();
		activeTui = undefined;
		sessionCtx = undefined;
		nativeWorkingHidden = false;
		footerInstalled = false;
		widgetInstalled = false;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		readSettings(ctx);
		applyUi(ctx);
		state = startRun(state, Date.now());
		failed = false;
		clearFlourish();
		if (!enabled()) return;

		ensureWidget(ctx);
		startTick();
		refresh();
	});

	pi.on("agent_end", (event) => {
		failed = runFailed(event.messages);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (state.phase !== "working") return;

		const outcome: RunOutcome = event.aborted ? "aborted" : failed ? "error" : "done";
		state = endRun(state, outcome, Date.now());
		stats.invalidate();
		stopTick();
		refresh();
		scheduleFlourish(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		readSettings(ctx);
		applyUi(ctx);
		if (state.phase === "working") {
			// A new turn is a new model request; tools from the previous turn are gone.
			if (state.active.length === 0) state = setModelPhase(state, "waiting");
			ensureWidget(ctx);
			startTick();
		}
		refresh();
	});

	pi.on("turn_end", (_event, ctx) => {
		stats.invalidate();
		if (ctx.mode === "tui" && ctx.hasUI) refresh();
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (state.phase !== "working" || event.message.role !== "assistant") return;
		const next = setModelPhase(state, "waiting");
		if (next === state) return;
		state = next;
		refresh();
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (state.phase !== "working" || event.message.role !== "assistant") return;
		const next = setModelPhase(state, phaseFromAssistantEvent(event.assistantMessageEvent));
		if (next === state) return;
		state = next;
		refresh();
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (state.phase !== "working" || event.message.role !== "assistant") return;
		if (event.message.stopReason !== "toolUse") return;
		const next = setModelPhase(state, "tools");
		if (next === state) return;
		state = next;
		refresh();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (state.phase !== "working" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const target = describeTarget(event.toolName, event.args);
		state = setModelPhase(state, "tools");
		state = startTool(state, {
			id: event.toolCallId,
			name: event.toolName,
			...(target ? { target } : {}),
		}, Date.now());
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		state = endTool(state, event.toolCallId);
		if (state.phase === "working" && state.active.length === 0) {
			state = setModelPhase(state, "waiting");
		}
		refresh();
	});

	// Any blocking prompt means the user, not the model, is the blocker.
	pi.on("ui_prompt_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		state = setPrompting(state, true, Date.now());
		refresh();
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		state = setPrompting(state, false, Date.now());
		refresh();
	});

	pi.on("model_select", (_event, ctx) => {
		stats.invalidate();
		if (ctx.mode === "tui" && ctx.hasUI) refresh();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.hasUI) refresh();
	});

	pi.on("session_compact", (_event, ctx) => {
		stats.invalidate();
		if (ctx.mode === "tui" && ctx.hasUI) refresh();
	});

	pi.on("session_tree", (_event, ctx) => {
		stats.invalidate();
		if (ctx.mode === "tui" && ctx.hasUI) refresh();
	});

	pi.registerCommand("lively", {
		description: "Turn the animated activity line and telemetry footer on or off for this session.",
		getArgumentCompletions(prefix) {
			return ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			readSettings(ctx);
			const action = args.trim().toLowerCase().split(/\s+/)[0] ?? "";

			if (!action || action === "status") {
				const source = sessionEnabled === undefined ? "settings" : "session";
				ctx.ui.notify(
					`lively ${enabled() ? "on" : "off"} (${source}) · footer ${settings.footer ? "on" : "off"} · activity ${settings.activity ? "on" : "off"} · celebrate ${settings.celebrate ? `${settings.celebrateMs}ms` : "off"} · spinner ${settings.spinner}`,
					"info",
				);
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /lively [on|off|status]", "error");
				return;
			}

			sessionEnabled = action === "on";
			applyUi(ctx);
			if (!enabled()) {
				stopTick();
				clearFlourish();
				settleIdle(ctx);
			} else if (state.phase === "working") {
				ensureWidget(ctx);
				startTick();
			} else if (state.phase === "settled") {
				ensureWidget(ctx);
				scheduleFlourish(ctx);
			}
			refresh();
			ctx.ui.notify(`lively ${enabled() ? "on" : "off"} for this session`, "info");
		},
	});
}
