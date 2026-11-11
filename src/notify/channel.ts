/**
 * Which escape sequence or delivery mechanism a terminal understands.
 *
 * Pure: the environment and the platform are passed in, so the smoke test can
 * pin the whole detection matrix without a terminal. Detection is best effort;
 * `notify.channel` in the settings file exists precisely for terminals whose
 * environment variables lie (or that support a protocol we do not guess).
 */

export type NotifyChannel = "auto" | "osc9" | "osc99" | "osc777" | "toast" | "bell" | "off";

/** Everything except `auto`, which is resolved before anything is sent. */
export type ResolvedChannel = Exclude<NotifyChannel, "auto">;

export const NOTIFY_CHANNELS: readonly NotifyChannel[] = [
	"auto",
	"osc9",
	"osc99",
	"osc777",
	"toast",
	"bell",
	"off",
];

/** Terminals that only understand `OSC 9 ; message BEL`. */
const OSC9_TERM_PROGRAMS = new Set(["iTerm.app", "Apple_Terminal"]);
/** Terminals that implement `OSC 777 ; notify ; title ; body`, including the title. */
const OSC777_TERM_PROGRAMS = new Set(["WezTerm", "ghostty"]);

/**
 * Resolves the configured channel to a concrete one.
 *
 * Order matters: an explicit setting wins, then the native Windows toast (it is
 * terminal independent, so it beats every escape sequence on Windows), then the
 * per-terminal variables. `toast` on a non-Windows host degrades to `osc777`
 * instead of silently doing nothing, because a wrong setting is easier to spot
 * than a notification that never arrives.
 */
export function resolveChannel(
	override: NotifyChannel,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform | string,
): ResolvedChannel {
	if (override !== "auto") {
		if (override === "toast" && platform !== "win32") return "osc777";
		return override;
	}

	if (platform === "win32") return "toast";
	// Windows Terminal on WSL keeps WT_SESSION but cannot reach powershell.exe.
	if (env.WT_SESSION) return "osc9";
	if (env.KITTY_WINDOW_ID) return "osc99";

	const termProgram = env.TERM_PROGRAM ?? "";
	if (OSC9_TERM_PROGRAMS.has(termProgram)) return "osc9";
	if (OSC777_TERM_PROGRAMS.has(termProgram)) return "osc777";
	if ((env.TERM ?? "").includes("ghostty")) return "osc777";

	// Unknown terminals ignore an OSC they do not implement, so this is safe.
	return "osc777";
}

/** tmux swallows escape sequences unless they are wrapped in a DCS passthrough. */
export function usesTmuxPassthrough(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.TMUX);
}
